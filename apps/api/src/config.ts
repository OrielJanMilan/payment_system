import path from "node:path";

const here = import.meta.dirname;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /* SQLite for the mock milestone; swaps for Postgres at the pilot phase. */
  dbFile: process.env.DB_FILE ?? path.join(here, "..", "data", "dev.sqlite"),
  webRoot: path.join(here, "..", "..", "web"),
  migrationsDir: path.join(here, "db", "migrations"),
  /* pending_payment TTL (SCREEN_FUNCTIONALITY.md S3: 10 min). Env-overridable for tests. */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 10 * 60 * 1000),
};
