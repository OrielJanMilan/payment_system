import path from "node:path";

const here = import.meta.dirname;

const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
  /* Public origin of this app — used for provider return URLs and the
     mock provider's webhook target. Set BASE_URL when tunneled (Phase 6). */
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  /* Shared secret for mock Maya webhook HMAC signatures (dev-only value). */
  mayaWebhookSecret: process.env.MAYA_WEBHOOK_SECRET ?? "mock-maya-dev-secret",
  /* SQLite for the mock milestone; swaps for Postgres at the pilot phase. */
  dbFile: process.env.DB_FILE ?? path.join(here, "..", "data", "dev.sqlite"),
  webRoot: path.join(here, "..", "..", "web"),
  migrationsDir: path.join(here, "db", "migrations"),
  /* pending_payment TTL (SCREEN_FUNCTIONALITY.md S3: 10 min). Env-overridable for tests. */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 10 * 60 * 1000),
};
