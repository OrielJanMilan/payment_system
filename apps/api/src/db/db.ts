import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/* Migration runner: numbered .sql files applied in order, tracked via
   PRAGMA user_version. Each migration runs in one transaction. */
export function migrate(): void {
  const applied = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  const files = fs
    .readdirSync(config.migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (version <= applied) continue;
    const sql = fs.readFileSync(path.join(config.migrationsDir, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
      console.log(`migrated: ${file}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
