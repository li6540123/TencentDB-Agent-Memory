# ~~Selfhosted HA（PostgreSQL + pgvector + Redis）~~ — 已废弃

> **此文档已废弃。** 存储层改为公司 **OceanBase 4.4.2（MySQL 租户 + VECTOR）**，请使用：
>
> **[2026-08-26-selfhosted-ha-oceanbase.md](./2026-08-26-selfhosted-ha-oceanbase.md)**
>
> 架构总览：**[`deploy/selfhosted-ha/ARCHITECTURE.md`](../../deploy/selfhosted-ha/ARCHITECTURE.md)**

废弃原因：目标环境不可用 PostgreSQL；OceanBase 4.4.2 原生支持 VECTOR 列、HNSW 索引与 `DBMS_HYBRID_SEARCH` hybrid 检索，可单库替代 PG + pgvector + 独立向量库。

---

<details>
<summary>原文档（PostgreSQL 版，仅供 diff 参考）</summary>

# Selfhosted HA（PostgreSQL + pgvector + Redis）Implementation Plan

**Goal:** Enable horizontal scaling of Proxy/Core/Hub on a single host first, using company PostgreSQL (+ pgvector) and Redis for shared state, local disk for files (NFS later), without TCVDB/Mongo/COS.

**Tech Stack:** PostgreSQL 15+ with pgvector, Redis 7, existing memory-core/hub/proxy images (fork), nginx, Docker Compose.

（完整内容见 git history；不再维护。）

</details>
