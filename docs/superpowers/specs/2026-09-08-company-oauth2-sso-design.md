# 方案：Hub 对接公司 OAuth2 SSO（马上消费 IAMCenter）

- 日期：2026-09-08（2026-09-10 修订：email/`iam`、确认页、Redis、三轮审查补丁）
- 状态：设计稿（内网部署口径：功能/使用/安全无已知明显漏洞；待确认后写实施计划）
- 背景：官方 2.0.2-beta.1 的 Panel 登录已有 IdP 骨架，落地的是腾讯内网 **WOA 网关注入头**；标准授权码 OAuth2（`RedirectOAuth2Provider`）**接口先立位、未实现**。公司架构部已下发 IAMCenter UAT 的 `client_id` / `client_secret` / authorize / token / userinfo。目标是员工用公司账号登 Hub，不必每人先找管理员要 `sk-mem`。
- 认人唯一键（已锁定）：**`email`**（邮箱终身不变、一人一条，由架构部 2026-09-09 确认）
- 相关代码（`release`）：
  - `MemoryPanel/src/panel/auth/types.ts`（`RedirectOAuth2Provider`）
  - `MemoryPanel/src/panel/auth/service.ts`（WOA 建号 / `find-by-external` / `create-with-key`）
  - `MemoryPanel/src/panel/http/routes/auth.ts`（仅 `/auth/idp/woa/*`）
  - Core `user/find-by-external`、`user/create`（`external_id` + `auth_provider`）

## 1. 目标

1. Hub 登录页在保留 **user_key** 的同时，增加 **「公司IAM登录」**。
2. 走标准授权码：浏览器跳转 IAMCenter → 带回 `code` → Panel 换 token → 拉 userinfo → 映射成 Hub 用户。
3. 首次 SSO（该公司账号尚未绑过 Hub 用户）：进入确认页，二选一——**自动建号并一次性展示新 sk-mem**，或 **本人填写已有 sk-mem 绑定**（团队、key、资产保留）。**可以关掉走人**（不建号、不绑定，回到登录页；pending 作废）。不自动加入任何团队。不做管理员在 Hub 后台代绑。Hub 展示用公司 **用户名 / 邮箱**，不把工号当显示名。
4. 再次 SSO：按官方查找顺序命中已有用户（先 `iam` 再 `local`，见 §7.1），直接进 Hub，不再展示 key。每次登录用通讯录 **覆盖** `username` / `email` / `display_name`（覆盖的是展示字段，不是认人键）。
5. 所有 SSO 地址与密钥走 **环境变量**，不进 git。Hub 对外根用 `PANEL_AUTH_OAUTH2_APP_URL`，部署时再填。

```text
员工浏览器
  点「公司IAM登录」
        │
        ▼
Panel  GET /api/v1/auth/idp/oauth2/login
  生成 state（默认不带 PKCE）
  302 → authorization_url?client_id&redirect_uri&state&response_type=code
        │
        ▼
IAMCenter 登录
  302 → redirect_uri?code&state
        │
        ▼
Panel  GET /api/v1/auth/idp/oauth2/callback
  校验 state
  POST token_url（client_id + secret + code + redirect_uri）
  GET  userinfo_url（Bearer access_token）
  映射 ExternalIdentity
  find-by-external：先 (iam, 规范化 email)，再 (local, 规范化 email)
  任一命中 → 直接登录（Set-Cookie）+ 覆盖展示字段（失败不阻断）
  两个都未命中 → 写 pending，302 → /confirm?pending=…（不 Set-Cookie）
  LoginGate 读 pending → GET .../oauth2/pending 展示身份 → 用户确认
        │
        ▼
浏览器回 Hub
  resumeSession：…
    localStorage 里有 userKey → 仍走今天的 user_key 路
    没有 → GET /api/v1/auth/session（自动带 Cookie）
      authenticated=true → 面板切成已登录
      禁止把会话里的 sk-mem 再写入 localStorage
        │
        ▼
之后 Hub meta：前端不带 X-Tdai-User-Key；Panel 用 Cookie 取出会话里的 key 调 Core
客户端连 Proxy 仍用 sk-mem
```

### 成功标准（MVP）

1. UAT 上 `PANEL_AUTH_MODE=user_key,oauth2` 时，登录页出现「公司IAM登录」；点了能跳到架构部给的 `authorization_url`。
2. 登完回到 Hub：**页面离开 LoginGate、进入控制台**（靠 `/auth/session` 认 Cookie，不是靠 localStorage 里有 sk-mem）。Core 里该员工能被 §7.1 的查找命中（自动建号 / 绑老号后一般为 `iam`；历史数据可能仍是 `local`，靠双查兜底）。
3. 该公司账号第一次进来：可「自动建号」（复制一次新 sk-mem，**不加入团队**）、「绑定已有 sk-mem」，或关掉确认页回登录（不建号）。绑过或建过之后，第二次 SSO **不再出确认页**。每次登录用通讯录覆盖用户名/邮箱，不用工号当显示名。
4. 关掉 oauth2 或漏配时，行为与现在一样：只有 user_key，Panel 能启动。
5. `client_secret` 只出现在运行环境，不进仓库、不进前端、不进接口响应。
6. `redirect_uri` 与 SSO 控制台白名单、authorize 请求里带的值 **三处同一字符串**。

