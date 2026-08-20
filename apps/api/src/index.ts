import express from "express";
import { config } from "./config.ts";
import { db, migrate } from "./db/db.ts";
import { seed } from "./db/seed.ts";

migrate();
seed();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const row = db.prepare("SELECT COUNT(*) AS n FROM chargers").get() as { n: number };
  res.json({ ok: true, chargers: row.n });
});

/* The driver PWA — served from the same origin as the API so the phone
   needs exactly one URL and no CORS is involved. */
app.use(express.static(config.webRoot));

app.listen(config.port, () => {
  console.log(`api + web on http://localhost:${config.port}`);
});
