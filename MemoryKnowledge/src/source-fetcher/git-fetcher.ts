/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：默认仅 HTTPS；KNOWLEDGE_ALLOW_HTTP=1 时放行 HTTP；内网/环回地址黑名单
 *     （对齐项目 security_rules，可由 KNOWLEDGE_SSRF_CHECK=off 关闭）。
 *   - R3 凭据：KNOWLEDGE_GIT_TOKEN + KNOWLEDGE_GIT_USERNAME（默认 jenkins）仅在 clone/fetch
 *     期间临时嵌入 URL，操作后立即 remote set-url 恢复原始地址，token 不落盘。
 *     注意：错误日志或 ps 列表可能短暂暴露带 token 的 URL（后续可加脱敏）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

function truthyEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

/** KNOWLEDGE_ALLOW_HTTP=1/true/on/yes 时允许 http:// 协议。 */
export function allowHttpFromEnv(): boolean {
  return truthyEnv("KNOWLEDGE_ALLOW_HTTP");
}

/** KNOWLEDGE_GIT_USERNAME，默认 jenkins。 */
export function gitAuthUsernameFromEnv(): string {
  const raw = process.env.KNOWLEDGE_GIT_USERNAME;
  return raw?.trim() || "jenkins";
}

/** KNOWLEDGE_GIT_TOKEN 非空时返回 true。 */
export function hasAuthToken(): boolean {
  const raw = process.env.KNOWLEDGE_GIT_TOKEN;
  return raw != null && raw.trim() !== "";
}

/** 将 jenkins:<token>@ 嵌入 URL；无 token 或 URL 已有凭据时原样返回。 */
export function injectAuth(sourceUrl: string): string {
  if (!hasAuthToken()) return sourceUrl;
  const parsed = new URL(sourceUrl);
  if (parsed.username) return sourceUrl;
  parsed.username = gitAuthUsernameFromEnv();
  parsed.password = process.env.KNOWLEDGE_GIT_TOKEN!.trim();
  return parsed.toString();
}

export interface GitSourceFetcherOptions {
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关（协议白名单始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;

  constructor(opts?: GitSourceFetcherOptions) {
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    const lower = sourceUrl.toLowerCase();
    if (
      lower.startsWith("ssh://") ||
      lower.startsWith("git@") ||
      lower.startsWith("file://")
    ) {
      throw new Error(
        "unsupported git protocol; use https:// or http:// (with KNOWLEDGE_ALLOW_HTTP=1)",
      );
    }
    if (!this.isAllowedProtocol(sourceUrl)) {
      throw new Error(
        allowHttpFromEnv()
          ? "repo_url must use https:// or http://"
          : "repo_url must use https:// (set KNOWLEDGE_ALLOW_HTTP=1 for http://)",
      );
    }
    const host = this.extractHost(sourceUrl);
    if (!host) {
      throw new Error(`invalid repo_url: cannot parse host from ${sourceUrl}`);
    }
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string): Promise<FetchResult> {
    this.validate(sourceUrl);
    const authUrl = injectAuth(sourceUrl);
    const cloneOpts = { "--depth": 1, "--branch": branch };

    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    await simpleGit().clone(authUrl, localPath, cloneOpts);

    if (hasAuthToken()) {
      try {
        await simpleGit(localPath).remote(["set-url", "origin", sourceUrl]);
      } catch (err) {
        throw new Error(`failed to restore origin URL after clone: ${err}`);
      }
    }

    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

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
      // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
      // 导致增量 sync 永远失败、每次回退到全量 clone。
      await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    } finally {
      if (needsAuth) {
        await git.remote(["set-url", "origin", sourceUrl]);
      }
    }

    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  private isAllowedProtocol(sourceUrl: string): boolean {
    if (sourceUrl.startsWith("https://")) return true;
    if (sourceUrl.startsWith("http://") && allowHttpFromEnv()) return true;
    return false;
  }

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private extractHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}
