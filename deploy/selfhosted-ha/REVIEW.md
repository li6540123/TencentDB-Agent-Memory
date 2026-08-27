# Selfhosted HA 方案审查报告（OceanBase 4.4.2）

> **分支：** `feat/selfhosted-ha-oceanbase`  
> **审查基准：** `deploy/internal-team`（单机） + 现有 MemoryCore / MemoryHub / MemoryProxy 代码  
> **结论：** 方向正确，可实施；需修正 **数据分层描述**、**P3/P4 边界** 与若干 **代码/部署细节** 后再开工。

---

## 1. 审查结论（TL;DR）

| 维度 | 评级 | 说明 |
|------|------|------|
| 存储选型 | ✅ | OB 4.4.2 同时覆盖 MongoDB 职责（metadata）+ TCVDB 职责（向量）；单库 `agent_team_memory` 与单实例目标一致 |
| 水平扩展拓扑 | ✅ | Proxy→Redis、Core→OB+Redis+NFS、Hub→OB+NFS；nginx LB 分层合理 |
| 阶段划分 | ⚠️ | P1 可独立做；P2→P3 是主路径；P4 仅 Hub 引擎库，勿与 Core Knowledge 注册表混淆 |
| 代码就绪度 | ❌ | `deployMode: selfhosted`、`mysql` metadata、`obvector` store **均未实现** |
| 文档一致性 | ⚠️ | 已统一库名；需补齐「三层数据」与 internal-team 迁移差异 |

**建议执行顺序：** P0 → P1（Proxy 双副本，零 Core 二开）→ P2（metadata 上 OB，Core 仍 SQLite 向量）→ P3（向量+Skill+Redis state）→ P4（Hub knowledge.db）→ P5 NFS。

---

## 2. 数据分层（审查后定稿）

方案里最容易混的是 **三套库/存储**，必须分开：

```text
┌─────────────────────────────────────────────────────────────────┐
│ OceanBase  agent_team_memory                                     │
├─────────────────────────────────────────────────────────────────┤
│ P2  IMetadataStore（原 MongoDB / SQLite metadata.db）            │
│     meta_users, meta_teams, meta_user_keys, meta_agents, ...     │
├─────────────────────────────────────────────────────────────────┤
│ P3  IMemoryStore + ISkillStore（原 SQLite vectors.db）           │
│     l0_*, l1_* + VECTOR/FULLTEXT                                 │
│     skill_* + VECTOR                                             │
│     entity_knowledge ← Core Knowledge **注册表**（service_url 等）│
│     entity_teams/users/agents 镜像表、audit、prompts 等           │
├─────────────────────────────────────────────────────────────────┤
│ P4  Hub 引擎元数据（原 knowledge.db / Drizzle SQLite）           │
│     knowledge_wiki, knowledge_code_graph, llm_binding, ...     │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────┐     ┌──────────────────────┐
│ NFS /data/tdai/core  │     │ NFS .../hub/knowledge │
│ L2/L3 jsonl、Skill 文件│     │ Git clone、Wiki 索引   │
└──────────────────────┘     └──────────────────────┘

┌──────────────────────┐
│ Redis                │
│ Proxy 会话、Core 锁/队列、Hub CodeGraph 构建锁（P4）              │
└──────────────────────┘
```

### 2.1 与 MongoDB / TCVDB 的精确对应

| 官方 service | 实际接口 | selfhosted 落点 | 阶段 |
|--------------|----------|-----------------|------|
| MongoDB | `IMetadataStore` | OB `meta_*` | **P2** |
| TCVDB 记忆向量 | `IMemoryStore` | OB `l0_*`/`l1_*` + VECTOR | **P3** |
| TCVDB Skill 向量 | `ISkillStore` | OB `skill_*` + VECTOR | **P3** |
| TCVDB 内 Knowledge 注册 | `IMemoryStore.createKnowledge` 等 | OB `entity_knowledge` | **P3**（非 P4） |
| Hub SQLite | Drizzle `knowledge.db` | OB `knowledge_*` | **P4** |
| COS | `LocalStorageBackend` | `/data/tdai/core` → NFS | 配置 + P5 |

