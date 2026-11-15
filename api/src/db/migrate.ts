import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { createPool, type Db } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../../../db/migrations");

/** Split a SQL file into batches on lines that contain only GO. */
export function splitBatches(text: string): string[] {
  return text
    .split(/^\s*GO\s*;?\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.replace(/--.*$/gm, "").trim().length > 0);
}

export function checksum(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

async function ensureTable(db: Db) {
  await db.request().query(`
    IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
      CREATE TABLE dbo.schema_migrations (
        name       NVARCHAR(200) NOT NULL PRIMARY KEY,
        checksum   CHAR(64)      NOT NULL,
        applied_at DATETIME2(3)  NOT NULL DEFAULT SYSUTCDATETIME()
      );`);
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR, log = console.log) {
  await ensureTable(db);
  const applied = new Map<string, string>(
    (await db.request().query("SELECT name, checksum FROM dbo.schema_migrations")).recordset.map(
      (r: { name: string; checksum: string }) => [r.name, r.checksum],
    ),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    const sum = checksum(text);
    const prev = applied.get(file);
    if (prev) {
      if (prev !== sum) throw new Error(`Migration ${file} was changed after it was applied`);
      continue;
    }
    const tx = new sql.Transaction(db);
    await tx.begin();
    try {
      for (const batch of splitBatches(text)) await new sql.Request(tx).batch(batch);
      await new sql.Request(tx)
        .input("name", sql.NVarChar(200), file)
        .input("sum", sql.Char(64), sum)
        .query("INSERT INTO dbo.schema_migrations (name, checksum) VALUES (@name, @sum)");
      await tx.commit();
      log(`applied ${file}`);
      count++;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
  if (!count) log("database is up to date");
  return count;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = await createPool(loadConfig());
  try {
    await migrate(db);
  } finally {
    await db.close();
  }
}
