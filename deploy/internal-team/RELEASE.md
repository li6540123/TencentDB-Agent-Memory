# internal-team 当前发版说明

与分支 **`feat/per-sk-mem-and-http-git`** 同步。完整清单见：

[`../upgrades/2026-08-24-per-sk-mem-and-http-git/UPGRADE.md`](../upgrades/2026-08-24-per-sk-mem-and-http-git/UPGRADE.md)

## 本包比官方版多 3 件事

| # | 功能 | 涉及容器 |
|---|------|---------|
| 1 | Hub API Keys 每行可绑 **MaaS API Key** | core + proxy + hub |
| 2 | CodeGraph 支持 **http://** 内网 Git | hub |
| 3 | **Bugfix**：L0/L1 向量写入 `sendDimensions`（Qwen3 matryoshka 400） | core |

## 推荐镜像 tag（linux/amd64）

```bash
MEMORY_CORE_IMAGE=tdai-local/memory-core:20688f9-amd64
PROXY_IMAGE=tdai-local/memory-proxy:20688f9-amd64
MEMORY_HUB_IMAGE=tdai-local/memory-hub:20688f9-amd64
```

## 自己部署（本机有源码）

```bash
cd deploy/internal-team
cp .env.example .env          # 填 LLM / Redis / PUBLIC_HOST 等
# 可选：打开 MEMORY_EMBEDDING_*、KNOWLEDGE_*（见 .env.example 注释）

PLATFORM=linux/amd64 TAG=20688f9-amd64 ./build-local.sh   # 或 ./up-local.sh 构建并启动
./up.sh

# 存量 Core DB（可选）
./init-per-sk-mem-maas.sh

# 冒烟
./verify-upgrade.sh
```

## 离线拷到 Linux 服务器

```bash
# 本机
PLATFORM=linux/amd64 TAG=20688f9-amd64 ./export-images.sh
PACK_PLATFORM=linux/amd64 PACK_TAG=20688f9-amd64 ./pack.sh

# 服务器
./load-images.sh dist/tdai-images-20688f9-amd64.tgz
cp .env.company.example .env   # 对照 image-tags.env 改镜像行
./up.sh
```

## 新增 env 速查

| 容器 | 变量 | 用途 |
|------|------|------|
| core | `TDAI_MAAS_KEY_SECRET` | MaaS Key 加密（必填） |
| core | `MEMORY_EMBEDDING_*` | 向量召回；Qwen3 设 `SEND_DIMENSIONS=false` |
| proxy | `PROXY_MAAS_KEY_*` | MaaS resolve 缓存 |
| hub | `KNOWLEDGE_ALLOW_HTTP` 等 | HTTP Git clone |
| hub | `VITE_PROXY_MAAS_KEY_CACHE_TTL_MS` | 与 Proxy TTL 一致 |

DB：Core metadata 新增表 `meta_user_key_maas_credentials`（重启自动建）。
