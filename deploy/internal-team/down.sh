#!/usr/bin/env bash
# 停止容器，默认保留 named volume（记忆 / 会话 / 面板数据都在）。
# 只有加 --purge 才会删 volume（不可恢复，除非先 backup）。
set -euo pipefail
cd "$(dirname "$0")"
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  COMPOSE=(docker-compose)
fi
if [[ "${1:-}" == "--purge" ]]; then
  echo "[warn] 将删除 tdai-core-data / tdai-hub-data / tdai-redis-data"
  "${COMPOSE[@]}" --env-file .env down -v
else
  "${COMPOSE[@]}" --env-file .env down
  echo "[ok] 容器已停，volume 仍在。再 ./up.sh 会接着用。"
fi
