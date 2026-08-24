#!/usr/bin/env bash
# per-sk-mem MaaS API Key — 部署初始化 / 存量库迁移
#
# 做什么：
#   1. 检查 .env 中 TDAI_MAAS_KEY_SECRET 已配置（加密主密钥）
#   2. 在 Core 数据卷内所有 metadata.db 上执行 SQLite 迁移（幂等）
#   3. 可选验证表已存在
#
# 用法（在 deploy/internal-team/ 下）:
#   ./init-per-sk-mem-maas.sh
#   ./init-per-sk-mem-maas.sh --verify-only
#   SQLITE_DB=/path/to/metadata.db ./init-per-sk-mem-maas.sh
#
# 注意：
#   - 新装：升级后的 Core 启动时 createSchema() 也会自动建表；本脚本用于升级前/后显式确认。
#   - MongoDB 部署：用 MemoryCore/scripts/db/migrate-per-sk-mem-maas-mongo.js
#   - 表建好后，在 Hub「API Keys」页为每把 sk-mem 配置 MaaS API Key。

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
MIGRATE_JS="$ROOT/MemoryCore/scripts/db/migrate-per-sk-mem-maas.mjs"
SQL_FILE="$ROOT/MemoryCore/scripts/db/migrate-per-sk-mem-maas-sqlite.sql"

VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --verify-only) VERIFY_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

if [[ ! -f .env ]]; then
  echo "[error] 没有 .env。先: cp .env.example .env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

check_secret() {
  if [[ -z "${TDAI_MAAS_KEY_SECRET:-}" ]]; then
    echo "[error] TDAI_MAAS_KEY_SECRET 未设置。Hub 无法加密存储 MaaS Key。" >&2
    echo "        生成示例: openssl rand -base64 32" >&2
    exit 1
  fi
  if [[ "$TDAI_MAAS_KEY_SECRET" == replace-with-32plus* ]]; then
    echo "[error] TDAI_MAAS_KEY_SECRET 仍为占位符，请改成随机串（≥32 字节）。" >&2
    exit 1
  fi
  if [[ ${#TDAI_MAAS_KEY_SECRET} -lt 32 ]]; then
    echo "[warn] TDAI_MAAS_KEY_SECRET 长度 < 32，建议使用 openssl rand -base64 32" >&2
  fi
}

run_node_migrate() {
  local data_dir="$1"
  local extra=()
  [[ "$VERIFY_ONLY" == 1 ]] && extra+=(--verify-only)
  node "$MIGRATE_JS" "${extra[@]}" --scan-dir "$data_dir"
}

run_sqlite_cli() {
  local db="$1"
  if ! command -v sqlite3 >/dev/null 2>&1; then
    return 1
  fi
  sqlite3 "$db" < "$SQL_FILE"
  sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name='meta_user_key_maas_credentials';"
}

migrate_one_db() {
  local db="$1"
  echo "[init] SQLite: $db"
  if [[ "$VERIFY_ONLY" == 1 ]]; then
    node "$MIGRATE_JS" --verify-only "$db"
    return
  fi
  if run_sqlite_cli "$db" 2>/dev/null; then
    echo "[ok] migrated via sqlite3 CLI"
    return
  fi
  node "$MIGRATE_JS" "$db"
}

# ── 单文件模式（宿主机路径）────────────────────────────────────────
if [[ -n "${SQLITE_DB:-}" ]]; then
  check_secret
  migrate_one_db "$SQLITE_DB"
  echo
  echo "[done] 下一步：重启 Core（若未重启）→ Hub API Keys 页配置 MaaS Key"
  exit 0
fi

# ── Docker Compose 数据卷模式 ─────────────────────────────────────
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-tdai-internal}"
CORE_VOLUME="${CORE_VOLUME:-${COMPOSE_PROJECT}_core-data}"
CORE_DATA_DIR="${CORE_DATA_DIR:-/data/tdai-memory}"

check_secret

if docker volume inspect "$CORE_VOLUME" >/dev/null 2>&1; then
  echo "[init] 发现 Docker volume: $CORE_VOLUME"
  extra=()
  [[ "$VERIFY_ONLY" == 1 ]] && extra+=(--verify-only)
  docker run --rm \
    -v "${CORE_VOLUME}:${CORE_DATA_DIR}" \
    -v "${MIGRATE_JS}:/migrate.mjs:ro" \
    node:22-slim \
    node /migrate.mjs "${extra[@]}" --scan-dir "$CORE_DATA_DIR"
elif [[ -d "${CORE_DATA_HOST_DIR:-}" ]]; then
  echo "[init] 使用宿主机目录: $CORE_DATA_HOST_DIR"
  run_node_migrate "$CORE_DATA_HOST_DIR"
else
  echo "[warn] 未找到 volume ${CORE_VOLUME}，也未设置 SQLITE_DB / CORE_DATA_HOST_DIR" >&2
  echo "       可手动执行:" >&2
  echo "         node $MIGRATE_JS --scan-dir <tdai-memory目录>" >&2
  echo "         或: sqlite3 <metadata.db> < $SQL_FILE" >&2
  exit 1
fi

echo
echo "[done]  schema 就绪。后续步骤："
echo "  1. 确保 Core 镜像已含 per-sk-mem 功能并重启: docker compose restart memory-core"
echo "  2. Hub → API Keys → 每行「MaaS API Key」列添加/修改"
echo "  3. 客户端仍用 sk-mem-… 调 Proxy；有绑定则走该 MaaS Key"
echo "  4. MongoDB 部署请另执行: mongosh ... migrate-per-sk-mem-maas-mongo.js"
