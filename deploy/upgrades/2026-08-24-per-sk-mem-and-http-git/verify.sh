#!/usr/bin/env bash
# 部署方冒烟：检查 env 契约 + DB 表（可选）+ MaaS Proxy 链路
#
# 用法（在仓库根或 deploy/internal-team 下）:
#   ./deploy/upgrades/2026-08-24-per-sk-mem-and-http-git/verify.sh
#   cd deploy/internal-team && ../upgrades/2026-08-24-per-sk-mem-and-http-git/verify.sh
#
# 环境：优先读 deploy/internal-team/.env

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INTERNAL="$REPO_ROOT/deploy/internal-team"

fail=0
ok() { echo "[ok] $*"; }
warn() { echo "[warn] $*" >&2; }
err() { echo "[error] $*" >&2; fail=1; }

if [[ -f "$INTERNAL/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$INTERNAL/.env"
  set +a
fi

echo "==> 1/4 环境变量契约"
if [[ -z "${TDAI_MAAS_KEY_SECRET:-}" ]]; then
  err "TDAI_MAAS_KEY_SECRET 未设置（Core 必填）"
elif [[ ${#TDAI_MAAS_KEY_SECRET} -lt 32 ]]; then
  warn "TDAI_MAAS_KEY_SECRET 长度 < 32"
else
  ok "TDAI_MAAS_KEY_SECRET 已配置"
fi

proxy_ttl="${PROXY_MAAS_KEY_CACHE_TTL_MS:-60000}"
hub_ttl="${VITE_PROXY_MAAS_KEY_CACHE_TTL_MS:-60000}"
if [[ "$proxy_ttl" != "$hub_ttl" ]]; then
  warn "PROXY_MAAS_KEY_CACHE_TTL_MS ($proxy_ttl) != VITE_PROXY_MAAS_KEY_CACHE_TTL_MS ($hub_ttl)"
else
  ok "MaaS 缓存 TTL 一致: ${proxy_ttl}ms"
fi

if [[ "${KNOWLEDGE_ALLOW_HTTP:-}" =~ ^(1|true|on|yes)$ ]]; then
  ok "KNOWLEDGE_ALLOW_HTTP 已启用"
  if [[ -z "${KNOWLEDGE_GIT_TOKEN:-}" ]]; then
    warn "KNOWLEDGE_ALLOW_HTTP=1 但 KNOWLEDGE_GIT_TOKEN 未设（内网 HTTP 仓库可能 clone 失败）"
  fi
else
  ok "KNOWLEDGE_ALLOW_HTTP 未启用（仅 HTTPS 仓库）"
fi

echo ""
echo "==> 2/4 数据库表（可选，需 Docker volume 或 SQLITE_DB）"
if [[ -x "$INTERNAL/init-per-sk-mem-maas.sh" ]]; then
  if (cd "$INTERNAL" && ./init-per-sk-mem-maas.sh --verify-only); then
    ok "meta_user_key_maas_credentials 已就绪"
  else
    warn "DB 验证跳过或失败（新装 Core 重启后也会自动建表）"
  fi
else
  warn "未找到 init-per-sk-mem-maas.sh，跳过 DB 验证"
fi

echo ""
echo "==> 3/4 MaaS Proxy 链路"
if [[ -x "$INTERNAL/verify-maas-proxy.sh" ]]; then
  if (cd "$INTERNAL" && ./verify-maas-proxy.sh); then
    ok "verify-maas-proxy 通过"
  else
    err "verify-maas-proxy 失败（检查 Core/Proxy 是否已起、Hub 是否已配 MaaS Key）"
  fi
else
  warn "未找到 verify-maas-proxy.sh，跳过"
fi

echo ""
echo "==> 4/4 服务健康（可选）"
core_port="${MEMORY_CORE_PORT:-8420}"
panel_port="${PANEL_PORT:-8125}"
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:${core_port}/health" >/dev/null 2>&1 && ok "Core :${core_port} health" || warn "Core health 不可达"
  curl -fsS "http://127.0.0.1:${panel_port}/health" >/dev/null 2>&1 && ok "Hub :${panel_port} health" || warn "Hub health 不可达"
fi

echo ""
if [[ "$fail" -ne 0 ]]; then
  echo "验证未全部通过，见上方 [error]"
  exit 1
fi
echo "全部检查完成。详见: $SCRIPT_DIR/UPGRADE.md"
