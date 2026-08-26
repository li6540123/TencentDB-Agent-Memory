#!/usr/bin/env bash
# 构建本地镜像 + 更新 .env 镜像 tag + 启动 compose。
set -euo pipefail
cd "$(dirname "$0")"

TAG="${TAG:-20688f9-amd64}"
PLATFORM="${PLATFORM:-linux/amd64}"
export TAG PLATFORM

if [[ ! -f .env ]]; then
  echo "[error] 没有 .env。先: cp .env.example .env 并填入 LLM/Redis 等真值。" >&2
  exit 1
fi

chmod +x ./build-local.sh

echo "[up-local] 构建镜像 tag=$TAG platform=$PLATFORM ..."
./build-local.sh

CORE="tdai-local/memory-core:${TAG}"
HUB="tdai-local/memory-hub:${TAG}"
PROXY="tdai-local/memory-proxy:${TAG}"

# 更新 .env 镜像行（不碰其它配置）
for pair in "MEMORY_CORE_IMAGE=$CORE" "MEMORY_HUB_IMAGE=$HUB" "PROXY_IMAGE=$PROXY"; do
  key="${pair%%=*}"
  val="${pair#*=}"
  if grep -q "^${key}=" .env; then
    sed -i '' "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
done

if ! grep -q '^TDAI_MAAS_KEY_SECRET=.' .env || grep -q 'replace-with-32plus' .env; then
  secret=$(openssl rand -base64 32 | tr -d '\n')
  if grep -q '^TDAI_MAAS_KEY_SECRET=' .env; then
    sed -i '' "s|^TDAI_MAAS_KEY_SECRET=.*|TDAI_MAAS_KEY_SECRET=${secret}|" .env
  else
    echo "TDAI_MAAS_KEY_SECRET=${secret}" >> .env
  fi
  echo "[up-local] 已生成 TDAI_MAAS_KEY_SECRET（写入 .env，勿提交）"
fi

echo "[up-local] 启动 compose ..."
./up.sh
