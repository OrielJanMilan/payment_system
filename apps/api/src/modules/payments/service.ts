import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PaymentIntentDto, PaymentIntentState } from "@payment-system/shared";
import { db, nowIso } from "../../db/db.ts";
import { config } from "../../config.ts";
import { getProvider } from "./providers/provider.ts";
import * as sessions from "../sessions/service.ts";

/* Intent lifecycle (SCREEN_FUNCTIONALITY.md mapping table):
     CREATED → PENDING_AUTH            checkout created, driver on hosted page
     PENDING_AUTH → AUTHORIZED         provider webhook: authorized/paid
     PENDING_AUTH → AUTH_FAILED        provider webhook: failed
     PENDING_AUTH → EXPIRED            provider webhook: checkout expired
     AUTHORIZED → CAPTURING → CAPTURED session ended, exact amount taken
     AUTHORIZED → VOIDED               charger failed to start
     CAPTURED → REFUNDED               support-initiated (not in driver UI) */
const TRANSITIONS: Record<PaymentIntentState, PaymentIntentState[]> = {
  CREATED: ["PENDING_AUTH"],
  PENDING_AUTH: ["AUTHORIZED", "AUTH_FAILED", "EXPIRED"],
  AUTHORIZED: ["CAPTURING", "VOIDED"],
  CAPTURING: ["CAPTURED"],
  CAPTURED: ["REFUNDED"],
  AUTH_FAILED: [],
  EXPIRED: [],
  VOIDED: [],
  REFUNDED: [],
};

/* Cross-module notifications without payments importing chargers:
   Phase 4's charger gateway subscribes to 'authorized' to fire remote-start. */
export const paymentsBus = new EventEmitter();

interface IntentRow {
  id: string;
  session_id: string;
  provider: string;
  state: PaymentIntentState;
  method: string | null;
  prepay: number;
  hold_centavos: number;
  captured_centavos: number | null;
  checkout_id: string | null;
  created_at: string;
  updated_at: string;
}

function toDto(row: IntentRow): PaymentIntentDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    provider: row.provider,
    state: row.state,
    method: row.method,
    prepay: row.prepay === 1,
    holdCentavos: row.hold_centavos,
    capturedCentavos: row.captured_centavos,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getIntent(id: string): PaymentIntentDto | null {
  const row = db.prepare("SELECT * FROM payment_intents WHERE id = ?").get(id) as
    | IntentRow
    | undefined;
  return row ? toDto(row) : null;
}

function transitionIntent(
  id: string,
  to: PaymentIntentState,
  patch: Record<string, string | number | null> = {}
): boolean {
  const from = (Object.keys(TRANSITIONS) as PaymentIntentState[]).filter((s) =>
    TRANSITIONS[s].includes(to)
  );
  const patchCols = Object.keys(patch);
  const setSql = ["state = ?", "updated_at = ?", ...patchCols.map((c) => `${c} = ?`)].join(", ");
  const result = db
    .prepare(
      `UPDATE payment_intents SET ${setSql} WHERE id = ? AND state IN (${from
        .map(() => "?")
        .join(", ")})`
    )
    .run(to, nowIso(), ...patchCols.map((c) => patch[c] ?? null), id, ...from);
  return result.changes > 0;
}

export type CheckoutCreation =
  | { ok: true; intent: PaymentIntentDto; redirectUrl: string }
  | { ok: false; error: "session_not_found" | "session_not_payable" };

/* S3 / C2 "Hold & start": create the intent and the provider checkout.
   The hold amount comes off the session, where it was pinned server-side. */
export function createCheckout(sessionId: string, method: string): CheckoutCreation {
  const session = sessions.getSession(sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.state !== "pending_payment") return { ok: false, error: "session_not_payable" };

  const provider = getProvider("mock-maya");
  const prepay = !provider.supportsHold(method);
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO payment_intents (id, session_id, provider, state, method, prepay,
                                  hold_centavos, created_at, updated_at)
     VALUES (?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)`
  ).run(id, sessionId, provider.name, method, prepay ? 1 : 0, session.holdCentavos, now, now);

  const checkout = provider.createCheckout({
    intentId: id,
    amountCentavos: session.holdCentavos,
    method,
    prepay,
    successUrl: `${config.baseUrl}/?payment_return=${id}`,
    failureUrl: `${config.baseUrl}/?payment_return=${id}`,
  });
  transitionIntent(id, "PENDING_AUTH", { checkout_id: checkout.checkoutId });

  return { ok: true, intent: getIntent(id)!, redirectUrl: checkout.redirectUrl };
}

interface ProviderEvent {
  type: string;
  intent_id: string;
  checkout_id: string;
}

/* Called by the webhook module after signature verification + persistence.
   Transitions are guarded, so replays and out-of-order deliveries are no-ops. */
export function applyProviderEvent(event: ProviderEvent): boolean {
  const intent = getIntent(event.intent_id);
  if (!intent) return false;

  switch (event.type) {
    case "payment.authorized": {
      if (!transitionIntent(intent.id, "AUTHORIZED")) return false;
      /* Money is held — the charger may now start (S3 off-screen behavior). */
      sessions.transition(intent.sessionId, "pending_start");
      paymentsBus.emit("authorized", { sessionId: intent.sessionId, intentId: intent.id });
      return true;
    }
    case "payment.failed":
      return transitionIntent(intent.id, "AUTH_FAILED");
    case "payment.expired":
      return transitionIntent(intent.id, "EXPIRED");
    default:
      return false;
  }
}

function authorizedIntentFor(sessionId: string): IntentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM payment_intents WHERE session_id = ? AND state = 'AUTHORIZED'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId) as IntentRow | undefined;
}

/* Session ended → capture exactly the metered amount; the rest of the hold is
   released (or refunded, for prepay methods). Issues the mock OR number. */
export function captureForSession(sessionId: string, amountCentavos: number): boolean {
  const row = authorizedIntentFor(sessionId);
  if (!row || !row.checkout_id) return false;
  if (!transitionIntent(row.id, "CAPTURING")) return false;

  const provider = getProvider(row.provider);
  provider.capture(row.checkout_id, amountCentavos);
  if (row.prepay === 1 && row.hold_centavos > amountCentavos) {
    provider.refund(row.checkout_id, row.hold_centavos - amountCentavos);
  }
  transitionIntent(row.id, "CAPTURED", { captured_centavos: amountCentavos });

  /* Mock BIR receipt number — real numbering is a Launch-phase concern. */
  const n = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE receipt_no IS NOT NULL").get() as { n: number }).n + 1;
  const receiptNo = `OR-${new Date().getFullYear()}-${String(n).padStart(6, "0")}`;
  db.prepare("UPDATE sessions SET receipt_no = ? WHERE id = ?").run(receiptNo, sessionId);

  paymentsBus.emit("captured", { sessionId, intentId: row.id, amountCentavos });
  return true;
}

/* Charger failed to start → release the driver's money. */
export function voidForSession(sessionId: string): boolean {
  const row = authorizedIntentFor(sessionId);
  if (!row || !row.checkout_id) return false;
  if (!transitionIntent(row.id, "VOIDED")) return false;
  getProvider(row.provider).voidHold(row.checkout_id);
  paymentsBus.emit("voided", { sessionId, intentId: row.id });
  return true;
}