## 2. 非目标

- 不接腾讯 WOA（`x-tai-identity`）。公司 IdP 不是那套网关。
- 不改 MemoryProxy / Claude Code 登录方式（继续 `sk-mem`）。
- 不做 OIDC Discovery、refresh_token 续 Panel 会话（Panel 继续用现有 Cookie TTL；持久化靠 §12 可选 Redis）。
- 不把 OAuth access_token 拿去调 MaaS / Proxy。
- 不配默认团队（不设 `DEFAULT_TEAM_ID`；新用户由管理员事后拉进团队）。
- 不做管理员代绑：没有「把邮箱绑到某 user」的后台入口。绑定只发生在本人 SSO 之后的确认页（填一把属于该 user 的 sk-mem）。
- 不把 UAT 的 client 配进镜像默认值。

## 3. 方案选择（已锁定 A）

| | 做法 | 评价 |
|---|---|---|
| **A（采用）** | 实现官方 `RedirectOAuth2Provider`，新路由 `/auth/idp/oauth2/*`，`auth_provider=iam` | 和 WOA 并列，官方升级不踩同一条路 |
| B | 把 WOA Provider 改成打 OAuth2 | 协议完全不同，后续合官方必炸 |
| C | 公司网关注入头，Panel 继续 header-injected | 要架构部改网关，本迭代不可控 |

## 4. `redirect_uri`

登记给架构部、写进 env、authorize 请求里，必须完全一致。

默认由对外根地址拼出（少一个易配错的项）：

```text
{PANEL_AUTH_OAUTH2_APP_URL 去尾斜杠}/api/v1/auth/idp/oauth2/callback
```

例：Hub UAT 浏览器里是 `http://hub.xxx.msxfyun.test:8125`，则

```text
http://hub.xxx.msxfyun.test:8125/api/v1/auth/idp/oauth2/callback
```

**不要把 `instance_id` 写进登记 URI**（路径、query 都不行）。OAuth2 对 `redirect_uri` 做精确匹配，IdP 白名单认的是「Hub 回调入口」，不是「哪套 Core」。登录页先选 instance，再点 SSO；`instance_id` 只放服务端 `state`（以及回来后的会话），callback 路径始终这一条。

### 两种公司部署

| 模式 | 登记几条 redirect | 填什么 |
|---|---|---|
| **共用 Hub**：1 个 Hub，6 个 instance，各挂一套 Core+Proxy | **1 条** | 这台 Hub 的对外根 + `/api/v1/auth/idp/oauth2/callback` |
| **分套 Hub**：每团队自己一套 Hub（+ Core+Proxy） | **每套 Hub 1 条** | 各自 `APP_URL` 拼出的 callback；同一 `client_id` 在控制台加多条白名单（或每套一个 client） |

共用 Hub 时：6 套 Core 用户表互不相通。同一邮箱进 instance A / B 会是两个 user、两把 sk-mem；绑定已有 key 必须先选对 instance，那把 key 也必须属于那套 Core。这和今天 user_key 登录先选实例是同一语义。

- 本机联调才用 `http://127.0.0.1:8125/api/v1/auth/idp/oauth2/callback`，且 SSO 控制台要单独加这条白名单。
- 允许用 `PANEL_AUTH_OAUTH2_REDIRECT_URI` **覆盖**拼出来的值（网关剥端口、https 终结时用）。

**待你确认 Hub UAT 对外 URL 后，把完整 `redirect_uri` 发给架构部。**

## 5. 环境变量

`PANEL_AUTH_MODE` 增加可选值 `oauth2`（可与 `user_key` 组合，建议始终保留 user_key）。

**配置锁死（现网必改一点）：** 官方 `panel-config` 今天是 `idpEnabled = woa || modes.has('idp')`。只配 `oauth2` **不会**生成 `sessionSecret`、不会启用 Cookie 会话。实现时必须改成：

```text
oauth2Enabled = modes.has('oauth2')
idpEnabled    = woaEnabled || modes.has('idp') || oauth2Enabled
```

- `oauth2` ⇒ 打开 IdP 会话基础设施（secret / Cookie / SessionStore）
- **不要**因为开了 oauth2 就打开 WOA（`woaEnabled` 仍只看 `woa`）