### 2.2 原方案需修正的一点

~~「Knowledge 元数据 Phase 4 进 OB」~~ 应拆成两句：

- **Core `KnowledgeEntity` 注册表**（Panel 创建 Knowledge、填 `service_url`）→ **P3**，随 `ObVectorMemoryStore` 从 `sqlite.ts` 移植 `entity_knowledge`。
- **Hub Wiki/CodeGraph 引擎表** → **P4**，改 Drizzle 驱动。

---

## 3. 与 internal-team 现状的差异

| 项 | internal-team 现在 | selfhosted 目标 | 迁移注意 |
|----|-------------------|-----------------|----------|
| Core 数据目录 | `/data/tdai-memory` 单 volume | `/data/tdai/core` | 仅保留 L2/L3/Skill 文件；metadata+vectors 迁 OB |
| metadata | `{dataDir}/metadata/.../metadata.db` | OB `meta_*` | P2 迁移脚本 |
| vectors | `{dataDir}/vectors.db`（含 entity_knowledge） | OB 向量表 | P3 迁移脚本 |
| stateBackend | 默认 `local` | **`redis`** | P3 前 Core 多副本不可用 |
| compose | 全服务 `container_name` |  scalable 服务无固定名 | P0/P1 必须改 |
| Hub DB | `hub-data` volume 内 SQLite | OB + 共享 knowledge 目录 | P4 |
| Proxy | 单实例，Redis 会话已有 | nginx + ×2 | P1 即可 |

---

## 4. 代码就绪度检查

| 能力 | 代码位置 | 状态 |
|------|----------|------|
| `deployMode` | `config.ts`: `standalone` \| `service` only | ❌ 需加 `selfhosted` |
| Metadata mysql | `factory.ts` case `mysql` | ❌ `throw not yet implemented` |
| Memory obvector | `store-pool.ts`: `sqlite` \| `tcvdb` only | ❌ 需 `obvector` |
| `KnowledgeEntity` | `sqlite.ts` / `tcvdb.ts` | ✅ 有参考实现 → 移植到 P3 |
| Hub MySQL | `db/client.ts` 仅 better-sqlite3 | ❌ P4 |
| Hybrid search | — | ❌ 需封装 `DBMS_HYBRID_SEARCH` |
| Contract tests | `metadata-store.contract.ts` | ✅ 可复用于 mysql adapter |

---

## 5. 分阶段审查

### P0 — 脚手架 ✅ 合理

- compose 不含 OB；`.env.example` 写 `agent_team_memory`。
- **补充：** 从 internal-team 复制 `render-config.py` / `up.sh` 模式，避免重复造轮子。

### P1 — Proxy 水平扩展 ✅ 可先做

- internal-team Proxy 已支持 Redis session。
- **风险：** `hookCacheRepo` 等若走本地 SQLite，多 Proxy 副本可能 cache 不一致——需确认是否可接受或改 Redis（低优先级，不影响会话）。

### P2 — Metadata on OB ⚠️ 工作量中等

- 镜像 `sqlite-adapter.ts`（~1400 行）→ `mysql-adapter.ts`。
- selfhosted **固定库** `agent_team_memory`，**不用** `resolveMetadataDbName` 分库。
- `validateMetadataStartupConfig`：selfhosted 应要求 `TDAI_OB_URI`，**禁止**与 SQLite metadata 路径同时配置。

### P3 — 向量 + Skill ⚠️⚠️ 工作量最大

- 移植 `sqlite.ts` 全量能力（L0/L1、entity 镜像、audit、prompts、**entity_knowledge**）。
- **Embedding 维度：** internal-team 由 env 配置（如 Qwen embedding），DDL `VECTOR(n)` **须与线上一致**；建议在 `embedding_meta` 表记录维度，启动时校验。
- **距离度量：** SQLite vec0 用 **cosine**；OB 建索引时选 `distance=cosine`（若支持）或与模型对齐的 metric，否则迁移后 KNN 质量下降。
- **Hybrid：** 中文 FULLTEXT 效果依赖 OB 分词配置，需 POC；失败时可降级 `recall.strategy: vector`。
- `StorePool`：selfhosted 仅 `default` 一条连接，可简化为 singleton，避免误走 per-instance SQLite 路径。

