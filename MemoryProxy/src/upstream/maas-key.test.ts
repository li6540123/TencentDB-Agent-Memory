import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMaasKeyCacheForTests,
  resolveEffectiveUpstreamApiKey,
  resolveMaasApiKey,
} from "./maas-key.js";

const baseOpts = {
  coreBaseUrl: "http://core.test",
  serviceToken: "svc-token",
  serviceId: "default",
  cacheTtlMs: 60_000,
  timeoutMs: 1_500,
};

function mockResolveResponse(data: { configured?: boolean; maas_api_key?: string }, code = 0) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ code, data }),
  });
}

describe("resolveEffectiveUpstreamApiKey", () => {
  it("prefers per-user maas key over agent and global", () => {
    expect(
      resolveEffectiveUpstreamApiKey({
        perUserMaasKey: "maas-user",
        agentUpstreamEntry: { apiKey: "agent-key" },
        globalApiKey: "global-key",
      }),
    ).toBe("maas-user");
  });

  it("falls back to agent empty string passthrough when no maas", () => {
    expect(
      resolveEffectiveUpstreamApiKey({
        perUserMaasKey: null,
        agentUpstreamEntry: { apiKey: "" },
        globalApiKey: "global-key",
      }),
    ).toBe("");
  });

  it("falls back to global when agent missing", () => {
    expect(
      resolveEffectiveUpstreamApiKey({
        perUserMaasKey: null,
        agentUpstreamEntry: undefined,
        globalApiKey: "global-key",
      }),
    ).toBe("global-key");
  });
});

describe("resolveMaasApiKey cache", () => {
  beforeEach(() => {
    clearMaasKeyCacheForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearMaasKeyCacheForTests();
    vi.unstubAllGlobals();
  });

  it("returns cached value on second call (cache hit)", async () => {
    const fetchMock = mockResolveResponse({ configured: true, maas_api_key: "maas-bound" });
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveMaasApiKey("sk-mem-hit", baseOpts);
    const second = await resolveMaasApiKey("sk-mem-hit", baseOpts);

    expect(first).toBe("maas-bound");
    expect(second).toBe("maas-bound");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("negative cache for configured:false", async () => {
    const fetchMock = mockResolveResponse({ configured: false });
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveMaasApiKey("sk-mem-none", baseOpts)).toBeNull();
    expect(await resolveMaasApiKey("sk-mem-none", baseOpts)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache HTTP errors (degrade, retry next time)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { configured: true, maas_api_key: "recovered" } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveMaasApiKey("sk-mem-retry", baseOpts)).toBeNull();
    expect(await resolveMaasApiKey("sk-mem-retry", baseOpts)).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("singleflight coalesces concurrent resolves", async () => {
    let resolveJson!: () => void;
    const jsonPromise = new Promise<{ configured: boolean; maas_api_key: string }>((resolve) => {
      resolveJson = () => resolve({ configured: true, maas_api_key: "coalesced" });
    });
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: await jsonPromise }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const p1 = resolveMaasApiKey("sk-mem-flight", baseOpts);
    const p2 = resolveMaasApiKey("sk-mem-flight", baseOpts);
    resolveJson!();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("coalesced");
    expect(r2).toBe("coalesced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects cache TTL expiry", async () => {
    vi.useFakeTimers();
    const fetchMock = mockResolveResponse({ configured: true, maas_api_key: "ttl-key" });
    vi.stubGlobal("fetch", fetchMock);

    await resolveMaasApiKey("sk-mem-ttl", { ...baseOpts, cacheTtlMs: 1_000 });
    vi.advanceTimersByTime(1_001);
    await resolveMaasApiKey("sk-mem-ttl", { ...baseOpts, cacheTtlMs: 1_000 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
