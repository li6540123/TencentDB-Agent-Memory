/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROXY_MAAS_KEY_CACHE_TTL_MS?: string;
  readonly VITE_TMC_BACKEND_URL?: string;
  readonly VITE_SKILL_GATEWAY_URL?: string;
  readonly VITE_ENTRY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
