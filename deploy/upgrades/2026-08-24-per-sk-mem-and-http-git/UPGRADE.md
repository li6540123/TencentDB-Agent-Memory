# Upgrade: per-sk-mem MaaS API Key + HTTP Git clone

> **Git:** `feat/per-sk-mem-and-http-git` @ `2f96266`（发版时请改为实际 commit）  
> **基线:** 官方 `feat/server_team` / v2.0.1-beta.2 一带  
> **平台:** `linux/amd64`（内网 x86 服务器）

## 变更摘要

| 能力 | 涉及镜像 | 新增 env | DB 变更 |
|------|----------|----------|---------|
| 每把 sk-mem 绑定 MaaS API Key | **core + proxy + hub** | `TDAI_MAAS_KEY_SECRET` 等 | +1 表 SQLite/Mongo |
| 内网 HTTP Git CodeGraph | **hub**（Panel+Knowledge） | `KNOWLEDGE_ALLOW_HTTP` 等 | 无 |

---

## 1. 镜像（部署方替换 tag）

见同目录 `MANIFEST.yaml`。示例（本地构建 tag）：

```text
tdai-local/memory-core:per-sk-mem-and-http-git
tdai-local/memory-proxy:per-sk-mem-and-http-git
tdai-local/memory-hub:per-sk-mem-and-http-git
```

**最小升级路径：**

- 只用 MaaS Key：升 core + proxy + hub  
- 只用 HTTP Git：仅升 hub  
- 两者都要：三件套一起升（推荐）

---

## 2. 环境变量（合并进自有部署脚本）

完整机器可读清单：`env.add.yaml`。

### 2.1 Memory Core（必填 1 项）

| 变量 | 必填 | 说明 |
|------|------|------|
| `TDAI_MAAS_KEY_SECRET` | **是** | ≥32 字节随机串；AES 加密 MaaS Key。**仅 Core 容器** |

生成：`openssl rand -base64 32`

> 未配置：Hub 无法保存 MaaS Key；Proxy resolve 视为未绑定，走原有上游 Key。

### 2.2 Memory Proxy（可选，有默认）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PROXY_MAAS_KEY_CACHE_TTL_MS` | `60000` | resolve 缓存 TTL（毫秒） |
| `PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS` | `1500` | 调 Core resolve 超时 |

还需**已有**变量（非本次新增）：`PROXY_CORE_SERVICE_TOKEN`、Core 地址等。

### 2.3 Memory Hub（MaaS 提示 + HTTP Git）

| 变量 | 默认 | 说明 |
|------|------|------|
| `VITE_PROXY_MAAS_KEY_CACHE_TTL_MS` | `60000` | 前端「保存成功」提示；应与 Proxy TTL **一致** |
| `KNOWLEDGE_ALLOW_HTTP` | 未设=仅 HTTPS | 设为 `1` 允许 `http://` 仓库 |
| `KNOWLEDGE_GIT_TOKEN` | - | 内网 Git PAT（HTTP Basic） |
| `KNOWLEDGE_GIT_USERNAME` | `jenkins` | Basic Auth 用户名 |
| `KNOWLEDGE_SSRF_CHECK` | 默认开启 | 内网 IP 仓库时设 `off` |

---

## 3. 数据库变更

### 3.1 新增表（per-sk-mem）

**表名：** `meta_user_key_maas_credentials`（Mongo 同名 collection）

```sql
-- SQLite；幂等
CREATE TABLE IF NOT EXISTS meta_user_key_maas_credentials (
  key_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  maas_api_key_ciphertext TEXT NOT NULL,
  key_hint TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (key_id) REFERENCES meta_user_keys(key_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES meta_users(user_id) ON DELETE CASCADE
);
```

- **不修改**现有 `meta_users` / `meta_user_keys` 列  
- **升级 Core 并重启后自动建表**（`createSchema()` / Mongo `ensureIndex`）  
- 可选离线确认（幂等）：

```bash
# Docker volume
cd deploy/internal-team && ./init-per-sk-mem-maas.sh

# 单库
SQLITE_DB=/path/to/metadata.db ./init-per-sk-mem-maas.sh

# Mongo
mongosh "$URI" --eval 'const dbName="tdai_metadata_default"' \
  ../../MemoryCore/scripts/db/migrate-per-sk-mem-maas-mongo.js
```

### 3.2 HTTP Git

无 metadata / knowledge DB schema 变更。

---

## 4. 推荐升级步骤（给自有脚本编排）

```text
1. load 新镜像（或 docker pull）
2. 合并 env.add.yaml → 生成/更新 Secret 或 .env
3. 【新装 Core】生成并注入 TDAI_MAAS_KEY_SECRET（勿用示例占位符）
4. （可选）./init-per-sk-mem-maas.sh --verify-only
5. 滚动重启：core → proxy → hub
6. 冒烟（见下）
7. 人工：Hub → API Keys → 每行配置 MaaS API Key
8. 人工（HTTP Git）：Hub 容器注入 KNOWLEDGE_*，Panel 创建 CodeGraph 测 http:// 仓库
```

---

## 5. 冒烟 / 验证

```bash
# MaaS Proxy 链路（需 Hub 已配某行 MaaS Key）
cd deploy/internal-team
./verify-maas-proxy.sh

# HTTP Git：创建 CodeGraph 后进容器检查 token 未落盘
# grep 不应出现 token：
#   cat /data/knowledge/<id>/.git/config | grep url
```

单测（开发机）：

```bash
cd MemoryCore && npm test
cd MemoryProxy && npm test
cd MemoryKnowledge && pnpm test src/source-fetcher/git-fetcher.test.ts
```

---

## 6. 回滚

| 操作 | 影响 |
|------|------|
| 换回上一版镜像 | 功能回退；新表可保留（向前兼容） |
| 去掉 `TDAI_MAAS_KEY_SECRET` | MaaS set 失败；其余不变 |
| 去掉 `KNOWLEDGE_ALLOW_HTTP` | 再次拒绝 `http://` repo_url |

---

## 7. 发版方打包参考

```bash
cd deploy/internal-team
TAG=per-sk-mem-and-http-git ./build-local.sh
PACK_PLATFORM=linux/amd64 PACK_TAG=20250824-2f96266 ./pack.sh
# 交付：dist/tdai-images.tgz + dist/tdai-internal-team.tgz + 本 upgrade 目录
```

**勿将真实 `TDAI_MAAS_KEY_SECRET` / `KNOWLEDGE_GIT_TOKEN` 写入镜像或 MANIFEST。**
