/* Phase 3 smoke test: mock Maya checkout → signed webhook → intent state
   machine → capture/void/prepay-refund, over real HTTP against a throwaway
   DB and port. Run: npm run smoke:p3  (from apps/api) */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac } from "node:crypto";

const PORT = 3947;
process.env.PORT = String(PORT);
process.env.BASE_URL = `http://localhost:${PORT}`;
process.env.DB_FILE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "ps-smoke3-")),
  "smoke.sqlite"
);

const { migrate, db } = await import("../src/db/db.ts");
const { seed } = await import("../src/db/seed.ts");
const { createApp } = await import("../src/app.ts");
const sessions = await import("../src/modules/sessions/service.ts");
const payments = await import("../src/modules/payments/service.ts");
const { getMockCheckout } = await import(
  "../src/modules/payments/providers/maya/mock-maya.ts"
);
const { config } = await import("../src/config.ts");

migrate();
seed();
const server = createApp().listen(PORT);
const base = `http://localhost:${PORT}`;

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) failures++;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function getJson(url: string): Promise<any> {
  return (await fetch(base + url)).json();
}
async function completeCheckout(redirectUrl: string, outcome: string): Promise<Response> {
  const id = redirectUrl.split("/").pop();
  return fetch(`${base}/mock-maya/checkout/${id}/complete`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `outcome=${outcome}`,
    redirect: "manual",
  });
}

/* --- A: happy path — checkout → authorize webhook → capture exact amount --- */
const sA = (await post("/sessions", { chargerCode: "CHG-0042", connectorId: 1 })).json;
const coA = await post("/payments/checkout", { sessionId: sA.id, method: "Maya Wallet" });
check("checkout created (201)", coA.status === 201);
check("intent PENDING_AUTH after checkout", coA.json.intent.state === "PENDING_AUTH");
check("hold on intent from session (150000)", coA.json.intent.holdCentavos === 150000);

const pageA = await (await fetch(coA.json.redirectUrl)).text();
check("hosted page shows amount", pageA.includes("1,500.00"));
check("hosted page offers hold (not prepay)", pageA.includes("Authorize"));

const doneA = await completeCheckout(coA.json.redirectUrl, "authorize");
check("completion redirects back to app", doneA.status === 302 &&
  String(doneA.headers.get("location")).includes(`payment_return=${coA.json.intent.id}`));
check("intent AUTHORIZED via webhook",
  (await getJson(`/payments/${coA.json.intent.id}`)).state === "AUTHORIZED");
check("session moved to pending_start",
  (await getJson(`/sessions/${sA.id}`)).state === "pending_start");
check("hosted page now gone (410)", (await fetch(coA.json.redirectUrl)).status === 410);

sessions.transition(sA.id, "charging", { meter_start_wh: 1_204_320, transaction_id: "tx-a" });
sessions.transition(sA.id, "ended", { meter_stop_wh: 1_222_720, billed_wh: 18_400, amount_centavos: 89_240, stop_reason: "Remote" });
check("captureForSession succeeds", payments.captureForSession(sA.id, 89_240));
const intentA = await getJson(`/payments/${coA.json.intent.id}`);
check("intent CAPTURED with exact amount", intentA.state === "CAPTURED" && intentA.capturedCentavos === 89_240);
check("provider captured 892.40 of the 1500 hold",
  getMockCheckout(coA.json.redirectUrl.split("/").pop()!)?.capturedCentavos === 89_240);
const receiptA = (await getJson(`/sessions/${sA.id}`)).receiptNo;
check("mock OR number issued", /^OR-\d{4}-\d{6}$/.test(receiptA ?? ""));
check("double capture is a no-op", !payments.captureForSession(sA.id, 89_240));

