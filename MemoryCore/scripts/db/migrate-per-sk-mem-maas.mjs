#!/usr/bin/env node
/**
 * per-sk-mem MaaS API Key — SQLite 迁移（Node 22+ 内置 sqlite）
 *
 * 用法:
 *   node scripts/db/migrate-per-sk-mem-maas.mjs /data/tdai-memory/tdai_metadata_default/metadata.db
 *   node scripts/db/migrate-per-sk-mem-maas.mjs --scan-dir /data/tdai-memory
 *   node scripts/db/migrate-per-sk-mem-maas.mjs --verify-only --scan-dir /data/tdai-memory
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const MIGRATION_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta_user_key_maas_credentials (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  maas_api_key_ciphertext TEXT NOT NULL,
  key_hint TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES meta_user_keys(key_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES meta_users(user_id) ON DELETE CASCADE
);
`;

const TABLE_NAME = "meta_user_key_maas_credentials";

function usage() {
  console.error(`用法:
  node migrate-per-sk-mem-maas.mjs <metadata.db> [...]
  node migrate-per-sk-mem-maas.mjs --scan-dir <baseDir>
  node migrate-per-sk-mem-maas.mjs --verify-only [--scan-dir <baseDir> | <db> ...]

示例:
  node migrate-per-sk-mem-maas.mjs --scan-dir /data/tdai-memory
`);
  process.exit(1);
}

function findMetadataDbs(baseDir) {
  const results = [];
  if (!existsSync(baseDir)) return results;

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name === "metadata.db") {
        results.push(full);
      }
    }
  }

  walk(baseDir);
  return results.sort();
}

function tableExists(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
      )
      .get(TABLE_NAME);
    return !!row;
  } finally {
    db.close();
  }
}

function migrateDb(dbPath, { verifyOnly }) {
  if (!existsSync(dbPath)) {
    throw new Error(`文件不存在: ${dbPath}`);
  }

  if (verifyOnly) {
    const ok = tableExists(dbPath);
    return { dbPath, action: ok ? "verified" : "missing", ok };
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(MIGRATION_SQL);
    const ok = tableExists(dbPath);
    if (!ok) {
      throw new Error(`迁移后仍未找到表 ${TABLE_NAME}`);
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM ${TABLE_NAME}`)
      .get();
    return { dbPath, action: "migrated", ok: true, rowCount: Number(count?.c ?? 0) };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const verifyOnly = argv.includes("--verify-only");
  const scanIdx = argv.indexOf("--scan-dir");
  let scanDir;
  if (scanIdx >= 0) {
    scanDir = argv[scanIdx + 1];
    if (!scanDir) usage();
  }
  const files = argv.filter(
    (a) => !a.startsWith("--") && a !== scanDir,
  );
  return { verifyOnly, scanDir, files };
}

function main() {
  const { verifyOnly, scanDir, files } = parseArgs(process.argv.slice(2));
  const dbPaths = [...files];
  if (scanDir) {
    dbPaths.push(...findMetadataDbs(scanDir));
  }
  if (dbPaths.length === 0) {
    if (scanDir) {
      console.error(`[warn] 在 ${scanDir} 下未找到 metadata.db`);
      process.exit(verifyOnly ? 0 : 1);
    }
    usage();
  }

  let failed = 0;
  for (const dbPath of dbPaths) {
    try {
      const result = migrateDb(dbPath, { verifyOnly });
      const tag = result.ok ? "[ok]" : "[missing]";
      const extra =
        result.action === "migrated"
          ? ` rows=${result.rowCount}`
          : "";
      console.log(`${tag} ${result.action} ${dbPath}${extra}`);
      if (!result.ok) failed = 1;
    } catch (err) {
      failed = 1;
      console.error(`[error] ${dbPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  process.exit(failed);
}

main();
