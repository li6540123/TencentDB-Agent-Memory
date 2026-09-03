# TencentDB-Agent-Memory

AI Agent 长期记忆服务，为任意 Agent 框架提供四层渐进式记忆能力（L0 对话 → L1 原子记忆 → L2 场景归纳 → L3 用户画像）。

## 镜像信息

| 项目 | 值 |
|------|---|
| 镜像名 | `tencentdb-agent-memory` |
| 基础镜像 | `node:22-slim` |
| 大小 | ~920MB |
| 端口 | 8420 |
| 运行用户 | tdai (uid 10001) |
| PID 1 | tini |

## 快速开始

以下命令默认在 `MemoryCore/` 目录内执行；如果你位于仓库根目录，请先 `cd MemoryCore`。

### 1. 构建镜像

```bash
docker build -t tencentdb-agent-memory:latest .
```

### 2. 准备配置文件

项目提供两个配置模板：

| 模板 | 适用场景 |
|------|---------|
| `tdai-gateway.standalone.yaml` | 本地开发、单机部署，零外部依赖 |
| `tdai-gateway.service.yaml` | K8s 多副本、多租户云服务 |

复制模板并修改：

```bash
# 单机模式
cp tdai-gateway.standalone.yaml tdai-gateway.yaml

# 服务模式
cp tdai-gateway.service.yaml tdai-gateway.yaml
```

### 3. 启动容器

**Standalone 模式（最简）：**

```bash
docker run -d --name agent-memory \
  -v $(pwd)/tdai-gateway.yaml:/data/config/tdai-gateway.yaml:ro \
  -e TDAI_LLM_API_KEY=sk-your-key \
  -p 8420:8420 \
  tencentdb-agent-memory:latest
```

**Service 模式（需要 Redis）：**

```bash
# 启动 Redis（如果没有远端 Redis）
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 启动 mock-shark（本地提供 VDB/COS 凭证）
VDB_ENDPOINT=http://your-vdb:8100 \
VDB_API_KEY=xxx \
VDB_DATABASE=your-db \
COS_BUCKET=your-bucket \
COS_REGION=ap-guangzhou \
COS_SECRET_ID=xxx \
COS_SECRET_KEY=xxx \
npx tsx scripts/mock-shark-server.ts &

# 启动 Memory Service
docker run -d --name agent-memory \
  -v $(pwd)/tdai-gateway.real.yaml:/data/config/tdai-gateway.yaml:ro \
  -e TDAI_LLM_API_KEY=sk-your-key \
  -p 8420:8420 \
  tencentdb-agent-memory:latest
```

**Docker Compose 一键启动（含 Redis）：**

```bash
TDAI_LLM_API_KEY=sk-your-key docker compose -f docker-compose.local.yaml up --build
```

### 4. 验证服务

```bash
curl http://localhost:8420/health
```

正常返回：

```json
{
  "status": "ok",
  "version": "0.1.0",
  "services": {
    "timerScanner": { "isLeader": true },
    "pipelineWorker": { "workerId": "worker-xxx" },
    "stateBackend": "connected"
  }
}
```

### 4.1 现场查 SQLite（宿主机 sqlite3 只读查挂载卷）

`memory-core` 的 SQLite 已经被 `deploy/global-images/start-memory-core.sh` 挂成命名卷
（默认 `tdai-memory-core-data`，可在 `.env` 改 `MEMORY_CORE_VOLUME`）；db 路径
`/data/tdai-memory/vectors.db` 和 `/data/tdai-memory/metadata/tdai_metadata_<id>/metadata.db`
落在卷挂载点下。

宿主机装好 `sqlite3`，拿到卷挂载点后**只读**查询即可，不必改镜像：

```bash
CORE_DIR=$(docker volume inspect tdai-memory-core-data --format '{{ .Mountpoint }}')
sqlite3 "file:${CORE_DIR}/vectors.db?mode=ro" '.tables'
sqlite3 "file:${CORE_DIR}/vectors.db?mode=ro" \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

务必 `?mode=ro`（避免与业务进程的 `node:sqlite` 抢锁）。WAL 下 `docker cp` 单个 `.db`
会缺数据，走挂载点直读现场文件不存在这个问题。完整说明、卷名对照、Mac + Colima 适配、
故障排查见 `docs/SQLITE-DEBUG.md`。

## 配置方式

### 配置文件 + 环境变量（推荐）

所有配置项同时支持 **YAML 配置文件** 和 **环境变量**，环境变量优先级更高。

容器内配置文件路径由 `TDAI_GATEWAY_CONFIG` 环境变量指定，默认 `/data/config/tdai-gateway.yaml`。

```
┌─────────────────────────────┐
│  环境变量 (最高优先级)        │  ← Secret 敏感凭证
├─────────────────────────────┤
│  tdai-gateway.yaml 配置文件  │  ← ConfigMap 挂载
├─────────────────────────────┤
│  代码默认值                  │  ← 兜底
└─────────────────────────────┘
```

### 配置文件结构

```yaml
deployMode: service          # standalone | service

server:
  port: 8420
  host: "0.0.0.0"

llm:                         # LLM API (OpenAI 兼容)
  baseUrl: "https://api.lkeap.cloud.tencent.com/v1"
  apiKey: "${TDAI_LLM_API_KEY}"
  model: "deepseek-v3.2"

