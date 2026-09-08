# 方案：Hub 对接公司 OAuth2 SSO（马上消费 IAMCenter）

- 日期：2026-09-08
- 状态：设计稿，待确认后写实施计划
- 背景：官方 2.0.2-beta.1 的 Panel 登录已有 IdP 骨架，落地的是腾讯内网 **WOA 网关注入头**；标准授权码 OAuth2（`RedirectOAuth2Provider`）**接口先立位、未实现**。公司架构部已下发 IAMCenter UAT 的 `client_id` / `client_secret` / authorize / token / userinfo。目标是员工用公司账号登 Hub，不必每人先找管理员要 `sk-mem`。
- 相关代码（`release`）：
  - `MemoryPanel/src/panel/auth/types.ts`（`RedirectOAuth2Provider`）
  - `MemoryPanel/src/panel/auth/service.ts`（WOA 建号 / `find-by-external` / `create-with-key`）
  - `MemoryPanel/src/panel/http/routes/auth.ts`（仅 `/auth/idp/woa/*`）
  - Core `user/find-by-external`、`user/create`（`external_id` + `auth_provider`）

## 1. 目标

1. Hub 登录页在保留 **user_key** 的同时，增加 **「公司IAM登录」**。
2. 走标准授权码：浏览器跳转 IAMCenter → 带回 `code` → Panel 换 token → 拉 userinfo → 映射成 Hub 用户。
3. 首次 SSO（该公司账号尚未绑过 Hub 用户）：进入确认页，二选一——**自动建号并一次性展示新 sk-mem**，或 **本人填写已有 sk-mem 绑定**（团队、key、资产保留）。**可以关掉走人**（不建号、不绑定，回到登录页；pending 作废）。不自动加入任何团队。不做管理员在 Hub 后台代绑。Hub 展示用公司 **用户名 / 邮箱**，不把工号当显示名。
4. 再次 SSO：按官方查找顺序命中已有用户（先 `msxf` 再 `local`，见 §7.1），直接进 Hub，不再展示 key。每次登录用通讯录 **覆盖** `username` / `email` / `display_name`（覆盖的是展示字段，不是认人键）。
5. 所有 SSO 地址与密钥走 **环境变量**，不进 git。Hub 对外根用 `PANEL_AUTH_OAUTH2_APP_URL`，部署时再填。

