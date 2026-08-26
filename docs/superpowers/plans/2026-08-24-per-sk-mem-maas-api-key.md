# Per-sk-mem MaaS API Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **给内网人工改代码：** 本计划可独立阅读；设计依据见 `docs/superpowers/specs/2026-08-24-per-sk-mem-maas-api-key-design.md`。按 Task 顺序做，每 Task 做完再进下一个。

**Goal:** Hub「API Keys」每行可绑定一把 MaaS API Key；Agent CLI 只带 `sk-mem`；Proxy 转发 LLM 时优先用该绑定 Key，没有则行为与改前完全一致。

**Architecture:** Core 按 `key_id` 加密存 MaaS Key；Panel `set` 走 `/v3/meta`；Proxy `resolve` 走 `/v3/internal/meta` + 进程内 60s 缓存；各 handler 只改 `effectiveApiKey` 决议，Header 注入逻辑不动。

**Tech Stack:** TypeScript（MemoryCore / MemoryProxy / MemoryPanel）、SQLite + Mongo adapters、AES-256-GCM（node:crypto）、Tea + i18n（Panel）、docker-compose（`deploy/internal-team`）。

## 实施进度（分支 `feat/per-sk-mem-maas-api-key`）

| Task | 代码 | 说明 |
|------|------|------|
| 1–7 | ✅ 已落地 | 见下方各 Task 勾选 |
| 8 E2E | ⏳ 待内网机 | 需自建镜像 + 真环境验收 |
| git commit | ⏳ 未做 | 按约定未自动提交 |
| 单测执行 | ✅ 已跑通 | Core 57 + Proxy 8 用例 |

额外：`deploy/internal-team/.env.company.example` 已同步 MaaS env（Task 7 补充）。

## Global Constraints

- 绑定粒度：**每把 sk-mem（`meta_user_keys.key_id`）一把 MaaS Key**（不是 per-user）。
- 有绑定 → 压过 yaml 配置；无绑定 / resolve 失败 → **与改前配置决议一致**。
- Panel / list **永不**回传 MaaS 明文。
- `resolve` 失败 **不得**导致客户端 500（降级配置）。
- Proxy **必须**短缓存 + singleflight；默认 TTL 60s。
- Hub 成功提示时长 = `PROXY_MAAS_KEY_CACHE_TTL_MS`，**禁止写死「1 分钟」**。
- 主密钥 `TDAI_MAAS_KEY_SECRET` **仅 Core**；不改 `MEMORY_LLM_API_KEY` / `systemUserPassthrough`。
- 不改官方发版流程；内网自建镜像即可。

---

## File map（先读这些）

| 区域 | 路径 | 做什么 |
|------|------|--------|
| Core 类型 | `MemoryCore/src/metadata/types.ts` | `UserKeyPublic` 加 `maas_*`；实体类型 |
| Core 加密 | `MemoryCore/src/metadata/utils/crypto.ts`（旁路新建更好） | 建议新建 `maas-key-crypto.ts` |
| Core store | `.../store/interface.ts` + `sqlite-adapter.ts` + `mongodb-adapter.ts` | 表/CRUD |
| Core service | `.../service/metadata-service.ts` | set / status / resolve / list 附加字段 |
| Core 路由 | `.../router/v3-meta-router.ts` + `v3-meta-schemas.ts` + `internal-meta-router.ts` | 注册 API |
| Panel 白名单 | `MemoryPanel/src/panel/api/meta-actions.ts` | 加 `user-key/maas-key/set` |
| Panel API | `MemoryPanel/web/src/lib/api/users.ts` | `UserKey` 类型 + set API |
| Panel UI | `MemoryPanel/web/src/pages/team/ApiKeysPage/components/ApiKeyPanel.tsx` | 新列 + Modal |
| Panel i18n | `MemoryPanel/web/src/i18n/zh-CN.ts` + `en-US.ts` | 文案 |
| Proxy 公共 | **新建** `MemoryProxy/src/upstream/maas-key.ts` | resolve + cache + effective |
| Proxy handlers | `anthropicHandler.ts` / `handler.ts` / `codexHandler.ts` / `workbuddyHandler.ts` / `auxiliaryHandler.ts` | 接入决议 |
| 部署 | `deploy/internal-team/.env.example` + `docker-compose.yml` + `up.sh` | secret + TTL |

---

### Task 1: Core — 加密工具 + 表结构（sqlite + mongo）

