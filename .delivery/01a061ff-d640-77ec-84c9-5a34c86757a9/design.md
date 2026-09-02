# SUIB-12 架构设计 — release 快照重建 amd64 镜像并本机验证

| 字段 | 值 |
|------|-----|
| Issue | SUIB-12 (`01a061ff-d640-77ec-84c9-5a34c86757a9`) |
| 仓库 | https://github.com/li6540123/TencentDB-Agent-Memory.git |
| 基线分支 | `release` (commit `2a9f762`) |
| 部署环境 | **本机 / staging**（非生产） |
| 部署路径 | `deploy/global-images` (PRD OQ-3 默认) |
| 架构 | TypeScript (Node 22 ESM) 三件套 + Hono proxies + Vite/React Panel |
| needs_human_decision | false（Q4/Q5/Q6 由 PO 并行决策，不阻塞 BUILD） |

---

## 1. 方案概述

本任务是 **交付型** 而非功能开发：在 `release` 当前快照上重建 linux/amd64 三件套 Docker 镜像，经 `deploy/global-images` 本机拉起并完成 smoke。不引入新服务、新接口、新依赖。

### 1.1 数据流（运行态）

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  coding agent   │ ───► │ memory-proxy:8096│ ───► │ upstream LLM    │
│ (Claude Code…)  │ ◄─── │ (Hono + cost-    │ ◄─── │ (MEMORY/PROXY   │
└─────────────────┘      │  guard stub)     │      │  _LLM_*)        │
                         └────────┬─────────┘      └─────────────────┘
                                  │ tdai-memory inject (skill, recall)
                                  ▼
                         ┌──────────────────┐
                         │ memory-core:8420 │
                         │ (native http +   │
                         │  tsx runtime)    │
                         └────────┬─────────┘
                                  │ SQLite store + RAG
                                  ▼
                         ┌──────────────────┐
                         │ memory-hub:8125  │  Panel UI (Vite/React)
                         │            :8424 │  Knowledge API (Hono)
                         └──────────────────┘
```

三个容器通过 `tdai-memory-stack` Docker network 互通；`memory-hub` 内部两个进程共享镜像。数据卷：`tdai-memory-core-data`、`tdai-panel-data`。

### 1.2 交付管线（本次任务执行顺序）

```
release checkout (commit 2a9f762)
   └─► T1 build (deploy/dockerhub/publish.sh PUSH=0 LOAD_PLATFORM=linux/amd64)
         └─► agentmemory/memory-{core,proxy,hub}:suib-12-YYYYMMDD
              └─► T2 deploy (deploy/global-images .env + start-all.sh)
                    └─► 3 containers Up on ports 8420/8125/8424/8096
                         └─► T3 smoke (T0 contract, ≥2 runs per endpoint)
                              └─► qa-report + deploy.yaml + PR (title: SUIB-12)
