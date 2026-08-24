# 方案：每把 sk-mem 绑定一把 MaaS API Key

- 日期：2026-08-24
- 状态：设计完成；实施计划已写出（见 plans）
- 取代：`2026-08-21-per-user-upstream-api-key-design.md`、`2026-08-21-per-user-upstream-key-options.md`（旧方案按 **user_id** 绑定；本方案按 **key_id / sk-mem** 绑定）
- 背景：内网 Hub + MemoryProxy；同事用各客户端只配 Proxy 地址与 `sk-mem-…`；公司 MaaS 网关 Key 在 Hub「API Keys」页按行配置
- 实施计划：`docs/superpowers/plans/2026-08-24-per-sk-mem-maas-api-key.md`

## 1. 目标（产品叙述）

1. **Hub 前端**：API Keys 表在 `sk-mem`（`key_prefix`）列后增加 **MaaS API Key** 列；支持对该行 **添加 / 修改 / 清除**。
2. **Agent CLI**：只配置 **Proxy Base URL** + **`sk-mem-…`**，不配 MaaS Key。
3. **调 LLM 时**：转发 / 认人 / 按协议注 Header **保持现状**；只在算上游 API Key 时多一步：用入站 `sk-mem` 查库——**有绑定则用 Hub 的 MaaS Key（压过配置文件）**；**无绑定 / 解密失败 / resolve 不可用则完全按改前的配置决议**（`agents[].apiKey` → 全局 `PROXY_UPSTREAM_API_KEY` → 透传）。

```text
Agent CLI
  Base URL = http://<host>:8096/<agent>/default
  Auth    = sk-mem-…（x-api-key 或 Bearer，随协议）
        │
        ▼
MemoryProxy（所有转发模型网关的 handler）
  1) 入站 sk-mem → auth/verify（认人 / ACL 不变）
  2) 入站 sk-mem → Core resolve（短缓存）；有绑定 → 该 MaaS Key
  3) 无绑定 / 解密失败 / Core 不可用 → 与改前相同的 effectiveApiKey 决议
  4) 按协议注入后转发（Anthropic=x-api-key，OpenAI=Bearer）——注入逻辑不改
        │
        ▼
公司 MaaS 网关
```

### 成功标准（MVP）

1. 在 API Keys 某行配置 MaaS Key 后，用该行完整 `sk-mem` 调 Proxy，上游使用该 MaaS Key（不再用配置文件里的上游 Key）。
2. 未配置行：上游 Key 决议 **与改前行为一致**（有 `agents[].apiKey` 用 agent；否则全局；再否则透传）。
3. 同一用户两把 `sk-mem` 可绑不同 MaaS Key；互不影响。
4. list / status / Panel **永不**回传 MaaS Key 明文；仅 `configured` + 可选 hint。
5. 身份仍只用 `sk-mem`；`SessionInfo.user_key` 等仍存入站 sk-mem，不得改成 MaaS Key。
6. MaaS Key **加密落库**（AES-GCM，主密钥 env）。
7. resolve 超时或 Core 不可用时 **降级走配置**，不因此把整请求打成 500。

## 2. 非目标

- 不改官方 Docker Hub 发版流程；内网自建 amd64 镜像即可。
- 不做「每协议一把 MaaS Key」；一把按上游协议改写成 `x-api-key` 或 `Bearer`。
- 不做 KMS / 主密钥轮换 UI。
- 不做「未绑定则 403」。
- **不覆盖** Hub/Core 侧 `MEMORY_LLM_API_KEY`（记忆抽取等仍用服务端共用 Key）。
- 不改 `systemUserPassthrough`（内部账号仍用配置/全局 Key）。
- 不做客户端自定义 Header / 透传双 Key 方案（本方案唯一主路径）。

## 3. 绑定粒度（已锁定 B）

| 项 | 决定 |
|----|------|
| 粒度 | **每把 `meta_user_keys` 一行（key_id）一把 MaaS Key** |
| 查找键 | 运行时用入站 **sk-mem 明文**（`key_value`）定位行，再取绑定 |
| 吊销 | 吊销 / 删除 `sk-mem` 时 **级联删除** 对应 MaaS 绑定 |

## 4. Hub 前端（API Keys 页）

改动面：`MemoryPanel/.../ApiKeyPanel.tsx`（及 i18n）。

