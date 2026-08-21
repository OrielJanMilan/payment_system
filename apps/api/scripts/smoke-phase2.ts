/* Phase 2 smoke test: session state machine, connector claim/release,
   TTL expiry, and event publication — against a throwaway DB.
   Run: npm run smoke  (from apps/api) */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ps-smoke-")), "smoke.sqlite");
process.env.DB_FILE = tmpDb;
process.env.SESSION_TTL_MS = "150"; // fast TTL for the expiry check

const { migrate, db } = await import("../src/db/db.ts");
const { seed } = await import("../src/db/seed.ts");
const { createSession, getSession, transition } = await import(
  "../src/modules/sessions/service.ts"
);
const { subscribe } = await import("../src/modules/sessions/events.ts");

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

function connectorStatus(): string {
  return (db.prepare("SELECT status FROM connectors WHERE id = 1").get() as { status: string })
    .status;
}

migrate();
seed();

/* --- happy path: pending_payment → pending_start → charging → ended --- */
const created = createSession("chg-0042", 1); // lowercase on purpose — lookup must be case-insensitive
check("createSession ok", created.ok);
if (!created.ok) process.exit(1);
const s = created.session;
check("starts in pending_payment", s.state === "pending_payment");
check("tariff pinned (4850)", s.tariffCentavosPerKwh === 4850);
check("hold computed server-side (150000)", s.holdCentavos === 150000);
check("connector claimed on create", connectorStatus() === "IN_USE");

const events: string[] = [];
const unsubscribe = subscribe(s.id, (e) => events.push(e.type === "state" ? e.state : e.type));

check("second session on same connector rejected",
  (() => { const r = createSession("CHG-0042", 1); return !r.ok && r.error === "connector_unavailable"; })());

check("invalid: pending_payment → charging refused", !transition(s.id, "charging"));
check("invalid: pending_payment → ended refused", !transition(s.id, "ended"));

check("pending_payment → pending_start", transition(s.id, "pending_start"));
check("charging with meter_start patch",
  transition(s.id, "charging", { meter_start_wh: 1_204_320, transaction_id: "tx-1", started_at: new Date().toISOString() }));
check("replayed charging transition is a no-op", !transition(s.id, "charging"));
check("connector still held while charging", connectorStatus() === "IN_USE");

check("charging → ended with billing patch",
  transition(s.id, "ended", { meter_stop_wh: 1_222_720, stop_reason: "Remote", billed_wh: 18_400, amount_centavos: 89_240, ended_at: new Date().toISOString() }));
check("connector released after ended", connectorStatus() === "AVAILABLE");
check("terminal state is dead: ended → charging refused", !transition(s.id, "charging"));

const final = getSession(s.id)!;
check("billing fields persisted", final.billedWh === 18_400 && final.amountCentavos === 89_240);
check("events published in order",
  JSON.stringify(events) === JSON.stringify(["pending_start", "charging", "ended"]));
unsubscribe();

/* --- expiry: TTL lapse flips pending_payment → expired, frees connector --- */
const second = createSession("CHG-0042", 1);
check("connector reusable after release", second.ok);
if (second.ok) {
  await new Promise((r) => setTimeout(r, 300)); // outlive the 150 ms TTL
  const read = getSession(second.session.id)!;
  check("lazy expiry on read", read.state === "expired");
  check("expired session released connector", connectorStatus() === "AVAILABLE");
  check("expired is terminal: → pending_start refused", !transition(second.session.id, "pending_start"));
}

/* --- start failure: pending_start → start_failed frees the connector --- */
const third = createSession("CHG-0042", 1);
if (third.ok) {
  transition(third.session.id, "pending_start");
  check("pending_start → start_failed", transition(third.session.id, "start_failed"));
  check("start_failed released connector", connectorStatus() === "AVAILABLE");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
