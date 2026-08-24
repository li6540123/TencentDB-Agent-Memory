#!/usr/bin/env bash
# 升级后冒烟：env + DB 表 + MaaS Proxy（委托 upgrades 目录脚本）
set -euo pipefail
cd "$(dirname "$0")"
exec ./../upgrades/2026-08-24-per-sk-mem-and-http-git/verify.sh