### P4 — Hub knowledge.db ✅ 边界清晰

- Drizzle schema 已有；加 `mysql2` driver 路径。
- CodeGraph 构建锁用 Redis（方案已写）。
- Hub×2 依赖 **共享** `/data/tdai/hub/knowledge` NFS。

### P5/P6 — 运维 ✅

- 仅文件 NFS；OB/Redis 仍公司托管。

---

## 6. 风险矩阵（按优先级）

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| R1 | P3 `ObVectorMemoryStore` 范围低估 | 延期 | 按 `sqlite.ts` 能力 checklist 逐项移植；Knowledge 注册表算 P3 |
| R2 | VECTOR 维度与 embedding 模型不一致 | 启动失败 / 检索错误 | 启动读 `embedding_meta`；DDL 参数化 |
| R3 | cosine→OB index metric 不一致 | 召回质量差 | POC 对比；必要时重算 embedding |
| R4 | 中文 hybrid FULLTEXT 弱 | hybrid 不如 SQLite FTS | 可配置降级纯向量；调 OB 全文参数 |
| R5 | P3 完成前 Core×2 | 数据损坏 | 严格：P3 前 core replicas=1 |
| R6 | Hub P4 前 hub×2 | SQLite 多写损坏 | 严格：P4 前 hub replicas=1 |
| R7 | NFS 文件锁 / 并发写 L2 | Pipeline 异常 | 已有 Redis pipeline lock；验证 NFS 文件锁语义 |
| R8 | `DBMS_HYBRID_SEARCH` JSON 注入 | 安全 | 参数化构造 JSON；禁止拼接用户原文进 JSON 结构 |

---

## 7. 配置审查（定稿）

```bash
# OB（已建库）
TDAI_OB_URI=mysql://<user>:<pass>@<host>:2881/agent_team_memory?charset=utf8mb4
TDAI_OB_DATABASE=agent_team_memory

# 单实例
TDAI_INSTANCE_ID=default
TDAI_DEPLOY_MODE=selfhosted          # 二开后

# Redis（Core 锁/队列 + Proxy 会话）
STATE_BACKEND=redis
REDIS_HOST=...
REDIS_PASSWORD=...
REDIS_KEY_PREFIX=tdai_memory

# 文件（与 OB 库名无关）
TDAI_DATA_DIR=/data/tdai/core
KNOWLEDGE_DATA_DIR=/data/tdai/hub/knowledge
```

---

## 8. 文档与分支

| 文件 | 状态 |
|------|------|
| `ARCHITECTURE.md` | ✅ 已 OB + 单实例 + `agent_team_memory` |
| `2026-08-26-selfhosted-ha-oceanbase.md` | ⚠️ 已按审查更新 P3 Knowledge 边界 |
| `REVIEW.md` | ✅ 本文 |
| 分支 | ✅ `feat/selfhosted-ha-oceanbase` |

---

## 9. 审查后行动项

- [ ] **A1** P3 任务清单增加 `entity_knowledge` 与 entity 镜像表移植
- [ ] **A2** P2 增加 selfhosted 启动校验（OB URI 必填、禁 SQLite metadata 混用）
- [ ] **A3** embedding 维度 POC：读 internal-team `.env` 实际模型 → 定 `VECTOR(n)`
- [ ] **A4** OB 上跑 hybrid smoke（插入 + `DBMS_HYBRID_SEARCH` + 中文 content）
- [ ] **A5** P0 compose 去掉 scalable 服务的 `container_name`
- [ ] **A6** 编写 `migrate-sqlite-to-oceanbase` 分两步：metadata（P2）、vectors（P3）

---

## 10. 一句话（审查版）

**单实例 `default` + 单库 `agent_team_memory` + Redis + NFS 文件；MongoDB 等价物是 P2 metadata adapter，TCVDB 等价物是 P3 memory/skill adapter（含 Core Knowledge 注册表），Hub 引擎库是 P4；最大风险在 P3 移植面与向量/hybrid POC，而非架构选型本身。**