| 变量 | 必填（开启 oauth2 时） | 说明 |
|---|---|---|
| `PANEL_AUTH_OAUTH2_DISPLAY_NAME` | 否 | 按钮文案，默认 `公司IAM登录` |
| `PANEL_AUTH_OAUTH2_CLIENT_ID` | 是 | 架构部 client_id |
| `PANEL_AUTH_OAUTH2_CLIENT_SECRET` | 是 | 只放机器 `.env` / 密钥平台 |
| `PANEL_AUTH_OAUTH2_AUTHORIZATION_URL` | 是 | 浏览器跳转 |
| `PANEL_AUTH_OAUTH2_TOKEN_URL` | 是 | Panel 服务端 POST |
| `PANEL_AUTH_OAUTH2_USERINFO_URL` | 是 | Panel 服务端 GET |
| `PANEL_AUTH_OAUTH2_APP_URL` | 是 | Hub 对外根，用来拼 redirect_uri |
| `PANEL_AUTH_OAUTH2_REDIRECT_URI` | 否 | 覆盖拼出的 callback |
| `PANEL_AUTH_OAUTH2_SCOPE` | 否 | 有则带上；空则 authorize 不带 `scope`（与同事 `OAuthClient` 一致） |
| `PANEL_AUTH_OAUTH2_PKCE` | 否 | **默认 `false`**。同事示例未发 `code_challenge`；IAM 若要求再开 |
| `PANEL_AUTH_OAUTH2_TOKEN_AUTH` | 否 | 已锁定 **POST form body**（与示例 `data=payload` 一致）：`grant_type` / `code` / `redirect_uri` / `client_id` / `client_secret`。Header 加 `Accept: application/json` |
| `PANEL_AUTH_OAUTH2_USERINFO_TOKEN` | 否 | 已锁定 **GET + `Authorization: Bearer {access_token}`** |
| `PANEL_AUTH_OAUTH2_SUBJECT_JSONPATH` | 否 | 认人键。**已锁定默认 `email`**（架构部 2026-09-09） |
| `PANEL_AUTH_OAUTH2_LOGIN_JSONPATH` | 否 | 默认 `username` |
| `PANEL_AUTH_OAUTH2_NAME_JSONPATH` | 否 | 默认 `nickname` |
| `PANEL_AUTH_OAUTH2_EMAIL_JSONPATH` | 否 | 默认 `email` |
| `PANEL_AUTH_SESSION_TTL_SECONDS` | 否 | 会话有效期，默认 28800（8 小时）。`local` / `redis` 都用这个值 |
| `PANEL_SESSION_STORE` | 否 | `local`（默认）或 `redis`。见 §12 |
| `METADATA_EXTERNAL_AUTH_PROVIDER` | 否 | 写入 Core 的域，**本方案默认 `iam`**（不要用 `woa`） |

`.env.example` 只留空变量名。真实值按环境分文件，gitignore。

开启 oauth2 但缺 client_id/secret/三个 URL/`APP_URL`（且无显式 redirect）→ **启动失败并打出缺哪几个**，避免跳到空地址。

`PANEL_SESSION_STORE=redis` 时还要配 Redis 连接参数，见 §12.2。

## 6. 代码落点

新建 `MemoryPanel/src/panel/auth/oauth2-provider.ts`，实现 `RedirectOAuth2Provider`：

- Provider **`id`**（稳定键，如 `oauth2`）≠ Core **`authProviderDomain`**（本方案 `iam`，可用 `METADATA_EXTERNAL_AUTH_PROVIDER` 覆盖）。会话 / identity 缓存里的 `providerId` 用 Provider `id`；写入 Core 的 `auth_provider` 用 `authProviderDomain`。不要把两者都写成 `iam` 或都写成 `oauth2`。
- `prepareAuthorize({ state, redirectUri })` → authorize URL（`client_id`、`redirect_uri`、`response_type=code`、`state`；`scope` 有配才带。默认 **不带 PKCE**）
- `authenticateFromCallback({ code, redirectUri })` → **POST** `token_url`（form body 换 token，`Accept: application/json`）→ GET userinfo（Bearer）→ 按同事 `normalize_user_info` 映射；**email 先规范化再当 subject**（§7）

`PanelAuthService`：

- `oauth2.enabled` 时 `providers.register(...)`；`listMethods()` 增加 `{ id: 'oauth2', type: 'oauth2', display_name }`（前端联合类型扩 `oauth2`）
- 复用 `provisionIdentity` / `find-by-external`，**不要复制一套 WOA 建号**；WOA 错误码抽成 IdP 通用或加 `OAUTH2_*` 别名
- `state` / `pending` / `session` / `identity`：存储后端见 §12.0（`redis` 模式四类都必须进 Redis）
- **login**：`GET /auth/idp/oauth2/login?instance_id=xxx` 写 state，302 到 IdP；callback 用 state 取回 `instanceId`

**接口异步化：** `SessionStore` / Identity / pending 全部 `Promise`；auth 路由、`validate-panel-headers`、logout 一并 `await`。

