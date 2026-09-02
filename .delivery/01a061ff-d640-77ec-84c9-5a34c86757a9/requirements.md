# SUIB-12 产品需求规格 — 基于 release 重建 amd64 镜像并本机验证

| 字段 | 值 |
|------|-----|
| Issue | SUIB-12 (`01a061ff-d640-77ec-84c9-5a34c86757a9`) |
| 仓库 | https://github.com/li6540123/TencentDB-Agent-Memory.git |
| 基线分支 | `release` |
| 部署环境 | **本机 / staging**（非生产） |
| Product Owner | fule.li |
| 版本 | 1.0 |
| 状态 | PLAN-1 完成，待 Architect |

---

## 1. 背景与问题陈述

TencentDB Agent Memory 提供 Agent 记忆服务三件套：**memory-core**（内核 gateway）、**memory-hub**（管理面板 + 知识服务）、**proxy**（LLM 请求转发）。当前 fork 的 `release` 分支需要基于最新快照 **重新构建 linux/amd64 Docker 镜像**，并在本机完成部署与功能验证，交付可复现的构建/部署产物。

本需求**不是**功能开发或 upstream 合并，而是 **构建 + 部署 + smoke 验证** 的交付任务。

---

## 2. 目标

1. 以 `release` 为唯一基线，确认并执行 **linux/amd64** 镜像构建。
2. 在本机通过部署脚本（或 repo 现有脚本）启动三件套容器。
3. 完成核心功能 smoke 验证，证明镜像不仅 build 成功且**可运行**。
4. 交付镜像 tag 说明、部署脚本/文档、验证记录及 `.delivery/` 门禁产物。

---

## 3. 用户与场景

| 角色 | 场景 |
|------|------|
| 开发/运维 | 从 `release`  checkout，一条命令构建 amd64 镜像 |
| 开发/运维 | 本机 `.env` 配置后启动三件套，访问 Panel 与 API |
| QA | 按本 PRD 验收标准执行 L1–L3 验证并写入 `qa-report.yaml` |
| PO | 确认 scope、授权 PR 合并回 `release`（非生产部署授权） |

---

## 4. 范围

### 4.1 In scope

- 基于 `release` 分支构建 **linux/amd64** Docker 镜像（memory-core、memory-hub、proxy，或 repo 定义的等价组件集）。
- 本机部署验证（默认路径：`deploy/global-images` 或 Architect 在 `stack.yaml` 中指定的等价路径）。
- 部署脚本完善或用法文档更新（若 repo 已有脚本则补充说明，不重复造轮子）。
- `.delivery/01a061ff-d640-77ec-84c9-5a34c86757a9/` 下门禁产物（requirements 已完成；stack/design/tasks/qa/deploy 由后续角色补齐）。
- 若修复构建/部署阻塞问题，改动以 PR 形式提交，标题含 `SUIB-12`。

### 4.2 Out of scope

- 合并官方 upstream 新代码（除非 `release` 当前快照构建失败且需最小 fix）。
- **生产环境**发布与公网暴露（需 PO 单独授权）。
- 非 amd64 架构（arm64 等多架构构建不在本需求范围）。
- 新功能开发、性能优化、安全加固（除非阻塞 smoke）。
- 内网离线打包路径（`deploy/internal-team`）——除非 Architect 判定为本机验证唯一可行路径。

---

## 5. 功能与非功能需求

### 5.1 镜像构建（FR-1）

- **FR-1.1** 构建源必须为 `release` 分支当前 checkout（记录 commit SHA）。
- **FR-1.2** 产出镜像平台为 `linux/amd64`（`docker inspect` 或 build log 可证）。
- **FR-1.3** 构建命令/脚本可复现，记录在 `deploy.yaml` 的 `build_cmd` 字段。
- **FR-1.4** 镜像 tag 命名需含 issue 标识或日期语义，避免覆盖 `:latest` 且无说明。

### 5.2 本机部署（FR-2）

- **FR-2.1** 使用 repo 现有部署入口（优先 `deploy/global-images/start-all.sh` 或 Architect 确认的路径）。
- **FR-2.2** 部署前可通过 `verify.sh`（或等价脚本）做环境干跑校验；LLM 预检允许 `--skip-llm` 仅当 QA 记录中说明离线限制。
- **FR-2.3** 三容器成功启动且端口监听（默认：8125 Panel、8420 Gateway、8424 Knowledge、8096 Proxy——以 repo 文档为准）。
- **FR-2.4** 部署脚本/README 说明所需环境变量（memory 组 LLM、proxy 组 LLM 等）及最小配置步骤。

### 5.3 功能 Smoke（FR-3）

以下为**产品级** smoke 清单；具体 HTTP 路径与命令由 Architect 写入 `stack.yaml` / QA 写入 `qa-report.yaml` evidence。

| ID | 验证项 | 通过条件 |
|----|--------|----------|
| SM-1 | memory-core 存活 | Gateway 端口可访问；health/readiness 或等价 API 返回成功 |
| SM-2 | memory-hub 存活 | Panel UI（默认 `:8125`）HTTP 200；Knowledge API（默认 `:8424/v3/`）可访问 |
| SM-3 | proxy 存活 | Proxy 端口（默认 `:8096`）可访问；无 crash loop |
| SM-4 | 组件联通 | memory-hub 可连 memory-core（日志无持续 RAG/auth 致命错误） |
| SM-5 | 基础 API | 至少一项 documented health/docs/swagger 端点响应正常 |

**注：** 完整 LLM 对话链路验证依赖有效 API Key；smoke 最低标准为容器健康 + 端点可达。若配置 LLM，可选 SM-6：`verify.sh` LLM 通路预检通过。