**Files:**
- Create: `MemoryCore/src/metadata/utils/maas-key-crypto.ts`
- Modify: `MemoryCore/src/metadata/store/interface.ts`
- Modify: `MemoryCore/src/metadata/store/sqlite-adapter.ts`（建表 + CRUD）
- Modify: `MemoryCore/src/metadata/store/mongodb-adapter.ts`（同名 collection）
- Modify: `MemoryCore/src/metadata/types.ts`（实体 + `UserKeyPublic` 扩展字段）
- Test: 同目录或现有 Core 单测风格下新增 `maas-key-crypto` 单测

**Produces:**
- `encryptMaasApiKey(plain: string, secret: string): string`
- `decryptMaasApiKey(ciphertext: string, secret: string): string`
- `hintFromMaasApiKey(plain: string): string`（末 4 位）
- store: `upsertMaasCredential` / `getMaasCredentialByKeyId` / `deleteMaasCredential` / `getUserKeyByValue`（resolve 用）

- [x] **Step 1:** 在 `maas-key-crypto.ts` 用 `node:crypto` 实现 AES-256-GCM
- [x] **Step 2:** 写单测 `maas-key-crypto.test.ts`（roundtrip / 缺 secret / 坏密文）
- [x] **Step 3:** sqlite 建表 + `PRAGMA foreign_keys = ON` 已有
- [x] **Step 4:** mongo `ensureIndex({ key_id: 1 }, { unique: true })`
- [x] **Step 5:** `UserKeyPublic` 增加 `maas_configured` / `maas_key_hint`
- [ ] **Step 6:** Commit：`feat(core): add maas credential table and AES-GCM helpers`

---

### Task 2: Core — service + `/v3/meta` set/status + list 附加字段

**Files:**
- Modify: `MemoryCore/src/metadata/service/metadata-service.ts`
- Modify: `MemoryCore/src/metadata/router/v3-meta-schemas.ts`
- Modify: `MemoryCore/src/metadata/router/v3-meta-router.ts`
- Modify: `MemoryPanel/src/panel/api/meta-actions.ts`（白名单，本 Task 末尾一起做）

**Produces:**
- `setUserKeyMaasApiKey(callerCtx, keyId, maasApiKey: string): Promise<{ ok: true }>`
- `getUserKeyMaasStatus(callerCtx, keyId): Promise<{ configured, key_hint?, updated_at? }>`
- `listUserKeys` 每行带 `maas_configured` / `maas_key_hint`
- 路由：
  - `POST /v3/meta/user-key/maas-key/set`
  - ~~`POST /v3/meta/user-key/maas-key/status`~~（未做；list 已带 `maas_configured` / hint）

- [x] **Step 1:** Zod schema `userKeyMaasKeySetSchema`
- [x] **Step 2:** `setUserKeyMaasApiKeyForCaller`（属主校验 / 空串清除 / 缺 secret 报错）
- [x] **Step 3:** `listUserKeys` 批量附加 `maas_configured` / `maas_key_hint`
- [x] **Step 4:** 路由 + Panel `META_ACTIONS` 白名单
- [ ] **Step 5:** 手工或单测：set → list → 清除 → 越权 403（待内网/E2E）
- [ ] **Step 6:** Commit：`feat(core): user-key maas-key set/list fields`

---

### Task 3: Core — `/v3/internal/meta` resolve

**Files:**
- Modify: `MemoryCore/src/metadata/router/internal-meta-router.ts`
- Modify: `MemoryCore/src/metadata/router/v3-meta-schemas.ts`（或 internal 专用 schema）
- Modify: `MemoryCore/src/metadata/service/metadata-service.ts`

**Produces:**
- `resolveMaasApiKeyByUserKey(userKey: string): Promise<{ configured: boolean; maas_api_key?: string }>`
- 路由：`POST /v3/internal/meta/user-key/maas-key/resolve`，body `{ user_key: string }`

- [x] **Step 1:** `getUserKeyByValue` + active/过期校验 → `{ configured: false }`
- [x] **Step 2:** 解密失败 / 缺 secret → warn + `{ configured: false }`
- [x] **Step 3:** 成功 → `{ configured: true, maas_api_key }`
- [x] **Step 4:** 仅 `internal-meta-router` 注册
- [ ] **Step 5:** 测：绑定 / 未绑定 / 吊销 CASCADE（待内网/E2E）
- [ ] **Step 6:** Commit：`feat(core): internal maas-key resolve`

---

### Task 4: Proxy — `upstream/maas-key.ts`（缓存 + 降级 + 决议）

**Files:**
- Create: `MemoryProxy/src/upstream/maas-key.ts`
- Create: `MemoryProxy/src/upstream/maas-key.test.ts`（或项目既有测试布局）
- Modify: `MemoryProxy/src/types.ts` / `config.ts`（可选：读 TTL/timeout env；也可用 `process.env` 直接读）

