# 运维手册：重置 IAM SSO 测试数据（给公司机 AI / 实施同学）

目的：某员工邮箱已通过「公司IAM登录」自动建号后，再 SSO **不会出现**「新建账号 / 绑定已有 sk-mem」确认页。要复测多种场景，需按本手册清理状态。

前提（与当前公司部署一致）：

- 一个 Hub，多套 Core+Proxy（每套一个 **instance**）
- Hub 已开 `PANEL_SESSION_STORE=redis`（会话 + IAM identity 在 Redis，前缀 `panel:`）
- Core **网关门禁关闭**；Hub 实例 `api_key` = 该套 Core 的 **admin sk-mem**

---

## 0. Hub 里有没有「表」要清？

| 存储 | 要不要为复测 SSO 确认页去清 | 说明 |
|------|------------------------------|------|
| **Core 用户库**（`meta_users` 等） | **要** | IAM 认人键 `(auth_provider=iam, external_id=邮箱)` 在这里 |
| **Redis `panel:*`** | **要** | Hub Cookie 会话 + IAM identity 绑定（加密 sk-mem） |
| **Hub `hub-data` / Knowledge SQLite** | **一般不要** | 知识库/Wiki 等，与 IAM 用户表无关；清了会丢知识资产 |
| **Proxy Redis `inj:*` 等** | **不要** | Proxy 注入缓存，与 SSO 确认页无关 |
| **本地 `panel-auth-identities.json`** | 仅当 **未**开 Redis session 时才有 | 你们已开 Redis → **忽略本地 identity 文件** |

结论：**复测确认页 = 清「该 instance 的 Core 用户」+ 清 Redis `panel:*`（或至少 identity/session）。不要动 hub-data 知识库卷。**

---

## 1. 执行前收集参数

请先填好（AI 执行前向操作者确认）：

```text
INSTANCE_ID=          # 登录页选的记忆实例 id，如 default / team-a
CORE_URL=             # 该 instance 的 Core，如 http://127.0.0.1:8420 或容器网内 http://memory-core:8420
ADMIN_SK_MEM=         # 该 instance 的 admin sk-mem（.admin-key / metadata-instances.json 的 api_key）
TARGET_EMAIL=         # 规范化后的公司邮箱（小写、去首尾空格），即 external_id
REDIS_PASSWORD=       # 与 .env 中 REDIS_PASSWORD 一致
REDIS_CONTAINER=tdai-redis   # compose 容器名，按实际改
```

可选：已知 `TARGET_USER_ID=usr-xxxx`（不知道则下面用 list/find 查）。

---

## 2. 推荐流程（精确复测「再次出现确认页」）

### 步骤 A — 在 Core 找到并删除该 SSO 用户

```bash
# A1. 按外部身份查找（admin）
curl -sS -X POST "${CORE_URL}/v3/meta/user/find-by-external" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -H "x-tdai-user-key: ${ADMIN_SK_MEM}" \
  -d "{\"external_id\":\"${TARGET_EMAIL}\",\"auth_provider\":\"iam\"}"
```

若 `data` 里有 `user_id`，记为 `TARGET_USER_ID`。若为空，再试不带 `auth_provider`（或 `local`）一次，排除绑在 local 域的老号：

```bash
curl -sS -X POST "${CORE_URL}/v3/meta/user/find-by-external" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -H "x-tdai-user-key: ${ADMIN_SK_MEM}" \
  -d "{\"external_id\":\"${TARGET_EMAIL}\"}"
```

```bash
# A2. 删除用户（会级联相关成员关系等，按 Core 实现；测试号可删）
curl -sS -X POST "${CORE_URL}/v3/meta/user/delete" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -H "x-tdai-user-key: ${ADMIN_SK_MEM}" \
  -d "{\"user_ids\":[\"${TARGET_USER_ID}\"]}"
```

也可用 Hub UI：admin 登录该 instance → 用户管理 → 删除该用户。

**不要只吊销 sk-mem。** 吊销 ≠ 解绑 IAM；Core 里 `(iam, email)` 还在，确认页通常仍不会出现。

### 步骤 B — 清 Redis 里 Hub 会话与 identity

在部署机执行（密码来自 `.env`）：

```bash
# B1. 预览
docker exec -i "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning \
  --scan --pattern 'panel:*'

# B2. 删除全部 Hub panel:*（推荐测试环境；不影响 Proxy 的 inj:*）
docker exec -i "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning \
  --scan --pattern 'panel:*' | \
  while IFS= read -r k; do
    [ -n "$k" ] && docker exec -i "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning DEL "$k"
  done

# B3. 确认清空
docker exec -i "${REDIS_CONTAINER}" redis-cli -a "${REDIS_PASSWORD}" --no-auth-warning \
  --scan --pattern 'panel:*' | wc -l
# 期望输出 0
```

若宿主机已映射 `127.0.0.1:6379`，也可：

```bash
redis-cli -h 127.0.0.1 -a "${REDIS_PASSWORD}" --no-auth-warning --scan --pattern 'panel:*'
```

### 步骤 C — 浏览器

- 无痕窗口，或清掉 Hub 站点 Cookie  
- 打开 Hub → **选同一 INSTANCE_ID** → 公司 IAM 登录  
- 期望：再次出现「自动建号 / 绑定已有 key」确认页  

---

## 3. 各测试场景对照

| 场景 | Core | Redis `panel:*` | 操作要点 |
|------|------|-----------------|----------|
| 再次出确认页 → 自动建号 | 删该邮箱用户 | 清 | 无痕再 SSO |
| 再次出确认页 → 绑老号 | 删该邮箱 SSO 用户；另备一把**本 instance** 已有 sk-mem | 清 | SSO 后选绑定 |
| 第二次 SSO 直接进（回归） | **不要删** | 可不清 | 建号后再点一次 IAM |
| 换 instance 测 | 清的是**另一套 Core** 上的用户 | 可整清 `panel:*`，或只关心新 instance | 登录页换实例 |

---

## 4. 禁止 / 慎用

| 动作 | 原因 |
|------|------|
| `docker volume rm tdai-hub-data` | 清知识库，与 SSO 无关，损失大 |
| 只 `DEL panel:*` 不删 Core 用户 | `find-by-external` 仍命中 → 可能直接登录或兜底新签，**不出确认页** |
| 只吊销最后一把 sk-mem | Core 禁止；且不解绑 IAM |
| 清错 Redis 全库 `FLUSHALL` | 会干掉 Proxy `inj:*` 等，波及面过大；测试机才可考虑 |
| 清错 **别的 instance** 的 Core 用户 | 多套 Core 用户表不相通，认准 `CORE_URL` / `INSTANCE_ID` |

---

## 5. AI 执行检查清单

- [ ] 已确认 `INSTANCE_ID` / `CORE_URL` / `ADMIN_SK_MEM` / `TARGET_EMAIL` / `REDIS_PASSWORD`
- [ ] `find-by-external` 找到 `user_id`（或确认本就无人）
- [ ] `user/delete` 成功（或 Hub UI 已删）
- [ ] Redis `panel:*` 扫描为 0（或已删除目标 key）
- [ ] **未**删除 `hub-data` / 未 `FLUSHALL`
- [ ] 无痕浏览器复测，选对 instance

---

## 6. 一句话给 AI

**开了 Redis 时：删对应 Core 里该邮箱的用户 + 删 Redis 所有 `panel:*`；不要清 Hub 知识库卷。然后无痕选对 instance 再走公司 IAM。**
