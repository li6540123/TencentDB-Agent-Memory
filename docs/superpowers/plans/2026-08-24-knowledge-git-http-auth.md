# Knowledge Git HTTP + Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CodeGraph 的 `GitSourceFetcher` 通过环境变量支持内网 `http://` 仓库，并在 clone/fetch 时临时注入 `jenkins:<PAT>` Basic Auth，操作后立即恢复 origin URL，token 不落盘。

**Architecture:** 在 `MemoryKnowledge/src/source-fetcher/git-fetcher.ts` 增加三个 env 驱动的 module-level helper（与现有 `ssrfCheckEnabledFromEnv()` 风格一致），扩展 `validate()` / `fetch()` / `sync()`；`fetch()` 用带 token 的 URL clone 后立即 `remote set-url` 恢复；`sync()` 在 fetch 前临时改 origin，`try/finally` 保证异常时也恢复。单元测试 mock `simple-git`，不发起真实网络请求。

**Tech Stack:** TypeScript, simple-git, Vitest

## Global Constraints

- 改动范围以 `git-fetcher.ts` + 新建 `git-fetcher.test.ts` 为核心；测试基础设施（`vitest.config.ts`）和部署 env 文档为必要配套，不改动 Panel / API 层。
- `KNOWLEDGE_ALLOW_HTTP=1` → 允许 `http://`（默认仅 `https://`）
- `KNOWLEDGE_GIT_TOKEN=<PAT>` → 将 `jenkins:<token>` 嵌入 URL 做 HTTP Basic 认证
- `KNOWLEDGE_SSRF_CHECK=off` → 关闭内网/环回地址黑名单（已存在）
- 仍拒绝 `ssh://`、`git@`、`file://` 等协议
- token 不得持久化到 `.git/config` 或文件系统
- TDD：先写失败测试，再实现

---

## 需求理解确认

### 用户场景

用户在 Panel 填写：

```
http://codelab.msxf.test/demo/test.git
```

服务端在运行时将其转为（仅内存 + 临时 git remote）：

```
http://jenkins:<KNOWLEDGE_GIT_TOKEN>@codelab.msxf.test/demo/test.git
```

用户无需配置 SSH key；数据库和 `.git/config` 中始终保存**不含 token** 的原始 URL。

### 数据流

```mermaid
sequenceDiagram
  participant Panel
  participant KS as MemoryKnowledge
  participant GF as GitSourceFetcher
  participant Git as simple-git

  Panel->>KS: POST code-graph { repo_url: "http://..." }
  KS->>GF: fetch(repo_url, branch, localPath)
  GF->>GF: validate(repo_url)
  GF->>GF: authUrl = injectAuth(repo_url)
  GF->>Git: clone(authUrl)
  GF->>Git: remote set-url origin repo_url
  GF->>Git: revparse HEAD
  GF-->>KS: { localPath, version }
```

`sync()` 同理，但在已有仓库上先 `set-url` → `fetch` → `reset` → `clean` → `finally set-url`。

---

## 方案评审：你的设计整体正确，需注意以下 6 点

| # | 问题 | 建议 |
|---|------|------|
| 1 | **用户名写死 `jenkins`**，但需求提到「账号和 token 都要放环境变量」 | 增加 `KNOWLEDGE_GIT_USERNAME`（默认 `jenkins`），与 token 对称，避免换账号要改代码 |
| 2 | **内网 HTTP 几乎一定触发 SSRF 黑名单**（若 host 是 `10.x` / `192.168.x` 或解析到私网） | 部署文档明确：内网场景需同时设 `KNOWLEDGE_SSRF_CHECK=off`；`codelab.msxf.test` 这类 DNS 名不在正则黑名单内，通常可过 |
| 3 | **`fetch()` 若 clone 成功但 `set-url` 前进程崩溃**，token 会留在 config | clone 成功后**立即** `set-url`（不等 headCommit）；外层 `try/finally` 双保险 |
| 4 | **URL 已含凭据**（`http://user:pass@host/...`） | `injectAuth()` 检测 `url.username` 非空则跳过注入，避免双重凭据 |
| 5 | **HTTPS 私有仓库** | token 注入逻辑应对 `http://` 和 `https://` 均生效；`KNOWLEDGE_ALLOW_HTTP` 仅控制是否放行 http 协议 |
| 6 | **MemoryKnowledge 无 `vitest.config.ts`** | 需新增（参照 `MemoryCore/vitest.config.ts`），否则 `pnpm test` 找不到 `*.test.ts` |

