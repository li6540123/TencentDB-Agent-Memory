#!/usr/bin/env bash
# 导出三件套 linux/amd64 镜像为 gzip 包（给内网 Linux 服务器 docker load）
#
# 用法（在 deploy/internal-team/ 下）:
#   ./export-images.sh
#   TAG=20688f9-amd64 ./export-images.sh
#   OUT=/tmp ./export-images.sh

set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TAG="${TAG:-20688f9-amd64}"
OUT="${OUT:-$PWD/dist}"
mkdir -p "$OUT"

CORE="${MEMORY_CORE_IMAGE:-tdai-local/memory-core:${TAG}}"
PROXY="${PROXY_IMAGE:-tdai-local/memory-proxy:${TAG}}"
HUB="${MEMORY_HUB_IMAGE:-tdai-local/memory-hub:${TAG}}"
ARCHIVE="$OUT/tdai-images-${TAG}.tgz"

for img in "$CORE" "$PROXY" "$HUB"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "[error] 本地没有镜像: $img" >&2
    echo "        先: PLATFORM=linux/amd64 TAG=${TAG} ./build-local.sh" >&2
    exit 1
  fi
  arch=$(docker image inspect "$img" --format '{{.Architecture}}')
  echo "[check] $img → $arch"
  if [[ "$arch" != "amd64" ]]; then
    echo "[error] $img 不是 amd64，Linux x86 服务器无法使用" >&2
    echo "        请: PLATFORM=linux/amd64 TAG=${TAG} ./build-local.sh" >&2
    exit 1
  fi
done

echo "[export] → $ARCHIVE"
docker save "$CORE" "$PROXY" "$HUB" | gzip -1 > "$ARCHIVE"
ls -lh "$ARCHIVE"

cat > "$OUT/MANIFEST-${TAG}.txt" <<EOF
packed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
platform=linux/amd64
tag=${TAG}
images:
  - ${CORE}
  - ${PROXY}
  - ${HUB}
load:
  gzip -dc $(basename "$ARCHIVE") | docker load
upgrade_doc: deploy/upgrades/2026-08-24-per-sk-mem-and-http-git/UPGRADE.md
release_doc: deploy/internal-team/RELEASE.md
EOF

echo "[ok] 一并带上 RELEASE.md 与 deploy/upgrades/.../UPGRADE.md 给部署同事"
