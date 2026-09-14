# 升级说明：IAM SSO + 会话 Redis（iam-sso-2418d1a4-amd64）

给公司内网 Linux x86 机器用。本包在现有 `user_key` 登录之外，增加 **公司 IAM（OAuth2）登录**；可选把 Hub 登录会话存进 Redis，**Hub 重启不丢 Cookie 登录**。

| 项 | 值 |
|----|----|
| 镜像包 | `tdai-images-iam-sso-2418d1a4-amd64.tgz`（约 663MB） |
| 平台 | `linux/amd64` |
| 镜像 tag | `iam-sso-2418d1a4-amd64` |

> **不要**把本机 MiniMax / 本机 `127.0.0.1` 的 `.env` 整份拷到公司机。只改镜像 tag，并按下文追加 IAM / Redis 变量；`PUBLIC_HOST`、密钥等仍用公司机原有值。

---

## 1. 导入镜像

```bash
gzip -dc tdai-images-iam-sso-2418d1a4-amd64.tgz | docker load
docker images | grep iam-sso-2418d1a4-amd64
```

应看到三件套：

- `tdai-local/memory-core:iam-sso-2418d1a4-amd64`
- `tdai-local/memory-hub:iam-sso-2418d1a4-amd64`
- `tdai-local/memory-proxy:iam-sso-2418d1a4-amd64`

---

## 2. 改 `.env`（必改 + 按需加）

### 2.1 镜像 tag（必改）

```bash
MEMORY_CORE_IMAGE=tdai-local/memory-core:iam-sso-2418d1a4-amd64
MEMORY_HUB_IMAGE=tdai-local/memory-hub:iam-sso-2418d1a4-amd64
PROXY_IMAGE=tdai-local/memory-proxy:iam-sso-2418d1a4-amd64
```

### 2.2 公司 IAM SSO（要开「公司IAM登录」按钮时必加）

把下面 `<公司Hub对外主机>` 换成 **浏览器实际打开 Hub 的主机名/IP**（含端口；若前面有网关剥端口或 https，按对外真实 URL 写）。

```bash
PANEL_AUTH_MODE=user_key,oauth2

PANEL_AUTH_OAUTH2_CLIENT_ID=01m1zvmv1twtnw6cw9hqa0t6nv
PANEL_AUTH_OAUTH2_CLIENT_SECRET=<架构部下发的 secret>
PANEL_AUTH_OAUTH2_AUTHORIZATION_URL=http://tenantcenter-fe-uat.msxf.msxfyun.test/oauth
PANEL_AUTH_OAUTH2_TOKEN_URL=http://tenantcenter-uat.msxf.msxfyun.test/api/v1/oauth2/token
PANEL_AUTH_OAUTH2_USERINFO_URL=http://tenantcenter-fe-uat.msxf.msxfyun.test/web/v2/GetUserInfo

PANEL_AUTH_OAUTH2_APP_URL=http://<公司Hub对外主机>:8125
PANEL_AUTH_OAUTH2_REDIRECT_URI=http://<公司Hub对外主机>:8125/api/v1/auth/idp/oauth2/callback

PANEL_AUTH_OAUTH2_DISPLAY_NAME=公司IAM登录
PANEL_AUTH_OAUTH2_PKCE=false
PANEL_AUTH_SESSION_SECURE=false
METADATA_EXTERNAL_AUTH_PROVIDER=iam
```

说明：

| 变量 | 说明 |
|------|------|
| `PANEL_AUTH_MODE` | 建议 `user_key,oauth2`，保留钥匙登录兜底 |
| `PANEL_AUTH_OAUTH2_*` URL / client | 用架构部 TenantCenter UAT 下发值；生产换生产地址 |
| `PANEL_AUTH_OAUTH2_APP_URL` | Hub 对外根地址 |
| `PANEL_AUTH_OAUTH2_REDIRECT_URI` | 回调地址；**必须与架构部白名单一字不差** |
| `PANEL_AUTH_SESSION_SECURE` | 纯 http 内网建议 `false` |
| `METADATA_EXTERNAL_AUTH_PROVIDER` | 固定 `iam`（不要和 WOA 共用同一域） |

可选（一般不用）：`PANEL_AUTH_OAUTH2_SCOPE=`

**redirect_uri 示例**（登记给架构部的也是这一条）：

```text
http://<公司Hub对外主机>:8125/api/v1/auth/idp/oauth2/callback
```