redis:                       # Redis (service 模式必需)
  host: "redis:6379"
  keyPrefix: "tdai_memory"

shark:                       # Shark 配置中心 (下发 VDB/COS 凭证)
  baseUrl: "http://shark:8000"

scanner:                     # Timer Scanner
  intervalMs: 500

worker:                      # Pipeline Worker
  pollMs: 200

memory:                      # 记忆引擎调参
  pipeline:
    everyNConversations: 5
    enableWarmup: true
  recall:
    maxResults: 5
    strategy: "hybrid"
```

完整配置参考 `tdai-gateway.standalone.yaml` 和 `tdai-gateway.service.yaml`。

### 环境变量与配置文件对照表

| 环境变量 | YAML 路径 | 默认值 | 说明 |
|---------|----------|--------|------|
| `TDAI_DEPLOY_MODE` | `deployMode` | `standalone` | 部署模式 |
| `TDAI_GATEWAY_CONFIG` | — | `/data/config/tdai-gateway.yaml` | 配置文件路径 |
| `TDAI_LLM_API_KEY` | `llm.apiKey` | — | LLM API Key |
| `TDAI_LLM_BASE_URL` | `llm.baseUrl` | `https://api.openai.com/v1` | LLM 地址 |
| `TDAI_LLM_MODEL` | `llm.model` | `gpt-4o` | 模型名 |
| `REDIS_HOST` | `redis.host` | `127.0.0.1` | Redis 地址 |
| `REDIS_PORT` | `redis.port` | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | `redis.password` | — | Redis 密码 |
| `REDIS_KEY_PREFIX` | `redis.keyPrefix` | `tdai_memory` | Key 前缀 |
| `SHARK_BASE_URL` | `shark.baseUrl` | — | Shark 地址 |
| `STATE_BACKEND` | `stateBackend` | 自动 | `redis` / `local` |
| `SCANNER_INTERVAL_MS` | `scanner.intervalMs` | `500` | 扫描间隔 |
| `WORKER_POLL_MS` | `worker.pollMs` | `200` | Worker 轮询 |
| `COS_DOMAIN` | `cos.domain` | — | COS 内网域名 |

## K8s / TKE 部署

参考 `MemoryCore/deploy/k8s/tdai-memory.yaml`，核心做法：

1. **ConfigMap** 挂载 `tdai-gateway.yaml` 到 `/app/config/`
2. **Secret** 通过环境变量注入 `TDAI_LLM_API_KEY` + `REDIS_PASSWORD`
3. **Deployment** 设置 `TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml`

```yaml
# Deployment 中的关键配置
env:
  - name: TDAI_GATEWAY_CONFIG
    value: /data/config/tdai-gateway.yaml
  - name: TDAI_LLM_API_KEY
    valueFrom:
      secretKeyRef:
        name: tdai-memory-secrets
        key: TDAI_LLM_API_KEY
volumeMounts:
  - name: config-volume
    mountPath: /app/config
    readOnly: true
volumes:
  - name: config-volume
    configMap:
      name: tdai-memory-config
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| POST | `/recall` | 记忆召回 |
| POST | `/capture` | 写入对话 |
| POST | `/search/memories` | L1 记忆搜索 |
| POST | `/search/conversations` | L0 对话搜索 |
| POST | `/session/end` | 结束会话 |
| POST | `/v2/*` | v2 多租户 API（需 Bearer Token） |

## 架构

```
┌─────────────────────────────────────────────────────┐
│                 TencentDB Agent Memory               │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Gateway  │  │ TimerScanner │  │ PipelineWorker│  │
│  │ HTTP API │  │ 500ms 扫描   │  │ 竞争消费      │  │
│  └────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│       │               │                 │            │
│  ┌────▼─────────────────────────────────▼────────┐  │
│  │          IStateBackend (Redis / Local)         │  │
│  └───────────────────────────────────────────────┘  │
│       │                                              │
│  ┌────▼───────────┐  ┌────────────┐  ┌───────────┐  │
│  │  TdaiCore      │  │ StorePool  │  │ COS       │  │
│  │  L0→L1→L2→L3   │  │ VDB 连接池 │  │ 对象存储  │  │
│  └────────────────┘  └────────────┘  └───────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │               │
    ┌────▼────┐         ┌────▼────┐     ┌────▼────┐
    │  LLM    │         │  TCVDB  │     │  COS    │
    │ API     │         │ 向量库   │     │ 对象存储│
    └─────────┘         └─────────┘     └─────────┘
```

## 文件结构

```
.
├── MemoryCore/
│   ├── Dockerfile                       # 镜像构建
│   ├── docker-compose.local.yaml        # 本地一键测试 (含 Redis)
│   ├── tdai-gateway.standalone.yaml     # Standalone 配置模板
│   ├── tdai-gateway.service.yaml        # Service 配置模板
│   ├── tdai-gateway.real.yaml           # 本地测试配置 (连真实服务)
│   ├── deploy/k8s/tdai-memory.yaml      # K8s/TKE 部署清单
│   ├── scripts/mock-shark-server.ts     # Mock Shark (本地开发)
│   └── src/gateway/server.ts            # 服务入口
```

## License

Proprietary — Tencent Cloud