其余设计（env 驱动、临时改 origin、`.codegraph/` 排除、simple-git 不走 shell）与现有代码一致，**无架构性问题**。

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `MemoryKnowledge/src/source-fetcher/git-fetcher.ts` | 修改 | helper + validate/fetch/sync |
| `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts` | 新建 | 单元测试 |
| `MemoryKnowledge/vitest.config.ts` | 新建 | Vitest 配置（测试基础设施） |
| `MemoryKnowledge/docker/env.example` | 修改 | 文档化新 env 变量 |
| `deploy/panel-knowledge-combined/README.md` 或 `deploy/internal-team/.env.example` | 修改 | 219 部署 env 速查（Task 6） |

`types.ts` 文件头注释可顺带更新一行（「仅 HTTPS」→「HTTPS 默认，HTTP 需 KNOWLEDGE_ALLOW_HTTP」），非必须。

---

### Task 1: 测试基础设施 + Env Helper（TDD）

**Files:**
- Create: `MemoryKnowledge/vitest.config.ts`
- Create: `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts`
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts`（仅新增 helper，暂不改 fetch/sync）

**Interfaces:**
- Produces（module-level，与 `ssrfCheckEnabledFromEnv` 同级）:
  - `allowHttpFromEnv(): boolean` — `KNOWLEDGE_ALLOW_HTTP` 为 `1/true/on/yes` 时 true
  - `gitAuthUsernameFromEnv(): string` — 读 `KNOWLEDGE_GIT_USERNAME`，默认 `"jenkins"`
  - `hasAuthToken(): boolean` — `KNOWLEDGE_GIT_TOKEN` trim 后非空
  - `injectAuth(url: string): string` — 无 token 或 URL 已有 username 时原样返回；否则 `protocol//user:pass@host/path`

- [ ] **Step 1: 新建 vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
  },
});
```

- [ ] **Step 2: 写失败测试 — env 解析**

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";

// 测试 helper 时通过 re-import 或导出测试专用入口；
// 推荐：将 helper 作为 named export（与 ssrfCheckEnabledFromEnv 一样仅用于模块内，
// 但 vitest 可通过 vi.importActual 或单独 export { allowHttpFromEnv, ... } for testing）

describe("env helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allowHttpFromEnv: default false", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", undefined);
    expect(allowHttpFromEnv()).toBe(false);
  });

  it("allowHttpFromEnv: 1 / true / on", () => {
    for (const v of ["1", "true", "on", "yes"]) {
      vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", v);
      expect(allowHttpFromEnv()).toBe(true);
    }
  });

  it("hasAuthToken: empty vs set", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "");
    expect(hasAuthToken()).toBe(false);
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "abc");
    expect(hasAuthToken()).toBe(true);
  });
});
```

- [ ] **Step 3: 写失败测试 — injectAuth**

```typescript
describe("injectAuth", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no token → unchanged", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "");
    const url = "http://codelab.msxf.test/demo/test.git";
    expect(injectAuth(url)).toBe(url);
  });

  it("injects jenkins:token@host", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "nJxBt66_secret");
    expect(injectAuth("http://codelab.msxf.test/demo/test.git"))
      .toBe("http://jenkins:nJxBt66_secret@codelab.msxf.test/demo/test.git");
  });

  it("percent-encodes special chars in token", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "a@b:c/d");
    expect(injectAuth("http://host/r.git"))
      .toBe("http://jenkins:a%40b%3Ac%2Fd@host/r.git");
  });

  it("skips when URL already has credentials", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "tok");
    const url = "http://existing:pass@host/r.git";
    expect(injectAuth(url)).toBe(url);
  });

  it("custom username from KNOWLEDGE_GIT_USERNAME", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "tok");
    vi.stubEnv("KNOWLEDGE_GIT_USERNAME", "ci-bot");
    expect(injectAuth("http://host/r.git"))
      .toBe("http://ci-bot:tok@host/r.git");
  });
});
```

- [ ] **Step 4: 运行测试确认 FAIL**

Run: `cd MemoryKnowledge && pnpm test src/source-fetcher/git-fetcher.test.ts`
Expected: FAIL — helper not defined

- [ ] **Step 5: 实现 helper**

