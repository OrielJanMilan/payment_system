import { Router } from "express";
import { createSession, getSession } from "./service.ts";
import { subscribe } from "./events.ts";

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
  const heartbeat = setInterval(() => res.write(":hb\n\n"), 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