| UI | 行为 |
|----|------|
| 新列「MaaS API Key」 | 在 `key_prefix`（sk-mem 展示）列之后 |
| 未配置 | 文案「未配置」+「添加」 |
| 已配置 | 「已配置」或 hint（如末 4 位）+「修改」/「清除」 |
| 添加/修改 | Modal 输入明文；提交后列表 **不展示** 完整 Key（对齐 sk-mem：明文仅提交瞬间可见） |
| 清除 | 二次确认后删绑定，回退为未配置；成功提示须带 **与 Proxy 缓存 TTL 一致** 的生效说明（见 §7.5(8)） |

数据来源：

- `user-key/list` 响应每行增加只读字段，例如 `maas_configured: boolean`、`maas_key_hint?: string`（**无明文**）。
- 写操作走独立 meta action（见 §6），body 带 `key_id` + 可选明文。

文案要点：此 Key 仅用于经 Proxy 访问公司 MaaS；客户端身份仍用本行 sk-mem；**不**影响 Hub 记忆抽取用的 `MEMORY_LLM_API_KEY`（见 §7.5(3)）。

## 5. 数据模型（MemoryCore）

### 5.1 表

```sql
CREATE TABLE meta_user_key_maas_credentials (
  key_id TEXT PRIMARY KEY,                 -- = meta_user_keys.key_id
  user_id TEXT NOT NULL,                   -- 冗余，便于鉴权/清理
  maas_api_key_ciphertext TEXT NOT NULL,  -- AES-GCM 密文
  key_hint TEXT,                           -- 可选末 4 位，仅展示
  updated_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES meta_user_keys(key_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES meta_users(user_id) ON DELETE CASCADE
);
```

Mongo：同名 collection，`key_id` unique。

### 5.2 不采用

- 按 `user_id` 只存一把（已否决，见粒度 B）。
- 明文落库；塞进 `auth/verify` / `UserPublic`。
- 与 `key_value`（sk-mem）同一列混存。

### 5.3 加密

- AES-256-GCM；主密钥 `TDAI_MAAS_KEY_SECRET`（≥32 字节随机串；**仅 Core** 持有）。
- 缺失主密钥：`set` 失败；`resolve` 视为未绑定 → Proxy 走**改前配置决议**（打 warn，无明文）。
- Proxy **不**注入该 env，只拿 resolve 明文。

## 6. API 契约

对齐现有分层：

- `/v3/meta/*`：须 `x-tdai-user-key`（Panel / 用户）
- `/v3/internal/meta/*`：仅网关 Bearer（Proxy S2S），**无** user-key

| 路由 | 调用方 | 入参 | 出参 |
|------|--------|------|------|
| `POST /v3/meta/user-key/maas-key/set` | Panel | `{ key_id, maas_api_key }`；空串 = 清除 | `{ ok: true }` |
| `POST /v3/meta/user-key/maas-key/status` | Panel（可选；也可并进 list） | `{ key_id }` | `{ configured, key_hint?, updated_at? }` |
| `POST /v3/internal/meta/user-key/maas-key/resolve` | **仅 Proxy** | `{ user_key }`（入站 sk-mem 明文） | `{ configured: bool, maas_api_key?: string }` |

鉴权与越权：

- `set` / `status`：从 Header `x-tdai-user-key` 解析 caller；**仅当** `key_id` 属于该用户（或 system_admin）才允许。
- `resolve`：只认 internal Bearer；用 `user_key` 查 `meta_user_keys` → 再查绑定；无效/吊销的 sk-mem → `configured: false`（不抛明文）。
- Panel meta-actions 白名单增加 `user-key/maas-key/set`（及 status，若单独用）。

`user-key/list`：每行附加 `maas_configured` / `maas_key_hint`，避免 N+1。

## 7. Proxy 改造

### 7.1 公共模块

例如 `MemoryProxy/src/upstream/maas-key.ts`：

- `resolveMaasApiKey(inboundSkMem, config): Promise<string | null>`
  - 调 Core `.../maas-key/resolve`，body `{ user_key: inboundSkMem }`
  - **必须**走 §7.3 短缓存 + §7.4 超时降级（不可每条请求直打 Core）
  - 超时 / 网络错误 / 非 0 响应 → 返回 `null`（视为未绑定，**降级走配置**，不 fail 整请求）

