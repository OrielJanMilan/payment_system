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
  return {
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
