import { Router } from "express";
import { createCheckout, getIntent } from "./service.ts";

export const paymentsRouter = Router();

/* "Authorize hold" / "Hold & start": returns the hosted-checkout redirect.
   The client full-page-redirects to redirectUrl, then polls GET /payments/{id}
   on return until the webhook lands. */
paymentsRouter.post("/payments/checkout", (req, res) => {
  const { sessionId, method } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof method !== "string") {
    res.status(400).json({ error: "sessionId (string) and method (string) required" });
    return;
  }
  const result = createCheckout(sessionId, method);
  if (!result.ok) {
    res.status(result.error === "session_not_found" ? 404 : 409).json({ error: result.error });
    return;
  }
  res.status(201).json({ intent: result.intent, redirectUrl: result.redirectUrl });
});

/* Poll target while waiting for the provider webhook after checkout return. */
paymentsRouter.get("/payments/:id", (req, res) => {
  const intent = getIntent(req.params.id);
  if (!intent) {
    res.status(404).json({ error: "intent_not_found" });
    return;
  }
  res.json(intent);
});
