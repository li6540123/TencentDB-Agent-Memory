# 方案：Hub User_Key 列表复制明文

- 日期：2026-09-08
- 状态：设计稿，待确认后写实施计划
- 背景：`meta_user_keys.key_value` 库里是完整 `sk-mem`，但 list/get 只回 `key_prefix`（如 `sk-mem-ab12****`）。用户忘了 key 只能吊销再新建。需要在「User_Key 管理」前缀列加复制图标，把明文写进剪贴板。
- 相关代码：
  - `MemoryPanel/web/src/pages/ApiKeysPage/components/ApiKeyPanel.tsx`（列表；注释写明 list 不含明文）
  - Core `user-key/list` / `user-key/get` → `toPublicUserKey`（只 `key_prefix`）
  - Core `user-key/create` 才带一次 `key_value`

## 1. 目标

1. **Key Prefix 单元格里**，现有 `sk-mem-ab12****` 文案 **正后面** 紧跟一个复制图标（和 key_id 列 `copyable` 一样贴在值后面）。只点这个图标，不点整行。点了把该 key 的 **完整 sk-mem 明文** 写入剪贴板；格子里仍只显示 prefix，不换成全文。
2. **只有当前登录人是这把 key 的主人才能复制。** admin / system_admin 也不能代别人 reveal。
3. list / get 行为不变：响应里继续没有 `key_value`。

## 2. 非目标

- 不在列表里展示或回传全部明文。
- 不改 Proxy / Claude Code。
- 不恢复已吊销 key 的明文。
- 不做「复制 MaaS API Key」（那是另一列、另一套密文）。
- 吊销仍走现有 Core 规则：每人至少一把 active key（`last_key_cannot_revoke`）。Hub 对最后一把禁用吊销并提示。

## 3. 权限（硬约束）

```text
caller.user_id === meta_user_keys.user_id
且 key status = active（未吊销）
```

不满足 → `permission_denied` 或 `user_key_not_found`（与现有 get 越权口径一致，不暴露别人 key 是否存在）。

Hub 这页今天就只 list 自己的 key；后端 reveal **仍必须按 owner 校验**，不能只靠前端。不要复用 `assertUserScope` 的 admin 放行。

## 4. 接口

新 action：`POST /v3/meta/user-key/reveal`

- 入参：`{ key_id }`
- 出参：`{ key_id, key_value }`
- Panel 加入 `META_ACTIONS`，前端 `userKeysApi.reveal(keyId)`
- 日志继续脱敏 `key_value`（现有 `transport-fetch` 已对日志打码，响应给浏览器的明文保留）

点图标才调 reveal，不要把明文塞进 list。

## 5. 前端

同一单元格内联，不要新列、不要点整行：

```text
sk-mem-ab12****  📋
```

对照：key_id 列已经是 `usr-…` 后面跟复制图标（Tea `Text copyable`）。prefix 列做成同样布局，只是复制的内容是 **reveal 回来的明文**，不是屏幕上的 prefix。

- 只点图标 → `reveal(key_id)` → `copyToClipboard`（内网 http 非安全上下文走现有 execCommand 兜底）
- 成功 toast「已复制」；失败 notify 错误
- 剪贴板里是完整 `sk-mem-…`

## 6. 测试

- 主人 reveal → 得到与建号时相同的 `key_value`
- 另一个用户 / 仅 admin 身份 reveal 别人的 key_id → 拒绝
- 已吊销 → 拒绝
- list 响应仍无 `key_value`

## 7. 工作量

约 0.5 人日（Core 一接口 + 面板一列 + 权限单测）。