**Produces（签名建议）:**

```ts
export async function resolveMaasApiKey(
  inboundSkMem: string,
  opts: {
    coreBaseUrl: string;       // 通常 config.auth.url 或 tdai.endpoint
    serviceToken: string;      // Bearer：tdai.apiKey 或 skill.serviceToken
    serviceId: string;         // x-tdai-service-id（spaceId）
    timeoutMs?: number;        // 默认 1500；env PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS
    cacheTtlMs?: number;       // 默认 60000；env PROXY_MAAS_KEY_CACHE_TTL_MS
  },
): Promise<string | null>;

/** 纯函数：在已拿到 perUserMaasKey 后算最终 upstream key */
export function resolveEffectiveUpstreamApiKey(args: {
  perUserMaasKey: string | null;
  agentUpstreamEntry?: { apiKey?: string } | undefined;
  globalApiKey: string;
}): string;
```

`resolveEffectiveUpstreamApiKey` 语义（无 costGuard；costGuard 仍在 handler 里用 `target.authHeaders` 覆盖）：

```text
if (perUserMaasKey) return perUserMaasKey;
if (agentUpstreamEntry) return agentUpstreamEntry.apiKey ?? "";  // 空串 = 透传
return globalApiKey;
```

（与现 `handler.ts` / `anthropicHandler.ts` 三态一致。）

- [x] **Step 1:** 进程内 Map + sha256 缓存键 + 负缓存
- [x] **Step 2:** singleflight（`inflight` Map）
- [x] **Step 3:** internal resolve HTTP + Bearer + `x-tdai-service-id`
- [x] **Step 4:** 超时/错误降级不写正缓存；`configured:false` 写负缓存
- [x] **Step 5:** `maas-key.test.ts`（effective 优先级 + cache hit/miss/负缓存/降级/singleflight/TTL）
- [ ] **Step 6:** Commit：`feat(proxy): maas key resolve cache and effectiveApiKey helper`

---

### Task 5: Proxy — 接入全部模型转发 handler

**Files:**
- Modify: `MemoryProxy/src/anthropicHandler.ts`（约 1171 行 `effectiveApiKey`）
- Modify: `MemoryProxy/src/handler.ts`（约 1102 行）
- Modify: `MemoryProxy/src/codexHandler.ts`（约 959–968 及全局注入处）
- Modify: `MemoryProxy/src/workbuddyHandler.ts`（约 457–501）
- Modify: `MemoryProxy/src/auxiliaryHandler.ts`（约 54–76）

**规则：**
- 入站 sk-mem 已从现有 `extractApiKey` / bearer 取得（各 handler 已有变量，勿改认人）。
- **仅**替换算 `effectiveApiKey` 的那段；`buildUpstreamHeaders` / Bearer 注入 **不动**。
- `systemUserPassthrough`：**不要**接 MaaS resolve。
- 若 `target.authHeaders` 存在，保持现有覆盖（costGuard 优先）。

伪代码（Anthropic / OpenAI 主路径）：

```ts
const inboundSkMem = /* 现有入站 key */;
const perUser = inboundSkMem
  ? await resolveMaasApiKey(inboundSkMem, { coreBaseUrl, serviceToken, serviceId: spaceId })
  : null;
const effectiveApiKey = resolveEffectiveUpstreamApiKey({
  perUserMaasKey: perUser,
  agentUpstreamEntry,
  globalApiKey: config.upstream.apiKey,
});
// 后续 buildUpstreamHeaders(..., effectiveApiKey) 不变
```

- [x] **Step 1:** `anthropicHandler.ts`
- [x] **Step 2:** `handler.ts`
- [x] **Step 3:** `codexHandler.ts`
- [x] **Step 4:** `workbuddyHandler.ts`
- [x] **Step 5:** `auxiliaryHandler.ts`
- [x] **Step 6:** 五 handler 已接 `resolveEffectiveUpstreamApiKeyWithMaas`；`systemUserPassthrough` 未改
- [ ] **Step 7:** Commit：`feat(proxy): wire per-sk-mem maas key into all LLM handlers`

---

### Task 6: Panel — API + ApiKeyPanel 列 + Modal + i18n

**Files:**
- Modify: `MemoryPanel/web/src/lib/api/users.ts`（`UserKey` + `userKeysApi.setMaasKey`）
- Modify: `MemoryPanel/web/src/pages/team/ApiKeysPage/components/ApiKeyPanel.tsx`
- Modify: `MemoryPanel/web/src/i18n/zh-CN.ts` / `en-US.ts`
- Modify: Panel 读取 TTL：compose 注入 `PROXY_MAAS_KEY_CACHE_TTL_MS` → Control/Panel 能读到（见 Task 7）；前端用 `import.meta.env` 或现有 runtime config 模式