- `resolveEffectiveUpstreamApiKey(...)` 统一优先级（**所有**模型转发 handler）：

```text
1. costGuard / target.authHeaders（若有）——现有行为，不变
2. 该 sk-mem 绑定的 MaaS Key（新；有则用，压过配置）
3. 无绑定（或 resolve 降级为 null）时，与改前完全一致：
     upstream.agents[agent].apiKey（非空才用）
     → upstream.apiKey（全局 PROXY_UPSTREAM_API_KEY）
     → 透传客户端（仅前几项皆空且该 agent 允许 passthrough）
```

注意：现有「agent 在 map 且 apiKey 为空 → 切断全局、透传」仅在 **步骤 2 无结果** 时生效；有绑定则 **先于** 一切配置/透传。

### 7.2 必须接入的入口

| Handler | 上游 Header |
|---------|-------------|
| `anthropicHandler.ts` | `x-api-key` = MaaS（或配置决议结果） |
| `handler.ts` | `Authorization: Bearer …` |
| `codexHandler.ts` | Bearer |
| `workbuddyHandler.ts` | Bearer |
| `auxiliaryHandler.ts` | 按端点协议同上 |

注入前去掉把 sk-mem 误传给 MaaS 的头；认人已完成，上游只用 MaaS 或配置决议结果。

### 7.3 resolve 缓存（MVP 必须）

不加缓存时，**每条**转发 LLM 的请求（含流式多 chunk 前的首次 forward）都会多打一次 Core `resolve`，延迟与 Core 压力不可接受。MVP **必须**在 Proxy 侧做短缓存。

| 项 | 约定 |
|----|------|
| 缓存键 | `sha256(inbound_sk_mem)`；日志 / metric **禁止**出现 sk-mem 或 MaaS 明文 |
| 缓存值 | `{ configured: boolean; maas_api_key?: string }` 或等价 `string \| null` |
| TTL | 默认 **60s**；可配置 env，如 `PROXY_MAAS_KEY_CACHE_TTL_MS=60000` |
| 存储 | MVP：**进程内** LRU/Map（单 Proxy 实例足够）；P1 多实例再考虑 Redis |
| 负缓存 | `configured: false`（未绑定 / 无效 sk-mem）**同样缓存**，避免反复 hammer Core |
| 失效 | MVP 仅靠 TTL；Panel `set` / 清除后 **最多 TTL 内仍用旧值**（需在 Hub 文案说明）；P1 可做主动失效 |
| 并发 | 同一 sk-mem 并发 miss 时 **singleflight**（只发一次 resolve，其余 await） |

实现位置：`MemoryProxy/src/upstream/maas-key.ts`（与 `resolveMaasApiKey` 同模块）。

### 7.4 resolve 超时与降级（MVP 必须）

| 项 | 约定 |
|----|------|
| 超时 | 硬上限建议 **1–2s**（可 env `PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS`）；不得阻塞 LLM forward 过久 |
| Core 不可达 / 非 0 / 超时 | 打 **warn**（无密钥明文）→ 返回 `null` → **走改前配置决议** |
| 客户端可见性 | **不得**因 resolve  alone 返回 500；认人（auth/verify）失败仍按现有 401 处理 |
| 与缓存关系 | 降级结果 **不写入** 正缓存（避免把短暂 Core 故障缓存成「未绑定」60s）；负缓存仅对「Core 明确返回 configured:false」生效 |

### 7.5 实现注意事项（MVP 必遵）

**1. 转发链路其余部分不动**

- `auth/verify`、session-init、injection、URL 路由、SSE/stream、Langfuse 等 **不改语义**。
- 仅替换各 handler 里 **算 `effectiveApiKey` 的那一段**，统一调 `resolveEffectiveUpstreamApiKey(...)`。
- 各 handler 仍负责本协议的 Header 形状（`x-api-key` vs `Bearer`），**不复制**决议逻辑。

**2. costGuard 仍最优先**

- `target.authHeaders` / costGuard 自带凭据 **压过** MaaS 绑定与配置（与现网一致）。
- 内网部署通常关 costGuard；方案保留此优先级，避免改行为。

**3. `MEMORY_LLM_API_KEY` 不在本方案范围**