```typescript
function truthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function allowHttpFromEnv(): boolean {
  return truthyEnv("KNOWLEDGE_ALLOW_HTTP");
}

function gitAuthUsernameFromEnv(): string {
  const raw = process.env.KNOWLEDGE_GIT_USERNAME;
  return raw?.trim() || "jenkins";
}

function hasAuthToken(): boolean {
  const raw = process.env.KNOWLEDGE_GIT_TOKEN;
  return raw != null && raw.trim() !== "";
}

function injectAuth(sourceUrl: string): string {
  if (!hasAuthToken()) return sourceUrl;
  const parsed = new URL(sourceUrl);
  if (parsed.username) return sourceUrl;
  parsed.username = gitAuthUsernameFromEnv();
  parsed.password = process.env.KNOWLEDGE_GIT_TOKEN!.trim();
  return parsed.toString();
}
```

- [ ] **Step 6: 运行测试确认 PASS**

Run: `cd MemoryKnowledge && pnpm test src/source-fetcher/git-fetcher.test.ts`
Expected: PASS

---

### Task 2: 扩展 validate() 支持 HTTP

**Files:**
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts:57-72`
- Test: `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts`

**Interfaces:**
- Consumes: `allowHttpFromEnv()`

- [ ] **Step 1: 写失败测试 — 协议校验**

```typescript
describe("GitSourceFetcher.validate", () => {
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });

  it("allows https by default", () => {
    expect(() => fetcher.validate("https://github.com/org/repo.git")).not.toThrow();
  });

  it("rejects http unless KNOWLEDGE_ALLOW_HTTP", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", undefined);
    expect(() => fetcher.validate("http://codelab.msxf.test/r.git")).toThrow(/http/i);
  });

  it("allows http when KNOWLEDGE_ALLOW_HTTP=1", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    expect(() => fetcher.validate("http://codelab.msxf.test/r.git")).not.toThrow();
  });

  it("rejects ssh and git@ and file", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    for (const url of [
      "ssh://git@host/r.git",
      "git@host:org/r.git",
      "file:///tmp/r.git",
    ]) {
      expect(() => fetcher.validate(url)).toThrow();
    }
  });

  it("SSRF blocks private host when enabled", () => {
    const strict = new GitSourceFetcher({ ssrfCheck: true });
    expect(() => strict.validate("https://127.0.0.1/r.git")).toThrow(/private/i);
  });
});
```

- [ ] **Step 2: 运行确认 FAIL**

- [ ] **Step 3: 实现 validate()**

```typescript
private isAllowedProtocol(sourceUrl: string): boolean {
  if (sourceUrl.startsWith("https://")) return true;
  if (sourceUrl.startsWith("http://") && allowHttpFromEnv()) return true;
  return false;
}

validate(sourceUrl: string): void {
  const lower = sourceUrl.toLowerCase();
  if (
    lower.startsWith("ssh://") ||
    lower.startsWith("git@") ||
    lower.startsWith("file://")
  ) {
    throw new Error("unsupported git protocol; use https:// or http:// (with KNOWLEDGE_ALLOW_HTTP=1)");
  }
  if (!this.isAllowedProtocol(sourceUrl)) {
    throw new Error(
      allowHttpFromEnv()
        ? "repo_url must use https:// or http://"
        : "repo_url must use https:// (set KNOWLEDGE_ALLOW_HTTP=1 for http://)",
    );
  }
  // ... existing host + SSRF checks unchanged
}
```

- [ ] **Step 4: 运行测试 PASS**

---

### Task 3: fetch() 注入鉴权并清理

**Files:**
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts:74-85`
- Test: `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts`

**Interfaces:**
- Consumes: `injectAuth()`, `hasAuthToken()`

- [ ] **Step 1: mock simple-git**

```typescript
const cloneMock = vi.fn().mockResolvedValue(undefined);
const setUrlMock = vi.fn().mockResolvedValue(undefined);
const revparseMock = vi.fn().mockResolvedValue("abc123def456\n");

vi.mock("simple-git", () => ({
  default: vi.fn((path?: string) => {
    if (path) {
      return { revparse: revparseMock, remote: setUrlMock };
    }
    return { clone: cloneMock };
  }),
  CleanOptions: { FORCE: 2, RECURSIVE: 4 },
  ResetMode: { HARD: "hard" },
}));
```

- [ ] **Step 2: 写失败测试**

