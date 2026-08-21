import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import { db, nowIso } from "../../db/db.ts";
import { config } from "../../config.ts";
import { applyProviderEvent } from "../payments/service.ts";

export const webhooksRouter = Router();

/* Provider webhook ingestion (BACKEND.md §6): verify signature → persist the
   raw payload → apply an idempotent state transition. The unique event_id
   makes redelivery a recorded no-op; we always 200 duplicates so the
   provider stops retrying. */
webhooksRouter.post("/webhooks/maya", (req, res) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.get("x-maya-signature");
  if (!raw || !signature || !signatureValid(raw, signature)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }

  const payload = req.body as { event_id?: string; type?: string; intent_id?: string };
  if (!payload?.event_id || !payload.type) {
    res.status(400).json({ error: "malformed_event" });
    return;
  }

  try {
    db.prepare(
      `INSERT INTO provider_events (provider, event_id, payload, signature, received_at)
       VALUES ('mock-maya', ?, ?, ?, ?)`
    ).run(payload.event_id, raw.toString("utf8"), signature, nowIso());
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    throw err;
  }

  const processed = applyProviderEvent(payload as { type: string; intent_id: string; checkout_id: string });
  db.prepare("UPDATE provider_events SET processed_at = ? WHERE event_id = ?").run(
    nowIso(),
    payload.event_id
  );
  res.json({ ok: true, processed });
});

function signatureValid(raw: Buffer, signature: string): boolean {
  const expected = createHmac("sha256", config.mayaWebhookSecret).update(raw).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
