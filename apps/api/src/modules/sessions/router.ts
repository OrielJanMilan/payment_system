import { Router } from "express";
import { completedSessions, createSession, getSession } from "./service.ts";
import { subscribe } from "./events.ts";
import { requestStop } from "../chargers/gateway.ts";

export const sessionsRouter = Router();

/* S2/C2 "Continue to payment" / "Hold & start": creates the session in
   pending_payment with the tariff pinned and the hold computed server-side.
   (The payment intent is created by POST /payments/checkout — Phase 3.) */
sessionsRouter.post("/sessions", (req, res) => {
  const { chargerCode, connectorId } = req.body ?? {};
  if (typeof chargerCode !== "string" || typeof connectorId !== "number") {
    res.status(400).json({ error: "chargerCode (string) and connectorId (number) required" });
    return;
  }
  const result = createSession(chargerCode, connectorId);
  if (!result.ok) {
    const status = result.error === "connector_unavailable" ? 409 : 404;
    res.status(status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.session);
});

/* S6 history — dev-stub identity for the mock milestone (no OTP). */
sessionsRouter.get("/me/sessions", (_req, res) => {
  res.json(completedSessions());
});

/* S4 "Stop charging" (confirmation sheet) → RemoteStopTransaction. The stop
   is asynchronous: the client stays on Live and lands on the receipt when the
   session_ended event flows through SSE. */
sessionsRouter.post("/sessions/:id/stop", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  if (requestStop(session.id) !== "ok") {
    res.status(409).json({ error: "session_not_charging" });
    return;
  }
  res.status(202).json({ ok: true });
});

sessionsRouter.get("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json(session);
});

/* Live screen stream. Emits the current state immediately (so a reconnecting
   client resyncs), then every published event; comment heartbeats keep
   proxies from idling the connection out. */
sessionsRouter.get("/sessions/:id/events", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`data: ${JSON.stringify({ type: "state", state: session.state, session })}\n\n`);

  const unsubscribe = subscribe(session.id, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  /* A data event, not a comment — the client uses it to detect staleness. */
  const heartbeat = setInterval(() => res.write(`data: {"type":"hb"}\n\n`), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