- Hub/Core **记忆抽取、归档** 等内部 LLM 仍用 compose 里的 `MEMORY_LLM_API_KEY`（服务端共用）。
- 本方案只影响 **Agent CLI → Proxy → 公司 MaaS 网关** 的模型转发。
- Panel 文案需写清：MaaS Key 仅用于经 Proxy 调模型；记忆侧 LLM 与客户端 sk-mem 身份无关。

**4. `systemUserPassthrough` 不走 MaaS resolve**

- 内部 systemUser 短路路径仍用 yaml / 全局 Key；MVP 不查 `meta_user_key_maas_credentials`。

**5. 公司网关 Header 验收**

- 默认：Anthropic → `x-api-key`；OpenAI 系 → `Authorization: Bearer`（**与现实现一致**）。
- 若公司 MaaS 对 OpenAI 兼容口 **只认 `X-Api-Key`**，这是**改前就可能存在的**问题，不是本方案引入；上线前用真实网关测 CodeBuddy/Codex 路径。
- 需要时在 P1 增加 `upstream.authHeaderStyle` 配置；MVP 以真实网关验收为准。

**6. handler 清单验收**

- §7.2 五处 **全部**接入公共决议；Code review 对照清单，避免只改 `anthropicHandler` 漏 OpenAI 系。
- `workbuddyHandler` 内若有独立 upstream 注入分支，须一并接入。

**7. 日志与可观测性**

- 禁止日志打印：入站 sk-mem、resolve 返回的 MaaS Key、缓存 value。
- 可打：cache hit/miss、resolve 耗时、降级次数、`key_id` hash 前缀（可选）。

**8. Hub `set` / 清除后生效延迟（文案须跟 TTL 配置一致）**

- 因 Proxy 短缓存，用户改/清 MaaS Key 后，在 **当前 TTL** 内可能仍用旧 Key。
- Hub 成功提示 **禁止写死「约 1 分钟」**；必须展示与 Proxy 实际配置相同的时长，例如：
  - `PROXY_MAAS_KEY_CACHE_TTL_MS=60000`（默认）→ 「约 60 秒内全局生效」
  - 若改为 `30000` → 「约 30 秒内全局生效」
  - 若改为 `120000` → 「约 2 分钟内全局生效」（或「约 120 秒」，同一套格式化规则即可）
- 时长来源：与 Proxy 共用同一配置值（`PROXY_MAAS_KEY_CACHE_TTL_MS`）。内网 compose 把该 env 同时注入 Proxy 与 Panel/Control；Hub 用 i18n 参数插值，**不要**在前端硬编码 60。
- 格式化建议：`< 60s` 用「约 N 秒」；`≥ 60s` 且整分可用「约 N 分钟」，否则「约 N 秒」——规则固定，随 env 变。

### 7.6 部署建议

- `PROXY_PASSTHROUGH_SOURCES=` 清空；`PROXY_KEY_MODE=server`
- 保留 `PROXY_UPSTREAM_API_KEY`（及可选 per-agent apiKey）作未绑定时的配置源（与改前相同；全局 Key 建议仍必配）
- Core：`TDAI_MAAS_KEY_SECRET` 必配
- 可选：`PROXY_MAAS_KEY_CACHE_TTL_MS`、`PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS`（**同一 TTL env 须同时注入 Proxy 与 Panel/Control**，供 Hub 成功提示插值）

### 7.7 上游 Header 与公司网关

默认：Anthropic 协议 → `x-api-key`；OpenAI 系 → `Bearer`。  
若公司 MaaS 对某协议只认另一种头，MVP 用配置项覆盖（如 `upstream.authHeaderStyle: x-api-key | bearer`），**验收以真实网关为准**，写入测试清单。

## 8. 客户端配置（示例）

```bash
# Claude Code — 只 sk-mem
export ANTHROPIC_BASE_URL=http://<host>:8096/claude-code/default
export ANTHROPIC_API_KEY='sk-mem-...'

# OpenAI 系
export OPENAI_BASE_URL=http://<host>:8096/codebuddy/default
export OPENAI_API_KEY='sk-mem-...'
```

不在客户端配置 MaaS Key；不启用透传上游 Key。

## 9. 安全

