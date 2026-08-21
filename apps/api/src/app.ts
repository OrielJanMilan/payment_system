import express, { type Request } from "express";
import { config } from "./config.ts";
import { chargersRouter } from "./modules/chargers/router.ts";
import { sessionsRouter } from "./modules/sessions/router.ts";
import { paymentsRouter } from "./modules/payments/router.ts";
import { webhooksRouter } from "./modules/webhooks/router.ts";
import { registerProvider } from "./modules/payments/providers/provider.ts";
import { mockMaya } from "./modules/payments/providers/maya/mock-maya.ts";
import { mockMayaRouter } from "./modules/payments/providers/maya/mock-maya-router.ts";
import { initChargerGateway } from "./modules/chargers/gateway.ts";
import { mockCpRouter } from "./modules/chargers/mock-cp-router.ts";
import { db } from "./db/db.ts";

export function createApp(): express.Express {
  registerProvider(mockMaya);
  initChargerGateway();

  const app = express();
  /* Keep the raw body around: webhook signatures are computed over exact bytes. */
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: false })); // mock hosted-checkout form posts

  app.get("/health", (_req, res) => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM chargers").get() as { n: number };
    res.json({ ok: true, chargers: row.n });
  });

  app.use(chargersRouter);
  app.use(sessionsRouter);
  app.use(paymentsRouter);
  app.use(webhooksRouter);
  app.use(mockMayaRouter);
  app.use(mockCpRouter);

  /* The driver PWA — same origin as the API: one URL for the phone, no CORS. */
  app.use(express.static(config.webRoot));

  return app;
}