/* --- B: fail, expire, then authorize + void (charger-start failure path) --- */
const sB = (await post("/sessions", { chargerCode: "CHG-0042", connectorId: 1 })).json;
const coB1 = await post("/payments/checkout", { sessionId: sB.id, method: "Credit / debit card" });
await completeCheckout(coB1.json.redirectUrl, "fail");
check("failed outcome → AUTH_FAILED",
  (await getJson(`/payments/${coB1.json.intent.id}`)).state === "AUTH_FAILED");
check("session still payable after failure",
  (await getJson(`/sessions/${sB.id}`)).state === "pending_payment");

const coB2 = await post("/payments/checkout", { sessionId: sB.id, method: "Maya Wallet" });
await completeCheckout(coB2.json.redirectUrl, "expire");
check("expired outcome → EXPIRED",
  (await getJson(`/payments/${coB2.json.intent.id}`)).state === "EXPIRED");

const coB3 = await post("/payments/checkout", { sessionId: sB.id, method: "Maya Wallet" });
await completeCheckout(coB3.json.redirectUrl, "authorize");
check("retry after failures authorizes",
  (await getJson(`/payments/${coB3.json.intent.id}`)).state === "AUTHORIZED");
check("voidForSession releases the hold", payments.voidForSession(sB.id));
check("intent VOIDED", (await getJson(`/payments/${coB3.json.intent.id}`)).state === "VOIDED");
sessions.transition(sB.id, "start_failed");
check("checkout on non-payable session → 409",
  (await post("/payments/checkout", { sessionId: sB.id, method: "Maya Wallet" })).status === 409);

/* --- C: QR Ph prepay fallback — pay now, refund unused --- */
const sC = (await post("/sessions", { chargerCode: "CHG-0042", connectorId: 1 })).json;
const coC = await post("/payments/checkout", { sessionId: sC.id, method: "QR Ph" });
check("QR Ph flagged prepay", coC.json.intent.prepay === true);
const pageC = await (await fetch(coC.json.redirectUrl)).text();
check("prepay page says Pay (not hold)", pageC.includes("Pay ₱1,500.00"));
await completeCheckout(coC.json.redirectUrl, "authorize");
sessions.transition(sC.id, "charging", { transaction_id: "tx-c", meter_start_wh: 0 });
sessions.transition(sC.id, "ended", { meter_stop_wh: 10_309, billed_wh: 10_309, amount_centavos: 50_000, stop_reason: "Remote" });
payments.captureForSession(sC.id, 50_000);
const checkoutC = getMockCheckout(coC.json.redirectUrl.split("/").pop()!)!;
check("prepay captured 500.00", checkoutC.capturedCentavos === 50_000);
check("prepay unused 1000.00 refunded", checkoutC.refundedCentavos === 100_000);

/* --- webhook security & idempotency --- */
const evtBody = JSON.stringify({ event_id: "evt_replay_test", type: "payment.noop", intent_id: "none", checkout_id: "none" });
const goodSig = createHmac("sha256", config.mayaWebhookSecret).update(evtBody).digest("hex");
const bad = await fetch(`${base}/webhooks/maya`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-maya-signature": "deadbeef" },
  body: evtBody,
});
check("bad signature rejected (401)", bad.status === 401);
const first = await (await fetch(`${base}/webhooks/maya`, {
  method: "POST", headers: { "content-type": "application/json", "x-maya-signature": goodSig }, body: evtBody,
})).json();
const second = await (await fetch(`${base}/webhooks/maya`, {
  method: "POST", headers: { "content-type": "application/json", "x-maya-signature": goodSig }, body: evtBody,
})).json();
check("first delivery accepted", first.ok === true && !first.duplicate);
check("replay flagged duplicate", second.duplicate === true);
const stored = (db.prepare("SELECT COUNT(*) AS n FROM provider_events WHERE event_id = 'evt_replay_test'").get() as { n: number }).n;
check("replayed event stored exactly once", stored === 1);
const total = (db.prepare("SELECT COUNT(*) AS n FROM provider_events").get() as { n: number }).n;
check("all webhook deliveries audited", total >= 6);

server.close();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