后端路由（`/api/v1`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/auth/idp/oauth2/login` | 写 state，302 到 IdP |
| GET | `/auth/idp/oauth2/callback` | 已有用户：session + Set-Cookie + 302 `/`。首次：写 pending + **一次性消费 state** + 302 `/confirm?pending=…` 或 `/？pending=…`（**不 Set-Cookie**） |
| GET | `/auth/idp/oauth2/pending` | 用 `pending` query 返回可展示身份（§7.2）；无 sk-mem |
| POST | `/auth/idp/oauth2/confirm-create` | 自动建号（§7.2） |
| POST | `/auth/idp/oauth2/confirm-bind/preview` | 绑老号预览（不消费 pending） |
| POST | `/auth/idp/oauth2/confirm-bind` | 绑老号确认 |
| GET | `/auth/session` | 复用官方；Cookie → 已登录（确认页不依赖它带 pending） |
| POST | `/auth/logout` | 复用官方；清后端会话 + 过期 Cookie |

oauth2 未启用时 login/callback **302 `/`**。

**前端落点：**

1. `LoginGate.tsx`：SSO 按钮 → `window.location.assign('/api/v1/auth/idp/oauth2/login?instance_id=...')`
2. **确认页（锁死挂载位置）：** 现网 `App.tsx` 未登录只渲染 `LoginGate`，**不挂载** `RouterProvider`。因此确认页 **必须做在 `LoginGate` 内**（读 `location.search` 的 `pending=`，或路径仍是 `/` / `/confirm` 但由 LoginGate/App 在 `auth===undefined` 时渲染），**禁止**只把 `/confirm` 加进已登录后的 `routes`——那样 callback 回来永远进不了确认页。官方 WOA pending UI 也在 LoginGate 内，对齐即可。
3. **确认页展示身份：** 见 §7.2「读取 pending 展示信息」。不要在浏览器放 `client_secret`。

### 6.1 Hub 登录态：两条路，不要搅在一起

今天这套 Hub（`App` → `checkSession` → `resumeSession`）**只认 localStorage** `tdai-panel.session`：有 `{ instance_id, user_key, user }` 才算已登录；之后每个 meta 请求前端自己带 `X-Tdai-User-Key`。

官方 IdP（WOA 已落地、本方案跟同一套）是另一条路：

| | user_key 登录（今天） | IAM / 官方 IdP |
|---|---|---|
| 浏览器里的凭证 | localStorage 明文 `sk-mem-…` | HttpOnly Cookie `tdai_idp_session=<UUID>`，JS **读不到** |
| 明文 sk-mem 在哪 | 浏览器 localStorage | Panel 会话存储（内存或 Redis，见 §12）；Cookie 里没有 key |
| 前端怎么知道已登录 | 读 localStorage | **必须** `GET /api/v1/auth/session`（`credentials: include`） |
| 之后调 Core | 前端 Header 带 `X-Tdai-User-Key` | 前端 **不带**；中间件用 Cookie 取出会话里的 `userKey` |

**只 Set-Cookie 不够。** 回调 302 回 Hub 后，`resumeSession` 若仍只读 localStorage，会 **Cookie 已登、页面还在 LoginGate**。

实现跟官方 `LoginGate.resumeSession` 同一顺序：

1. localStorage 里已有非空 `userKey` → `auth/verify`（user_key 路）。
2. 否则 → `GET /api/v1/auth/session`。`authenticated === true` 才写 React auth，并 `setPanelSession({ authMethod: 'idp', instanceId, userKey: '', user })`。
3. **`userKey` 必须是空字符串。** 禁止把会话里的 sk-mem 写入 localStorage。确认页展示的 key 只给 Proxy/Claude Code，不是 Hub 登录凭证。
4. meta 请求：`session.userKey` 为空则 **省略** `X-Tdai-User-Key`。
5. 带 Cookie 的请求必须 `credentials: 'include'`。

**登出（统一双向清）：** 无论哪种登录方式，`logout()` 必须：

1. 先 `POST /api/v1/auth/logout`（清后端会话——内存或 Redis——+ Cookie 过期）
2. 再清 localStorage / React auth

不能只清一边，否则刷新会「复活」（SSO Cookie 或 localStorage userKey 残留）。无 Cookie 时 `/auth/logout` 仍调一次（幂等）。

```typescript
async function logout() {
  try {
    await authMethodsApi.logout();  // POST /auth/logout
  } catch {
    // 忽略：可能没有 Cookie
  }
  clearPanelSession();
  _authCache = null;
}
```

**刷新 / 新开 tab：** IdP 路每次问 `/auth/session`。

**重启行为（按 `PANEL_SESSION_STORE`）：**

| 模式 | Hub 进程重启后 |
|---|---|
| `local`（默认） | 内存会话没了，Cookie UUID 失效 → 重新 SSO。**不要**把 key 塞进 localStorage 抗重启 |
| `redis` | 会话在 Redis，Cookie 仍有效 → **不必**重新 SSO（见 §12） |

**多 tab：** localStorage 与 Cookie 共享；一 tab 登出，其它 tab 刷新进登录页。预期行为。

## 7. 身份映射

对照同事 `OAuthClient.normalize_user_info`（userinfo JSON 字段）：

```text
email, username, nickname, avatar_url  （avatar 可回落 picture）
```

Hub 对人有用的是 **用户名、邮箱**。头像 MVP **不展示**；可写入 `raw_profile_json`。

| Hub 字段 | 来自 userinfo | 何时写 |
|---|---|---|
| `username` | `username`；没有则规范化后 `email` 的 `@` 前一段 | **每次 SSO 覆盖**（失败不阻断登录，见下） |
| `email` | 规范化后的 `email` | **每次 SSO 覆盖**（失败不阻断） |
| `display_name` | `nickname`；没有则等于 username | **每次 SSO 覆盖**（失败不阻断） |
| `external_id` | **规范化后的 `email`** | 建号或绑定时写一次，之后不改 |

**Email 规范化（锁死，作 `external_id` / subject 之前必须做）：**

1. `trim`
2. Unicode 邮箱按 `toLowerCase()`（MVP；若架构部另有规则再改 env/代码一处）
3. 空 → 登录失败

未规范化会导致 `Alice@X.com` 与 `alice@x.com` 变成两个 Hub 用户。

**已确认（2026-09-09）：规范化后的 `email` 终身不变、一人一条。** `SUBJECT_JSONPATH` 默认 `email`。

极端邮箱变更：Core 找不到旧号 = 新用户。展示字段每次覆盖；**认人键写入后不随登录更新。**

认人键缺失 → 登录失败。缺 username 但有 email → 用 local-part 作 username。

不覆盖：`user_id`、user_key、团队、`user_type`。

Hub `username` 非法字符换成 `_`。

**每次登录覆盖资料（锁死实现路径）：** 现网 **没有** `POST /v3/meta/user/update` 路由（仅有 create/get/list/delete/find-by-external/bind-external；`store.updateUser` 只给内部用）。本方案 **必须新增** Core action：

- `POST /v3/meta/user/update`：`{ user_id, username?, email?, display_name? }`
- 鉴权：与建号相同，**仅 system_admin**（Panel 用实例 `api_key` 调用）
- Panel 在 SSO 命中已有用户后调用；**失败只 warn，不阻断登录**

不要写「调已有 user/update」——它还不存在，要本迭代加上。

**Cookie Secure：** 官方今天跟 `PANEL_AUTH_WOA_APP_URL` 是否 https。只开 oauth2、不开 WOA 时，改用 `PANEL_AUTH_OAUTH2_APP_URL`（或显式 `PANEL_AUTH_SESSION_SECURE`）决定 `Secure`，避免 http UAT 误加 Secure 导致 Cookie 存不上。

### 7.1 认人查找与绑老号（跟官方 WOA 同一套，域换成 `iam`）

Core 认人键是 **`(auth_provider, external_id)`**。对照 `lookupCoreUserByExternal` / `bindExternalAuth`，**不要另写一套 Core 逻辑**。

| 怎么进 Hub | 写入 | 之后 `auth_provider` |
|---|---|---|
| 自动建号 `user/create` | `auth_provider=iam` + `external_id=email` | **`iam`** |
| 绑老号 `bind-external` | 带 `auth_provider=iam` | **一般为 `iam`**（现网 Core patch 会写 `auth_provider`；与旧注释「不改」不一致） |

**查找顺序（锁死）：**

1. `find-by-external`：`(iam, email)`
2. 未命中再省略 `auth_provider`（Core 默认 `local`）——兜底历史/异常数据
3. 两次都没有 → 真·首次 → 确认页
4. 任一命中 → 同一 `usr-xxx` 直接登录，禁止再弹确认页、禁止再自动建号

不要去查 `woa`。`METADATA_EXTERNAL_AUTH_PROVIDER` 默认 `iam`。

### 绑定缓存与 key 无效兜底

`panel-auth-identities`（文件或 Redis）缓存「唯一键 → usr-xxx + 加密 sk-mem」。

**多实例：** `PANEL_SESSION_STORE=redis` 时 identity 也进 Redis（与 session 同实例、同 key 前缀策略）。`local` 时仍用本地 JSON。

```typescript
const IDENTITY_BINDING_TTL_SECONDS = 90 * 24 * 60 * 60; // 仅 Redis

