# 升级说明：20688f9-amd64（给部署同事）

> **镜像包：** `tdai-images-20688f9-amd64.tgz`  
> **平台：** `linux/amd64`  
> **分支：** `feat/per-sk-mem-and-http-git`  
> **Git：** `1ac6058`（含 sendDimensions 修复）

---

## 一分钟看懂：比官方版多了什么？

本次在官方 Memory 三件套基础上，**一共 3 件事**：

| # | 改了什么（用户能感知） | 要升哪个镜像 | 要配什么 |
|---|----------------------|-------------|---------|
| **1** | Hub「API Keys」表多一列 **MaaS API Key**：每把 `sk-mem` 可单独绑公司网关 Key，同事 CLI 仍只配 `sk-mem` | core + proxy + hub | Core 加 `TDAI_MAAS_KEY_SECRET`；Hub 页面里逐行填 MaaS Key |
| **2** | CodeGraph 支持内网 **`http://` Git 仓库**（自动用 Jenkins 账号拉代码，token 不落盘） | **仅 hub** | Hub 加 `KNOWLEDGE_ALLOW_HTTP=1`、`KNOWLEDGE_GIT_TOKEN` 等 |
| **3** | **Bug 修复**：L0/L1 写入时向量 embedding 失败（Qwen3 报 matryoshka 400），导致语义搜索只有关键词、没有向量 | **仅 core** | 确保 embedding 配置里 `sendDimensions=false`（与搜索路径一致） |

**推荐：三件套一起升**（你手里的 `tdai-images-20688f9-amd64.tgz` 已包含全部）。

---

## 本次镜像 tag（直接填部署脚本）

```bash
MEMORY_CORE_IMAGE=tdai-local/memory-core:20688f9-amd64
PROXY_IMAGE=tdai-local/memory-proxy:20688f9-amd64
MEMORY_HUB_IMAGE=tdai-local/memory-hub:20688f9-amd64
```

服务器导入：

```bash
gzip -dc tdai-images-20688f9-amd64.tgz | docker load
```

---

## 功能 1：每把 sk-mem 绑定 MaaS API Key

### 以前（官方）

- 所有同事共用一个 `PROXY_UPSTREAM_API_KEY`，或各自客户端透传网关 Key
- Hub 只能管理 `sk-mem`，不能管上游 MaaS Key

### 现在

- Hub → **API Keys** → 每行多一列 **「MaaS API Key」**，可添加/修改/清除
- 同事 Agent 只配：**Proxy 地址 + `sk-mem-xxx`**
- 某把 `sk-mem` 绑了 MaaS Key → 走该 Key 调公司网关；没绑 → **和以前完全一样**（共用 Key 或透传）

### 部署要改的（仅新增，旧配置保留）

| 容器 | 新增环境变量 | 必填？ |
|------|-------------|--------|
| **memory-core** | `TDAI_MAAS_KEY_SECRET` | **是**（`openssl rand -base64 32`） |
| **memory-proxy** | `PROXY_MAAS_KEY_CACHE_TTL_MS=60000` | 否（有默认） |
| **memory-proxy** | `PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS=1500` | 否（有默认） |
| **memory-hub** | `VITE_PROXY_MAAS_KEY_CACHE_TTL_MS=60000` | 否（应与 Proxy TTL 一致） |

### 数据库（Core 的 metadata 库）

**新增 1 张表**（不改动任何旧表）：

- 表名：`meta_user_key_maas_credentials`
- 作用：存每把 `sk-mem` 对应的 **加密后** MaaS Key
- **升级后重启 Core 会自动建表**，一般不用手工跑 SQL
- 可选确认：`deploy/internal-team/init-per-sk-mem-maas.sh`

### 上线后人工一步

在 Hub 网页里给需要的 `sk-mem` 行配置 MaaS API Key（**不写进 env**）。

---

## 功能 2：CodeGraph 内网 HTTP Git

