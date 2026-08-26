/**
 * Per-sk-mem MaaS API Key resolve + upstream effectiveApiKey 决议。
 */
import { createHash } from "node:crypto";
import { log } from "../report/log.js";

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 1_500;

type CacheEntry = {
  expiresAt: number;
  value: string | null;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

function cacheKeyForSkMem(inboundSkMem: string): string {
  return createHash("sha256").update(inboundSkMem, "utf8").digest("hex");
}

function readCacheTtlMs(): number {
  const raw = process.env.PROXY_MAAS_KEY_CACHE_TTL_MS;
  const n = raw ? Number(raw) : DEFAULT_CACHE_TTL_MS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
}

function readResolveTimeoutMs(): number {
  const raw = process.env.PROXY_MAAS_KEY_RESOLVE_TIMEOUT_MS;
  const n = raw ? Number(raw) : DEFAULT_RESOLVE_TIMEOUT_MS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RESOLVE_TIMEOUT_MS;
}

function readCached(key: string): string | null | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() >= hit.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function writeCache(key: string, value: string | null, ttlMs?: number): void {
  const ttl = ttlMs ?? readCacheTtlMs();
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

/** 单测用：清空进程内缓存与 inflight。 */
export function clearMaasKeyCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

export function resolveEffectiveUpstreamApiKey(args: {
  perUserMaasKey: string | null;
  agentUpstreamEntry?: { apiKey?: string } | undefined;
  globalApiKey: string;
}): string {
  if (args.perUserMaasKey) return args.perUserMaasKey;
  if (args.agentUpstreamEntry) return args.agentUpstreamEntry.apiKey ?? "";
  return args.globalApiKey;
}

export async function resolveMaasApiKey(
  inboundSkMem: string,
  opts: {
    coreBaseUrl: string;
    serviceToken: string;
    serviceId: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
  },
): Promise<string | null> {
  const trimmed = inboundSkMem.trim();
  if (!trimmed) return null;

  const ck = cacheKeyForSkMem(trimmed);
  const cached = readCached(ck);
  if (cached !== undefined) return cached;

  const existing = inflight.get(ck);
  if (existing) return existing;

  const promise = fetchMaasKeyFromCore(trimmed, opts)
    .then((value) => {
      if (value !== undefined) writeCache(ck, value, opts.cacheTtlMs);
      return value ?? null;
    })
    .finally(() => {
      inflight.delete(ck);
    });

  inflight.set(ck, promise);
  return promise;
}

/** undefined = 降级，不写缓存 */
async function fetchMaasKeyFromCore(
  userKey: string,
  opts: {
    coreBaseUrl: string;
    serviceToken: string;
    serviceId: string;
    timeoutMs?: number;
  },
): Promise<string | null | undefined> {
  const base = opts.coreBaseUrl.replace(/\/+$/, "");
  const url = `${base}/v3/internal/meta/user-key/maas-key/resolve`;
  const timeoutMs = opts.timeoutMs ?? readResolveTimeoutMs();

  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": opts.serviceId,
        ...(opts.serviceToken ? { authorization: `Bearer ${opts.serviceToken}` } : {}),
      },
      body: JSON.stringify({ user_key: userKey }),
    };
    if (timeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(timeoutMs);
    }

    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) {
      log.warn("maasKey.resolve.httpError", { status: resp.status });
      return undefined;
    }

    const body = (await resp.json()) as {
      code?: number;
      data?: { configured?: boolean; maas_api_key?: string };
    };

    if (body.code !== 0) {
      log.warn("maasKey.resolve.badEnvelope", { code: body.code });
      return undefined;
    }

    if (body.data?.configured === true && body.data.maas_api_key) {
      return body.data.maas_api_key;
    }

    return null;
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    log.warn("maasKey.resolve.error", {
      timeout: isTimeout,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function resolveEffectiveUpstreamApiKeyWithMaas(args: {
  inboundSkMem: string | null | undefined;
  config: {
    upstream: { apiKey: string; agents?: Record<string, { apiKey?: string } | undefined> };
    auth?: { url?: string; enabled?: boolean };
    coreSkill?: { endpoint?: string; serviceToken?: string; serviceId?: string };
  };
  agentName?: string;
  spaceId: string;
}): Promise<string> {
  const agentUpstreamEntry = args.agentName
    ? args.config.upstream.agents?.[args.agentName]
    : undefined;

  let perUser: string | null = null;
  const skMem = args.inboundSkMem?.trim();
  if (skMem) {
    const coreBaseUrl =
      args.config.auth?.url ||
      args.config.coreSkill?.endpoint ||
      "";
    if (coreBaseUrl) {
      perUser = await resolveMaasApiKey(skMem, {
        coreBaseUrl,
        serviceToken: args.config.coreSkill?.serviceToken ?? "",
        serviceId: args.spaceId || args.config.coreSkill?.serviceId || "default",
      });
    }
  }

  return resolveEffectiveUpstreamApiKey({
    perUserMaasKey: perUser,
    agentUpstreamEntry,
    globalApiKey: args.config.upstream.apiKey,
  });
}