### 5.4 交付与文档（FR-4）

- **FR-4.1** `deploy.yaml` 含：镜像 tag、build_cmd、env 摘要、访问 url、health_check 命令、rollback_cmd。
- **FR-4.2** `qa-report.yaml` 含每项 AC 的 evidence（命令输出摘要或截图路径）。
- **FR-4.3** 改动 repo 文件时开 PR，base=`release`，标题含 `SUIB-12`。

### 5.5 非功能需求

| ID | 要求 |
|----|------|
| NFR-1 | 构建与部署步骤可在 README/脚本注释中 30 分钟内被新同学复现 |
| NFR-2 | 不在交付物中提交真实 API Key / 密钥 |
| NFR-3 | 默认凭据（如 `local`/`admin`）仅用于本机；文档须 warn 生产需替换 |

---

## 6. 验收标准（可测）

与 issue AC 一一对应，QA 必须逐项给出 pass/fail + evidence。

| ID | 条件 | 验证方法 |
|----|------|----------|
| **AC1** | 从 `release` 成功构建 amd64 镜像 | `docker build` / Makefile / repo 脚本 exit 0；`docker inspect` 显示 `Architecture: amd64`（或 buildx `--platform linux/amd64` 日志） |
| **AC2** | 镜像可在本机启动 | `docker compose up` 或 `start-all.sh` 后三容器 Running；目标端口 listening |
| **AC3** | 核心功能 smoke 通过 | SM-1～SM-5 全部 pass；evidence 写入 qa-report |
| **AC4** | deploy 脚本或文档更新 | `deploy/` 下脚本可执行或 README/DEPLOY 用法清晰；变更有 PR 或 delivery 目录说明 |
| **AC5** | `.delivery/<issue-id>/` 门禁产物齐全 | 存在 `stack.yaml`、`qa-report.yaml`（blocking=false）、`deploy.yaml`；requirements.md 已存在 |

### 6.1 验收通过定义

- AC1–AC5 **全部 pass**。
- `qa-report.yaml` 中 `blocking: false`。
- 无未记录的 open blocker。

---

## 7. 交付物清单

| 产物 | 负责角色 | 路径 | 本需求状态 |
|------|----------|------|------------|
| requirements.md | Product Spec | `.delivery/01a061ff-d640-77ec-84c9-5a34c86757a9/requirements.md` | ✅ 本文档 |
| stack.yaml | Architect | 同上 | 待产出 |
| design.md | Architect | 同上 | 待产出 |
| tasks.md | Architect | 同上 | 待产出 |
| amd64 镜像 | Dev | 记录在 deploy.yaml | 待 BUILD |
| 部署脚本/文档 | Dev | repo `deploy/` | 待 BUILD |
| qa-report.yaml | QA | `.delivery/.../` | 待 VERIFY |
| deploy.yaml | DevOps | `.delivery/.../` | 待 SHIP |
| review.md | Reviewer | `.delivery/.../` | 待 REVIEW |
| PR（若有代码改动） | Dev | GitHub | 待 BUILD |

---

## 8. 测试策略（Architect 细化）

| 层级 | 范围 | 负责 |
|------|------|------|
| **L1** | 构建脚本 exit 0；repo 既有单元测试（若有） | Dev |
| **L2** | 容器启动、配置加载、端口监听 | Dev / QA |
| **L3** | SM-1～SM-5 smoke；可选 LLM 通路 | QA（本机部署后） |

QA 可 skip L3 子项须 explicit 理由写入 qa-report（本需求默认 **不可 skip** SM-1～SM-5）。

---

## 9. 分支与发布约定

- Checkout ref：`release`
- Feature 分支建议：`agent/full-delivery/suib-12-rebuild-amd64`
- PR 合并目标：`release`（**需 PO 确认**）
- 镜像发布：本机验证通过即可；Docker Hub 推送 **不在本需求默认范围**（除非 PO 追加）

---

## 10. 风险与假设

| 类型 | 描述 | 缓解 |
|------|------|------|
| 假设 | 执行环境有 Docker，可 build/run linux/amd64 | Architect 在 stack.yaml 记录 host 要求 |
| 假设 | `release` 当前快照可构建 | 若失败，允许最小 fix PR，不 merge upstream |
| 风险 | LLM Key 缺失导致交互式 start 失败 | smoke 以容器+端点为准；LLM 检查 optional |
| 风险 | 端口冲突（8125/8420/8424/8096） | 文档说明 `.env` 改端口 |
| 风险 | Mac arm64 host 交叉构建 amd64 | 明确 buildx/platform 参数 |

---

## 11. Open Questions

| # | 问题 | 默认决策 | 需 PO 确认 |
|---|------|----------|------------|
| OQ-1 | 是否推送镜像到 Docker Hub / 私仓？ | **否**，仅本机构建+本地 tag | 若需推送则 PO 确认 |
| OQ-2 | PR 合并 release 时机 | 全链路 PASS 后 PO 确认 merge | 是 |
| OQ-3 | 使用 `global-images` 还是 `internal-team` 路径？ | 默认 **global-images**（本机可联网拉基础镜像） | Architect 可 override |

---

## 12. 附录：产品组件速查（非技术栈绑定）

供 smoke 与验收对齐用语，具体实现以 repo 为准：

| 组件 | 用户可见能力 | 默认端口 |
|------|--------------|----------|
| memory-core | 记忆读写、鉴权、skill/RAG 数据面 | 8420 |
| memory-hub | Panel UI + Knowledge API | 8125 / 8424 |
| proxy | Coding agent 的 LLM API 入口 | 8096 |

参考：`deploy/global-images/README.md`、根目录 `README.md` / `INSTALL.md`。