```text
员工浏览器
  点「公司IAM登录」
        │
        ▼
Panel  GET /api/v1/auth/idp/oauth2/login
  生成 state（+ 可选 PKCE）
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
  find-by-external：先 (msxf, 唯一键)，再 (local, 唯一键)
  任一命中 → 直接登录
  两个都未命中 → 确认页（pending，5 分钟）：
    ① 自动建号：user/create，展示一次新 sk-mem，不加入团队
    ② 绑定已有：用户填 sk-mem → preview 显示账号 → 确认后 bind-external
    ③ 关掉走人：清 pending，回登录页，Core 不建号
  完成 ① 或 ② 后才 Set-Cookie（HttpOnly UUID）进 Hub
        │
        ▼
浏览器 302 回 Hub 前端
  App 启动 / 刷新走 resumeSession：
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
2. 登完回到 Hub：**页面离开 LoginGate、进入控制台**（靠 `/auth/session` 认 Cookie，不是靠 localStorage 里有 sk-mem）。Core 里该员工能被 §7.1 的查找命中（自动建号一般是 `msxf`；绑老号可能仍是 `local`）。
3. 该公司账号第一次进来：可「自动建号」（复制一次新 sk-mem，**不加入团队**）、「绑定已有 sk-mem」，或关掉确认页回登录（不建号）。绑过或建过之后，第二次 SSO **不再出确认页**（即使绑老号后 `auth_provider` 仍是 `local`）。每次登录用通讯录覆盖用户名/邮箱，不用工号当显示名。
4. 关掉 oauth2 或漏配时，行为与现在一样：只有 user_key，Panel 能启动。
5. `client_secret` 只出现在运行环境，不进仓库、不进前端、不进接口响应。
6. `redirect_uri` 与 SSO 控制台白名单、authorize 请求里带的值 **三处同一字符串**。

## 2. 非目标

- 不接腾讯 WOA（`x-tai-identity`）。公司 IdP 不是那套网关。
- 不改 MemoryProxy / Claude Code 登录方式（继续 `sk-mem`）。
- 不做 OIDC Discovery、refresh_token 续 Panel 会话（Panel 继续用现有 Cookie TTL）。
- 不把 OAuth access_token 拿去调 MaaS / Proxy。
- 不配默认团队（不设 `DEFAULT_TEAM_ID`；新用户由管理员事后拉进团队）。
- 不做管理员代绑：没有「把工号绑到某 user」的后台入口。绑定只发生在本人 SSO 之后的确认页（填一把属于该 user 的 sk-mem）。
- 不把 UAT 的 client 配进镜像默认值。

## 3. 方案选择（已锁定 A）

| | 做法 | 评价 |
|---|---|---|
| **A（采用）** | 实现官方 `RedirectOAuth2Provider`，新路由 `/auth/idp/oauth2/*`，`auth_provider=msxf` | 和 WOA 并列，官方升级不踩同一条路 |
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

共用 Hub 时：6 套 Core 用户表互不相通。同一工号进 instance A / B 会是两个 user、两把 sk-mem；绑定已有 key 必须先选对 instance，那把 key 也必须属于那套 Core。这和今天 user_key 登录先选实例是同一语义。

- 本机联调才用 `http://127.0.0.1:8125/api/v1/auth/idp/oauth2/callback`，且 SSO 控制台要单独加这条白名单。
- 允许用 `PANEL_AUTH_OAUTH2_REDIRECT_URI` **覆盖**拼出来的值（网关剥端口、https 终结时用）。

**待你确认 Hub UAT 对外 URL 后，把完整 `redirect_uri` 发给架构部。**

## 5. 环境变量

`PANEL_AUTH_MODE` 增加可选值 `oauth2`（可与 `user_key` 组合，建议始终保留 user_key）。

| 变量 | 必填（开启 oauth2 时） | 说明 |
|---|---|---|
| `PANEL_AUTH_OAUTH2_DISPLAY_NAME` | 否 | 按钮文案，默认 `公司IAM登录` |
| `PANEL_AUTH_OAUTH2_CLIENT_ID` | 是 | 架构部 client_id |
| `PANEL_AUTH_OAUTH2_CLIENT_SECRET` | 是 | 只放机器 `.env` / 密钥平台 |
| `PANEL_AUTH_OAUTH2_AUTHORIZATION_URL` | 是 | 浏览器跳转 |
| `PANEL_AUTH_OAUTH2_TOKEN_URL` | 是 | Panel 服务端 POST |
| `PANEL_AUTH_OAUTH2_USERINFO_URL` | 是 | Panel 服务端 GET |
| `PANEL_AUTH_OAUTH2_APP_URL` | 是* | Hub 对外根，用来拼 redirect_uri |
| `PANEL_AUTH_OAUTH2_REDIRECT_URI` | 否 | 覆盖拼出的 callback |
| `PANEL_AUTH_OAUTH2_SCOPE` | 否 | 有则带上；空则 authorize 不带 `scope`（与同事 `OAuthClient` 一致） |
| `PANEL_AUTH_OAUTH2_PKCE` | 否 | **默认 `false`**。同事示例未发 `code_challenge`；IAM 若要求再开 |
| `PANEL_AUTH_OAUTH2_TOKEN_AUTH` | 否 | 已锁定 **POST form body**（与示例 `data=payload` 一致）：`grant_type` / `code` / `redirect_uri` / `client_id` / `client_secret`。Header 加 `Accept: application/json` |
| `PANEL_AUTH_OAUTH2_USERINFO_TOKEN` | 否 | 已锁定 **GET + `Authorization: Bearer {access_token}`** |
| `PANEL_AUTH_OAUTH2_SUBJECT_JSONPATH` | 否 | 认人键。**等架构部确认后再定默认值**；未确认前不要默认 `email` |
| `PANEL_AUTH_OAUTH2_LOGIN_JSONPATH` | 否 | 默认 `username` |
| `PANEL_AUTH_OAUTH2_NAME_JSONPATH` | 否 | 默认 `nickname` |
| `PANEL_AUTH_OAUTH2_EMAIL_JSONPATH` | 否 | 默认 `email` |
| `METADATA_EXTERNAL_AUTH_PROVIDER` | 否 | 写入 Core 的域，**本方案默认 `msxf`**（不要用 `woa`） |

`.env.example` 只留空变量名。真实值按环境分文件，gitignore。

开启 oauth2 但缺 client_id/secret/三个 URL/`APP_URL`（且无显式 redirect）→ **启动失败并打出缺哪几个**，避免跳到空地址。

## 6. 代码落点

新建 `MemoryPanel/src/panel/auth/oauth2-provider.ts`，实现 `RedirectOAuth2Provider`：

- `prepareAuthorize({ state, redirectUri })` → authorize URL（`client_id`、`redirect_uri`、`response_type=code`、`state`；`scope` 有配才带。默认 **不带 PKCE**）
- `authenticateFromCallback({ code, redirectUri })` → **POST** `token_url`（form body 换 token，`Accept: application/json`）→ GET userinfo（Bearer）→ 按同事 `normalize_user_info` 映射

`PanelAuthService`：

- `oauth2.enabled` 时 `providers.register(new Oauth2Provider(...))`
- `listMethods()` 增加 `{ id: 'oauth2', type: 'oauth2', display_name }`（前端 `LoginGate` 今天只认 `user_key` | `woa`，要扩联合类型）
- 复用现有 `provisionIdentity` / `find-by-external`，**不要复制一套 WOA 建号**；把 WOA 专用错误码抽成 IdP 通用或加 `OAUTH2_*` 别名
- `state` 服务端短 TTL 存储（内存即可，与 pending WOA 类似）：内容含 `instance_id`、`return_to`、过期时间。禁止只靠前端 localStorage 当 CSRF 防护

路由（挂在现有 `/api/v1`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/auth/idp/oauth2/login` | 查 `instance_id`，写 state，302 到 IdP |
| GET | `/auth/idp/oauth2/callback` | 校验 state，换票，建/登用户，Set-Cookie，302 回 Hub；**首次**带一次性 query 或 cookie 让前端展示 sk-mem |
| GET | `/auth/session` | **复用官方已有接口**。前端用它把 Cookie 会话认成「已登录」。本方案不新开一套 |
| POST | `/auth/logout` | **复用官方已有接口**。IdP 登出必须打它：清内存会话 + 过期 Cookie。只清 localStorage 不够 |

oauth2 未启用时 login/callback 两个 GET **302 回 `/`**（与 WOA 未启用时一样，避免浏览器停在 JSON 404）。

前端 `LoginGate.tsx`：user_key 表单下方增加 SSO 按钮 → `window.location.assign('/api/v1/auth/idp/oauth2/login?instance_id=...')`。不要在浏览器里放 `client_secret`。

### 6.1 Hub 登录态：两条路，不要搅在一起

今天这套 Hub（`App` → `checkSession` → `resumeSession`）**只认 localStorage** `tdai-panel.session`：有 `{ instance_id, user_key, user }` 才算已登录；之后每个 meta 请求前端自己带 `X-Tdai-User-Key`。

官方 IdP（WOA 已落地、本方案跟同一套）是另一条路：

| | user_key 登录（今天） | IAM / 官方 IdP |
|---|---|---|
| 浏览器里的凭证 | localStorage 明文 `sk-mem-…` | HttpOnly Cookie `tdai_idp_session=<UUID>`，JS **读不到** |
| 明文 sk-mem 在哪 | 浏览器 localStorage | **只在 Panel 内存会话**（`MemorySessionStore`），Cookie 里没有 key |
| 前端怎么知道已登录 | 读 localStorage，不必打后端 | **必须** `GET /api/v1/auth/session`（`credentials: include`，自动带 Cookie） |
| 之后调 Core | 前端 Header 带 `X-Tdai-User-Key` | 前端 **不带** 该 Header；`validate-panel-headers` 用 Cookie 取出会话里的 `userKey` 再代理 |

**只 Set-Cookie 不够。** Cookie 是 HttpOnly，前端看不见。回调 302 回 Hub 后，`resumeSession` 若仍只读 localStorage，会判定未登录，**Cookie 已经登上了，页面还停在 LoginGate**。

实现必须跟官方 `LoginGate.resumeSession` 同一顺序（对照 `origin/feat/server_team`）：

1. localStorage 里已有非空 `userKey` → 走今天的 `auth/verify`（user_key 路，不要误伤）。
2. 否则 → `GET /api/v1/auth/session`。`authenticated === true` 才把 React `auth` 写成已登录，并 `setPanelSession({ authMethod: 'idp', instanceId, userKey: '', user })`。
3. **`userKey` 必须是空字符串。** 禁止把 `/auth/session` 或内存会话里的 sk-mem 再写入 localStorage，也禁止首次确认页「复制过一次」之后把那把 key 当长期会话缓存。确认页展示是一次性给 Proxy/Claude Code 用的，不是 Hub 登录凭证。
4. `lib/api/base.ts` meta 请求：`session.userKey` 为空则 **省略** `X-Tdai-User-Key`（官方已是 `if (session.userKey) headers[...] = ...`）。空字符串也当没有。带了空 Header 或把 key 塞回去，会走回 user_key 路，两条路搅在一起。
5. 所有会带 Cookie 的请求（`/auth/session`、oauth2 回调后的页面 fetch、登出）必须 `credentials: 'include'`。

**登出（IdP 路）：** `logout()` 必须先 `POST /api/v1/auth/logout`（清内存会话、Set-Cookie 过期），再清 localStorage / React auth。只清浏览器缓存的话，刷新会再打 `/auth/session`，Cookie 还在，人又进来了。user_key 路可以继续只清 localStorage。

**刷新 / 新开 tab：** IdP 路不能靠 localStorage 恢复（里面没有 key）。每次都问 `/auth/session`。Hub 进程重启后内存会话没了，Cookie UUID 失效，用户重新 SSO——这是已锁定的行为，不要改成把 key 存进 localStorage 来「抗重启」。

## 7. 身份映射

对照同事 `OAuthClient.normalize_user_info`（userinfo JSON 字段）：

```text
email, username, nickname, avatar_url  （avatar 可回落 picture）
```

Hub 对人有用的是 **用户名、邮箱**。头像 Hub 资料页没有位，MVP **不展示**；可原样写入 `raw_profile_json` 备以后用。

| Hub 字段 | 来自 userinfo | 何时写 |
|---|---|---|
| `username` | `username`；没有则 `email` 的 `@` 前一段 | **每次 SSO 覆盖** |
| `email` | `email` | **每次 SSO 覆盖** |
| `display_name` | `nickname`；没有则等于 username | **每次 SSO 覆盖** |
| `external_id` | **认人唯一键（待架构部确认）** | 建号或绑定时写一次，之后不改。只给 Core 认人，Hub UI 不单独展示 |

**待确认（明天问架构部）：userinfo 里哪个字段终身不变、一人一条。** 同事示例只有 `email` / `username` / `nickname`，没有 `sub`。在确认之前，实现上 JSONPath 可配，**先不要把 email 写死成唯一键**。

若唯一键是会变的邮箱：公司换邮箱 = Core 找不到旧号 = 当成新用户（确认页新建或再绑）。这就是要架构部拍板的原因。展示用的 `email` 字段仍可每次登录覆盖；**认人键必须是他们说的那个稳定 ID**。

认人键和展示用的 username/email 都没有 → 登录失败。

不覆盖：`user_id`、user_key、团队成员关系、`user_type`。

Hub `username` 规则是字母数字下划线：IAM 用户名不合规则时，把非法字符换成 `_`。

### 7.1 认人查找与绑老号（跟官方 WOA 同一套，域换成 `msxf`）

Core 认人键是 **`(auth_provider, external_id)`**，不是单看唯一键。对照 `origin/feat/server_team` 的 `lookupCoreUserByExternal` / `bindExternalAuth`，**不要另写一套 Core 逻辑**。

库里两类号：

| 怎么进 Hub | 写入 | 之后 `auth_provider` |
|---|---|---|
| 确认页「自动建号」`user/create` | 带 `auth_provider=msxf` + `external_id` | **`msxf`** |
| 确认页「绑定已有 sk-mem」`bind-external` | 与官方一样：`user_id` + `external_id` + `auth_provider=msxf` + 可选 `display_name` | **以 Core 现有实现为准，Hub 不额外改**。官方注释说存量号可仍为 `local`；当前 Core patch 可能把 provider 写成传入值。两种行都可能存在 |

**查找顺序（锁死，每次 SSO / json 缓存未命中都走）：**

1. `user/find-by-external`：`auth_provider=msxf`，`external_id=唯一键`
2. 未命中再查一次：**省略 `auth_provider`**（Core 默认 `local`）
3. 两次都没有 → 才是真·首次，出确认页
4. 任一命中 → 同一 `usr-xxx` 直接登录，**禁止再弹确认页、禁止再自动建号**

不要去查 `woa`。`METADATA_EXTERNAL_AUTH_PROVIDER` 默认 `msxf`，与 WOA 的 `woa` 分域。实现上把官方 `lookupCoreUserByExternal` 的 domain 从 `requireWoa()` 改成「本次 identity 的 provider 域」，顺序仍是「外部域 → 默认 local」。

**绑定不要在 Hub 侧强行改 / 强行不改 `auth_provider`。** 只调官方 `user/bind-external`。若只查 `msxf`、绑完老号仍是 `local`，第二次会当成新人再弹确认页——这就是必须双查的原因。

### 绑定 json 与吊销 key

`panel-auth-identities.json` 里会缓存「唯一键 → usr-xxx + 一把加密 sk-mem」。这把是建号/绑号当时用的那一把。

**官方 WOA 现状：** json 还在、但这把 key 已被用户吊销 → `auth/verify` 失败 → **整次 SSO 401**，不会再去 `find-by-external`。json 整文件丢了反而能兜底登录。

**本方案不跟这个坑：** json 里的 key 无效（吊销 / 过期 / verify 失败）时，当作缓存未命中：

1. Core 按 §7.1 **先 msxf 再 local** 查 `find-by-external`，人还在就 **直接登录**（不出确认页）
2. 给该 `usr-xxx` **新签一把** sk-mem 写入 json 和本次会话（Core 不回旧明文，和 json 丢失时的官方兜底相同）
3. 旧的其它 key 不受影响，Proxy 仍可用
4. 活跃 key 已满签不出来 → 再回确认页，让用户填一把仍有效的 key

Core 里绑定还在（`(msxf, 唯一键)` 或 `(local, 唯一键)`），吊销的只是某一把 sk-mem，不是解绑 IAM。解绑只有改 `external_id` / 删用户才会变成「真·首次」。

**每个 `usr-xxx` 至少留一把 active sk-mem。** Core `user-key/revoke` 已有 `last_key_cannot_revoke`（最后一把会 409）。Hub 吊销按钮对只剩一把时应禁用并提示「至少保留一把 Key，否则无法登录」。不能只靠 SSO 兜底去新签。

## 8. 安全

- `state` 随机、一次性、5 分钟过期。
- callback 只接受登记过的 `redirect_uri`（用配置值，不用 query 里客户端传来的任意 URL）。
- token / userinfo 只在 Panel **服务端**访问；浏览器永不碰 secret。
- 日志禁止打印 `client_secret`、authorization code、access_token、sk-mem 全文。
- 会话 Cookie 沿用现有 `tdai_idp_session`（值是 UUID，**不是** IAM token，也 **不是** sk-mem）；`Secure` 随 APP_URL 是否 https；HttpOnly，前端 JS 不得读。
- IAM `access_token` 换完 userinfo 即丢，不进 Cookie、不进 localStorage。
- PKCE：默认关，与同事 IAM 客户端一致；IAM 要求再开 `PANEL_AUTH_OAUTH2_PKCE=true`。

## 9. 测试

- Provider 单测：用 mock HTTP 覆盖 authorize URL 编码、token POST body、userinfo 映射、缺字段失败。
- 路由单测：无 state / state 过期 / IdP 4xx → 回到登录页或明确错误码，不 500 空页。
- 登录态：callback 已 Set-Cookie 后，前端 `resumeSession` 在 localStorage 无 userKey 时必须打 `/auth/session` 才能离开 LoginGate；断言 **不会** 把 sk-mem 写入 `tdai-panel.session`。IdP 登出后 `/auth/session` 为 `authenticated: false`。
- 建号：两次 `find-by-external`（msxf、local）都空 → `user/create` 带 `auth_provider=msxf`；第二次 SSO 第一次查找（msxf）即命中，不二次 create，但 username/email/display_name 按新 userinfo 更新。
- 绑老号：`bind-external` 后即使 Core 用户仍为 `auth_provider=local`，第二次 SSO 必须在第二下 local 查找命中，**不得**再出确认页、不得再 `user/create`。
- 不写真实 UAT secret 进测试。

## 10. 联调步骤

1. 确认 Hub UAT 对外 URL → 算出 `redirect_uri` → 给架构部加白名单。
2. 机器 `.env` 填上表变量，`PANEL_AUTH_MODE=user_key,oauth2`。
3. 浏览器走一遍授权码；抓 token 响应用户信息字段，必要时只改 JSONPath env。登完必须离开 LoginGate。DevTools Application 里 `tdai-panel.session` 的 `userKey` 应为空；Cookie 有 `tdai_idp_session`。
4. 验证第二次登录同一 `user_id`（自动建号、绑老号各走一遍）；用展示过的 `sk-mem` 打 Proxy 仍可用。绑老号那次不要要求 `auth_provider` 一定变成 `msxf`。

## 11. 风险

| 风险 | 处理 |
|---|---|
| `GetUserInfo` 要特殊 Header / token 放 query | 示例已是 Bearer GET；若改口再动 `USERINFO_TOKEN` |
| IAM 突然要求 PKCE | 打开 `PANEL_AUTH_OAUTH2_PKCE` |
| token 端点（已锁定 POST body） | 不走 Basic；IAM 若改口再动 `TOKEN_AUTH` |
| `redirect_uri` http/https、端口、尾斜杠不一致 | 文档写「三处同一字符串」；启动时 log 即将登记的 URI（不含 secret） |
| 官方后续补了官方 OAuth2 | 我方 Provider 放独立文件、独立路由，合 `feat/server_team` 时按「两套都留」 |
| 只 Set-Cookie、前端仍只读 localStorage | 必现「Cookie 有了、页面还在 LoginGate」。§6.1 把 `/auth/session` 写成登录完成条件 |
| 绑老号后只查 `msxf` | 必现「已绑定、再弹确认页」，甚至再自动建出第二个 user。§7.1 锁死 msxf → local |

## 12. 工作量（量级）

- Provider + 配置 + 路由 + 前端按钮：约 2～3 人日（含 mock 测试）。
- 卡点通常在 userinfo 字段和 `redirect_uri` 白名单，不是业务代码。