```

---

## 2. 模块边界

| 模块 | 职责 | 关键文件 |
|------|------|---------|
| **memory-core** | 内核 gateway：L0/L1 记忆读写、鉴权、skill/RAG 数据面、`init-admin` | `MemoryCore/src/gateway/server.ts`, `MemoryCore/src/metadata/`, `MemoryCore/Dockerfile` |
| **memory-hub** | Panel UI (8125) + Knowledge API (8424) 合并镜像 | `MemoryPanel/`, `MemoryKnowledge/`, `deploy/panel-knowledge-combined/Dockerfile` |
| **memory-proxy** | LLM 转发 + tdai-memory 上下文注入 + cost-guard（开源构建时降级 passthrough） | `MemoryProxy/`, `MemoryProxy/Dockerfile` |
| **deploy/global-images** | 三件套本机部署入口（启动/停止/校验/LLM 预检） | `start-all.sh`, `start-memory-core.sh`, `verify.sh`, `_lib.sh` |
| **deploy/dockerhub** | buildx 多架构发布脚本（本地验证时 PUSH=0 LOAD_PLATFORM=amd64） | `publish.sh` |

**关键边界：**
- memory-core 的 `/health` **始终无需鉴权**（`server.ts:1043-1048` 注释说明：k8s liveness / docker healthcheck 依赖此契约），其它所有路由经 `TDAI_GATEWAY_API_KEY` Bearer gate。
- memory-proxy → memory-core 调用目前 **未带 Bearer**（源码遗漏，见 `MemoryProxy/src/auth.ts`），故 `MEMORY_CORE_GATEWAY_API_KEY` 本任务留空；此为已知设计，非本任务范围。
- admin user_key 在首次 `init-admin` 时由 `start-memory-core.sh` 生成随机 base32url 并落盘到 `.admin-key`（umask 077），后续重启复用。

---

## 3. 构建设计

### 3.1 主路径 — `deploy/dockerhub/publish.sh`

| 组件 | Context | 输出镜像 | Dockerfile |
|------|---------|----------|-----------|
| memory-core | `MemoryCore/` | `agentmemory/memory-core:${VERSION}` | `MemoryCore/Dockerfile` (multi-stage deps-builder → runtime) |
| memory-proxy | rsync + cost-guard stub | `agentmemory/memory-proxy:${VERSION}` | `MemoryProxy/Dockerfile` |
| memory-hub | `panel-knowledge-combined/build.sh PREPARE_ONLY` | `agentmemory/memory-hub:${VERSION}` | `deploy/panel-knowledge-combined/Dockerfile` |

**amd64 保证：** `PUSH=0 LOAD_PLATFORM=linux/amd64` → buildx `--platform linux/amd64 --load`（本地单架构 load，不 push Docker Hub）。

**VERSION 命名：** `suib-12-YYYYMMDD`（满足 FR-1.4：含 issue 标识 + 日期语义，避免误覆盖 `:latest`）。

**前置：** `secret-scan` (`MemoryPanel/scripts/secret-scan.sh`) 由 publish.sh 强制执行。

### 3.2 备选路径 — `deploy/internal-team/build-local.sh`

当 buildx/publish 路径受阻（如离线 / 无 rsync / 内网私仓）时切换：`PLATFORM=linux/amd64 TAG=suib-12-YYYYMMDD ./build-local.sh`，镜像前缀 `tdai-local/*`，需同步改 `.env` 与部署入口（`up-local.sh`）。**仅 fallback，PR 中须说明切换原因。**

### 3.3 AMD64 验证命令

```bash
docker image inspect agentmemory/memory-core:${VERSION} --format '{{.Architecture}}' | grep -qx amd64
```

（对 memory-hub / memory-proxy 同样执行；任一非 amd64 即视为 AC1 失败。）

---

## 4. T0 契约 — Health / Smoke API

> **门禁 (T0 gate)：** BUILD/QA 阶段 Dev/QA 均以此为准；任何变更须 Architect 修订 `stack.yaml` t0_contract 与本节。

### 4.1 Memory-core `/health` 响应 schema（最关键）

来源：`MemoryCore/src/gateway/types.ts:18-32`，`server.ts:1376-1384`。

```typescript
interface HealthResponse {
  status: "ok" | "degraded";     // vectorStore 存在 → "ok"；否则 "degraded"
  version: string;                // 当前 "0.1.0"
  uptime: number;                 // 秒（自 server 启动）
  stores: {
    vectorStore: boolean;
    embeddingService: boolean;
  };
  services?: {                    // 仅 state_backend 配置时存在
    timerScanner: unknown;
    pipelineWorker: unknown;
    stateBackend: string;
  };
}
```

### 4.2 Smoke endpoints

| ID | Endpoint | 方法 | 期望 HTTP | 期望 body 关键字段 | 来源 |
|----|----------|------|----------|--------|------|
| SM-1 | `http://127.0.0.1:8420/health` | GET | 200 | `status: "ok"\|"degraded"` | `MemoryCore/src/gateway/server.ts:1046` |
| SM-2a | `http://127.0.0.1:8125/health` | GET | 200 | `{"status":"ok"}` | `MemoryPanel/src/panel/http/routes/meta/instances.ts:5` |
| SM-2b | `http://127.0.0.1:8424/health` | GET | 200 | HealthResponse-shape | `MemoryKnowledge/src/routes/health.ts:10` |
| SM-3 | `http://127.0.0.1:8096/health` | GET | 200 | OK | `MemoryProxy/src/server.ts:84` |
| SM-5 | `http://127.0.0.1:8424/docs` | GET | 200 | Swagger UI HTML | Knowledge Service |

**SM-4（组件联通，QA 截屏 evidence）：** `docker logs tdai-memory-hub | grep -iE 'error|fatal'` 在 60s 启动窗口内无 memory-core 连接失败。

**SM-6（可选 LLM 通路）：** `deploy/global-images/verify.sh`（含 LLM 预检）通过；离线环境可 `--skip-llm` 并在 qa-report 注明。

**端口 override：** 若 `.env` 改端口（`MEMORY_CORE_PORT` / `PANEL_PORT` / `KNOWLEDGE_PORT` / `PROXY_PORT`），T0 URL 同步替换；`stack.yaml` t0_contract 字段一并更新（视为契约微调，不需重启 T0）。

---

## 5. 部署设计

### 5.1 `.env` 最小配置

`cp deploy/global-images/.env.example deploy/global-images/.env` 后设置：

```bash
MEMORY_CORE_IMAGE=agentmemory/memory-core:suib-12-YYYYMMDD
MEMORY_HUB_IMAGE=agentmemory/memory-hub:suib-12-YYYYMMDD
PROXY_IMAGE=agentmemory/memory-proxy:suib-12-YYYYMMDD
MEMORY_LLM_BASE_URL=https://...     # or REPLACE_ME + interactive
MEMORY_LLM_API_KEY=sk-...
MEMORY_LLM_MODEL=...
PROXY_UPSTREAM_URL=https://...
PROXY_UPSTREAM_API_KEY=...
PROXY_UPSTREAM_MODEL=...
```

非交互路径：手动填好后 `cd deploy/global-images && ./start-all.sh` 一路回车。

### 5.2 启动顺序

`start-all.sh`：memory-core (`wait_healthy 90s`) → memory-hub (`wait_healthy 90s`) → proxy。

`_lib.sh:wait_healthy()` 检查 `docker inspect .State.Health.Status`；无 healthcheck 的镜像以 running 为准。

### 5.3 回滚

```bash
cd deploy/global-images && ./stop-all.sh            # 停容器，保留 volume
cd deploy/global-images && ./stop-all.sh --purge    # 停容器 + 删 volume + 删网络
```

彻底清理后会丢失 admin user_key；下次启动脚本会重新生成。

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| Mac arm64 交叉构建 amd64 失败 | 高 | 强制 buildx + `LOAD_PLATFORM=linux/amd64`；失败切 `internal-team/build-local.sh` |
| build 耗时长 / OOM | 中 | 分组件构建 `publish.sh memory-core` 等；增大 Docker Desktop 内存到 ≥ 4GB |
| `start-all.sh` 交互阻塞自动化 | 中 | 预填 `.env` LLM 变量；QA 记录非交互路径用法 |
| 端口占用 | 中 | `verify.sh` 的 `check_ports` 兜底；改 `.env` 端口 |
| cost-guard stub（开源 build） | 低 | 已知设计；proxy 自动降级 passthrough |
| 默认 admin/local 凭据 | 低 | 仅本机；`deploy.yaml` 标注 NFR-3 不进入生产 |
| release 快照构建失败需 hotfix | 中 | Q4 默认 **不在本 PR 带修**；最小 fix 单独立 PR + PO 授权 |
| memory-proxy → memory-core 缺 Bearer（已知） | 低 | 本任务 `MEMORY_CORE_GATEWAY_API_KEY` 留空；不引入新逻辑 |
| LLM_KEY 暴露 | 中 | `.env` 不入仓；`.gitignore` 已含（`deploy/global-images/.env` 由 repo 验证脚本 `require_vars` 保护） |

---

## 7. Breaking change 策略

本任务 **不引入 breaking change**：
- 镜像二进制与 `release` 快照一致（同一 commit 重新打包）。
- 部署入口（`deploy/global-images/start-all.sh`）与脚本参数不变。
- T0 health endpoints 不变（已与 release 当前实现对齐）。

唯一对外可观察变化：**镜像 tag**（`:latest` → `:suib-12-YYYYMMDD`），由 `.env` 显式覆盖，属 PRD 允许的 FR-1.4 命名变更。

---

## 8. PO 待决项（不阻塞 BUILD）

| ID | 问题 | PRD 默认 | 阻塞 |
|----|------|---------|------|
| Q4 | release 快照若构建失败，是否允许 1–2 行 hotfix 入本 PR | 否，单独立项或 PO 同步授权 | 仅 T5 review 时可能触发 |
| Q5 | 除本机外是否还有受控 staging 范围 | 仅本机 | 否 |
| Q6 | 交付完成后是否自动 merge 到 release | 否，PO 显式触发 | 仅 T6 完成后由 PO 操作 |

Q1–Q3（健康入口权威路径 / tag 命名 / 部署入口形态）已采纳 PRD 默认假设推进。

---

## 9. 交付物映射（PRD AC ↔ 设计）

| PRD AC | 设计支撑 |
|--------|---------|
| AC1 amd64 镜像构建可复现 | §3.1 publish.sh PUSH=0 + §3.3 inspect amd64 |
| AC2 本机部署可启动 | §5.2 start-all 启动序列 + `verify.sh` 端口预检 |
| AC3 功能 smoke 通过 | §4 T0 contract SM-1..SM-5 ≥ 2 次 |
| AC4 部署脚本/说明 | `deploy.yaml` 含 env/url/health_check/rollback_cmd（`stop-all.sh`） |
| AC5 4 份交付物 | stack.yaml / design.md / tasks.md（本文件）+ qa-report.yaml + deploy.yaml |

---

## 10. Architect 自我边界

- **不写**业务实现代码；本文件 + stack.yaml + tasks.md 为 PLAN-2 唯一产出。
- 下一棒 Dev-Backend 仅消费 `tasks.md` T1–T3 与 `stack.yaml` t0_contract。
- 任何对 T0 contract 的修订须同步更新 stack.yaml + 本文件 §4，并由 Architect 重新派工。
