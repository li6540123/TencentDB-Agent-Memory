# 已知问题与修复记录

本目录记录已在代码中修复、或需通过升级镜像规避的缺陷，便于发版与内网部署对照。

| 日期 | 文档 | 组件 | 摘要 |
|------|------|------|------|
| 2026-08-24 | [l0-l1-embedding-sendDimensions-store-pool](./2026-08-24-l0-l1-embedding-sendDimensions-store-pool.md) | memory-core | L0/L1 写入未传 `sendDimensions`，Qwen3 等模型向量全失败 |
