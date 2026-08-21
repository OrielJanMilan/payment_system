/* Phase 4 smoke test: virtual charge point + gateway — remote start, meter
   stream, register-delta billing, watchdog, soft-stop, scenario stops.
   Run: npm run smoke:p4  (from apps/api) */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = 3948;
process.env.PORT = String(PORT);
process.env.BASE_URL = `http://localhost:${PORT}`;
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ps-smoke4-")), "smoke.sqlite");
process.env.START_TIMEOUT_MS = "250";
process.env.MOCK_CP_SAMPLE_MS = "40";
process.env.MOCK_CP_ACCEL = "200";
process.env.MOCK_CP_START_DELAY_MS = "50";

const { migrate, db } = await import("../src/db/db.ts");
const { seed } = await import("../src/db/seed.ts");
const { createApp } = await import("../src/app.ts");
const { amountForWh } = await import("../src/modules/chargers/gateway.ts");
const { subscribe } = await import("../src/modules/sessions/events.ts");

migrate();
seed();
const server = createApp().listen(PORT);
const base = `http://localhost:${PORT}`;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}
async function post(url: string, body?: unknown): Promise<any> {
  const r = await fetch(base + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function getJson(url: string): Promise<any> {
  return (await fetch(base + url)).json();
}
async function until(fn: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
async function startAuthorizedSession(method = "Maya Wallet"): Promise<{ sid: string; intentId: string }> {
  const s = (await post("/sessions", { chargerCode: "CHG-0042", connectorId: 1 })).json;
  const co = (await post("/payments/checkout", { sessionId: s.id, method })).json;
  const checkoutId = co.redirectUrl.split("/").pop();
  await fetch(`${base}/mock-maya/checkout/${checkoutId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "outcome=authorize",
    redirect: "manual",
  });
  return { sid: s.id, intentId: co.intent.id };
}
const sessionState = async (sid: string) => (await getJson(`/sessions/${sid}`)).state;
const connectorStatus = async () =>
  (await getJson("/chargers/CHG-0042")).connectors[0].status as string;

/* --- billing math: peso rounded half-up, from Wh × centavos/kWh --- */
check("rounding: 123 Wh @4850 → 597 (596.55 up)", amountForWh(123, 4850) === 597);
check("rounding: 101 Wh @4850 → 490 (489.85 up)", amountForWh(101, 4850) === 490);
check("rounding: exact .5 rounds up", amountForWh(1, 500) === 1);
check("rounding: 18400 Wh @4850 → 89240 exact", amountForWh(18_400, 4850) === 89_240);

/* --- happy path: authorize → charging → meter stream → stop → capture --- */
const a = await startAuthorizedSession();
const meterEvents: { energyWh: number }[] = [];
subscribe(a.sid, (e) => { if (e.type === "meter") meterEvents.push(e); });
check("charging after spin-up", await until(async () => (await sessionState(a.sid)) === "charging", 2000));
const live = await getJson(`/sessions/${a.sid}`);
check("meterStart recorded from register", typeof live.meterStartWh === "number" && live.meterStartWh >= 1_204_320);
check("meter samples streaming", await until(() => meterEvents.length >= 3, 2000));
check("running energy grows monotonically",
  meterEvents.length >= 2 && meterEvents.every((e, i) => i === 0 || e.energyWh >= meterEvents[i - 1]!.energyWh));

const stop = await post(`/sessions/${a.sid}/stop`);
check("stop accepted (202)", stop.status === 202);
check("session ended", await until(async () => (await sessionState(a.sid)) === "ended", 2000));
const endedA = await getJson(`/sessions/${a.sid}`);
check("stop reason Remote", endedA.stopReason === "Remote");
check("billed = register delta", endedA.billedWh === endedA.meterStopWh - endedA.meterStartWh);
check("amount = delta × tariff, half-up",
  endedA.amountCentavos === amountForWh(endedA.billedWh, endedA.tariffCentavosPerKwh));
check("intent captured for exact amount", await until(async () => {
  const i = await getJson(`/payments/${a.intentId}`);
  return i.state === "CAPTURED" && i.capturedCentavos === endedA.amountCentavos;
}, 1000));
check("receipt number issued", /^OR-\d{4}-\d{6}$/.test(endedA.receiptNo ?? (await getJson(`/sessions/${a.sid}`)).receiptNo ?? ""));
check("connector released", (await connectorStatus()) === "AVAILABLE");
check("double stop → 409", (await post(`/sessions/${a.sid}/stop`)).status === 409);

/* --- charger refuses the start: immediate void + start_failed --- */
await post("/mock-cp/scenario", { startBehavior: "reject" });
const b = await startAuthorizedSession();
check("rejected start → start_failed", await until(async () => (await sessionState(b.sid)) === "start_failed", 1000));
check("hold voided on rejection",
  (await getJson(`/payments/${b.intentId}`)).state === "VOIDED");
check("connector released after rejection", (await connectorStatus()) === "AVAILABLE");

/* --- accepted but never starts: the 90 s (here 250 ms) watchdog --- */
await post("/mock-cp/scenario", { startBehavior: "silent" });
const c = await startAuthorizedSession();
await new Promise((r) => setTimeout(r, 150));
check("still pending_start before watchdog", (await sessionState(c.sid)) === "pending_start");
check("watchdog → start_failed", await until(async () => (await sessionState(c.sid)) === "start_failed", 1500));
check("watchdog voided the hold", (await getJson(`/payments/${c.intentId}`)).state === "VOIDED");

/* --- soft-stop at 90% of the hold (small hold so it trips fast) --- */
db.prepare("UPDATE chargers SET hold_centavos = 10000 WHERE id = 1").run();
const d = await startAuthorizedSession();
check("soft-stop ends the session without a driver stop",
  await until(async () => (await sessionState(d.sid)) === "ended", 5000));
const endedD = await getJson(`/sessions/${d.sid}`);
check("soft-stop capture ≥ 90% of hold", endedD.amountCentavos >= 9000);
check("soft-stop capture never exceeds hold", endedD.amountCentavos <= 10000);
db.prepare("UPDATE chargers SET hold_centavos = 150000 WHERE id = 1").run();

/* --- cable unplugged mid-session --- */
const e1 = await startAuthorizedSession();
await until(async () => (await sessionState(e1.sid)) === "charging", 2000);
await post("/mock-cp/unplug");
check("unplug ends session", await until(async () => (await sessionState(e1.sid)) === "ended", 1000));
check("unplug reason EVDisconnected", (await getJson(`/sessions/${e1.sid}`)).stopReason === "EVDisconnected");
check("unplug still captured", await until(async () => (await getJson(`/payments/${e1.intentId}`)).state === "CAPTURED", 1000));

/* --- power loss: offline, end event queued, delivered on reconnect --- */
const f = await startAuthorizedSession();
await until(async () => (await sessionState(f.sid)) === "charging", 2000);
await post("/mock-cp/powerloss");
check("connector OFFLINE after power loss", (await connectorStatus()) === "OFFLINE");
await new Promise((r) => setTimeout(r, 200));
check("session still charging while end event is queued", (await sessionState(f.sid)) === "charging");
check("end event queued on the CP", (await getJson("/mock-cp/state")).queuedEndEvent === true);
await post("/mock-cp/online");
check("queued end delivered on reconnect", await until(async () => (await sessionState(f.sid)) === "ended", 1000));
const endedF = await getJson(`/sessions/${f.sid}`);
check("power-loss reason recorded", endedF.stopReason === "PowerLoss");
check("billed only to last trustworthy register", endedF.billedWh === endedF.meterStopWh - endedF.meterStartWh);
check("connector AVAILABLE after reconnect", (await connectorStatus()) === "AVAILABLE");

server.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