| 项 | MVP |
|----|-----|
| Panel / list / status 无 MaaS 明文 | 必须 |
| resolve 仅 `/v3/internal/meta` + Bearer | 必须 |
| 日志 / 缓存 key 脱敏 | 必须 |
| AES-GCM 落库；主密钥仅 Core | 必须 |
| set 防水平越权（key_id 属主校验） | 必须 |
| 未绑定回退**改前配置决议** | 必须 |
| resolve 失败降级配置（不 500） | 必须 |
| resolve 短缓存 + singleflight（§7.3） | 必须 |
| 缓存 / 日志不含 sk-mem、MaaS 明文 | 必须 |

## 10. 测试计划

1. Core：set 后库内无明文；list 仅 `maas_configured`；非属主 set → 403；吊销 sk-mem 后绑定消失。
2. resolve：valid sk-mem + 已绑定 → 明文；未绑定 → configured false；user-key 调 internal 路径应不可用（或 404）。
3. Proxy：Anthropic / OpenAI / Codex / WorkBuddy / auxiliary 只带 sk-mem，上游为绑定 MaaS。
4. 同用户两把 sk-mem、两把不同 MaaS → 上游分别正确。
5. 未绑定 → 与改前配置决议一致；错误 MaaS → 上游 401，认人仍成功。
6. 缺 `TDAI_MAAS_KEY_SECRET`：set 失败；resolve 走未绑定语义。
7. Core resolve 超时 / 不可达：Proxy 降级走配置，请求不因 resolve 失败而 500。
8. 缓存：同一 sk-mem 连续请求在 TTL 内只 resolve 一次（singleflight + hit）；`configured:false` 负缓存生效。
9. Panel `set` 后：TTL 窗口内仍可能用旧 MaaS Key（验收时等待 TTL 或调短 TTL 测）。
10. costGuard 开启时：`target.authHeaders` 仍压过 MaaS 绑定。

## 11. 分期与成本

| 阶段 | 范围 | 预估 |
|------|------|------|
| MVP | Core 表+加密+set/list 字段+internal resolve；Proxy 公共决议+**缓存/降级/singleflight**+全 handler；Panel 列+Modal；compose secret；自建镜像 | **约 8–10 人日** |
| P1 | admin 代设、主密钥轮换、网关 Header 风格可配、**Redis 共享缓存 / set 后主动失效** | +2–4 人日 |

## 12. 风险

| 风险 | 缓解 |
|------|------|
| resolve 超时拖垮请求 | §7.4 超时 + 降级配置；§7.3 短缓存 + singleflight |
| set 后旧 Key 仍生效至 TTL | Hub 提示时长 = 实际 `PROXY_MAAS_KEY_CACHE_TTL_MS`（禁止写死 1 分钟）；P1 主动失效 |
| handler 漏改 | 公共函数 + §7.2 / §7.5(6) 清单验收 |
| 与旧 agents 空 apiKey 透传语义冲突 | §7.1 优先级写死；部署清空透传 |
| 主密钥丢失 | 文档备份；解密失败 → 改前配置决议 + warn |
| 官方镜像分叉 | 改动集中 Core 凭证模块 + Proxy `upstream/*` + ApiKeyPanel |

## 13. 已锁定决策

1. 粒度：**B — 每把 sk-mem（key_id）一把 MaaS Key**
2. 未绑定：**回退现有配置决议**（非「强制只回全局」；有 agent Key 仍优先生效）
3. 存储：独立表 + MVP 加密；主密钥仅 Core
4. 客户端：只 Proxy 地址 + sk-mem
5. resolve：`/v3/internal/meta/...`，入参 `user_key`；失败降级配置
6. 不做方案 C（客户端自定义头）作为主路径
7. 产品一句话：**有库绑定用库；没有则行为与改前完全一样**
8. Proxy resolve：**必须**进程内短缓存（默认 60s）+ 超时降级 + singleflight

## 14. 下一步

实施按 `docs/superpowers/plans/2026-08-24-per-sk-mem-maas-api-key.md` 在内网机改代码（Task 1→8）。本机可只同步这两份文档：

1. `docs/superpowers/specs/2026-08-24-per-sk-mem-maas-api-key-design.md`（设计）
2. `docs/superpowers/plans/2026-08-24-per-sk-mem-maas-api-key.md`（任务清单）
