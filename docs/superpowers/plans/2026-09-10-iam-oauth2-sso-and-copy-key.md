# IAM OAuth2 SSO + Copy Plaintext User Key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **给内网人工改代码：** 设计依据  
> - `docs/superpowers/specs/2026-09-08-company-oauth2-sso-design.md`  
> - `docs/superpowers/specs/2026-09-08-user-key-copy-plaintext-design.md`  
> 基线分支：`feat/iam-oauth2-sso-and-copy-key`（自 `release`）。按 Task 顺序做；**Phase A 可单独上线**，Phase B（复制明文）可同迭代或随后。

**Goal:** Hub 支持公司 IAMCenter OAuth2 登录（保留 user_key），首次确认建号/绑号；可选 Redis 会话；User_Key 列表可复制明文 sk-mem（仅主人）。

**Architecture:** 实现官方未落地的 `RedirectOAuth2Provider`；路由 `/auth/idp/oauth2/*`；Core `auth_provider=iam`、`external_id=规范化 email`；会话 Cookie `tdai_idp_session` + SessionStore（默认内存，可选 Redis）；确认页嵌在 LoginGate。复制明文走新 Core `user-key/reveal`，owner-only。

**Tech Stack:** TypeScript（MemoryPanel / MemoryCore）、Hono、现有 `encryptSecret`、Tea + react-i18next、可选 `ioredis`。

## Global Constraints

- `PANEL_AUTH_MODE=user_key,oauth2` 时：`oauth2` ⇒ `idpEnabled=true`，**不**自动开 WOA。
- 认人键：规范化 email（trim + lower）；查找先 `iam` 再 `local`。
- IdP 登录：**禁止**把 sk-mem 写入 localStorage；登出必须 `POST /auth/logout` + 清 localStorage。
- 确认页必须在 **LoginGate / 未登录分支**，不能只挂已登录 Router。
- `client_secret` / sk-mem / token **不进 git、不进日志全文**。
- MVP：**不做**吊销级联；Redis **可选**（默认 `local`）。
- 内网单 Hub 优先；多 Hub 再开 `PANEL_SESSION_STORE=redis`。
- 覆盖资料：本迭代新增 Core `user/update`（system_admin）；失败不阻断 SSO。

---

## File map

| 区域 | 路径 | 做什么 |
|------|------|--------|
| OAuth2 Provider | **新建** `MemoryPanel/src/panel/auth/oauth2-provider.ts` | authorize / token / userinfo |
| Auth 配置 | `MemoryPanel/src/panel/config/panel-config.ts` | `oauth2` 模式、OAUTH2_* env、Secure 跟 APP_URL |
| Session | `MemoryPanel/src/panel/auth/session-store.ts` | 接口改 async；可选 Redis 实现旁路文件 |
| Identity | `MemoryPanel/src/panel/auth/identity-store.ts` | 可选 Redis；`touchTTL` / `removeByUserKey` |
| Auth Service | `MemoryPanel/src/panel/auth/service.ts` | 注册 oauth2、lookup 双域、pending、覆盖资料、key 兜底 |
| Auth 路由 | `MemoryPanel/src/panel/http/routes/auth.ts` | oauth2 login/callback/pending/confirm-* |
| Header 中间件 | `MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts` | await async session |
| 前端 LoginGate | `MemoryPanel/web/src/components/LoginGate.tsx` | SSO 按钮 + pending 确认 UI |
| 前端 auth API | `MemoryPanel/web/src/lib/api/auth.ts` | methods/session/oauth2/logout |
| 前端 auth store | `MemoryPanel/web/src/stores/auth.ts` | logout 调后端 |
| 前端 session | `MemoryPanel/web/src/lib/panelSession.ts` | `authMethod`（若缺） |
| Core user update | `MemoryCore/.../v3-meta-schemas.ts` + `v3-meta-router.ts` + `metadata-service.ts` | `user/update` |
| Core reveal | 同上 + `toPublic` 旁路 | `user-key/reveal` |
| Panel META | `MemoryPanel/src/panel/api/meta-actions.ts` | 白名单 reveal（及 update 若走 meta） |
| ApiKey UI | `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx` | 复制图标 |
| i18n | `MemoryPanel/web/src/i18n/zh-CN.ts` + `en-US.ts` | 文案 |
| 部署示例 | `deploy/internal-team/.env.example`（或公司 env 样例） | 空变量名 |

---

# Phase A — IAM OAuth2 SSO

