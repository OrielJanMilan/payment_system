import type { ChargerDto, ConnectorDto, ConnectorStatus } from "@payment-system/shared";
import { db } from "../../db/db.ts";

interface ChargerRow {
  id: number;
  code: string;
  qr_slug: string;
  site_name: string;
  bay: string;
  tariff_centavos_per_kwh: number;
  hold_centavos: number;
}

interface ConnectorRow {
  id: number;
  type: string;
  max_kw: number;
  status: ConnectorStatus;
}

function toDto(row: ChargerRow): ChargerDto {
  const connectors = db
    .prepare("SELECT id, type, max_kw, status FROM connectors WHERE charger_id = ? ORDER BY id")
    .all(row.id) as unknown as ConnectorRow[];
  /* Server-side resume: the charger knows its own live session, and the most
     recent finished one whose receipt the driver hasn't acknowledged yet. */
  const active = db
    .prepare(
      `SELECT id FROM sessions WHERE charger_id = ? AND state IN ('pending_start','charging')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(row.id) as { id: string } | undefined;
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recentEnded = db
    .prepare(
      `SELECT id FROM sessions WHERE charger_id = ? AND state = 'ended'
       AND acked_at IS NULL AND ended_at > ? ORDER BY ended_at DESC LIMIT 1`
    )
    .get(row.id, cutoff) as { id: string } | undefined;
  return {
    activeSessionId: active?.id ?? null,
    recentEndedSessionId: recentEnded?.id ?? null,
    code: row.code,
    qrSlug: row.qr_slug,
    siteName: row.site_name,
    bay: row.bay,
    tariffCentavosPerKwh: row.tariff_centavos_per_kwh,
    holdCentavos: row.hold_centavos,
    connectors: connectors.map(
      (c): ConnectorDto => ({ id: c.id, type: c.type, maxKw: c.max_kw, status: c.status })
    ),
  };
}

export function chargerByCode(code: string): ChargerDto | null {
  const row = db.prepare("SELECT * FROM chargers WHERE code = ?").get(code) as
    | ChargerRow
    | undefined;
  return row ? toDto(row) : null;
}

export function chargerBySlug(slug: string): ChargerDto | null {
  const row = db.prepare("SELECT * FROM chargers WHERE qr_slug = ?").get(slug) as
    | ChargerRow
    | undefined;
  return row ? toDto(row) : null;
}
