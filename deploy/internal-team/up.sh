#!/usr/bin/env bash
# 渲染配置、启动四件套、初始化 admin。不删除 named volume。
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "[error] 没有 .env。先: cp .env.example .env 并填入真值。" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

need() {
  local v
  for v in "$@"; do
    if [[ -z "${!v:-}" || "${!v}" == "REPLACE_ME" || "${!v}" == sk-replace-me || "${!v}" == replace-with-a-long-random-string ]]; then
      echo "[error] .env 未设置有效值: $v" >&2
      exit 1
    fi
  done
}
need MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL \
  REDIS_PASSWORD PUBLIC_HOST KNOWLEDGE_PUBLIC_BASE_URL

if ! command -v python3 >/dev/null 2>&1; then
  echo "[error] 需要 python3 来渲染 runtime 配置" >&2
  exit 1
fi

mode="${PROXY_KEY_MODE:-server}"
if [[ "$mode" != "server" && "$mode" != "passthrough" ]]; then
  echo "[error] PROXY_KEY_MODE 只能是 server 或 passthrough，当前: $mode" >&2
  exit 1
fi

export MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL
export MEMORY_LLM_MAX_TOKENS="${MEMORY_LLM_MAX_TOKENS:-4096}"
export MEMORY_LLM_TIMEOUT_MS="${MEMORY_LLM_TIMEOUT_MS:-120000}"
export MEMORY_SKILL_ARCHIVE_BYTES="${MEMORY_SKILL_ARCHIVE_BYTES:-40960}"
export PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY
export MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-}"
if [[ -n "${MEMORY_CORE_GATEWAY_API_KEY}" ]]; then
  export PROXY_CORE_SERVICE_TOKEN="${MEMORY_CORE_GATEWAY_API_KEY}"
else
  export PROXY_CORE_SERVICE_TOKEN="${PROXY_CORE_SERVICE_TOKEN:-local}"
fi
export REDIS_PASSWORD PROXY_KEY_MODE
export PUBLIC_HOST PROXY_PORT="${PROXY_PORT:-8096}"
export PROXY_AGENT_SOURCES="${PROXY_AGENT_SOURCES:-claude-code,codebuddy,codex,workbuddy,dsh,hermes,openclaw}"
export PROXY_PASSTHROUGH_SOURCES="${PROXY_PASSTHROUGH_SOURCES:-}"

python3 ./render-config.py

if [[ "${1:-}" == "--render-only" ]]; then
  echo "[ok] 只渲染配置。看 runtime/proxy-config.yaml 后去掉 --render-only 再 ./up.sh"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[error] 找不到 docker" >&2
  exit 1
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[error] 需要 docker compose" >&2
  exit 1
fi

echo "[info] 启动容器（volume 已有数据则复用，不会清空）"
"${COMPOSE[@]}" --env-file .env up -d

wait_http() {
  local url="$1" name="$2" timeout="${3:-90}"
  local i=0
  echo "[info] 等待 $name ..."
  while (( i < timeout )); do
    if curl -sf --max-time 2 "$url" >/dev/null 2>&1; then
      echo "[ok] $name 就绪"
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  echo "[error] $name 超时。docker logs $name 看原因。" >&2
  "${COMPOSE[@]}" logs --tail 40
  exit 1
}

CORE_PORT="${MEMORY_CORE_PORT:-8420}"
PROXY_PORT="${PROXY_PORT:-8096}"
wait_http "http://127.0.0.1:${CORE_PORT}/health" tdai-memory-core 120
wait_http "http://127.0.0.1:${PROXY_PORT}/health" tdai-proxy 90

ADMIN_KEY_FILE=./.admin-key
generate_user_key() {
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  echo "[info] 复用 .admin-key"
else
  ADMIN_KEY=$(generate_user_key)
fi

USER="${MEMORY_CORE_ADMIN_USERNAME:-admin}"
init_body=$(printf '{"username":"%s","user_key":"%s"}' "$USER" "$ADMIN_KEY")
code=$(curl -sS -o /tmp/tdai-init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -H "x-tdai-service-id: default" \
  "http://127.0.0.1:${CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" || echo "000")

case "$code" in
  200)
    umask 077
    printf '%s' "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    echo "[ok] 已创建 admin，key 写入 .admin-key"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      echo "[ok] admin 已存在，继续用 .admin-key"
    else
      echo "[warn] volume 里已有 admin，但本目录没有 .admin-key。从备份恢复 .admin-key，或清 volume 后重来。" >&2
    fi
    ;;
  *)
    echo "[warn] init-admin HTTP=$code" >&2
    cat /tmp/tdai-init-admin.$$ 2>/dev/null || true
    echo
    ;;
esac
rm -f /tmp/tdai-init-admin.$$

base="http://${PUBLIC_HOST}:${PROXY_PORT}"
echo
echo "  Panel     http://${PUBLIC_HOST}:${PANEL_PORT:-8125}/"
echo "  Proxy     ${base}/"
echo "  客户端 Base URL（身份都是 sk-mem-...，不是模型网关 Key）："
IFS=',' read -r -a _sources <<< "${PROXY_AGENT_SOURCES}"
for src in "${_sources[@]}"; do
  src="${src// /}"
  [[ -n "$src" ]] || continue
  echo "    /${src}/default  →  ${base}/${src}/default"
done
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  echo
  echo "  Claude Code 示例（请用业务用户的 sk-mem，不要长期用 admin）："
  echo "    export ANTHROPIC_BASE_URL=${base}/claude-code/default"
  cc_pass=0
  if [[ ",${PROXY_PASSTHROUGH_SOURCES}," == *",claude-code,"* || "$mode" == "passthrough" ]]; then
    cc_pass=1
  fi
  if [[ "$cc_pass" -eq 1 ]]; then
    echo "    export ANTHROPIC_API_KEY='sk-mem-<业务用户>'          # Proxy 认人 → x-api-key"
    echo "    export ANTHROPIC_AUTH_TOKEN='<公司网关 Key>'          # 透传上游 → Authorization"
  else
    echo "    export ANTHROPIC_AUTH_TOKEN='sk-mem-<业务用户>'"
  fi
  echo "    claude --model ${PROXY_UPSTREAM_MODEL}"
fi
echo
echo "  备份: ./backup.sh    恢复: ./restore.sh <backups/目录>"
echo "  停止: ./down.sh      （默认保留 volume）"
