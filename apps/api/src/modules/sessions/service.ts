import { randomUUID } from "node:crypto";
import type { SessionDto, SessionState } from "@payment-system/shared";
import { db, nowIso } from "../../db/db.ts";
import { config } from "../../config.ts";
import { publish } from "./events.ts";

/* Allowed transitions (SCREEN_FUNCTIONALITY.md state mapping):
     pending_payment → pending_start   payment authorized
     pending_payment → expired         10-min TTL ran out
     pending_start   → charging        charge point reported session_started
     pending_start   → start_failed    no start within 90 s / charger refused
     charging        → ended           charge point reported session_ended */
const TRANSITIONS: Record<SessionState, SessionState[]> = {
  pending_payment: ["pending_start", "expired"],
  pending_start: ["charging", "start_failed"],
  charging: ["ended"],
  ended: [],
  expired: [],
  start_failed: [],
};

/* States in which the session no longer occupies its connector. */
const RELEASES_CONNECTOR: SessionState[] = ["expired", "start_failed", "ended"];

interface SessionRow {
  id: string;
  charger_id: number;
  connector_id: number;
  state: SessionState;
  tariff_centavos_per_kwh: number;
  hold_centavos: number;
  transaction_id: string | null;
  meter_start_wh: number | null;
  meter_stop_wh: number | null;
  stop_reason: string | null;
  billed_wh: number | null;
  amount_centavos: number | null;
  receipt_no: string | null;
  created_at: string;
  expires_at: string;
  started_at: string | null;
  ended_at: string | null;
  code: string;
  site_name: string;
  bay: string;
}

const SELECT_SESSION = `
  SELECT s.*, c.code, c.site_name, c.bay
  FROM sessions s JOIN chargers c ON c.id = s.charger_id`;

function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    state: row.state,
    chargerCode: row.code,
    siteName: row.site_name,
    bay: row.bay,
    connectorId: row.connector_id,
    tariffCentavosPerKwh: row.tariff_centavos_per_kwh,
    holdCentavos: row.hold_centavos,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    meterStartWh: row.meter_start_wh,
    meterStopWh: row.meter_stop_wh,
    billedWh: row.billed_wh,
    amountCentavos: row.amount_centavos,
    receiptNo: row.receipt_no,
    stopReason: row.stop_reason,
  };
}

export type CreateSessionResult =
  | { ok: true; session: SessionDto }
  | { ok: false; error: "charger_not_found" | "connector_not_found" | "connector_unavailable" };

export function createSession(chargerCode: string, connectorId: number): CreateSessionResult {
  const charger = db
    .prepare("SELECT * FROM chargers WHERE code = ?")
    .get(chargerCode.toUpperCase()) as
    | { id: number; tariff_centavos_per_kwh: number; hold_centavos: number }
    | undefined;
  if (!charger) return { ok: false, error: "charger_not_found" };

  const connector = db
    .prepare("SELECT id FROM connectors WHERE id = ? AND charger_id = ?")
    .get(connectorId, charger.id);
  if (!connector) return { ok: false, error: "connector_not_found" };

  /* Atomic claim — doubles as the availability check. */
  const claim = db
    .prepare("UPDATE connectors SET status = 'IN_USE' WHERE id = ? AND status = 'AVAILABLE'")
    .run(connectorId);
  if (claim.changes === 0) return { ok: false, error: "connector_unavailable" };

  const id = randomUUID();
  const created = new Date();
  const expires = new Date(created.getTime() + config.sessionTtlMs);
  db.prepare(
    `INSERT INTO sessions (id, charger_id, connector_id, state,
                           tariff_centavos_per_kwh, hold_centavos, created_at, expires_at)
     VALUES (?, ?, ?, 'pending_payment', ?, ?, ?, ?)`
  ).run(
    id,
    charger.id,
    connectorId,
    charger.tariff_centavos_per_kwh,
    charger.hold_centavos,
    created.toISOString(),
    expires.toISOString()
  );

  return { ok: true, session: getSession(id)! };
}

export function getSession(id: string): SessionDto | null {
  const row = db.prepare(`${SELECT_SESSION} WHERE s.id = ?`).get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;
  /* Lazy expiry so a stale pending_payment session is never served as live. */
  if (row.state === "pending_payment" && row.expires_at < nowIso()) {
    transition(id, "expired");
    return getSession(id);
  }
  return toDto(row);
}

/* Guarded, idempotent transition: the UPDATE only fires when the current
   state legally precedes `to`, so replayed events are no-ops. Returns
   whether the transition happened, and publishes it to SSE subscribers. */
export function transition(
  id: string,
  to: SessionState,
  patch: Record<string, string | number | null> = {}
): boolean {
  const from = (Object.keys(TRANSITIONS) as SessionState[]).filter((s) =>
    TRANSITIONS[s].includes(to)
  );
  if (from.length === 0) return false;

  const patchCols = Object.keys(patch);
  const setSql = ["state = ?", ...patchCols.map((c) => `${c} = ?`)].join(", ");
  const placeholders = from.map(() => "?").join(", ");
  const result = db
    .prepare(`UPDATE sessions SET ${setSql} WHERE id = ? AND state IN (${placeholders})`)
    .run(to, ...patchCols.map((c) => patch[c] ?? null), id, ...from);
  if (result.changes === 0) return false;

  if (RELEASES_CONNECTOR.includes(to)) {
    db.prepare(
      "UPDATE connectors SET status = 'AVAILABLE' WHERE id = (SELECT connector_id FROM sessions WHERE id = ?)"
    ).run(id);
  }

  const session = getSession(id);
  if (session) publish(id, { type: "state", state: to, session });
  return true;
}

/* Background sweep for pending_payment sessions whose TTL lapsed while
   nobody was reading them (lazy expiry only covers sessions that get read). */
export function startExpirySweep(): void {
  setInterval(() => {
    const stale = db
      .prepare("SELECT id FROM sessions WHERE state = 'pending_payment' AND expires_at < ?")
      .all(nowIso()) as unknown as { id: string }[];
    for (const row of stale) transition(row.id, "expired");
  }, 30_000).unref();
}
