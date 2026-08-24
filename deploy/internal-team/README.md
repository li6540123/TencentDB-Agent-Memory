# 单节点内部部署（可备份、容器重启后续得上）

给团队共用 **一台 Docker 主机**。记忆在 Core 的 volume 里，会话绑定在 Redis volume 里。`restart: unless-stopped`，重建容器只要 **不删 volume**，数据和服务状态都能接着用。

**内网测试机（不能拉 Docker Hub、走公司 LLM 网关、Claude Code 透传）按 [DEPLOY.md](./DEPLOY.md) 做。** 有网机器先 `./pack.sh`。

不要用仓库里的 `deploy/global-images/start-all.sh` 当长期服务：它会删容器且不把 Proxy 会话落到 Redis。

## 会持久化什么

| Volume | 内容 | 容器 `restart` / `up.sh` 再来 |
|--------|------|------------------------------|
| `tdai-core-data` | 用户、Team/Agent、L0–L3、Skill | 还在 |
| `tdai-hub-data` | Wiki / CodeGraph | 还在 |
| `tdai-redis-data` | 会话已选的 Team/Agent（AOF） | 还在，不用再弹关联 |

`.admin-key` 在本目录，**必须和 `tdai-core-data` 一起备份**。

## `.env` 管什么、不管什么

`.env` 管这台机怎么起、默认上游打哪。**不是**每人一把 Key 的花名册，也不是模型名白名单。

| 哪把 Key | 在哪 | `.env`？ |
|----------|------|----------|
| 同事身份 `sk-mem-...` | 面板建用户；客户端 API Key / `ANTHROPIC_AUTH_TOKEN` | 否 |
| 每把 sk-mem 绑定的 MaaS Key | Hub「API Keys」表「MaaS API Key」列；Core 加密存库 | 否（Hub 里配；Core 需 `TDAI_MAAS_KEY_SECRET`） |
| 调模型网关 | `PROXY_KEY_MODE=server`：一把 `PROXY_UPSTREAM_API_KEY`；`passthrough`：每人客户端自己带；**已绑定 MaaS 的 sk-mem 优先用绑定 Key** | 模式 + 共用 Key + `PROXY_MAAS_KEY_*` 缓存 TTL |
| Core/Hub 内部 LLM | `MEMORY_LLM_API_KEY`；超时/输出上限 `MEMORY_LLM_TIMEOUT_MS` / `MEMORY_LLM_MAX_TOKENS` | 是 |

多种客户端靠 **URL 路径**，不是再起多个 proxy：

```text
http://<PUBLIC_HOST>:8096/claude-code/default
http://<PUBLIC_HOST>:8096/codebuddy/default
http://<PUBLIC_HOST>:8096/codex/default
http://<PUBLIC_HOST>:8096/workbuddy/default
http://<PUBLIC_HOST>:8096/dsh/default
http://<PUBLIC_HOST>:8096/hermes/default
http://<PUBLIC_HOST>:8096/openclaw/default
```

`./up.sh` 会按 `PROXY_AGENT_SOURCES` 写成 `runtime/proxy-config.yaml` 的 `upstream.agents`。OpenCode 没有独立前缀，按仓库说明伪装成 `codebuddy` 即可。

面板里的 Team/Agent 是资产角色，和路径里的 `claude-code` 不是一回事。

某类客户端要换上游：在 `.env` 里设 `PROXY_CODEBUDDY_URL` / `PROXY_CODEBUDDY_API_KEY`（其它源同理），再 `./up.sh`。混合透传用 `PROXY_PASSTHROUGH_SOURCES=claude-code`。

`MEMORY_CORE_GATEWAY_API_KEY` 必须留空（Proxy 的 `/v3/meta/auth/verify` 不带这个 Bearer，设了会话初始化会失败）。

记忆仍能工作：TdaiClient 会回退 `Bearer local-proxy`，Core 关了网关 Key 时不校验。

知识库 / Skill 不能跟着留空：Proxy 在 `knowledge.serviceToken` 为空时**根本不注册**知识库 injector；Hub 的 `REMOTE_INSTANCE_KEY` 为空则容器起不来。因此 `.env` 里用 `PROXY_CORE_SERVICE_TOKEN=local` 给 Hub 和 Proxy 当占位 Bearer，**不要**把它写进 `MEMORY_CORE_GATEWAY_API_KEY`。

## 第一台机器

需要：Docker Compose v2、Python 3、能拉镜像（或事先 `docker load`）。

```bash
cd deploy/internal-team
cp .env.example .env
# 编辑 .env：两组 LLM、REDIS_PASSWORD、PUBLIC_HOST
# 本机 Claude 用 127.0.0.1；同事从别的机器连再用局域网 IP。
# PUBLIC_HOST 会写进注入给客户端的 skill-bridge 地址，留空会变成容器网桥 IP。
chmod +x up.sh down.sh backup.sh restore.sh
./up.sh --render-only          # 可选：先看 runtime/*.yaml
./up.sh
```

打开 `http://<PUBLIC_HOST>:8125/`，用 `.admin-key` 登录，建业务用户和 Team/Agent。

Proxy 已开 `sessionInit.defaultTaskId: no-task`：关联团队资产时可选「本次不关联任务」。不配这项时，没选 Task 会 bypass，原始对话不会上传。

同事 Claude Code（`PROXY_KEY_MODE=server` 且 **未** 把 claude-code 列入透传）：

```bash
export ANTHROPIC_BASE_URL=http://<PUBLIC_HOST>:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN='sk-mem-<业务用户>'
claude --model <PROXY_UPSTREAM_MODEL>
```

`PROXY_PASSTHROUGH_SOURCES=claude-code`（测试环境默认）时两把都要带，**不要对调**：

```bash
export ANTHROPIC_API_KEY='sk-mem-<业务用户>'          # x-api-key，Proxy 认人
export ANTHROPIC_AUTH_TOKEN='<这个人的公司网关 Key>'  # Authorization，透传上游
```

Core 只绑 `127.0.0.1:8420`，外网不要暴露。

## 容器重启

```bash
docker compose --env-file .env restart          # 或 docker restart tdai-proxy ...
./down.sh && ./up.sh                            # 停再起，volume 默认保留
```

`./down.sh --purge` 会删三个 volume，等于清空实例。

## 备份 / 恢复

```bash
./backup.sh                          # 短暂停服务，写出 backups/<时间戳>/
./restore.sh backups/20260820-221500 # 覆盖当前 volume 后启动
```

备份目录权限收紧（含 `.env` 和 admin key）。建议拷到另一台盘或对象存储。

## 复制到另一台机器

内网离线：本机 `./pack.sh`，按 [DEPLOY.md](./DEPLOY.md) 在测试机 `docker load` + `.env.company.example`。

有 Docker Hub 时也可以只拷本目录，改 `PUBLIC_HOST` 后 `./up.sh`。同一套记忆不要在两台机同时写。

**本地源码镜像（含 MaaS 改动）：**

```bash
# 默认走 .env 里 BUILD_PROXY_PORT=7897 翻墙（Clash HTTP 代理）
./build-local.sh          # 只构建
./up-local.sh             # 构建 + 更新 .env 镜像 tag + 启动
```

Colima 下 docker build 容器内用 `host.docker.internal:7897`，宿主机 curl/buildx 用 `127.0.0.1:7897`。

## 升级镜像

改 `.env` 里的 image tag → `./backup.sh` → `docker compose --env-file .env pull` → `./up.sh`。
