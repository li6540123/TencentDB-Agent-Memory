/** Proxy MaaS resolve 缓存 TTL（与 PROXY_MAAS_KEY_CACHE_TTL_MS 对齐）。 */
export function getMaasCacheTtlMs(): number {
  const raw = import.meta.env.VITE_PROXY_MAAS_KEY_CACHE_TTL_MS;
  const n = raw ? Number(raw) : 60_000;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export function formatMaasCacheTtlHint(ttlMs: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const sec = Math.max(1, Math.round(ttlMs / 1000));
  if (sec >= 60 && sec % 60 === 0) {
    return t('apiKey.maas.effectiveHintMinutes', { minutes: sec / 60 });
  }
  return t('apiKey.maas.effectiveHintSeconds', { seconds: sec });
}