不要带 `instance_id`，不要用本机 `127.0.0.1`（除非架构部单独加了本机白名单）。

### 2.3 Hub 会话进 Redis（建议加，重启不丢 SSO 登录）

与现有 Proxy 共用 compose 里的 Redis，用前缀隔离：

```bash
PANEL_SESSION_STORE=redis
PANEL_REDIS_HOST=redis
PANEL_REDIS_PORT=6379
PANEL_REDIS_PASSWORD=
PANEL_REDIS_KEY_PREFIX=panel:
```

`PANEL_REDIS_PASSWORD` 可留空：若 compose 按下文写了回落，会用已有的 `REDIS_PASSWORD`。

---

## 3. 改 `docker-compose.yml`（旧 compose 必改）

> 若公司机上的 compose **已经**在 `memory-hub.environment` 里有 `PANEL_AUTH_MODE` / `PANEL_SESSION_STORE`，可跳过本节，只改 `.env`。  
> 自检：`grep PANEL_AUTH_MODE docker-compose.yml` —— 没有输出就说明要改。

**只改 `.env`、compose 不透传 → 容器里读不到，登录页不会出现 SSO 按钮。**

### 3.1 在 `memory-hub` → `environment:` 下追加

与现有其它环境变量同级粘贴：

```yaml
      PANEL_AUTH_MODE: "${PANEL_AUTH_MODE:-}"
      PANEL_AUTH_OAUTH2_CLIENT_ID: "${PANEL_AUTH_OAUTH2_CLIENT_ID:-}"
      PANEL_AUTH_OAUTH2_CLIENT_SECRET: "${PANEL_AUTH_OAUTH2_CLIENT_SECRET:-}"
      PANEL_AUTH_OAUTH2_AUTHORIZATION_URL: "${PANEL_AUTH_OAUTH2_AUTHORIZATION_URL:-}"
      PANEL_AUTH_OAUTH2_TOKEN_URL: "${PANEL_AUTH_OAUTH2_TOKEN_URL:-}"
      PANEL_AUTH_OAUTH2_USERINFO_URL: "${PANEL_AUTH_OAUTH2_USERINFO_URL:-}"
      PANEL_AUTH_OAUTH2_APP_URL: "${PANEL_AUTH_OAUTH2_APP_URL:-}"
      PANEL_AUTH_OAUTH2_REDIRECT_URI: "${PANEL_AUTH_OAUTH2_REDIRECT_URI:-}"
      PANEL_AUTH_OAUTH2_SCOPE: "${PANEL_AUTH_OAUTH2_SCOPE:-}"
      PANEL_AUTH_OAUTH2_DISPLAY_NAME: "${PANEL_AUTH_OAUTH2_DISPLAY_NAME:-}"
      PANEL_AUTH_OAUTH2_PKCE: "${PANEL_AUTH_OAUTH2_PKCE:-}"
      METADATA_EXTERNAL_AUTH_PROVIDER: "${METADATA_EXTERNAL_AUTH_PROVIDER:-}"
      PANEL_AUTH_SESSION_SECURE: "${PANEL_AUTH_SESSION_SECURE:-}"
      PANEL_SESSION_STORE: "${PANEL_SESSION_STORE:-}"
      PANEL_REDIS_URL: "${PANEL_REDIS_URL:-}"
      PANEL_REDIS_HOST: "${PANEL_REDIS_HOST:-}"
      PANEL_REDIS_PORT: "${PANEL_REDIS_PORT:-}"
      PANEL_REDIS_PASSWORD: "${PANEL_REDIS_PASSWORD:-${REDIS_PASSWORD:-}}"
      PANEL_REDIS_DB: "${PANEL_REDIS_DB:-}"
      PANEL_REDIS_KEY_PREFIX: "${PANEL_REDIS_KEY_PREFIX:-}"
```

### 3.2 同一 `memory-hub` 的 `depends_on` 增加 redis

若还没有依赖 redis，改成（需已有 `redis` 服务且带 healthcheck，一般 Proxy 栈已有）：

```yaml
    depends_on:
      memory-core:
        condition: service_started
      redis:
        condition: service_healthy
```

### 3.3 不用改的部分

- **不必**改 `memory-core` / `proxy` 的 environment（IAM 相关只进 Hub）
- Redis 是否映射 `127.0.0.1:6379` 到宿主机：**可选**，仅方便本机 `redis-cli`；线上可不映射

