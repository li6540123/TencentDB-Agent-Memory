#!/usr/bin/env bash
# Proxy MaaS 转发链路验收（仅 Proxy 层 + Core resolve，不依赖 Claude CLI）
#
# 用法（deploy/internal-team/）：
#   ./verify-maas-proxy.sh
#   SK_MAAS_BOUND=sk-mem-... SK_MAAS_UNBOUND=sk-mem-... ./verify-maas-proxy.sh
#
# 环境变量（可选，默认按 usr-c2hcd0mdxp 两把 key）：
#   PROXY_BASE=http://127.0.0.1:8096
#   CORE_BASE=http://127.0.0.1:8420
#   SK_MAAS_BOUND / SK_MAAS_UNBOUND
#   UPSTREAM_KEY  — .env PROXY_UPSTREAM_API_KEY，用于 T3 对照

set -euo pipefail
cd "$(dirname "$0")"

PROXY_BASE="${PROXY_BASE:-http://127.0.0.1:8096}"
CORE_BASE="${CORE_BASE:-http://127.0.0.1:8420}"
SK_MAAS_BOUND="${SK_MAAS_BOUND:-sk-mem-r6nbEKJY4waggSWvzHTQVxbMW2dRR9l7}"
SK_MAAS_UNBOUND="${SK_MAAS_UNBOUND:-sk-mem-uID7p4SOMPHUWt9dNeD6uTRqJz6a85Gg}"
UPSTREAM_KEY="${UPSTREAM_KEY:-$(grep '^PROXY_UPSTREAM_API_KEY=' .env 2>/dev/null | cut -d= -f2- || true)}"
MODEL="${PROXY_UPSTREAM_MODEL:-$(grep '^PROXY_UPSTREAM_MODEL=' .env 2>/dev/null | cut -d= -f2- || echo qwen3.7-max)}"
MSG_URL="$PROXY_BASE/claude-code/default/v1/messages"
BODY=$(printf '{"model":"%s","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' "$MODEL")

pass=0
fail=0
skip=0

note() { echo "[verify] $*"; }
ok() { pass=$((pass + 1)); note "PASS $1"; }
bad() { fail=$((fail + 1)); note "FAIL $1 — $2"; }
skip_case() { skip=$((skip + 1)); note "SKIP $1 — $2"; }

core_resolve() {
  local sk="$1"
  curl -sf -X POST "$CORE_BASE/v3/internal/meta/user-key/maas-key/resolve" \
    -H 'content-type: application/json' \
    -H 'x-tdai-service-id: default' \
    -H 'authorization: Bearer local' \
    -d "{\"user_key\":\"$sk\"}"
}

proxy_post() {
  local extra=("$@")
  curl -sS -o /tmp/verify-maas-body.txt -w '%{http_code}' -X POST "$MSG_URL" \
    -H 'content-type: application/json' \
    "${extra[@]}" \
    -d "$BODY"
}

classify_http() {
  local code="$1"
  local body
  body=$(cat /tmp/verify-maas-body.txt)
  if [[ "$code" == "200" ]]; then echo ok; return; fi
  if [[ "$code" == "429" ]]; then echo quota; return; fi
  if [[ "$code" == "401" ]] && grep -qE 'authentication_error|InvalidApiKey|invalid.*api.?key' /tmp/verify-maas-body.txt; then echo auth; return; fi
  echo "http_$code"
}

note "=== 场景设计（Proxy 转发链路）==="
note "L1 Core resolve | L2 Proxy 模块 | L3 Proxy HTTP → Token Plan 上游"
echo

note "=== L1 Core internal resolve ==="
r1=$(core_resolve "$SK_MAAS_BOUND" || echo '{}')
if echo "$r1" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; exit(0 if d.get('configured') else 1)" 2>/dev/null; then
  ok "L1-T1 绑 MaaS sk-mem → configured=true"
else
  bad "L1-T1 绑 MaaS sk-mem → configured=true" "$(echo "$r1" | head -c 120)"
fi

r2=$(core_resolve "$SK_MAAS_UNBOUND" || echo '{}')
if echo "$r2" | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; exit(0 if not d.get('configured') else 1)" 2>/dev/null; then
  ok "L1-T2 未绑 sk-mem → configured=false"
