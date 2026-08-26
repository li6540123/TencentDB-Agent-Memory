# 方案：每个用户（sk-mem）绑定上游 LLM 网关 API Key

> **已取代**：请改读 `2026-08-24-per-sk-mem-maas-api-key-design.md`（按 **key_id / 每把 sk-mem** 绑 MaaS Key，不再按 user_id）。

- 日期：2026-08-21
- 状态：已废弃
- 背景：公司内网部署；测试机 x86 离线镜像；公司 LLM 网关鉴权与客户端透传不兼容；无存量数据可迁
- 范围澄清：**与具体客户端无关**。凡经 MemoryProxy 转发到模型网关的请求，一律按用户绑定的上游 Key 注入（Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / … 同一套）

## 1. 目标

同事客户端**只携带身份 Key**（`sk-mem-...`）。Proxy 验过身份后，按该用户取出其在面板绑定的**公司 LLM 网关 API Key**，再注入上游请求。

```text
任意 coding agent（CC / CB / Codex / …）
  身份 = sk-mem-...（Header 形式随协议：x-api-key 或 Bearer）
  Base URL = http://<host>:8096/<agent>/default
        │
        ▼
MemoryProxy（所有转发模型的 handler）
  1) 入站 Key → auth/verify → user_id
  2) user_id → 查 upstream_llm_api_key
  3) 按上游协议注入网关 Key：
       Anthropic → x-api-key = 网关 Key（去掉身份用的 Authorization/sk-mem）
       OpenAI    → Authorization: Bearer <网关 Key>
        │
        ▼
公司 LLM 网关（/messages 或 /chat/completions 等）
```

成功标准（MVP）：

1. 用户在 Panel 绑定网关 Key 后，**任一**经 Proxy 的客户端只配 `sk-mem` 即可调模型。
2. 未绑定用户：**回退全局** `PROXY_UPSTREAM_API_KEY`（策略 A，已锁定）。
3. Panel / `auth/verify` / `user/get` **永不**把网关 Key 明文回给浏览器。
4. 身份 `sk-mem` 与上游 Key 职责分离；Meta/ACL 仍只用 `sk-mem`。
5. 网关 Key **加密落库**（MVP 必须；主密钥来自环境变量，见 §5.3 / §10）。

## 2. 非目标（MVP 不做）

- 不改官方 Docker Hub 发版流程；本仓库自建 amd64 镜像给内网即可。
- 不做多协议分 Key（Anthropic / OpenAI 各存一把）；**一把上游 Key**，按协议改写成对应 Header。
- 不做 KMS / HSM / 密钥轮换 UI（主密钥用 env 注入即可）。
- 不做「未绑定则 403」（策略 B 不做）。
- 不做数据迁移（无存量）。
- 不解决 embedding / hybrid 召回等问题。
- 不改客户端专用逻辑（无 CC 双 Header 特例）。

## 3. 现状结论（源码依据）

| 层 | 现状 |
|----|------|
| Core | `meta_users` + `meta_user_keys` 只有身份；`auth/verify` 只回 `UserPublic` |
| Panel | 无「上游网关 Key」UI |
| Proxy | 各 handler 各自算 `effectiveApiKey`：per-agent yaml / 全局 / 透传 |
| 会话 | `SessionInfo.user_key` 存入站 `sk-mem`；**不可**改成存网关 Key |

须统一改造的转发入口（凡访问模型网关）：

| Handler | 协议 | 上游 Header 形态 |
|---------|------|------------------|
| `anthropicHandler.ts` | Anthropic | `x-api-key` |
| `handler.ts` | OpenAI Chat | `Authorization: Bearer` |
| `codexHandler.ts` | OpenAI Responses | Bearer |
| `workbuddyHandler.ts` | OpenAI 系 | Bearer |
| `auxiliaryHandler.ts` | 视端点 | anthropic=`x-api-key` / openai=Bearer |

抽取公共函数，避免只改某一客户端路径。

## 4. 总体架构

