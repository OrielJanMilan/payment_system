import { db } from "./db.ts";

/* Idempotent dev seed: the one virtual pilot charger the whole mock
   milestone runs against. Matches the figures used across the design docs. */
export function seed(): void {
  db.prepare(
    `INSERT INTO chargers (id, code, qr_slug, site_name, bay, tariff_centavos_per_kwh, hold_centavos)
     VALUES (1, 'CHG-0042', 'chg-0042-a1b2', 'Ayala Malls Manila Bay', 'Basement 2 · Bay 14', 4850, 150000)
     ON CONFLICT(id) DO NOTHING`
  ).run();

  db.prepare(
    `INSERT INTO connectors (id, charger_id, type, max_kw, status)
     VALUES (1, 1, 'CCS2', 60, 'AVAILABLE')
     ON CONFLICT(id) DO NOTHING`
  ).run();
}
