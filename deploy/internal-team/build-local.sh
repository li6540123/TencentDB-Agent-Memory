#!/usr/bin/env bash
# 在本机构建 Core / Proxy / Hub 镜像（含当前工作区源码），供 ./up.sh 使用。
#
# 用法（在 deploy/internal-team/ 下）：
#   ./build-local.sh
#   TAG=my-feature PLATFORM=linux/arm64 ./build-local.sh
#   BUILD_PROXY_PORT=7897 ./build-local.sh   # 翻墙端口（默认 7897，也可写进 .env）
#
# 一键构建并启动：./up-local.sh
#
# 前置：Colima / Docker。无 buildx 时自动用各服务的 Dockerfile.local。

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

# shellcheck disable=SC1091
source "$ROOT/deploy/internal-team/proxy-env.sh"
resolve_build_proxy "$(pwd)"
apply_host_proxy

TAG="${TAG:-maas-dev}"
PLATFORM="${PLATFORM:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$(uname -m)" in
    arm64|aarch64) PLATFORM="linux/arm64" ;;
    *) PLATFORM="linux/amd64" ;;
  esac
fi

CORE_IMAGE="tdai-local/memory-core:${TAG}"
PROXY_IMAGE="tdai-local/memory-proxy:${TAG}"
HUB_IMAGE="tdai-local/memory-hub:${TAG}"

docker_build_proxy_argv

if ! command -v docker >/dev/null 2>&1; then
  echo "[error] 需要 docker" >&2
  exit 1
fi

ensure_buildx() {
  if docker buildx version >/dev/null 2>&1; then
    return 0
  fi
  echo "[build-local] 未检测到 buildx，尝试经代理 ${HOST_HTTP_PROXY} 安装 ..."
  mkdir -p "${HOME}/.docker/cli-plugins"
  local arch url
  case "$(uname -m)" in
    arm64|aarch64) arch=darwin-arm64 ;;
    x86_64) arch=darwin-amd64 ;;
    *) echo "[warn] 未知架构，跳过 buildx 自动安装" >&2; return 1 ;;
  esac
  url="https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.${arch}"
  if curl -fL --proxy "$HOST_HTTP_PROXY" "$url" -o "${HOME}/.docker/cli-plugins/docker-buildx"; then
    chmod +x "${HOME}/.docker/cli-plugins/docker-buildx"
    docker buildx version
  else
    echo "[warn] buildx 下载失败，将使用 Dockerfile.local" >&2
    return 1
  fi
}

pick_dockerfile() {
  local dir="$1"
  if docker buildx version >/dev/null 2>&1; then
    export DOCKER_BUILDKIT=1
    echo "Dockerfile"
  elif [[ -f "$dir/Dockerfile.local" ]]; then
    export DOCKER_BUILDKIT=0
    echo "[warn] 未检测到 docker buildx，${dir##*/} 使用 Dockerfile.local" >&2
    echo "Dockerfile.local"
  else
    echo "[error] 需要 docker buildx 或 $dir/Dockerfile.local" >&2
    exit 1
  fi
}

echo "[build-local] platform=$PLATFORM tag=$TAG"
echo "[build-local] 宿主机代理=$HOST_HTTP_PROXY  docker build 代理=$DOCKER_HTTP_PROXY"
echo "[build-local] repo=$ROOT"
ensure_buildx || true
echo

CORE_DF=$(pick_dockerfile "$ROOT/MemoryCore")
echo "==> MemoryCore ($CORE_DF) → $CORE_IMAGE"
docker build --platform "$PLATFORM" "${DOCKER_BUILD_PROXY_ARGV[@]}" \
  -f "$ROOT/MemoryCore/$CORE_DF" -t "$CORE_IMAGE" "$ROOT/MemoryCore"
echo

PROXY_DF=$(pick_dockerfile "$ROOT/MemoryProxy")
echo "==> MemoryProxy ($PROXY_DF) → $PROXY_IMAGE"
docker build --platform "$PLATFORM" "${DOCKER_BUILD_PROXY_ARGV[@]}" \
  -f "$ROOT/MemoryProxy/$PROXY_DF" -t "$PROXY_IMAGE" "$ROOT/MemoryProxy"
echo

echo "==> Memory Hub (Panel+Knowledge) → $HUB_IMAGE"
export DOCKER_BUILDKIT=0
export BUILD_PROXY_PORT HOST_HTTP_PROXY DOCKER_HTTP_PROXY DOCKER_HTTPS_PROXY
IMAGE_NAME=tdai-local/memory-hub IMAGE_TAG="$TAG" PLATFORM="$PLATFORM" \
  "$ROOT/deploy/panel-knowledge-combined/build.sh"
echo

echo "[ok] 本地镜像已就绪："
echo "  MEMORY_CORE_IMAGE=$CORE_IMAGE"
echo "  MEMORY_HUB_IMAGE=$HUB_IMAGE"
echo "  PROXY_IMAGE=$PROXY_IMAGE"
echo
echo "下一步：./up-local.sh  或手动改 .env 后 ./up.sh"
