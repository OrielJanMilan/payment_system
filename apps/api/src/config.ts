import path from "node:path";

const here = import.meta.dirname;

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /* SQLite for the mock milestone; swaps for Postgres at the pilot phase. */
  dbFile: process.env.DB_FILE ?? path.join(here, "..", "data", "dev.sqlite"),
  webRoot: path.join(here, "..", "..", "web"),
  migrationsDir: path.join(here, "db", "migrations"),
};
