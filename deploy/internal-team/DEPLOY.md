# 内网测试机部署（离线镜像 + 公司 LLM 网关 + Claude Code 透传）

测试机有 Docker、不能访问 Docker Hub / 公网模型。对话由 **测试机上的 Proxy 容器** 打公司 LLM 网关，不是同事笔记本直连。

不要用仓库里的 `deploy/global-images/start-all.sh`。

## 带走什么

在已有官方镜像的机器（例如这台 Mac）上：

```bash
cd deploy/internal-team
chmod +x pack.sh up.sh down.sh backup.sh restore.sh
# 公司 Linux x86（amd64）必须指定平台，否则 Mac 上会打成 arm64：
PACK_PLATFORM=linux/amd64 PACK_TAG=$(date +%Y%m%d)-amd64 ./pack.sh
```

拷 `dist/` 里两份文件到测试机：

| 文件 | 内容 |
|------|------|
| `tdai-images.tgz` | `memory-core/hub/proxy:<日期>-amd64`、redis:7-alpine、alpine:3.20（均为 linux/amd64） |
| `tdai-internal-team.tgz` | compose、脚本、模板、`image-tags.env`。不含本机 `.env` 和 Key |

测试机还要：**Docker Compose v2**、**Python 3**（`up.sh` 渲染 yaml）。

## MaaS API Key（每把 sk-mem 独立绑定）

1. 在 Hub「API Keys」页每行配置 **MaaS API Key**（加密存 Core，需 `TDAI_MAAS_KEY_SECRET`）。
2. 同事 CLI 只配 Proxy 地址 + `sk-mem`；未绑定时行为与改前一致（`PROXY_UPSTREAM_API_KEY` 等）。
3. 修改 MaaS Key 后 Hub 提示生效时间 = `PROXY_MAAS_KEY_CACHE_TTL_MS`（默认 60s）。自建 Hub 镜像时需传入 `VITE_PROXY_MAAS_KEY_CACHE_TTL_MS` 与之一致。

## 测试机操作

```bash
gzip -dc tdai-images.tgz | docker load
tar xzf tdai-internal-team.tgz
cd internal-team          # 若解压出来是 deploy/internal-team 则进那一层
chmod +x *.sh
cp .env.company.example .env
# 离线包里的 example 已是打包当天的日期 tag。也可对照 image-tags.env
# docker images | grep agentmemory   应看到 :YYYYMMDD，不要改回 latest
```

编辑 `.env`，至少改这些：

1. `PUBLIC_HOST` = 测试机局域网 IP（同事从自己电脑连；不要 `127.0.0.1`）
2. `MEMORY_LLM_BASE_URL` / `API_KEY` / `MODEL` = 公司网关 **OpenAI** 兼容地址（到 `/v1`）
3. `PROXY_UPSTREAM_URL` / `API_KEY` / `MODEL` = 公司网关 **Anthropic** base（到 `/v1`，**不要**写 `/messages`）
4. `REDIS_PASSWORD` = 新的长随机串
5. `MEMORY_CORE_GATEWAY_API_KEY` 保持空；`PROXY_CORE_SERVICE_TOKEN=local`
6. `PROXY_PASSTHROUGH_SOURCES=claude-code` 保持（只有 CC 透传）

OpenAI 和 Anthropic 不是同一条路径时：

```bash
PROXY_CODEBUDDY_URL=https://<网关>/v1
PROXY_CLAUDE_CODE_URL=https://<网关>/anthropic/v1
```

```bash
./up.sh --render-only
# 确认 runtime/proxy-config.yaml 里 claude-code 只有 url、注释「不写 apiKey」
./up.sh
```

打开 `http://<PUBLIC_HOST>:8125/`，用目录里 `.admin-key` 登录，**再建业务用户**（不要把 admin key 发给同事当日常身份）。建 Team / Agent。

端口：`8125` 面板、`8096` Proxy、`8424` 知识库。Core `8420` 只绑本机 `127.0.0.1`，不要对局域网暴露。

## 同事 Claude Code（透传）

```bash
export ANTHROPIC_BASE_URL=http://<PUBLIC_HOST>:8096/claude-code/default
export ANTHROPIC_API_KEY='sk-mem-<面板给这个人的>'       # Proxy 认人 → x-api-key
export ANTHROPIC_AUTH_TOKEN='<这个人自己的公司网关 Key>' # 上游模型 → Authorization
# 新开 shell 先 unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN，避免环境变量盖掉 settings.json
claude --model <PROXY_UPSTREAM_MODEL>
```

两把不要对调。提示 Both AUTH_TOKEN and API_KEY set 是预期现象。

路径：客户端请求 `/claude-code/default/v1/messages`，Proxy 转到 `{PROXY_UPSTREAM_URL}/messages`。

## 怎么确认透传生效

在测试机或能访问 8096 的电脑上（不要把 Key 打进日志）：

| 请求 | 期望 |
|------|------|
| 真 `sk-mem` + 真网关 Key | 200 |
| 假 `sk-mem` + 真网关 Key | Proxy `401 invalid user_key` |
| 真 `sk-mem` + 假网关 Key | **网关**报错，不能是 200 |

第三组如果 200，说明 `claude-code` 仍写了服务器 `apiKey`，重新 `./up.sh`。

公司网关必须能接受模型 Key 在 `Authorization: Bearer`（`x-api-key` 已被 `sk-mem` 占用）。只认 `X-Api-Key`、完全不看 Bearer 的网关，这套透传会失败。

容器里探网关：

```bash
docker exec tdai-proxy sh -c 'wget -S -O- --timeout=8 https://<公司网关>/v1/models'
```

`fetch failed` 或证书错误：网关 TLS / 内网 CA，不是 Proxy 配错。

## 不要做的事

- 不要把本机 MiniMax 的 `.env` 拷上去
- 不要填 `MEMORY_CORE_GATEWAY_API_KEY`
- 不要 `./down.sh --purge`（会清空三个 volume）
- 不要两台机器同时写同一份记忆 volume

## 备份

```bash
./backup.sh
./restore.sh backups/<时间戳>
```

`alpine:3.20` 已打进 `tdai-images.tgz`，离线备份才能跑。`.admin-key` 必须和 `tdai-core-data` 一起备份。
