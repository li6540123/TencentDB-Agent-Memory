# selfhosted-ha 快速索引

自托管、可水平扩展部署方案（**OceanBase 4.4.2** + Redis）。**单实例**：固定 `default`，一套 OB 库。

| 文档 | 读者 | 内容 |
|------|------|------|
| **[PROPOSAL.md](./PROPOSAL.md)** | 方案说明 | 现状、目标、组件替换、部署路径、风险摘要 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 研发 / 架构 | 目标拓扑、数据分层、配置、迁移与扩展约束 |
| [REVIEW.md](./REVIEW.md) | 研发 | 审查结论、P2–P4 边界、代码就绪度、风险矩阵 |
| [实施计划 P0–P6](../../docs/superpowers/plans/2026-08-26-selfhosted-ha-oceanbase.md) | 研发 | 任务拆解、验收标准、工期参考 |

**分支：** `feat/selfhosted-ha-oceanbase`

**当前状态：** 架构、审查报告与计划文档；代码二开未开始。

**存储前提：**

- OceanBase **4.4.2**，**MySQL 兼容租户**（公司已有，compose 内不部署 OB）
- **一个库 `agent_team_memory`**，一条连接串
- Redis（公司已有或 compose 内 1 实例）
- 文件：`/data/tdai/core`、`/data/tdai/hub`（本机盘 → 后续 NFS）

**首期单机副本建议：** `proxy=2`, `core=2`（P3 后）, `hub=1`.

**不在范围内：** 多 `instance_id`、按 instance 分库、按 instance 分文件目录。

---

## 与公司 OB 对接（P0 文档化）

向 DBA 索取：

```bash
TDAI_OB_URI=mysql://<user>:<pass>@<host>:2881/agent_team_memory?charset=utf8mb4
TDAI_OB_DATABASE=agent_team_memory
TDAI_INSTANCE_ID=default
TDAI_DATA_DIR=/data/tdai/core
```

确认项：

| 项 | 要求 |
|----|------|
| 版本 | **4.4.2** |
| 租户模式 | MySQL |
| 库 | **`agent_team_memory`**（utf8mb4 / utf8mb4_general_ci） |
| 向量 | `VECTOR` 列、`VECTOR INDEX`、可执行 `DBMS_HYBRID_SEARCH` |
| 字符集 | utf8mb4 |
| Embedding 维度 | 与模型一致（建表 `VECTOR(n)` 用） |
