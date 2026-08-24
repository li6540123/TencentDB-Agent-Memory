-- ============================================================
-- per-sk-mem MaaS API Key — SQLite 增量迁移
-- 新增表：meta_user_key_maas_credentials（每把 sk-mem 绑定一把加密 MaaS Key）
--
-- 幂等：CREATE TABLE IF NOT EXISTS，可重复执行。
--
-- 用法（单库）:
--   sqlite3 /path/to/metadata.db < scripts/db/migrate-per-sk-mem-maas-sqlite.sql
--
-- 说明：
--   - 升级 MemoryCore 后，createSchema() 启动时也会自动建表；
--     本脚本供「升级前手动检查」或「无 Core 进程时离线迁移」。
--   - 须配置 TDAI_MAAS_KEY_SECRET（≥32 字节）后才能在 Hub 写入 MaaS Key。
-- ============================================================

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

-- 验证（sqlite3 交互模式可手动执行）:
-- SELECT name FROM sqlite_master WHERE type='table' AND name='meta_user_key_maas_credentials';