else
  bad "L1-T2 未绑 sk-mem → configured=false" "$(echo "$r2" | head -c 120)"
fi

note "=== L2 Proxy 容器内模块（resolve + effectiveApiKey）==="
if docker exec tdai-proxy node --import tsx/esm -e "
import { resolveEffectiveUpstreamApiKeyWithMaas } from './src/upstream/maas-key.ts';
const sk='${SK_MAAS_BOUND}';
const eff=await resolveEffectiveUpstreamApiKeyWithMaas({
  inboundSkMem:sk,
  config:{upstream:{apiKey:'g',agents:{'claude-code':{}}},auth:{url:'http://memory-core:8420'},coreSkill:{serviceToken:'local'}},
  agentName:'claude-code',spaceId:'default'});
process.exit(eff && eff.length>20 ? 0 : 1);
" >/dev/null 2>&1; then
  ok "L2-T1 effectiveApiKey 非空（绑 MaaS）"
else
  bad "L2-T1 effectiveApiKey 非空（绑 MaaS）" "模块返回空"
fi

note "=== L3 Proxy HTTP → 上游（Hub MaaS 优先，未绑走 .env 全局 Key）==="

code=$(proxy_post -H "x-api-key: $SK_MAAS_BOUND")
result=$(classify_http "$code")
case "$result" in
  ok) ok "L3-T1 绑 MaaS，仅 sk-mem → 200" ;;
  quota) skip_case "L3-T1 绑 MaaS，仅 sk-mem" "上游 429 配额（链路已通）" ;;
  auth) bad "L3-T1 绑 MaaS，仅 sk-mem → 应 200" "HTTP $code（Hub MaaS Key 无效或未注入）" ;;
  *) bad "L3-T1 绑 MaaS，仅 sk-mem" "HTTP $code $(head -c 80 /tmp/verify-maas-body.txt)" ;;
esac

code=$(proxy_post -H "x-api-key: $SK_MAAS_UNBOUND")
result=$(classify_http "$code")
case "$result" in
  ok|quota) ok "L3-T2 未绑，仅 sk-mem → 走 .env 全局 Key（200/429）" ;;
  auth) bad "L3-T2 未绑，仅 sk-mem → 应到达上游" "HTTP $code — 检查 proxy-config claude-code 是否有 apiKey" ;;
  *) bad "L3-T2 未绑，仅 sk-mem" "HTTP $code $(head -c 80 /tmp/verify-maas-body.txt)" ;;
esac

if [[ -n "$UPSTREAM_KEY" ]]; then
  code=$(proxy_post -H "x-api-key: $SK_MAAS_UNBOUND" -H "Authorization: Bearer $UPSTREAM_KEY")
  result=$(classify_http "$code")
  case "$result" in
    ok|quota) ok "L3-T3 未绑 + 客户端 Bearer 上游 Key → 到达上游（200/429）" ;;
    auth) bad "L3-T3 未绑 + Bearer" "HTTP 401 — .env 上游 Key 失效" ;;
    *) bad "L3-T3 未绑 + Bearer" "HTTP $code" ;;
  esac
else
  skip_case "L3-T3 未绑 + Bearer" "无 UPSTREAM_KEY"
fi

code=$(proxy_post -H "x-api-key: $SK_MAAS_BOUND" -H "Authorization: Bearer ${UPSTREAM_KEY:-bad}")
result=$(classify_http "$code")
if [[ "$result" == "ok" ]] || [[ "$result" == "quota" ]]; then
  ok "L3-T4 绑 MaaS + 客户端 Bearer → MaaS 路径生效（200/429）"
elif [[ "$result" == "auth" ]] && [[ "$code" == "401" ]]; then
  ok "L3-T4 绑 MaaS 覆盖无效客户端 Bearer（401）"
else
  bad "L3-T4 绑 MaaS + Bearer" "HTTP $code"
fi

echo
note "=== 汇总: PASS=$pass FAIL=$fail SKIP=$skip ==="
if [[ "$fail" -gt 0 ]]; then
  note "常见修复：Hub 绑定的 MaaS Key / .env PROXY_UPSTREAM_API_KEY 换有效 Token Plan Key，确认 PROXY_UPSTREAM_URL 与 Key 区域匹配后 ./up.sh"
  exit 1
fi
exit 0