### Task 1: 配置 — `oauth2` ⇒ IdP 基础设施

**Files:**
- Modify: `MemoryPanel/src/panel/config/panel-config.ts`
- Modify: `.env.example` / `deploy/internal-team` 相关 example（只加空键名）

**Produces:**
- `oauth2Enabled`、`idpEnabled = woa || idp || oauth2`
- `PanelAuthConfig` 增加 oauth2 字段块（clientId/secret/urls/appUrl/redirectUri/scope/pkce/jsonPaths）
- `sessionSecure`：优先 `PANEL_AUTH_SESSION_SECURE`，否则看 `PANEL_AUTH_OAUTH2_APP_URL` 或 WOA appUrl 是否 https
- 缺必填时启动 throw，message 列出缺项

- [ ] **Step 1:** 改 `buildAuthConfig`：解析 `oauth2`；`idpEnabled` 含 oauth2；不设 `woaEnabled`
- [ ] **Step 2:** 读入 `PANEL_AUTH_OAUTH2_*`；拼默认 redirect = `{APP_URL}/api/v1/auth/idp/oauth2/callback`
- [ ] **Step 3:** 单测或启动脚本：只配 `user_key,oauth2` 且缺 secret → 启动失败；配齐 → `idpEnabled===true` 且 woa false
- [ ] **Step 4:** Commit：`feat(panel): enable IdP session when PANEL_AUTH_MODE includes oauth2`

---

### Task 2: Core — `user/update`（admin 覆盖展示字段）

**Files:**
- Modify: `MemoryCore/src/metadata/router/v3-meta-schemas.ts`
- Modify: `MemoryCore/src/metadata/router/v3-meta-router.ts`
- Modify: `MemoryCore/src/metadata/service/metadata-service.ts`

**Produces:**
- `POST /v3/meta/user/update` body: `{ user_id, username?, email?, display_name? }`
- 仅 `system_admin`（与 `user/create` 同 `assertCanManageUsers`）
- 不改 `external_id` / `auth_provider` / `user_type`

- [ ] **Step 1:** 加 zod schema + router bind
- [ ] **Step 2:** service：`updateUserProfileForAdmin` → `store.updateUser` 白名单字段
- [ ] **Step 3:** 单测：admin 可更新；非 admin 403；不可改 external_id
- [ ] **Step 4:** Commit：`feat(core): add admin user/update for IdP profile sync`

---

### Task 3: OAuth2 Provider + SessionStore async

**Files:**
- Create: `MemoryPanel/src/panel/auth/oauth2-provider.ts`
- Modify: `MemoryPanel/src/panel/auth/session-store.ts`（`create/get/destroy` → `Promise`）
- Modify: 所有调用方（`service.ts`、`validate-panel-headers.ts`、`auth.ts` routes）加 `await`
- Create（可选旁路）: `MemoryPanel/src/panel/auth/redis-session-store.ts` — **可放到 Task 8**；本 Task 先保证 Memory 版 async

**Produces:**
- `Oauth2Provider`：`id='oauth2'`，`authProviderDomain` 来自 config（默认 `iam`）
- `prepareAuthorize` / `authenticateFromCallback`
- email：`trim().toLowerCase()` 后作 `subject` / external_id

- [ ] **Step 1:** SessionStore 改 async；全仓编译通过
- [ ] **Step 2:** 实现 Provider（token POST form + Bearer userinfo；JSONPath 可配；默认无 PKCE）
- [ ] **Step 3:** Provider 单测：mock fetch — URL 编码、缺 email 失败、嵌套 `data.email` 可配 path
- [ ] **Step 4:** Commit：`feat(panel): add RedirectOAuth2Provider and async SessionStore`

---

### Task 4: AuthService — 双查、pending、建号/绑号、key 兜底、资料覆盖

**Files:**
- Modify: `MemoryPanel/src/panel/auth/service.ts`
- Modify: `MemoryPanel/src/panel/auth/identity-store.ts`（按需扩展接口）

**Produces（方法名可微调，语义锁死）：**
- `lookupCoreUserByExternal(email)`：先 `iam` 再省略 provider（local）
- `createOauth2Pending` / `getOauth2Pending` / `consumeOauth2Pending`（占坑 `open→consuming`，成功后删）
- `resolveOauth2Login`：binding 命中 → verify key；失败则双查 + 新签 key（官方 WOA 坑的反面）
- 命中用户后：Panel **服务端**用实例 `api_key` 调 Core `user/update`（不是浏览器直调）；catch 只 warn
- key 上限新签失败：pending `mode='bind_only'`

