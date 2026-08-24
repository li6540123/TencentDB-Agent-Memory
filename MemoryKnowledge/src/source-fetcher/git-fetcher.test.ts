import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloneMock = vi.fn().mockResolvedValue(undefined);
const remoteMock = vi.fn().mockResolvedValue(undefined);
const revparseMock = vi.fn().mockResolvedValue("abc123def456\n");
const fetchMock = vi.fn().mockResolvedValue(undefined);
const resetMock = vi.fn().mockResolvedValue(undefined);
const cleanMock = vi.fn().mockResolvedValue(undefined);

vi.mock("simple-git", () => ({
  default: vi.fn((path?: string) => {
    if (path === undefined) {
      return { clone: cloneMock };
    }
    return {
      clone: cloneMock,
      remote: remoteMock,
      revparse: revparseMock,
      fetch: fetchMock,
      reset: resetMock,
      clean: cleanMock,
    };
  }),
  CleanOptions: { FORCE: 2, RECURSIVE: 4 },
  ResetMode: { HARD: "hard" },
}));

import {
  allowHttpFromEnv,
  GitSourceFetcher,
  gitAuthUsernameFromEnv,
  hasAuthToken,
  injectAuth,
} from "./git-fetcher.js";

describe("env helpers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allowHttpFromEnv: default false", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", undefined);
    expect(allowHttpFromEnv()).toBe(false);
  });

  it("allowHttpFromEnv: 1 / true / on / yes", () => {
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

  it("gitAuthUsernameFromEnv: default jenkins", () => {
    vi.stubEnv("KNOWLEDGE_GIT_USERNAME", undefined);
    expect(gitAuthUsernameFromEnv()).toBe("jenkins");
  });

  it("gitAuthUsernameFromEnv: custom value", () => {
    vi.stubEnv("KNOWLEDGE_GIT_USERNAME", "ci-bot");
    expect(gitAuthUsernameFromEnv()).toBe("ci-bot");
  });
});

describe("injectAuth", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("no token → unchanged", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "");
    const url = "http://codelab.msxf.test/demo/test.git";
    expect(injectAuth(url)).toBe(url);
  });

  it("injects jenkins:token@host", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "nJxBt66_secret");
    expect(injectAuth("http://codelab.msxf.test/demo/test.git")).toBe(
      "http://jenkins:nJxBt66_secret@codelab.msxf.test/demo/test.git",
    );
  });

  it("percent-encodes special chars in token", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "a@b:c/d");
    expect(injectAuth("http://host/r.git")).toBe("http://jenkins:a%40b%3Ac%2Fd@host/r.git");
  });

  it("skips when URL already has credentials", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "tok");
    const url = "http://existing:pass@host/r.git";
    expect(injectAuth(url)).toBe(url);
  });

  it("custom username from KNOWLEDGE_GIT_USERNAME", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "tok");
    vi.stubEnv("KNOWLEDGE_GIT_USERNAME", "ci-bot");
    expect(injectAuth("http://host/r.git")).toBe("http://ci-bot:tok@host/r.git");
  });

  it("injects into https URLs when token is set", () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
    expect(injectAuth("https://gitlab.example.com/org/repo.git")).toBe(
      "https://jenkins:secret@gitlab.example.com/org/repo.git",
    );
  });
});

describe("GitSourceFetcher.validate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows https by default", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => fetcher.validate("https://github.com/org/repo.git")).not.toThrow();
  });

  it("rejects http unless KNOWLEDGE_ALLOW_HTTP", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", undefined);
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => fetcher.validate("http://codelab.msxf.test/r.git")).toThrow(/http/i);
  });

  it("allows http when KNOWLEDGE_ALLOW_HTTP=1", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    expect(() => fetcher.validate("http://codelab.msxf.test/r.git")).not.toThrow();
  });

  it("rejects ssh, git@, and file protocols", () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    for (const url of ["ssh://git@host/r.git", "git@host:org/r.git", "file:///tmp/r.git"]) {
      expect(() => fetcher.validate(url)).toThrow(/unsupported git protocol/i);
    }
  });

  it("SSRF blocks private host when enabled", () => {
    const fetcher = new GitSourceFetcher({ ssrfCheck: true });
    expect(() => fetcher.validate("https://127.0.0.1/r.git")).toThrow(/private/i);
  });
});

describe("GitSourceFetcher.fetch", () => {
  beforeEach(() => {
    cloneMock.mockClear();
    remoteMock.mockClear();
    revparseMock.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("clones with auth URL then restores origin", async () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const url = "http://codelab.msxf.test/demo/test.git";

    const result = await fetcher.fetch(url, "main", "/tmp/repo");

    expect(cloneMock).toHaveBeenCalledWith(
      "http://jenkins:secret@codelab.msxf.test/demo/test.git",
      "/tmp/repo",
      { "--depth": 1, "--branch": "main" },
    );
    expect(remoteMock).toHaveBeenCalledWith(["set-url", "origin", url]);
    expect(result).toEqual({
      localPath: "/tmp/repo",
      version: "abc123def456",
      sourceType: "git",
    });
  });

  it("without token clones clean URL and skips set-url", async () => {
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const url = "https://github.com/org/repo.git";

    await fetcher.fetch(url, "main", "/tmp/repo");

    expect(cloneMock).toHaveBeenCalledWith(url, "/tmp/repo", {
      "--depth": 1,
      "--branch": "main",
    });
    expect(remoteMock).not.toHaveBeenCalled();
  });
});

describe("GitSourceFetcher.sync", () => {
  beforeEach(() => {
    remoteMock.mockClear();
    fetchMock.mockClear();
    resetMock.mockClear();
    cleanMock.mockClear();
    revparseMock.mockClear();
    fetchMock.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("sets auth URL, fetches, resets, cleans, restores", async () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const url = "http://codelab.msxf.test/demo/test.git";

    const result = await fetcher.sync(url, "main", "/tmp/repo");

    expect(remoteMock).toHaveBeenCalledWith([
      "set-url",
      "origin",
      "http://jenkins:secret@codelab.msxf.test/demo/test.git",
    ]);
    expect(fetchMock).toHaveBeenCalledWith("origin", "main", { "--depth": 1 });
    expect(resetMock).toHaveBeenCalledWith("hard", ["origin/main"]);
    expect(cleanMock).toHaveBeenCalledWith(6, ["-e", ".codegraph"]);
    expect(remoteMock).toHaveBeenCalledWith(["set-url", "origin", url]);
    expect(result.version).toBe("abc123def456");
  });

  it("restores origin even when fetch throws", async () => {
    vi.stubEnv("KNOWLEDGE_ALLOW_HTTP", "1");
    vi.stubEnv("KNOWLEDGE_GIT_TOKEN", "secret");
    fetchMock.mockRejectedValueOnce(new Error("auth failed"));
    const fetcher = new GitSourceFetcher({ ssrfCheck: false });
    const url = "http://codelab.msxf.test/r.git";

    await expect(fetcher.sync(url, "main", "/tmp/repo")).rejects.toThrow("auth failed");

    const setUrlCalls = remoteMock.mock.calls.filter((c) => c[0][0] === "set-url");
    expect(setUrlCalls.at(-1)).toEqual([["set-url", "origin", url]]);
  });
});
