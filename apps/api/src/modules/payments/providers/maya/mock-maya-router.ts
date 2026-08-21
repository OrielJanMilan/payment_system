import { Router } from "express";
import { fireWebhook, getMockCheckout } from "./mock-maya.ts";

/* The mock "hosted checkout" the driver is redirected to — stands in for
   Maya's payment page. Dev-only routes; never mounted in production. */
export const mockMayaRouter = Router();

function peso(centavos: number): string {
  return "₱" + (centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}

mockMayaRouter.get("/mock-maya/checkout/:id", (req, res) => {
  const checkout = getMockCheckout(req.params.id);
  if (!checkout) {
    res.status(404).send("Unknown checkout");
    return;
  }
  if (checkout.status !== "open") {
    res.status(410).send(`Checkout already ${checkout.status}`);
    return;
  }
  const action = checkout.prepay
    ? `Pay ${peso(checkout.amountCentavos)}`
    : `Authorize ${peso(checkout.amountCentavos)} hold`;
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Maya Checkout</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0a9830;margin:0;display:grid;place-items:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;padding:28px;width:min(90vw,380px);box-shadow:0 12px 40px rgba(0,0,0,.25)}
  h1{font-size:16px;margin:0 0 4px;color:#0a9830}
  .badge{font-size:11px;color:#888;letter-spacing:.08em;text-transform:uppercase}
  .amount{font-size:34px;font-weight:700;margin:16px 0 2px}
  .method{color:#555;margin-bottom:20px}
  button{display:block;width:100%;padding:14px;margin-top:10px;border:0;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer}
  .ok{background:#0a9830;color:#fff}.bad{background:#fbe9e7;color:#c62828}.exp{background:#eee;color:#555}
</style></head><body>
<div class="card">
  <h1>maya</h1><div class="badge">Mock checkout — no real payment</div>
  <div class="amount">${peso(checkout.amountCentavos)}</div>
  <div class="method">${checkout.method}${checkout.prepay ? " · pay now, unused amount refunded" : " · hold, pay only what you use"}</div>
  <form method="post" action="/mock-maya/checkout/${checkout.id}/complete">
    <button class="ok"  name="outcome" value="authorize">${action}</button>
    <button class="bad" name="outcome" value="fail">Simulate: payment fails</button>
    <button class="exp" name="outcome" value="expire">Simulate: let checkout expire</button>
  </form>
</div></body></html>`);
});

mockMayaRouter.post("/mock-maya/checkout/:id/complete", async (req, res) => {
  const checkout = getMockCheckout(req.params.id);
  if (!checkout || checkout.status !== "open") {
    res.status(410).send("Checkout not open");
    return;
  }
  const outcome = String((req.body ?? {}).outcome);

  /* Update provider-side state, deliver the signed webhook (awaited so the
     driver's return lands after the intent has moved — the client still
     polls, matching the real async provider), then bounce the browser back. */
  if (outcome === "authorize") {
    checkout.status = "authorized";
    await fireWebhook("payment.authorized", checkout);
    res.redirect(302, checkout.successUrl);
  } else if (outcome === "fail") {
    checkout.status = "failed";
    await fireWebhook("payment.failed", checkout);
    res.redirect(302, checkout.failureUrl);
  } else if (outcome === "expire") {
    checkout.status = "expired";
    await fireWebhook("payment.expired", checkout);
    res.redirect(302, checkout.failureUrl);
  } else {
    res.status(400).send("outcome must be authorize | fail | expire");
  }
});
