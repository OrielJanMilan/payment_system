import { Router } from "express";
import { completedSessions, createSession, getSession } from "./service.ts";
import { subscribe } from "./events.ts";
import { latestSample, requestStop } from "../chargers/gateway.ts";
import { db, nowIso } from "../../db/db.ts";

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

/* Receipt acknowledgment ("Done" on the receipt): stops this session from
   being re-surfaced by the server-side resume after a QR scan. */
sessionsRouter.post("/sessions/:id/ack", (req, res) => {
  const result = db
    .prepare("UPDATE sessions SET acked_at = ? WHERE id = ? AND state = 'ended'")
    .run(nowIso(), req.params.id);
  res.json({ ok: result.changes > 0 });
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

/* Polling fallback for the Live screen: current session + latest meter
   sample in one response. Used when the SSE stream is buffered or dropped
   (tunnels and proxies routinely do this). */
sessionsRouter.get("/sessions/:id/live", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return;
  }
  res.json({ session, sample: latestSample(session.id) });
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
  /* 2 KB comment preamble defeats proxies that buffer the first chunk of a
     streaming response before forwarding anything (tunnels do this). */
  res.write(":" + " ".repeat(2048) + "\n\n");
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