```text
┌──────────────────┐   sk-mem    ┌──────────────┐  verify   ┌─────────────┐
│ CC/CB/Codex/…    │ ──────────► │ MemoryProxy  │ ────────► │ MemoryCore  │
└──────────────────┘             │ 全 handler   │ ◄──────── │             │
                                 │ resolve+inject│  plaintext│ upstream_*  │
                                 └──────┬───────┘           └──────▲──────┘
                                        │ gateway key              │ set
                                        ▼                          │
                                 ┌──────────────┐           ┌──────┴──────┐
                                 │ 公司 LLM 网关 │           │ MemoryPanel │
                                 └──────────────┘           └─────────────┘
```

Key 优先级（**所有**转发模型网关的请求）：

```text
1. costGuard / target.authHeaders（若有）
2. 用户绑定的 upstream_llm_api_key（新）
3. upstream.agents[agent].apiKey
4. upstream.apiKey（全局共用）
5. 透传客户端（仅当 2–4 皆空，且该 agent 允许 passthrough）
```

部署建议：**清空** `PROXY_PASSTHROUGH_SOURCES`，全局 `PROXY_KEY_MODE=server`。透传与「面板绑 Key」并存易混乱，本方案以面板为准。

## 5. 数据模型（MemoryCore）

### 5.1 推荐：独立表

```sql
CREATE TABLE meta_user_upstream_credentials (
  user_id TEXT PRIMARY KEY,
  llm_api_key_ciphertext TEXT NOT NULL,  -- 加密后的网关 Key（非明文）
  key_hint TEXT,                         -- 可选：末 4 位，仅 status 展示
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES meta_users(user_id) ON DELETE CASCADE
);
```

Mongo 同名 collection。无存量 → 直接建表，无迁移。

### 5.2 不采用

- `metadata_json` / 塞进 `auth/verify` 返回值（会泄漏到 Panel 登录）。
- 与 `meta_user_keys` 混存（身份 Key ≠ 模型网关 Key）。
- 库内明文存网关 Key。

### 5.3 加密约定（MVP）

- 算法：AES-256-GCM（或仓库若已有对称加密工具则复用）。
- 主密钥：环境变量，例如 `TDAI_UPSTREAM_KEY_SECRET`（≥32 字节随机串）；**不得**写进镜像层或提交 git。
- `set`：明文 → encrypt → 写 `llm_api_key_ciphertext`；同时可写 `key_hint`。
- `resolve`：读密文 → decrypt → 仅返回给 Proxy；解密失败打日志（无明文）并视为未绑定 → 走全局回退。
- 部署：`deploy/internal-team` 的 `.env` / compose 为 Core（及需要解密的路径）注入该变量；`pack` 的 example 留占位符。

## 6. API 契约（MemoryCore `/v3/meta`）

| 路由 | 调用方 | 行为 |
|------|--------|------|
| `POST /v3/meta/user/upstream-key/set` | Panel（本人；可选 admin 代设） | `{ llm_api_key }`；空串 = 清除 |
| `POST /v3/meta/user/upstream-key/status` | Panel | `{ configured, updated_at? }`，无明文 |
| `POST /v3/meta/user/upstream-key/resolve` | **仅 Proxy**（service token） | `{ user_id }` → `{ llm_api_key }` |

未绑定策略（**已锁定 A**）：

| 策略 | 行为 |
|------|------|
| A `fallback_global` | 无绑定或解密失败 → 用全局 `PROXY_UPSTREAM_API_KEY` |
| B `require_bound` | （不做） |

## 7. Proxy 改造

### 7.1 公共模块（必须）

`MemoryProxy/src/upstream/per-user-key.ts`：

- `resolvePerUserUpstreamApiKey(userId, config): Promise<string | null>`
- Core `upstream-key/resolve` + 短缓存（如 60s / Redis）

`MemoryProxy/src/upstream/effective-api-key.ts`（或并入上一文件）：

- `resolveEffectiveUpstreamApiKey({ userId, agentEntry, globalApiKey, perUserKey })`  
  实现 §4 优先级，供所有 handler 调用。

### 7.2 注入点（MVP 全覆盖）

凡会把请求转到模型网关的路径都要接上公共决议：

1. `anthropicHandler.ts` — Anthropic（含 `/claude-code/.../v1/messages`）
2. `handler.ts` — OpenAI Chat（含 codebuddy 等）
3. `codexHandler.ts`
4. `workbuddyHandler.ts`
5. `auxiliaryHandler.ts` — count_tokens / embeddings 等若走上游鉴权，同样注入