```typescript
it("fetch clones with auth URL then restores origin", async () => {
  vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
  vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const url = "http://codelab.msxf.test/demo/test.git";

  await fetcher.fetch(url, "main", "/tmp/repo");

  expect(cloneMock).toHaveBeenCalledWith(
    "http://jenkins:secret@codelab.msxf.test/demo/test.git",
    "/tmp/repo",
    { "--depth": 1, "--branch": "main" },
  );
  expect(setUrlMock).toHaveBeenCalledWith(
    ["set-url", "origin", url],
  );
});

it("fetch without token clones clean URL", async () => {
  vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "");
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const url = "https://github.com/org/repo.git";
  await fetcher.fetch(url, "main", "/tmp/repo");
  expect(cloneMock).toHaveBeenCalledWith(url, "/tmp/repo", expect.any(Object));
  expect(setUrlMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 实现 fetch()**

```typescript
async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
  this.validate(sourceUrl);
  const authUrl = injectAuth(sourceUrl);
  const cloneOpts = { "--depth": 1, "--branch": branch };

  await simpleGit().clone(authUrl, localPath, cloneOpts);

  if (hasAuthToken()) {
    try {
      await simpleGit(localPath).remote(["set-url", "origin", sourceUrl]);
    } catch (err) {
      // clone 已成功但恢复失败 — token 可能残留，抛明确错误
      throw new Error(`failed to restore origin URL after clone: ${err}`);
    }
  }

  const version = await this.headCommit(localPath);
  return { localPath, version, sourceType: "git" };
}
```

- [ ] **Step 4: 运行测试 PASS**

---

### Task 4: sync() try/finally 安全恢复 URL

**Files:**
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts:87-97`
- Test: `MemoryKnowledge/src/source-fetcher/git-fetcher.test.ts`

- [ ] **Step 1: 扩展 mock**

```typescript
const fetchMock = vi.fn().mockResolvedValue(undefined);
const resetMock = vi.fn().mockResolvedValue(undefined);
const cleanMock = vi.fn().mockResolvedValue(undefined);

// simpleGit(localPath) 返回 { fetch, reset, clean, remote, revparse }
```

- [ ] **Step 2: 写失败测试 — 正常路径**

```typescript
it("sync sets auth URL, fetches, resets, cleans, restores", async () => {
  vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
  vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const url = "http://codelab.msxf.test/demo/test.git";

  await fetcher.sync(url, "main", "/tmp/repo");

  expect(setUrlMock).toHaveBeenCalledWith(
    ["set-url", "origin", "http://jenkins:secret@codelab.msxf.test/demo/test.git"],
  );
  expect(fetchMock).toHaveBeenCalled();
  expect(cleanMock).toHaveBeenCalledWith(
    expect.any(Number),
    ["-e", ".codegraph"],
  );
  expect(setUrlMock).toHaveBeenCalledWith(["set-url", "origin", url]);
});
```

- [ ] **Step 3: 写失败测试 — fetch 抛错仍恢复**

```typescript
it("sync restores origin even when fetch throws", async () => {
  vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
  vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
  fetchMock.mockRejectedValueOnce(new Error("auth failed"));
  const fetcher = new GitSourceFetcher({ ssrfCheck: false });
  const url = "http://codelab.msxf.test/r.git";

  await expect(fetcher.sync(url, "main", "/tmp/repo")).rejects.toThrow("auth failed");

  // 最后一次 set-url 必须是干净 URL
  const calls = setUrlMock.mock.calls.filter((c) => c[0][0] === "set-url");
  expect(calls.at(-1)).toEqual([["set-url", "origin", url]]);
});
```

- [ ] **Step 4: 实现 sync()**

```typescript
async sync(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
  this.validate(sourceUrl);
  const git = simpleGit(localPath);
  const needsAuth = hasAuthToken();

  if (needsAuth) {
    await git.remote(["set-url", "origin", injectAuth(sourceUrl)]);
  }

  try {
    await git.fetch("origin", branch, { "--depth": 1 });
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
  } finally {
    if (needsAuth) {
      await git.remote(["set-url", "origin", sourceUrl]);
    }
  }

  const version = await this.headCommit(localPath);
  return { localPath, version, sourceType: "git" };
}
```

- [ ] **Step 5: 运行全部测试 PASS**

Run: `cd MemoryKnowledge && pnpm test`

---

### Task 5: 更新文件头注释 + env 文档

**Files:**
- Modify: `MemoryKnowledge/src/source-fetcher/git-fetcher.ts`（文件头）
- Modify: `MemoryKnowledge/docker/env.example`

