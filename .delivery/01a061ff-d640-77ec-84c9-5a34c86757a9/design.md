# SUIB-12 架构设计 — amd64 镜像重建与本机验证

| 字段 | 值 |
|------|-----|
| Issue | SUIB-12 |
| 状态 | PLAN-2 |
| needs_human_decision | false（Q4/Q5/Q6 由 PO 并行决策，不阻塞 BUILD） |

---

## 1. 方案概述

本需求为 **交付型** 任务：在 `release` 快照上重建 linux/amd64 三件套镜像，经 `deploy/global-images` 本机拉起并完成 smoke。不引入新服务或架构变更。

```
release checkout
    → build (deploy/dockerhub/publish.sh PUSH=0, linux/amd64)
    → tag local images (agentmemory/*:suib-12-YYYYMMDD)
    → configure deploy/global-images/.env
    → start-all.sh (core → hub → proxy)
    → T0 smoke (health + /docs)
    → qa-report + deploy.yaml + PR
```

**部署路径选定：** `deploy/global-images`（PRD OQ-3 默认）。`deploy/internal-team` 仅作备选（离线/compose 场景），本任务不默认采用。

---

## 2. 构建设计

### 2.1 主路径 — `deploy/dockerhub/publish.sh`

| 组件 | Context | 输出镜像 |
|------|---------|----------|
| memory-core | `MemoryCore/` | `agentmemory/memory-core:${VERSION}` |
| memory-proxy | rsync + cost-guard stub | `agentmemory/memory-proxy:${VERSION}` |
| memory-hub | `panel-knowledge-combined/build.sh` PREPARE_ONLY | `agentmemory/memory-hub:${VERSION}` |

**amd64 保证：** `PUSH=0 LOAD_PLATFORM=linux/amd64` → buildx `--platform linux/amd64 --load`.

**VERSION 命名：** `suib-12-YYYYMMDD`（满足 FR-1.4，含 issue 标识 + 日期语义）。

### 2.2 备选路径 — `deploy/internal-team/build-local.sh`

当 buildx/publish 路径受阻时，Dev 可切换：`PLATFORM=linux/amd64 TAG=suib-12-YYYYMMDD ./build-local.sh`，镜像前缀 `tdai-local/*`，需同步改 `.env` 与部署入口（`up-local.sh`）。**仅作 fallback，PR 中须说明切换原因。**

---

## 3. 部署设计

### 3.1 配置

1. `cp deploy/global-images/.env.example deploy/global-images/.env`
2. 设置三组镜像为本地 build tag：
   ```bash
   MEMORY_CORE_IMAGE=agentmemory/memory-core:suib-12-YYYYMMDD
   MEMORY_HUB_IMAGE=agentmemory/memory-hub:suib-12-YYYYMMDD
   PROXY_IMAGE=agentmemory/memory-proxy:suib-12-YYYYMMDD
   ```
3. 填入 MEMORY_LLM_* / PROXY_UPSTREAM_*（`start-all.sh` 交互式或手工填写）
4. 确认端口无冲突：`8420, 8125, 8424, 8096`

### 3.2 启动顺序

`start-all.sh`：memory-core (wait healthy) → memory-hub (wait healthy) → proxy.

容器网络：`tdai-memory-stack`。数据卷：`tdai-memory-core-data`, `tdai-panel-data`.

### 3.3 回滚

```bash
cd deploy/global-images && ./stop-all.sh
```

彻底清理：`./stop-all.sh --purge`（删 volume，仅本机测试可用）。

---

## 4. T0 契约 — Health / Smoke API

> **门禁：** BUILD 阶段 Dev/QA 均以此为准；变更须 Architect 修订 stack.yaml + 本节前缀 T0.

| ID | Endpoint | 方法 | 期望 |
|----|----------|------|------|
| SM-1 | `http://127.0.0.1:8420/health` | GET | HTTP 200；JSON 含 status/ok 语义 |
| SM-2a | `http://127.0.0.1:8125/health` | GET | HTTP 200 |
| SM-2b | `http://127.0.0.1:8424/health` | GET | HTTP 200 |
| SM-3 | `http://127.0.0.1:8096/health` | GET | HTTP 200 |
| SM-5 | `http://127.0.0.1:8424/docs` | GET | HTTP 200（Swagger UI） |

**SM-4（组件联通）：** `docker logs tdai-memory-hub` 无持续 fatal 级 memory-core 连接错误（QA 截取日志摘要作 evidence）。

**LLM 通路（可选 SM-6）：** `deploy/global-images/verify.sh` 全检通过；离线环境可 `--skip-llm` 并在 qa-report 注明。

**端口 override：** 若 `.env` 改端口，T0 URL 同步替换 host:port，stack.yaml `t0_contract` 一并更新。

---

## 5. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| Mac arm64 交叉构建 amd64 失败 | 高 | 强制 buildx + `--platform linux/amd64`；失败切 internal-team build-local |
| build 耗时长 / OOM | 中 | 分组件构建 `publish.sh memory-core` 等；增大 Docker 内存 |
| start-all.sh 交互阻塞自动化 | 中 | 预填 `.env` LLM 变量；QA 文档记录非交互路径 |
| 端口占用 | 中 | `verify.sh` / `check_ports`；改 `.env` 端口 |
| cost-guard stub（开源 build） | 低 | 已知设计；proxy passthrough fallback |
| 默认 admin/local 凭据 | 低 | 仅本机；deploy.yaml 标注 NFR-3 |
| release 快照构建失败 | 中 | Q4 默认不在本 PR hotfix；PO 授权后最小 fix |

---

## 6. 交付物映射

| PRD AC | 实现要点 |
|--------|----------|
| AC1 | publish.sh PUSH=0 + amd64 inspect |
| AC2 | global-images start-all + container Up |
| AC3 | T0 smoke ×2 runs |
| AC4 | .env 用法 + 必要时 README 补充 |
| AC5 | stack/design/tasks + 后续 qa/deploy |

---

## 7. PO 待决项（不阻塞 BUILD）

| ID | 问题 | PRD 默认 |
|----|------|----------|
| Q4 | 构建失败是否允许 hotfix 入 PR | 否，单独立项 |
| Q5 | staging 范围 | 仅本机 |
| Q6 | 交付后自动 merge release | 否，PO 显式触发 |
