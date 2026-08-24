#!/usr/bin/env bash
# 在已有镜像的机器上打离线包，拷到不能访问 Docker Hub 的内网测试机。
# core/hub/proxy 会打上日期 tag（默认今天 YYYYMMDD，可用 PACK_TAG=20260821 覆盖）。
#
# 公司 x86 服务器：PACK_PLATFORM=linux/amd64 PACK_TAG=$(date +%Y%m%d)-amd64 ./pack.sh
# 打完后会把本机 :latest 恢复成原来的架构，避免 Mac ARM 环境被换成 amd64。
set -euo pipefail
cd "$(dirname "$0")"

OUT="${PACK_OUT:-$PWD/dist}"
TAG="${PACK_TAG:-$(date +%Y%m%d)}"
PLATFORM="${PACK_PLATFORM:-}"
mkdir -p "$OUT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

CORE_SRC="${MEMORY_CORE_IMAGE:-agentmemory/memory-core:latest}"
HUB_SRC="${MEMORY_HUB_IMAGE:-agentmemory/memory-hub:latest}"
PROXY_SRC="${PROXY_IMAGE:-agentmemory/memory-proxy:latest}"
REDIS="${REDIS_IMAGE:-redis:7-alpine}"
ALPINE="alpine:3.20"

name_only() { echo "${1%:*}"; }
CORE="$(name_only "$CORE_SRC"):${TAG}"
HUB="$(name_only "$HUB_SRC"):${TAG}"
PROXY="$(name_only "$PROXY_SRC"):${TAG}"

need_src=("$CORE_SRC" "$HUB_SRC" "$PROXY_SRC" "$REDIS" "$ALPINE")

snapshot_id() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || echo ""
}

restore_ids=()
restore_names=()
for img in "${need_src[@]}"; do
  id=$(snapshot_id "$img")
  restore_names+=("$img")
  restore_ids+=("$id")
done

if [[ -n "$PLATFORM" ]]; then
  echo "[info] docker pull --platform ${PLATFORM}"
  for img in "${need_src[@]}"; do
    docker pull --platform "$PLATFORM" "$img"
  done
else
  missing=()
  for img in "${need_src[@]}"; do
    if ! docker image inspect "$img" >/dev/null 2>&1; then
      missing+=("$img")
    fi
  done
  if ((${#missing[@]})); then
    echo "[error] 本机没有这些镜像，先在有网环境 docker pull：" >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
  fi
fi

echo "[info] tag → :${TAG}"
docker tag "$CORE_SRC" "$CORE"
docker tag "$HUB_SRC" "$HUB"
docker tag "$PROXY_SRC" "$PROXY"

need_save=("$CORE" "$HUB" "$PROXY" "$REDIS" "$ALPINE")

cat > image-tags.env <<EOF
MEMORY_CORE_IMAGE=${CORE}
MEMORY_HUB_IMAGE=${HUB}
PROXY_IMAGE=${PROXY}
REDIS_IMAGE=${REDIS}
EOF

echo "[info] docker save ${#need_save[@]} 个镜像 → $OUT/tdai-images.tgz"
docker save "${need_save[@]}" | gzip > "$OUT/tdai-images.tgz"

# 把 :latest / redis / alpine 指回 pull 之前的镜像，避免本机 ARM 栈被换成 amd64
for i in "${!restore_names[@]}"; do
  name="${restore_names[$i]}"
  id="${restore_ids[$i]}"
  if [[ -n "$id" ]]; then
    docker tag "$id" "$name"
  fi
done

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"
tar -C "$(dirname "$PWD")" \
  --exclude .env \
  --exclude .admin-key \
  --exclude .user-key \
  --exclude runtime \
  --exclude backups \
  --exclude dist \
  --exclude '*.tgz' \
  -cf - "$(basename "$PWD")" | tar -C "$STAGE" -xf -

python3 - "$STAGE/$(basename "$PWD")" "$CORE" "$HUB" "$PROXY" <<'PY'
import sys
from pathlib import Path
root, core, hub, proxy = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
repl = [
    ("agentmemory/memory-core:latest", core),
    ("agentmemory/memory-hub:latest", hub),
    ("agentmemory/memory-proxy:latest", proxy),
]
for name in (".env.company.example", ".env.example"):
    p = Path(root) / name
    text = p.read_text()
    for a, b in repl:
        text = text.replace(a, b)
    p.write_text(text)
PY

echo "[info] 打包部署目录（不含 .env / key / runtime / backups）"
tar czf "$OUT/tdai-internal-team.tgz" -C "$STAGE" "$(basename "$PWD")"

{
  echo "packed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tag=${TAG}"
  echo "platform=${PLATFORM:-local}"
  echo "images:"
  for img in "${need_save[@]}"; do
    echo "  - $img"
  done
} > "$OUT/MANIFEST.txt"
cp image-tags.env "$OUT/image-tags.env"

echo
echo "[ok] 镜像 tag = ${TAG}  platform=${PLATFORM:-local}"
echo "     拷这两份到测试机："
ls -lh "$OUT/tdai-images.tgz" "$OUT/tdai-internal-team.tgz"
echo "     .env 里的 IMAGE 必须是 image-tags.env 这几行，不要用 latest"
echo "     升级契约（给自有部署脚本同事）: deploy/upgrades/2026-08-24-per-sk-mem-and-http-git/"
echo "       → UPGRADE.md + env.add.yaml + verify.sh（填 MANIFEST.example.yaml 后一并交付）"