> `user/update` **不要**加进前端随意可调的 META 白名单（除非仅 admin 页需要）；SSO 同步只走 AuthService → metaKernel。

- [ ] **Step 1:** 泛化 `lookupCoreUserByExternal`，domain 来自本次 Provider，不再写死 `requireWoa()`
- [ ] **Step 2:** pending 存内存 Map（TTL 300s）；Redis 留 Task 8
- [ ] **Step 3:** 复用 `provisionIdentity` / `bindExternalAuth` 路径，domain=`iam`
- [ ] **Step 4:** 单测：双查顺序；binding 坏 key → 新签；update 失败仍登录
- [ ] **Step 5:** Commit：`feat(panel): oauth2 identity resolve, pending, and profile sync`

---

### Task 5: 路由 — `/auth/idp/oauth2/*` + logout 前端

**Files:**
- Modify: `MemoryPanel/src/panel/http/routes/auth.ts`
- Modify: `MemoryPanel/web/src/lib/api/auth.ts`
- Modify: `MemoryPanel/web/src/lib/api/base.ts`（确认 `request()` 已 `credentials: 'include'`；若无则补上，否则 IdP Cookie 不生效）
- Modify: `MemoryPanel/web/src/stores/auth.ts`

**Produces:**
- `GET .../oauth2/login` → 写 state → 302 IdP
- `GET .../oauth2/callback`：校验后 **DEL state**；已有用户 Set-Cookie + 302 `/`；首次写 pending + 302 **`/?pending={token}`**（推荐，保证进 LoginGate；不要只 302 到未挂载的 `/confirm` 路由）
- `GET .../oauth2/pending?pending=`
- `POST .../confirm-create` | `confirm-bind/preview` | `confirm-bind`（均 `credentials` 带 Cookie；create/bind 成功响应 Set-Cookie）
- 未启用 → login/callback 302 `/`
- `logout()`：先 `POST /api/v1/auth/logout`，再清 localStorage

- [ ] **Step 1:** 注册路由；Cookie 用 `buildSessionCookie`（SameSite=Lax）
- [ ] **Step 2:** confirm 安全检查（双查 + target_already_bound）；preview 不删 pending
- [ ] **Step 3:** 路由单测：无 state / pending 过期 / 并发 consume
- [ ] **Step 4:** 前端 logout + 确认 fetch credentials
- [ ] **Step 5:** Commit：`feat(panel): wire oauth2 auth routes and IdP logout`

---

### Task 6: LoginGate — SSO 按钮 + 确认页 UI

**Files:**
- Modify: `MemoryPanel/web/src/components/LoginGate.tsx`（**唯一**确认页挂载点）
- Modify: `MemoryPanel/web/src/lib/api/auth.ts`
- Modify: `MemoryPanel/web/src/i18n/zh-CN.ts` + `en-US.ts`
- Modify: `MemoryPanel/web/src/components/login-gate.css`（按需）
- **不要**只在 `routes.tsx` 加 `/confirm` 页面（未登录进不去）

**Produces:**
- methods 含 `oauth2` →「公司IAM登录」→ `assign(/api/v1/auth/idp/oauth2/login?instance_id=…)`
- `useEffect` 读 `URLSearchParams pending` → `GET .../pending` → 确认 UI；`mode=bind_only` 隐藏自动建号
- create：对话框展示 `skMem` → 关闭后清空 React state 中的明文 → `checkSession()` / `onLoggedIn`；**禁止** `setPanelSession({ userKey: skMem })`
- bind：成功后 `checkSession()` 进主界面

- [ ] **Step 1:** SSO 按钮
- [ ] **Step 2:** pending 确认 UI（可参考现有 WOA pending 区块）
- [ ] **Step 3:** 与 IdP `resumeSession` 路径联调（Cookie 会话、userKey 空串）
- [ ] **Step 4:** i18n
- [ ] **Step 5:** Commit：`feat(panel-web): IAM login button and LoginGate confirm flow`

---

### Task 7: 部署文档 / env 样例（内网）

**Files:**
- Modify: 内网 deploy 的 `.env.example` 或 README 一小节说明

- [ ] **Step 1:** 列出必填 `PANEL_AUTH_OAUTH2_*` + `PANEL_AUTH_MODE=user_key,oauth2`（值为空）
- [ ] **Step 2:** 写清：登记 `redirect_uri`、单机默认不必 Redis
- [ ] **Step 3:** Commit：`docs(deploy): document IAM oauth2 env for internal Hub`