- [ ] **Step 1: 更新 git-fetcher.ts 顶部注释**

补充：
- R2 协议：默认 HTTPS；`KNOWLEDGE_ALLOW_HTTP=1` 放行 HTTP
- R3 凭据：`KNOWLEDGE_GIT_TOKEN` + `KNOWLEDGE_GIT_USERNAME`（默认 jenkins）临时注入，操作后恢复 origin
- 安全注意：日志/进程列表可能短暂暴露 token

- [ ] **Step 2: docker/env.example 追加**

```bash
# 内网 HTTP Git（CodeGraph clone/sync）
# KNOWLEDGE_ALLOW_HTTP=1
# KNOWLEDGE_GIT_TOKEN=<jenkins-pat>
# KNOWLEDGE_GIT_USERNAME=jenkins
# KNOWLEDGE_SSRF_CHECK=off          # 内网 IP 仓库时需要
```

- [ ] **Step 3: 全量测试 + typecheck**

Run:
```bash
cd MemoryKnowledge && pnpm test && pnpm typecheck
```

---

### Task 6: Docker 构建部署到 219 + E2E 验证

**Files:**
- Modify: 目标部署目录的 `.env` / `docker-compose.yml`（按 219 实际部署方式）

**部署 env 清单（219 实例）:**

```bash
KNOWLEDGE_ALLOW_HTTP=1
KNOWLEDGE_GIT_TOKEN=<公司 Jenkins PAT>
KNOWLEDGE_GIT_USERNAME=jenkins          # 可选，默认 jenkins
KNOWLEDGE_SSRF_CHECK=off                # 若 repo host 为内网 IP
```

- [ ] **Step 1: 构建镜像**

```bash
cd deploy/panel-knowledge-combined && ./build.sh
```

- [ ] **Step 2: 部署到 219，注入上述 env**

- [ ] **Step 3: Panel E2E 手动验证**

1. 创建 CodeGraph，`repo_url` = `http://codelab.msxf.test/demo/test.git`
2. 确认 clone 成功、build 完成
3. 触发 sync，确认增量更新成功
4. SSH 进容器检查 `.git/config` 中 `origin` URL **不含 token**

```bash
grep -R "KNOWLEDGE_GIT_TOKEN" /data/knowledge/**/.git/config  # 应无匹配
cat /data/knowledge/<code-graph-id>/.git/config | grep url    # 应为干净 http:// URL
```

- [ ] **Step 4: 负向测试**

- 不设 `KNOWLEDGE_ALLOW_HTTP` → `http://` 应被 validate 拒绝
- 设 token 但 URL 错误 → clone 失败，config 中无 token 残留

---

## 环境变量速查

| 变量 | 示例 | 作用 |
|------|------|------|
| `KNOWLEDGE_ALLOW_HTTP` | `1` | 启用 `http://` 协议 |
| `KNOWLEDGE_GIT_TOKEN` | `nJxBt66_...` | Jenkins PAT，HTTP Basic 密码 |
| `KNOWLEDGE_GIT_USERNAME` | `jenkins` | Basic Auth 用户名（**建议新增**，默认 `jenkins`） |
| `KNOWLEDGE_SSRF_CHECK` | `off` | 关闭内网地址黑名单（内网 IP 仓库时需要） |

---

## Self-Review（Spec Coverage）

| 需求 | 对应 Task |
|------|-----------|
| KNOWLEDGE_ALLOW_HTTP | Task 1 helper + Task 2 validate |
| KNOWLEDGE_GIT_TOKEN 注入 | Task 1 injectAuth + Task 3/4 |
| 临时改 origin、不落盘 | Task 3 fetch + Task 4 sync finally |
| validate 拒绝 ssh/git@/file | Task 2 |
| SSRF 黑名单保留 | Task 2（已有逻辑不动） |
| git clean 排除 .codegraph | Task 4（保留现有 `-e .codegraph`） |
| Vitest 全套单测 | Task 1–4 |
| Docker 219 部署 | Task 6 |

**Gap 已处理:** `KNOWLEDGE_GIT_USERNAME` 作为建议补充写入 Task 1/5/6。

---

## 执行选项

Plan 已保存至 `docs/superpowers/plans/2026-08-24-knowledge-git-http-auth.md`。

**1. Subagent-Driven（推荐）** — 每个 Task 派生子 agent，逐 task 审查  
**2. Inline Execution** — 当前会话按 Task 1→6 连续实现

选定方式后即可开始编码。
