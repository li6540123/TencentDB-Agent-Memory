# Bug: L0/L1 写入路径向量 embedding 全部失败（sendDimensions）

- **日期:** 2026-08-24
- **发现版本:** `memory-core` 镜像 `20260821-amd64`（及此前 gateway `StorePool` 路径）
- **修复:** `MemoryCore/src/core/store/store-pool.ts` — `createSqliteStore()` 传递 `sendDimensions`
- **状态:** 已修复（待新镜像）

## 现象

- L0 写入成功（`l0_recorded`），L1 提取成功（`L1 complete: stored=1`）
- **向量索引始终为空**：hybrid 搜索时 `vec0 returned 0 candidates`，仅 FTS 关键词命中
- 日志反复出现：

```text
Model '/models/Qwen3-Embedding' does not support matryoshka representation... HTTP 400
```

- 用户在 `.env` / gateway 配置中设置 `embedding.sendDimensions=false`（或 `sendDimensions=0`）后，**搜索/recall 路径正常**（`embedding OK dims=4096`），但 **L0/L1 写入仍失败**

## Root cause

Core 有两条创建 `EmbeddingService` 的路径：

| 路径 | 文件 | `sendDimensions` |
|------|------|------------------|
| 搜索 / recall（`createStoreBundle`） | `factory.ts` | ✅ 传入 `config.embedding.sendDimensions` |
| L0/L1 写入（`StorePool.createSqliteStore`） | `store-pool.ts` | ❌ **未传** |

`embedding.ts` 中默认：

```typescript
this.sendDimensions = config.sendDimensions ?? true;
```

未传时默认为 `true`，请求体会带上 `dimensions: 4096`。Qwen3-Embedding、BGE-M3 等**不支持 Matryoshka 截断**的模型会返回 HTTP 400，导致：

- capture / L1 worker 调用 `embedding.embed()` 失败
- `vec0` 表无向量写入
- 语义检索失效，退化为纯 FTS

这不是部署配置错误：写入路径**不读取**用户配置的 `sendDimensions`，仅搜索路径读取。

## 影响

- **语义向量检索**（hybrid 中的向量部分）不起作用
- **FTS 关键词检索**仍可用
- 示例：「小明喜欢跑步」能命中；「小明做什么锻炼」等语义相近 query 容易漏召

## 修复

`store-pool.ts` `createSqliteStore()` 与 `factory.ts` 对齐，增加：

```typescript
sendDimensions: embCfg.sendDimensions,
```

## 验证

1. 配置 `embedding.sendDimensions: false`（或环境变量等价项）
2. 触发一次对话 capture → 检查日志无 matryoshka 400
3. recall / search：`vec0 returned N candidates` 且 N > 0（有数据时）
4. 单测：`MemoryCore/src/core/store/embedding-send-dimensions.test.ts`

```bash
cd MemoryCore && npm test src/core/store/embedding-send-dimensions.test.ts
```

## 升级说明

- 需更换 **memory-core** 镜像（仅 Core，Hub/Proxy 无关）
- **无需** DB 迁移；修复后新写入的记忆会正常建向量，**历史已写入但缺向量的记录**需视业务决定是否重放 capture / 重建索引

## 相关配置

| 配置项 | 推荐（Qwen3 / BGE-M3） | 说明 |
|--------|------------------------|------|
| `embedding.sendDimensions` | `false` | 不在请求体中带 `dimensions` |
| `embedding.dimensions` | `4096`（或模型固定维度） | 仍用于本地 vec0 列宽 |

OpenAI `text-embedding-3-*` 等支持 Matryoshka 的模型可保持 `sendDimensions: true`（默认）。