---

### Task 8（可选，多实例再做）: Redis Session + Identity

**Files:**
- Create: `MemoryPanel/src/panel/auth/redis-session-store.ts`
- Modify: identity-store / panel-deps 注入
- Env: `PANEL_SESSION_STORE=redis` + `PANEL_REDIS_*`

- [ ] **Step 1:** Redis session 加密后 SET；state/pending/identity 全进 Redis（见 spec §12.0）
- [ ] **Step 2:** email key 段 `encodeURIComponent`
- [ ] **Step 3:** 单测 mock ioredis 或集成测
- [ ] **Step 4:** Commit：`feat(panel): optional Redis store for IdP session and identity`

**内网单 Hub 可跳过本 Task。**

---

# Phase B — Copy plaintext User Key

### Task 9: Core `user-key/reveal`

**Files:**
- Modify: `MemoryCore/src/metadata/router/v3-meta-schemas.ts`
- Modify: `MemoryCore/src/metadata/router/v3-meta-router.ts`
- Modify: `MemoryCore/src/metadata/service/metadata-service.ts`
- Modify: `MemoryPanel/src/panel/api/meta-actions.ts`

**Produces:**
- `POST /v3/meta/user-key/reveal` `{ key_id }` → `{ key_id, key_value }`
- 条件：`caller.user_id === key.user_id`；status=active；未过期
- **禁止** admin 代 reveal（不要走 `assertUserScope` 的 admin 旁路）

- [ ] **Step 1:** schema + service + router
- [ ] **Step 2:** 单测：主人 OK；他人/admin 拒；吊销拒；过期拒
- [ ] **Step 3:** Panel `META_ACTIONS` 加 `user-key/reveal`
- [ ] **Step 4:** Commit：`feat(core): add owner-only user-key/reveal`

---

### Task 10: Hub UI 复制图标

**Files:**
- Modify: `MemoryPanel/web/src/lib/api/users.ts`
- Modify: `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx`
- Modify: i18n

- [ ] **Step 1:** `userKeysApi.reveal(keyId)`
- [ ] **Step 2:** Key Prefix 旁复制图标；点图标 → reveal → clipboard；成功 toast
- [ ] **Step 3:** 确认 IdP 会话下列表仍可用（依赖现有 panelMeta 注入 userKey）
- [ ] **Step 4:** Commit：`feat(panel-web): copy full sk-mem via reveal on ApiKeys page`

---

# 验收清单（内网 UAT）

- [ ] `PANEL_AUTH_MODE=user_key,oauth2` 出现「公司IAM登录」，能跳到 IAM
- [ ] 首次：建号 → 复制 sk-mem → 进 Hub；二次 SSO 不再确认页
- [ ] 首次：绑已有 sk-mem → 进同一 `user_id`；团队资产仍在
- [ ] DevTools：`tdai-panel.session.userKey` 为空；有 `tdai_idp_session`
- [ ] 登出后再进需重新 SSO（或 user_key）
- [ ] 关掉 oauth2 后行为与现在一致
- [ ] （Phase B）主人可复制；admin 不能复制别人的 key

---

## 计划审查记录（多轮，内网口径）

### 第 1 轮 — Spec 覆盖
- oauth2⇒idp、Provider、双查、LoginGate 确认、pending GET、user/update、key 兜底、登出、reveal：均有 Task。
- Redis / 吊销级联：标为可选 Task 8 / 不做 MVP，与 spec 一致。

### 第 2 轮 — 可执行性 / 现网陷阱
- 修正：callback 推荐 302 `/?pending=`，确认页只挂 LoginGate。
- 修正：`credentials: 'include'` 写进 Task 5。
- 修正：`user/update` 仅 AuthService 用 api_key，不开放普通 META。

### 第 3 轮 — 功能/使用/安全（内网）
- 无明显断点；Phase A 可独立交付。
- 残留运维项：UAT `redirect_uri` 白名单、真实 secret 配机器——不挡编码。
- **结论：计划可执行。**

---

**Plan saved:** `docs/superpowers/plans/2026-09-10-iam-oauth2-sso-and-copy-key.md`

执行方式：

1. **Subagent-Driven（推荐）** — 每 Task 新开子代理  
2. **Inline Execution** — 本会话连续做  

要开做时选一个即可。
