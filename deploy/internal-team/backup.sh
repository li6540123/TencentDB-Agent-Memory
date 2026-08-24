#!/usr/bin/env bash
# 备份三个 named volume + .admin-key + 当时的 .env（密码打码不处理，请限制目录权限）。
set -euo pipefail
cd "$(dirname "$0")"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="backups/${STAMP}"
mkdir -p "$OUT"

echo "[info] 停止写入后打包（短暂中断服务）"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
"${COMPOSE[@]}" --env-file .env stop

copy_vol() {
  local vol="$1" name="$2"
  docker run --rm \
    -v "${vol}:/data:ro" \
    -v "$PWD/$OUT:/backup" \
    alpine:3.20 tar czf "/backup/${name}.tgz" -C /data .
  echo "[ok] $name"
}

copy_vol tdai-core-data core-data
copy_vol tdai-hub-data hub-data
copy_vol tdai-redis-data redis-data

[[ -f .admin-key ]] && cp .admin-key "$OUT/admin-key"
[[ -f .env ]] && cp .env "$OUT/env"

"${COMPOSE[@]}" --env-file .env start
echo "[ok] 备份目录 $OUT"
echo "     含 core-data.tgz hub-data.tgz redis-data.tgz ；.admin-key 必须和 core-data 成对恢复"
