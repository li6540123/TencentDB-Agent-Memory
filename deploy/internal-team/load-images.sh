#!/usr/bin/env bash
# 从 export-images.sh 产出的 tgz 导入镜像
#
# 用法:
#   ./load-images.sh dist/tdai-images-20688f9-amd64.tgz

set -euo pipefail
cd "$(dirname "$0")"

ARCHIVE="${1:-dist/tdai-images-20688f9-amd64.tgz}"
if [[ ! -f "$ARCHIVE" ]]; then
  echo "[error] 找不到: $ARCHIVE" >&2
  exit 1
fi

echo "[load] $ARCHIVE"
gzip -dc "$ARCHIVE" | docker load
echo "[ok] 请对照 image-tags.env 或 RELEASE.md 更新 .env 里的三行 IMAGE"