### 以前（官方）

- CodeGraph 只接受 `https://` 公开仓库
- 内网 `http://codelab.xxx/...` 会被拒绝

### 现在

- 用户在 Panel 填：`http://codelab.msxf.test/demo/test.git`
- 服务端用环境变量里的账号 token 临时拉代码，**`.git/config` 里不留 token**

### 部署要改的（Hub 容器）

| 环境变量 | 示例 | 说明 |
|---------|------|------|
| `KNOWLEDGE_ALLOW_HTTP` | `1` | 放行 `http://` |
| `KNOWLEDGE_GIT_TOKEN` | `<PAT>` | Jenkins 等 HTTP Basic 密码 |
| `KNOWLEDGE_GIT_USERNAME` | `jenkins` | 可选，默认 jenkins |
| `KNOWLEDGE_SSRF_CHECK` | `off` | 仓库 host 是内网 IP 时需要 |

**无数据库变更。**

---

## 功能 3：Bug 修复 — 记忆向量写入失败（Qwen3）

### 现象（旧镜像如 20260821-amd64）

- 对话能记进 L0/L1，但 **vec0 向量索引一直为空**
- 搜索只有 FTS 关键词命中，语义相近的问法搜不到
- 日志：`does not support matryoshka representation` HTTP 400

### 原因

- 搜索路径会读 `embedding.sendDimensions=false`
- **写入路径漏传该配置**，默认带了 `dimensions: 4096`，Qwen3 拒绝

### 本包已修复

- 镜像 `20688f9-amd64` 的 **core** 已包含修复
- 请确认 embedding 配置 **`sendDimensions: false`**（Qwen3 / BGE-M3）
- 修复后 **新写入** 的记忆会有向量；**历史已写入但缺向量的记录不会自动补**

详见：`docs/bugs/2026-08-24-l0-l1-embedding-sendDimensions-store-pool.md`

---

## 部署同事 checklist（按顺序打勾）

```
[ ] 1. docker load 导入 tdai-images-20688f9-amd64.tgz
[ ] 2. 三个服务的 image tag 改成 20688f9-amd64（见上文）
[ ] 3. Core 容器注入 TDAI_MAAS_KEY_SECRET（新随机串，≥32 字节）
[ ] 4. （若用 MaaS Key）Proxy/Hub 注入 PROXY_MAAS_KEY_* / VITE_PROXY_MAAS_KEY_*
[ ] 5. （若用 HTTP Git）Hub 注入 KNOWLEDGE_ALLOW_HTTP、KNOWLEDGE_GIT_TOKEN 等
[ ] 6. 确认 embedding.sendDimensions=false（Core 配置，Qwen3 必开）
[ ] 7. 滚动重启：core → proxy → hub
[ ] 8. Hub 网页：API Keys 里给需要的 sk-mem 配 MaaS Key
[ ] 9. （可选）创建 CodeGraph 测 http:// 仓库；对话后检查 vec0 有候选
```

---

## 没变的部分（不用动）

- `PROXY_UPSTREAM_URL` / `PROXY_UPSTREAM_API_KEY` — 未绑 MaaS 的 sk-mem 仍走这些
- `MEMORY_LLM_API_KEY` — Hub 记忆抽取 LLM，与 MaaS Key 无关
- Redis、Panel 端口、Proxy 路由等原有配置

---

## 回滚

换回上一版三件套镜像即可；新表 `meta_user_key_maas_credentials` 可留着，不影响旧版本运行。

---

## 附录：机器可读 env 清单

见同目录 `env.add.yaml`（可用脚本 merge 进自有模板）。

## 附录：相关 Git 提交

| Commit | 内容 |
|--------|------|
| `6987279` | per-sk-mem MaaS API Key 功能 |
| `9054c93` | HTTP Git clone |
| `20688f9` | sendDimensions 写入路径修复 |
| `b2686e5` | 本升级说明与迁移脚本 |