**UI：**
- 在 `key_prefix` 列后加「MaaS API Key」列
- 未配置：「未配置」+「添加」；已配置：「已配置」或 hint +「修改」/「清除」
- Modal：输入框提交明文；成功 toast **禁止写死 1 分钟**，用格式化函数：

```ts
function formatMaasCacheTtlHint(ttlMs: number): string {
  const sec = Math.max(1, Math.round(ttlMs / 1000));
  if (sec >= 60 && sec % 60 === 0) return `约 ${sec / 60} 分钟内全局生效`;
  return `约 ${sec} 秒内全局生效`;
}
```

- [x] **Step 1:** `userKeysApi.setMaasKey`
- [x] **Step 2:** 表格列 + Modal + 清除
- [x] **Step 3:** i18n zh-CN / en-US
- [x] **Step 4:** `maas-cache-ttl.ts` + toast 用 `formatMaasCacheTtlHint`
- [ ] **Step 5:** 本地点一遍 UI（待 Hub 自建镜像后）
- [ ] **Step 6:** Commit：`feat(panel): maas api key column on API Keys page`

---

### Task 7: 部署 — env / compose / 文档

**Files:**
- Modify: `deploy/internal-team/.env.example`
- Modify: `deploy/internal-team/docker-compose.yml`（Core 注入 `TDAI_MAAS_KEY_SECRET`；Proxy + Panel/Hub 注入 `PROXY_MAAS_KEY_CACHE_TTL_MS`）
- Modify: `deploy/internal-team/up.sh`（如需 export）
- Modify: `deploy/internal-team/DEPLOY.md` / `README.md`（一两段说明）

- Modify: `deploy/internal-team/.env.example` + `.env.company.example`
- Modify: `deploy/internal-team/docker-compose.yml`
- Modify: `deploy/internal-team/DEPLOY.md`

- [x] **Step 1:** `.env.example` + `.env.company.example` 增加 MaaS env
- [x] **Step 2:** compose：Core `TDAI_MAAS_KEY_SECRET`；Proxy + Hub `PROXY_MAAS_*`
- [x] **Step 3:** DEPLOY.md 增加 MaaS 绑定说明
- [x] **Step 4:** README.md 增加 MaaS Key 行说明

> `up.sh` 未改：compose 已直接读 `.env` 注入，无需额外 export。

---

### Task 8: 端到端验收清单（内网机）

- [ ] Core 库内无 MaaS 明文（看 sqlite/mongo）
- [ ] Panel list 无明文；异用户改别人 key_id 被拒
- [ ] 绑 Key 后，Claude Code 只带 sk-mem，上游用绑定 Key（可用 Proxy debug 日志看 **是否注入**，勿打明文；或对 mock upstream 断言 Header）
- [ ] 未绑定：行为与改前一致（全局/agent/透传）
- [ ] 两把 sk-mem 两把不同 MaaS → 分别正确
- [ ] 停 Core resolve（或错误 URL）：请求仍通，走配置，不 500
- [ ] TTL 内第二次请求不打 Core（看 Core access log / Proxy cache hit metric）
- [ ] 改 `PROXY_MAAS_KEY_CACHE_TTL_MS=30000` 后 Hub toast 显示「约 30 秒…」
- [ ] 记忆抽取仍用 `MEMORY_LLM_API_KEY`（抽一条记忆确认）

---

## 自测命令提示（按仓库习惯调整）

```bash
# Core / Proxy 单测（以各包 package.json 为准）
cd MemoryCore && npm test -- --grep maas
cd MemoryProxy && npm test -- --grep maas

# 内网打包（若你们用 deploy/dockerhub 或 internal-team pack）
# 改完后自建 amd64 镜像再上公司机
```

---

## 完成定义（DoD）

1. design 成功标准 §1 — ⏳ 待 Task 8 E2E  
2. §7.2 五个 handler 均已接入 — ✅  
3. 缓存 / 降级 / Hub TTL 文案与 env — ✅（Hub 需自建镜像才可见 UI）  
4. 内网 `.env.example` + compose — ✅（含 `.env.company.example`）  
5. 本 plan Task 1–7 代码勾选 — ✅；Task 8 E2E — ⏳；commit — ⏳；单测 — ✅  

---

## 参考

- 设计：`docs/superpowers/specs/2026-08-24-per-sk-mem-maas-api-key-design.md`
- 旧方案（废弃）：`docs/superpowers/specs/2026-08-21-per-user-upstream-*.md`