各 handler 仍负责本协议的 Header 形状（`x-api-key` vs Bearer）；**决议逻辑不复制多份**。

### 7.3 身份与上游分离

| 用途 | 来源 |
|------|------|
| 认人 / session / Meta ACL | 入站 `sk-mem` |
| 调公司模型网关 | 用户绑定 Key 或全局兜底 |

客户端（举例，所有 agent 同理）：

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://<host>:8096/claude-code/default
export ANTHROPIC_API_KEY='sk-mem-...'

# CodeBuddy / OpenAI 系
export OPENAI_BASE_URL=http://<host>:8096/codebuddy/default
export OPENAI_API_KEY='sk-mem-...'
```

不再要求客户端携带公司网关 Key。

## 8. Panel 改造

「API Keys / 我的设置」增加 **上游模型网关 Key** 绑定（与客户端种类无关的一句话说明）。

- 保存 / 清除 / 显示是否已配置（可选末 4 位 hint，不回完整 Key）  
- 文案：此 Key 用于经 Proxy 访问公司 LLM；登录与 Agent 身份仍用 `sk-mem`；未绑定则使用服务器默认网关 Key

## 9. 部署

- 自建 `memory-core` + `memory-proxy`（+ Panel 随 hub）amd64 镜像，`pack.sh` 离线包  
- `PROXY_PASSTHROUGH_SOURCES=` 清空  
- `PROXY_KEY_MODE=server`  
- 保留 `PROXY_UPSTREAM_API_KEY` 作未绑定兜底（必须配置）  
- Core 增加 `TDAI_UPSTREAM_KEY_SECRET`（加密主密钥，必须配置）  

## 10. 安全

| 项 | MVP |
|----|-----|
| 明文不进 Panel API | 必须 |
| `resolve` 仅 service | 必须 |
| 日志脱敏 | 必须 |
| **AES-GCM 加密落库** | **必须**（主密钥 `TDAI_UPSTREAM_KEY_SECRET`） |
| 未绑定回退全局 Key | 必须 |
| admin 代设 / 密钥轮换 UI | 非必须（可 P1） |

## 11. 测试计划

1. Core：set 后库内无明文；status 无明文；user_key 调 resolve 拒绝；service resolve 得明文。  
2. 错误/缺失 `TDAI_UPSTREAM_KEY_SECRET`：set 失败或启动告警（实现时二选一，须可测）。  
3. Proxy：Anthropic / OpenAI / Codex / WorkBuddy / auxiliary 只带 `sk-mem`，上游为绑定 Key。  
4. 未绑定 → 注入全局 `PROXY_UPSTREAM_API_KEY`。  
5. 错误网关 Key → 上游 401，认人仍成功。

## 12. 分期与成本（无存量；全 handler + 加密）

| 阶段 | 范围 | 预估 |
|------|------|------|
| **MVP** | Core 表+加密+接口；公共决议函数；**全部**模型转发 handler；Panel 绑定；策略 A；compose 注入主密钥；自编镜像 | **约 8–10 人日** |
| **P1** | admin 代设、主密钥轮换、session/Redis 缓存强化 | +2–4 人日 |

## 13. 风险

| 风险 | 缓解 |
|------|------|
| handler 漏改 | 公共函数 + 清单验收 |
| 主密钥丢失 → 已绑定 Key 无法解密 | 文档强调备份 secret；解密失败回退全局并打 warn |
| 透传残留 | 清空 `PROXY_PASSTHROUGH_SOURCES` |
| 官方镜像漂移 | 改动集中 `upstream/*` + Core 凭证模块 |

## 14. 已锁定决策

1. 未绑定：**A 回退全局 Key**  
2. 存储：**独立表** + **MVP 加密落库**  
3. 范围：**所有经 Proxy 访问模型网关的路径**  
4. 客户端：**只 sk-mem**，停用透传上游 Key  

## 15. 下一步

评审无异议后：写 `docs/superpowers/plans/2026-08-21-per-user-upstream-api-key.md` 实施任务清单并开工。
