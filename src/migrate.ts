import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type pg from "pg";
import { config } from "./config.js";
import { createPool, withTransaction } from "./db.js";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");

    const didApply = await withTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(727274)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [file]);
      if (done.rowCount) return false;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      return true;
    });
    if (didApply) applied.push(file);
  }
  return applied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = createPool(config.databaseUrl, 1);
  migrate(pool)
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date"))
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(() => pool.end());
}