interface IdentityStore {
  find(instanceId: string, providerId: string, externalSubject: string): Promise<IdentityBinding | null>;
  save(binding: IdentityBinding, plainUserKey: string): Promise<void>;
  touchTTL?(instanceId: string, providerId: string, externalSubject: string): Promise<void>;
  removeByUserKey(instanceId: string, plainUserKey: string): Promise<void>;
}
```

Redis key 用 `:` 分隔；**email 段必须 `encodeURIComponent`**（防 email 含 `:` 拆坏 key）：

```text
{keyPrefix}identity:{instanceId}:{providerId}:{encodeURIComponent(email)}
{keyPrefix}identity-by-userkey:{instanceId}:{sha256(userKey)}
```

`providerId` 此处是 **Provider.id**（如 `oauth2`），不是 `iam`。

**Identity binding TTL 续期：** Redis 模式 90 天；`find` 命中且 key 验活成功后 `touchTTL()`（`EXPIRE`，O(1)）。File 模式 `touchTTL` 为 no-op。

**Key 无效兜底（锁死，不能只靠吊销级联）：**

官方 WOA 坑：json 里 key 已吊销 → verify 失败 → 整次 SSO 401，不去 `find-by-external`。

本方案：**binding 命中但 key 验不过**（吊销 / 过期 / verify 失败 / 级联漏清 / Core 侧直接 revoke）→ **当缓存未命中**：

1. 按 §7.1 双查 `find-by-external`，人还在就直接登录（不出确认页）
2. 给该 `usr-xxx` **新签一把** sk-mem，写回 binding + 本次会话
3. 其它未吊销的 key 不受影响，Proxy 仍可用旧 key（若仍 active）
4. 活跃 key 已满签不出 → **不要当成「真·首次」乱建号**。写 pending 时带 `mode: 'bind_only'`（或等价字段）；`GET .../pending` 返回该标记。确认页文案：「你的公司账号已在系统中，请粘贴一把仍有效的 sk-mem」；**隐藏「自动建号」**。只保留绑 key + 关掉走人。

吊销级联（§12.5）是加速清理，**不是**唯一正确性来源。MVP **可以不做级联**，只靠本兜底；有 `user-key/reveal` 后再加级联。

**吊销 sk-mem ≠ 解绑 IAM。** Core `(iam, email)` 还在。

**每个 `usr-xxx` 至少留一把 active sk-mem。** Core 已有 `last_key_cannot_revoke`；Hub 对最后一把禁用吊销。

### 7.2 首次 SSO 确认页详细流程

首次 SSO 进确认页。三种选择，pending 生命周期 5 分钟。

#### Pending 状态存储

callback 完成后 **不立即 Set-Cookie**，生成一次性 `pending_token`：

```typescript
interface PendingState {
  pendingToken: string;
  instanceId: string;
  providerId: string;          // Provider.id，如 'oauth2'（不是 authProviderDomain）
  externalSubject: string;     // 规范化后的 email
  identity: ExternalIdentity;
  returnTo: string;            // 完成后跳转，默认 '/'
  createdAt: number;
  status: 'open' | 'consuming';
  mode: 'create_or_bind' | 'bind_only'; // 真·首次 vs 仅缺有效 key
  verifiedUserKeyHash?: string;
}
```

- redis：`{keyPrefix}pending:{pendingToken}`，TTL 300s  
- local：内存 Map + 5 分钟过期  

callback 302：优先 `/confirm?pending={pendingToken}`（LoginGate/App 未登录分支认这个 path 或 query）；也可用 `/?pending=`。

#### 读取 pending 展示信息（锁死）

确认页打开后立刻：

```http
GET /api/v1/auth/idp/oauth2/pending?pending={pendingToken}
```

200 示例（**不含** sk-mem / access_token）：

```json
{
  "instance_id": "…",
  "display_name": "张三",
  "login_name": "zhangsan",
  "email": "zhangsan@msxf.com",
  "mode": "create_or_bind",
  "expires_at": 1234567890
}
```

- `mode`: `create_or_bind`（真·首次）| `bind_only`（账号已在、仅差有效 key）
- pending 无效/过期 → 400 `pending_expired`；前端回登录表单
- **不要**靠把姓名邮箱塞进 URL query；**不要**复用 WOA pending Cookie（除非整段改回官方模型）

OAuth `state`：callback **校验成功后立即删除**（一次性），防 code/state 重放。

#### Pending 占坑与消费（防并发，且防 create 失败丢单）

**禁止**「先 GETDEL 再 `user/create`」。否则 create 成功、建 session 失败时 pending 已没，用户卡死。

正确顺序：

1. **原子占坑**：`open` → `consuming`（Redis Lua / WATCH；local 同 tick）。第二次 → `pending_consumed`。
2. 执行 Core 建号或绑定 + binding + session + Set-Cookie。
3. **成功后再删除** pending。
4. **失败**：按下方 MVP 策略；**禁止**先 GETDEL 再 create。

**崩溃自愈：** 若进程在 `consuming` 中挂掉，pending 靠 **5 分钟 TTL** 过期即可，不要做永久锁。用户重新 SSO。

**MVP 失败策略（锁死）：**

- `user/create` 已成功但后续失败：用返回的 `user_id` 再试 binding + session；仍失败 → 500 + log `user_id`；**删除 pending**（防重放再建号）。用户再 SSO 应被 §7.1 命中。
- `user/create` 未成功：删 pending + `user_create_failed`，重新 SSO。

**preview 禁止占坑/删除 pending**，只更新 `verifiedUserKeyHash` 并续期 TTL。

#### 确认页三种操作

**① 自动建号**

- `POST /auth/idp/oauth2/confirm-create` `{ pendingToken }`
- 占坑 → `user/create`（`auth_provider=iam`, `external_id=email`）→ binding → session → 删 pending
- 200 JSON（Set-Cookie 在响应头）：

```json
{ "skMem": "sk-mem-xxx", "redirectUrl": "/" }
```

- **`redirectUrl` 统一为 `/`**（进 Hub 根，由前端路由进控制台）。不要写 `/hub`。
- 前端展示一次性「复制 Key」对话框：关对话框后 **清空组件 state 中的 skMem**；**禁止**写入 localStorage；access/应用日志不得打印 `skMem` 全文（与 §8 一致）
- 关闭后 `location.href = redirectUrl`
- **不加入团队**

**② 绑定已有 sk-mem（两步）**

步骤 1 — preview（不消费 pending）：

- `POST .../confirm-bind/preview` `{ pendingToken, userKey }`
- `auth/verify` 失败 → 400 `invalid_key`
- **安全检查（与 §7.1 相同双查，锁死）：**
  1. `find-by-external(iam, email)` 再 `(local, email)`：若已绑到 **其它** `user_id` → 409 `identity_already_bound`
  2. 已绑到 **当前 verify 得到的同一** `user_id` → 允许（幂等）
  3. **目标账号已有非占位 `external_id`**（不等于 `user_id` 占位）且 **≠ 当前规范化 email** → 409 `target_already_bound_other_identity`（防止 bind-external 覆盖掉该账号原有外部身份）
- 通过 → 写 `verifiedUserKeyHash = sha256(userKey)`，续期 pending 5 分钟
- 200：`{ username, email, userId }`

步骤 2 — confirm：

- `POST .../confirm-bind` `{ pendingToken, userKey }`
- 校验 `verifiedUserKeyHash`；**再次执行与 preview 相同的双查 + 目标 external_id 检查**（防 preview 与 confirm 之间状态被改）
- 占坑 → `bind-external` → binding → session → 删 pending
- 200：`{ "redirectUrl": "/" }`（Set-Cookie 在头里）
- **不展示**新 key
- 前端收到 200 后：可先 `await checkSession()` 再跳 `/`，减少闪登录表单；或直接 `location.href='/'` 由 `resumeSession` 认 Cookie

**③ 关掉走人**

- 前端清 query / 回登录表单，不调后端；pending 5 分钟后过期

#### Cookie 时机

只有 confirm-create / confirm-bind **成功**后才 Set-Cookie。关掉确认页没有 Cookie。

#### 失败错误码

| 错误码 | 场景 | 前端提示 |
|--------|------|----------|
| `pending_expired` | 超过 5 分钟 | 登录超时，请重新登录 |
| `pending_consumed` | 并发重复提交 | 操作已完成，请刷新页面 |
| `invalid_key` | preview/confirm key 无效或不一致 | Key 无效或不属于此实例 |
| `preview_not_completed` | 未 preview 就 confirm | 请先预览再确认绑定 |
| `identity_already_bound` | 当前 IAM 身份已绑其它账号 | 该身份已绑定其他账号 |
| `target_already_bound_other_identity` | 要绑的 sk-mem 账号已有其它外部身份 | 该账号已绑定其他公司身份，请换一把 Key 或联系管理员 |
| `user_create_failed` | Core 建号失败 | 系统繁忙，请稍后重试 |
| `bind_failed` | Core 绑定失败 | 系统繁忙，请稍后重试 |

前端非 2xx：展示错误 +「返回登录页」。

`pending_token` 不可猜测、短 TTL、成功后删除 → 充当 CSRF 防护，confirm POST 不再另加 CSRF token。

## 8. 安全

- `state` 随机、一次性、5 分钟过期。
- callback 只接受配置的 `redirect_uri`。
- token / userinfo 只在 Panel 服务端；浏览器永不碰 secret。
- 日志禁止打印 `client_secret`、code、access_token、sk-mem 全文。
- Cookie：`tdai_idp_session=<UUID>`；HttpOnly；`Secure` 随 https；**`SameSite=Lax`**；path `/`。
- IAM `access_token` 用完即丢。
- PKCE 默认关。
- **会话落 Redis 时必须加密**（整段 JSON 或至少 `userKey`），密钥用 `panel-session-secret`，与 identity 的 `encryptedUserKey` 同一体系。内存 `local` 会话进程内可明文。
- **identity 文件/Redis** 里继续只存加密后的 `encryptedUserKey`（现网已有），不是「明文会话文件」。
- confirm-create 响应里的一次性 `skMem`：禁止进 access log / 禁止进 localStorage。

## 9. 测试

- Provider：authorize URL、token POST body、userinfo 映射、缺字段失败。
- 路由：无 state / 过期 / IdP 4xx → 明确错误，不 500 空页。
- 登录态：已有用户 callback Set-Cookie 后，无 localStorage userKey 时必须 `/auth/session` 才能离开 LoginGate；不写 sk-mem 进 `tdai-panel.session`。logout 后 session 为未登录。
- 建号：双查空 → create `iam`；第二次 SSO 命中 `iam`，覆盖展示字段。
- 绑老号：bind 后第二次 SSO 命中（通常第一次 `iam` 即中）；不得再确认页 / 再 create。
- binding 里 key 已吊销但 Core 人还在：应走兜底新签，直接登录，不出确认页。
- pending：GET pending 展示；create；并发 `pending_consumed`；preview 不删；confirm 二次安全检查；`bind_only` 无自动建号按钮。
- 新增 `user/update`：admin 可改展示字段；非 admin 拒绝。
- email 大小写不同 → 同一 `external_id`；`PANEL_AUTH_MODE=user_key,oauth2` 时 idp 开、WOA 关。
- 不写真实 UAT secret。

## 10. 联调步骤

1. 确认 Hub UAT 对外 URL → `redirect_uri` → 架构部白名单。
2. `.env`：`PANEL_AUTH_MODE=user_key,oauth2` + OAuth2 变量；多实例再开 `PANEL_SESSION_STORE=redis`。
3. 走授权码；必要时改 JSONPath。登完离开 LoginGate；`tdai-panel.session.userKey` 为空；有 `tdai_idp_session`。
4. 第二次登录同一 `user_id`（建号、绑老号各一遍）；sk-mem 打 Proxy 可用。

## 11. 风险

| 风险 | 处理 |
|---|---|
| userinfo 嵌套在 `data` | 联调后改 JSONPath |
| IAM 要求 PKCE | `PANEL_AUTH_OAUTH2_PKCE=true` |
| token 端点改口 | 再动 `TOKEN_AUTH` |
| `redirect_uri` 不一致 | 三处同一字符串；启动 log URI（无 secret） |
| 官方补官方 OAuth2 | 独立文件/路由，合入时两套都留 |
| 只 Set-Cookie | §6.1 `/auth/session` |
| 只查 `iam` | §7.1 双查 |
| Redis 明文 sk-mem | §8 加密后再 SET |
| pending 先删后 create | §7.2 占坑后置删除 |
| 只配 oauth2 不开会话 | §5：`oauth2` ⇒ `idpEnabled` |
| 预览只查 iam | §7.2 双查 + 目标 external_id + confirm 再验 |
| 确认页挂错路由 | §6：必须在 LoginGate / 未登录分支 |
| 无 user/update | §7：本迭代新增 admin update |
| pending 无展示 API | §7.2：`GET .../pending` |

## 12. 会话存储（Redis，可选）

### 12.0 `redis` 模式必须共享的数据（锁死）

多实例时下列 **全部** 进同一 Redis（同一 `PANEL_REDIS_*` / prefix），**禁止**任何一类仍用进程内存：

| 数据 | key 示例 | TTL |
|------|----------|-----|
| OAuth `state` | `{prefix}oauth2-state:{state}` | 5 min；callback 成功后立即 DEL |
| 首次确认 `pending` | `{prefix}pending:{token}` | 5 min |
| IdP `session` | `{prefix}sess:{uuid}` | `PANEL_AUTH_SESSION_TTL_SECONDS` |
| session 反向索引 | `{prefix}by-userkey:{instanceId}:{sha256(userKey)}` | 同 session |
| identity binding | `{prefix}identity:{instanceId}:{providerId}:{encodeURIComponent(email)}` | 90d（SSO 续期） |
| identity 反向索引 | `{prefix}identity-by-userkey:{instanceId}:{sha256(userKey)}` | 90d |

`local` 模式：上述均在进程内 Map / 本地 JSON，单实例足够。

### 12.1 动机

内存 `MemorySessionStore`：单机重启掉线；多实例不共享。

### 12.2 开关

| 变量 | 说明 |
|------|------|
| `PANEL_SESSION_STORE` | `local`（默认）或 `redis` |

`local`：不连 Redis，不强制装会话用 ioredis（实现上可仍声明依赖但不连接）。行为与现在一致。

`redis` 必填其一连接方式，否则启动失败：

| 变量 | 说明 |
|------|------|
| `PANEL_REDIS_URL` | 完整 URL，优先 |
| `PANEL_REDIS_HOST` / `PORT` / `PASSWORD` / `DB` | 拆分配置 |
| `PANEL_REDIS_KEY_PREFIX` | 默认 `panel:`，与 Proxy 隔离 |

TTL：

- Session：`PANEL_AUTH_SESSION_TTL_SECONDS`（默认 28800）
- Identity binding：常量 90 天，SSO 成功续期

### 12.3 实现要点

- `buildSessionStore` / `buildIdentityStore` 按 `PANEL_SESSION_STORE` 注入。
- `SessionStore` / `IdentityStore` **全部 async**。
- Redis 写入前 **加密**（§8）。
- Session key：`{keyPrefix}sess:{token}`
- 反向索引：`{keyPrefix}by-userkey:{instanceId}:{sha256(userKey)}` → Set of session tokens（TTL 与 session 对齐）

```typescript
interface SessionStore {
  create(input: Omit<IdpSession, 'token' | 'createdAt' | 'expiresAt'>): Promise<IdpSession>;
  get(token: string | undefined): Promise<IdpSession | null>;
  destroy(token: string | undefined): Promise<void>;
}
```

会话字段与官方一致（含 `userKey`，存盘/Redis 时加密）。

### 12.4 兼容

| 模式 | 重启 | 多 Hub |
|------|------|--------|
| `local` | 需重新 SSO | 不行（除非会话粘滞，仍不抗挂机） |
| `redis` | 一般不需重新 SSO | 可以 |

### 12.5 Key 吊销级联清理（可选增强）

**MVP：** 可不做级联。吊销后靠 §7.1「key 无效兜底」下次 SSO 新签即可。

**有余力 / 已上线 `user-key/reveal` 时：** Hub 吊销某把 sk-mem 后尽量清 session + identity binding，减少一段 401 窗口。

**明文 key 从哪来：**

- list/get **不回** `key_value`；不要假设 revoke 响应带明文。
- IdP 会话且会话 `userKey` 就是被吊销那把 → 用会话明文。
- 吊销「自己的其它 key」→ 调 **reveal**（见复制明文方案；仅 owner）再级联；reveal 未实现则 **跳过级联**，仍走 Core revoke + 兜底。
- **禁止**把明文 key 塞进 revoke 请求 body 当常规方案（易进日志/代理）。

反向索引：create/save 时 `SADD`；destroy 时 `SREM`。`local`：遍历内存 + `removeByUserKey`。

最后一把 key：Core 409；Hub 禁用按钮。

## 13. 工作量（量级）

- Provider + 配置（oauth2⇒idpEnabled、Cookie Secure 跟 OAUTH2_APP_URL）+ 路由 + LoginGate 确认页 + pending GET + 登录态/登出：约 **5～6 人日**
- Core 新增 `user/update`（admin）+ SSO 覆盖资料：约 **0.5 人日**
- Redis 四类共享 + 加密 + 反向索引：约 **1～1.5 人日**
- 吊销级联：可选，约 **0.5 人日**（依赖 reveal）
- 联调 / `redirect_uri` 白名单另计

## 14. 相对旧稿变更摘要

1. 认人键 `email`（规范化）；域 `iam`；Provider `id` ≠ `authProviderDomain`
2. `oauth2` ⇒ `idpEnabled`；Cookie Secure 跟 OAuth2 APP_URL
3. 确认页在 **LoginGate**；`GET .../pending` 展示身份；`mode: bind_only`
4. 新增 Core `user/update`；覆盖失败不阻断
5. pending 占坑后置删除；state 一次性 DEL；confirm-bind 二次校验
6. key 无效兜底；Redis 可选；email key 段 encodeURIComponent
7. 登出双向清；SessionStore async；吊销级联可选
8. 2026-09-10 多轮审查补丁（内网部署可实施口径）
