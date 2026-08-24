# 方案对比：每人一把上游 LLM 网关 Key

> **已取代**：主路径已定为 Hub 按 sk-mem 行绑 MaaS Key，见 `2026-08-24-per-sk-mem-maas-api-key-design.md`。本文仅作历史对比（A vs C）。

- 日期：2026-08-21
- 状态：已废弃（选型结束：采用 Hub 映射，粒度 per-key）
- 共同目标：经 MemoryProxy 访问公司模型网关时，**每人使用自己的网关 API Key**；Proxy 认人仍用 `sk-mem`；公司网关多半只认 `X-Api-Key`（与「sk-mem 占 x-api-key」冲突，需在服务端改写上游鉴权头）

---

## 共同前提

```text
客户端 ── sk-mem ──► Proxy 认人（auth/verify）
                 └──► 上游鉴权用「某人的公司网关 Key」（不能把 sk-mem 当模型 Key）
```

两种方案差别只在：**网关 Key 存在哪、谁维护映射**。

| | 方案 A：Hub 存映射 | 方案 C：客户端自定义 Header |
|--|--|--|
| 映射存在哪 | Core 加密库（用户 ↔ 网关 Key） | 每人电脑上的客户端配置 |
| Hub 是否存 sk-mem↔网关Key | **要** | **不要** |
| Hub 是否仍有 sk-mem 身份 | 要（登录/权限） | 要（同上） |

---

## 方案 A — Hub/Core 按用户绑定上游 Key

### 做法

1. Panel「我的设置」绑定公司网关 Key。  
2. Core 独立表加密落库（AES-GCM，主密钥 `TDAI_UPSTREAM_KEY_SECRET`）。  
3. Proxy 全 handler：`verify` → `user_id` → `resolve` 明文 → 注入上游（Anthropic=`x-api-key`，OpenAI=`Bearer`）。  
4. 未绑定 → 回退全局 `PROXY_UPSTREAM_API_KEY`。  
5. 客户端**只带 sk-mem**，关闭透传。

### 优点

- **与客户端无关**：CC / CodeBuddy / Codex / … 同一套，只要会配 Base URL + sk-mem。  
- Key **集中治理**：轮换、清除、审计、强制加密都在服务端。  
- 本机不落网关 Key，降低误提交 `settings.json` 的风险。  
- 产品形态清晰：身份 Key 与模型 Key 分离。

### 缺点

- 改造面大：Core + Proxy 全路径 + Panel + 自建镜像。  
- 成本约 **8–10 人日**（无存量）。  
- 要运维主密钥；主密钥丢失则已绑定密文无法解密（可回退全局）。  
- 与官方镜像分叉，后续要跟进 cherry-pick。

### 成本粗估

| 模块 | 工作 |
|------|------|
| Core | 表、加密、set/status/resolve |
| Proxy | 公共决议 + 全部模型转发 handler |
| Panel | 绑定 UI |
| 部署 | compose 注入 secret、文档、amd64 包 |

---

## 方案 C — 客户端自定义请求头

### 做法（以 Claude Code 为例）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<host>:8096/claude-code/default",
    "ANTHROPIC_API_KEY": "sk-mem-...",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Upstream-Api-Key: <公司网关Key>"
  }
}
```

- `sk-mem` → `x-api-key` → Proxy 认人。  
- `X-Upstream-Api-Key`（约定名）→ Proxy（或 nginx）改写成上游 `x-api-key`，**不要**把 sk-mem 转给网关。  
- 未带该头 → 回退全局 `PROXY_UPSTREAM_API_KEY`。  
- **Hub 不存** sk-mem↔网关 Key 映射。

> 仅加自定义头、Proxy/nginx 都不改：公司网关仍可能只看到 `X-Api-Key: sk-mem` 而 401。

### 优点

- **Hub/Core 无需映射表、无需用户绑 Key 页、无需落库加密。**  
- 改造小：Proxy 读约定头注入上游，或 nginx 改写；约 **1–3 人日**（或几乎只配 nginx）。  
- 天然每人一把 Key；映射在本机，改 settings 即生效。  
- Claude Code 官方支持 `ANTHROPIC_CUSTOM_HEADERS`（需较新版本）。

### 缺点

- **客户端能力不齐**：CC 有官方自定义头；CodeBuddy / Codex / 其它要各自找 `extra_headers` 等价物，有的没有 → 「凡经 Proxy 调网关都统一」做不到。  
- Key **散落本机**，难统一轮换/审计；易进 git（尤其项目级 settings）。  
- 依赖 CC 版本；同事配置成本高（每人改一份）。  
- 与「双 Header 透传」同类运维问题：文档要写清头名，配错仍 401。

### 成本粗估

| 做法 | 工作 |
|------|------|
| Proxy 约定头 + 全 handler 小改 | 1–3 人日 |
| 仅 nginx 改写 | 几乎不改产品代码 |
| 文档 + 客户端模板 | 0.5 人日 |

---

## 对照表（选型用）

| 维度 | A Hub 映射 | C 客户端自定义头 |
|------|------------|------------------|
| Hub 存 sk-mem↔网关Key | 是（加密） | **否** |
| Panel 绑 Key 页 | 要 | 不要 |
| 改 Core | 要 | 不要 |
| 改 Proxy | 中（全路径） | 小（或 nginx 替代） |
| 人日（无存量） | ~8–10 | ~1–3 |
| 全客户端统一 | **强** | 弱（看客户端） |
| 密钥治理 / 加密 | **强** | 弱 |
| 每人独立额度 | 是 | 是 |
| 未绑定回退全局 Key | 易 | 易 |
| 运维复杂度 | 主密钥 + 自建镜像 | 同事本机配置 |
| 官方镜像可继续用 | 否（要自建） | **可以**（若只用 nginx；改 Proxy 则仍要自建） |

---

## 建议

| 场景 | 更合适 |
|------|--------|
| 只要 Claude Code，尽快打通，接受每人改 `settings.json` | **C** |
| 多种客户端、Key 集中、加密、少让同事碰网关 Key | **A** |
| 临时验证公司网关 | 先 **C + nginx/Proxy 小改**，再视需要升级到 A |

不建议两套同时作为默认：文档和排障会乱。可「生产默认 A，个人调试允许 C」，但 MVP 只选一条主路径。

---

## 决策（请勾选）

- [ ] 采用 **A**（Hub 加密映射；客户端只 sk-mem）  
- [ ] 采用 **C**（客户端自定义头；Hub 不存映射）  
- [ ] 先 C 上线，再规划 A  

选定后按该方案出实施任务清单并改代码/配置。