---

## 4. 启动

在部署目录（有 `.env` 和 `docker-compose.yml` 处）：

```bash
./up.sh
# 或
docker compose up -d
```

建议至少 recreate Hub：

```bash
docker compose up -d --force-recreate memory-hub
```

---

## 5. 验收

```bash
# 应看到 type=oauth2、display_name=公司IAM登录
curl -sS http://127.0.0.1:8125/api/v1/auth/methods

# 容器内确实吃到了模式（不要在日志里打印 secret）
docker exec tdai-memory-hub printenv PANEL_AUTH_MODE
docker exec tdai-memory-hub printenv PANEL_SESSION_STORE
```

浏览器打开 Hub 登录页：在 user_key 表单下方应有 **「公司IAM登录」**。

点 SSO 能完成跳转的前提：

1. 架构部已登记与 `.env` 完全一致的 `redirect_uri`
2. Hub 容器能访问 TenantCenter 的 authorize / token / userinfo 地址（公司内网 DNS）

Redis 会话（若开了）：IAM 登录一次后，`docker restart tdai-memory-hub`，浏览器刷新仍应保持登录。

---

## 6. 多实例与鉴权（必读）

拓扑：**一个 Hub + 多套 Core/Proxy（每套一个 instance）**。登录先选 instance，再点公司 IAM；建号打在选中那套 Core 上。

Core 两层鉴权：

- **网关门禁**（`Authorization: Bearer`）：未配 gateway key 时关闭  
- **用户身份**（`x-tdai-user-key`）：`user/create` 等需要 **system_admin**

**当前约定：Core 门禁关闭**（`MEMORY_CORE_GATEWAY_API_KEY` 留空）。

| 项 | 填法 |
|----|------|
| Proxy `tdai.apiKey` / `MEMORY_CORE_GATEWAY_API_KEY` | **空着**即可 |
| Proxy `serviceToken` / `PROXY_CORE_SERVICE_TOKEN` | **非空占位**（如 `local`）；门禁关着不真校验。用于 Proxy→Core 调 Skill/知识库的 Bearer，不是员工 key |
| Hub `metadata-instances.json` 的 `api_key`（或 `REMOTE_INSTANCE_KEY`） | **该套 Core 的 admin `sk-mem`（`.admin-key`）**；SSO 建号靠它当 `x-tdai-user-key`。多套 Core 各配各的 |

不要把 Proxy 的 `local` 占位当成 Hub 实例 `api_key`——SSO 自动建号会 401。

---

## 7. 常见问题

| 现象 | 排查 |
|------|------|
| 没有 SSO 按钮 | `.env` 未开 `oauth2`；或 compose 未透传 → `printenv PANEL_AUTH_MODE` 为空 |
| 按钮有，回调失败 | `REDIRECT_URI` 与白名单不一致；`APP_URL` 写成了内网别名/错端口 |
| Hub 起不来 | `PANEL_AUTH_MODE` 含 `oauth2` 但缺 client/URL/`APP_URL`；看 Hub 日志 |
| SSO 建号 401/403 | Hub 实例 `api_key` 不是该 Core 的 admin sk-mem（误写成 `local` / 服务占位符） |
| 重启就掉登录 | 未设 `PANEL_SESSION_STORE=redis`，或 Hub 连不上 `redis:6379` |
| 只换了镜像、旧 compose | 必须按第 3 节补 environment，否则新功能等于没开 |

---

## 8. 变更清单（给实施同事勾）

- [ ] `docker load` 三件套 `iam-sso-2418d1a4-amd64`
- [ ] `.env` 三个 `*_IMAGE` tag
- [ ] `.env` IAM 变量 + 正确的对外 `APP_URL` / `REDIRECT_URI`
- [ ] （建议）`.env` Redis 会话变量
- [ ] 旧 `docker-compose.yml`：`memory-hub` 追加 environment + `depends_on redis`
- [ ] Hub 每个 instance 的 `api_key` = 对应 Core 的 admin sk-mem（不是 `local`）
- [ ] `MEMORY_CORE_GATEWAY_API_KEY` 仍为空；`PROXY_CORE_SERVICE_TOKEN` 非空占位
- [ ] 架构部白名单已是公司机那条 callback
- [ ] `./up.sh` 后 `/api/v1/auth/methods` 含 oauth2，登录页有按钮
