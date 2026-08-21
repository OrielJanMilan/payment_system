import { Router } from "express";
import { chargerByCode, chargerBySlug } from "./service.ts";

export const chargersRouter = Router();

/* S1 manual code entry ("Go" button). Codes are printed uppercase; accept any case. */
chargersRouter.get("/chargers/:code", (req, res) => {
  const charger = chargerByCode(req.params.code.toUpperCase());
  if (!charger) {
    res.status(404).json({ error: "charger_not_found" });
    return;
  }
  res.json(charger);
});

/* Charger data for a QR deep link (the client calls this after landing via /c/{slug}). */
chargersRouter.get("/chargers/by-slug/:slug", (req, res) => {
  const charger = chargerBySlug(req.params.slug);
  if (!charger) {
    res.status(404).json({ error: "charger_not_found" });
    return;
  }
  res.json(charger);
});

/* The URL encoded in each charger's QR code. The PWA is a hash-routed static
   app, so this resolves the slug and bounces to the app shell with a query
   the client reads on boot: valid → land on Start for that charger,
   invalid → S1 with the "Charger not found" error state. */
chargersRouter.get("/c/:slug", (req, res) => {
  const charger = chargerBySlug(req.params.slug);
  if (!charger) {
    res.redirect(302, "/?error=charger-not-found");
    return;
  }
  res.redirect(302, `/?c=${encodeURIComponent(charger.qrSlug)}`);
});
