#!/usr/bin/env bash
# 用法: ./restore.sh backups/20260101-120000
# 会覆盖当前三个 volume。先 ./backup.sh。
set -euo pipefail
cd "$(dirname "$0")"
ARG="${1:-}"
if [[ -z "$ARG" ]]; then
  echo "用法: $0 backups/<时间戳目录>" >&2
  exit 1
fi
if [[ "$ARG" == /* ]]; then SRC="$ARG"; else SRC="$PWD/$ARG"; fi
if [[ ! -d "$SRC" ]]; then
  echo "用法: $0 backups/<时间戳目录>" >&2
  exit 1
fi
for f in core-data.tgz hub-data.tgz redis-data.tgz; do
  [[ -f "$SRC/$f" ]] || { echo "[error] 缺少 $SRC/$f" >&2; exit 1; }
done

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi

echo "[warn] 覆盖 tdai-core-data / tdai-hub-data / tdai-redis-data"
"${COMPOSE[@]}" --env-file .env down

restore_vol() {
  local vol="$1" archive="$2"
  docker volume inspect "$vol" >/dev/null 2>&1 || docker volume create "$vol" >/dev/null
  docker run --rm \
    -v "${vol}:/data" \
    -v "${SRC}:/backup:ro" \
    alpine:3.20 sh -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +; tar xzf /backup/${archive} -C /data"
  echo "[ok] 恢复 $vol"
}

restore_vol tdai-core-data core-data.tgz
restore_vol tdai-hub-data hub-data.tgz
restore_vol tdai-redis-data redis-data.tgz

if [[ -f "$SRC/admin-key" ]]; then
  umask 077
  cp "$SRC/admin-key" .admin-key
  echo "[ok] 已写回 .admin-key"
fi

./up.sh
echo "[ok] 已从 $SRC 恢复并启动"
