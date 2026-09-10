import type Redis from 'ioredis';
import type { PanelAuthConfig } from '../config/panel-config.js';
import type { ExternalIdentity } from './types.js';
import { authRedisKeyPrefix } from './redis-client.js';

export const OAUTH2_EPHEMERAL_TTL_SECONDS = 5 * 60;
export const OAUTH2_EPHEMERAL_TTL_MS = OAUTH2_EPHEMERAL_TTL_SECONDS * 1000;

/** OAuth2 首次/绑 key 确认态。TTL 300s；消费：open → consuming → 成功后删除。 */
export type Oauth2PendingMode = 'create_or_bind' | 'bind_only';
export type Oauth2PendingStatus = 'open' | 'consuming';

export interface Oauth2PendingState {
  pendingToken: string;
  instanceId: string;
  providerId: string;
  externalSubject: string;
  identity: ExternalIdentity;
  returnTo: string;
  createdAt: number;
  expiresAt: number;
  status: Oauth2PendingStatus;
  mode: Oauth2PendingMode;
  /** preview 通过后写入 sha256(userKey)，confirm 再校验。 */
  verifiedUserKeyHash?: string;
}

/** GET .../oauth2/pending 对外视图（不含 sk-mem / token 明文）。 */
export interface Oauth2PendingView {
  instance_id: string;
  display_name?: string;
  login_name: string;
  email?: string;
  mode: Oauth2PendingMode;
  expires_at: number;
}

/** OAuth2 authorize `state` (one-shot; deleted on callback consume). */
export interface Oauth2LoginState {
  state: string;
  instanceId: string;
  returnTo: string;
  codeVerifier?: string;
  expiresAt: number;
}

export type ConsumePendingResult =
  | { kind: 'ok'; pending: Oauth2PendingState }
  | { kind: 'expired' }
  | { kind: 'consumed' };

/**
 * Ephemeral OAuth2 state + pending confirmation tokens.
 * `local` → in-memory Maps; `redis` → shared keys with 5 min TTL.
 */
export interface Oauth2EphemeralStore {
  putLoginState(state: Oauth2LoginState): Promise<void>;
  /** GET + DEL (atomic enough for one-shot replay protection). */
  takeLoginState(state: string): Promise<Oauth2LoginState | null>;
  putPending(pending: Oauth2PendingState): Promise<void>;
  getPending(token: string): Promise<Oauth2PendingState | null>;
  /** Race-safe open → consuming. */
  consumePending(token: string): Promise<ConsumePendingResult>;
  deletePending(token: string): Promise<void>;
}

export class MemoryOauth2EphemeralStore implements Oauth2EphemeralStore {
  private readonly loginStates = new Map<string, Oauth2LoginState>();
  private readonly pending = new Map<string, Oauth2PendingState>();

  async putLoginState(state: Oauth2LoginState): Promise<void> {
    this.loginStates.set(state.state, state);
  }

  async takeLoginState(state: string): Promise<Oauth2LoginState | null> {
    const found = this.loginStates.get(state) ?? null;
    if (found) this.loginStates.delete(state);
    if (!found || found.expiresAt <= Date.now()) return null;
    return found;
  }

  async putPending(state: Oauth2PendingState): Promise<void> {
    this.pending.set(state.pendingToken, state);
  }

  async getPending(token: string): Promise<Oauth2PendingState | null> {
    const state = this.pending.get(token);
    if (!state) return null;
    if (state.expiresAt <= Date.now()) {
      this.pending.delete(token);
      return null;
    }
    return state;
  }

  async consumePending(token: string): Promise<ConsumePendingResult> {
    const pending = await this.getPending(token);
    if (!pending) return { kind: 'expired' };
    if (pending.status === 'consuming') return { kind: 'consumed' };
    pending.status = 'consuming';
    return { kind: 'ok', pending };
  }

  async deletePending(token: string): Promise<void> {
    this.pending.delete(token);
  }
}

/**
 * Compare-and-set consume: only transition when stored JSON still matches open snapshot.
 * ARGV[1]=expected open JSON, ARGV[2]=consuming JSON, ARGV[3]=ttl ms (fallback).
 * Returns 1 ok, 0 missing, -1 raced/changed.
 */
const CONSUME_PENDING_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
if cur ~= ARGV[1] then return -1 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 1 then ttl = tonumber(ARGV[3]) end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1
`;

export class RedisOauth2EphemeralStore implements Oauth2EphemeralStore {
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    config: Pick<PanelAuthConfig, 'redis'>,
  ) {
    this.prefix = authRedisKeyPrefix(config as PanelAuthConfig);
  }

  private stateKey(state: string): string {
    return `${this.prefix}oauth2-state:${state}`;
  }

  private pendingKey(token: string): string {
    return `${this.prefix}pending:${token}`;
  }

  private ttlSecondsFromExpires(expiresAt: number): number {
    const sec = Math.ceil((expiresAt - Date.now()) / 1000);
    return Math.max(1, Math.min(OAUTH2_EPHEMERAL_TTL_SECONDS, sec));
  }

  async putLoginState(state: Oauth2LoginState): Promise<void> {
    await this.redis.set(
      this.stateKey(state.state),
      JSON.stringify(state),
      'EX',
      this.ttlSecondsFromExpires(state.expiresAt),
    );
  }

  async takeLoginState(state: string): Promise<Oauth2LoginState | null> {
    const key = this.stateKey(state);
    const raw = await this.redis.get(key);
    if (raw) await this.redis.del(key);
    if (!raw) return null;
    let parsed: Oauth2LoginState;
    try {
      parsed = JSON.parse(raw) as Oauth2LoginState;
    } catch {
      return null;
    }
    if (!parsed || parsed.expiresAt <= Date.now()) return null;
    return parsed;
  }

  async putPending(pending: Oauth2PendingState): Promise<void> {
    await this.redis.set(
      this.pendingKey(pending.pendingToken),
      JSON.stringify(pending),
      'EX',
      this.ttlSecondsFromExpires(pending.expiresAt),
    );
  }

  async getPending(token: string): Promise<Oauth2PendingState | null> {
    const raw = await this.redis.get(this.pendingKey(token));
    if (!raw) return null;
    let pending: Oauth2PendingState;
    try {
      pending = JSON.parse(raw) as Oauth2PendingState;
    } catch {
      await this.redis.del(this.pendingKey(token));
      return null;
    }
    if (pending.expiresAt <= Date.now()) {
      await this.redis.del(this.pendingKey(token));
      return null;
    }
    return pending;
  }

  async consumePending(token: string): Promise<ConsumePendingResult> {
    const key = this.pendingKey(token);
    const raw = await this.redis.get(key);
    if (!raw) return { kind: 'expired' };
    let pending: Oauth2PendingState;
    try {
      pending = JSON.parse(raw) as Oauth2PendingState;
    } catch {
      await this.redis.del(key);
      return { kind: 'expired' };
    }
    if (pending.expiresAt <= Date.now()) {
      await this.redis.del(key);
      return { kind: 'expired' };
    }
    if (pending.status === 'consuming') return { kind: 'consumed' };
    if (pending.status !== 'open') return { kind: 'consumed' };

    const consuming: Oauth2PendingState = { ...pending, status: 'consuming' };
    const ttlMs = Math.max(1, pending.expiresAt - Date.now());
    const result = await this.redis.eval(
      CONSUME_PENDING_LUA,
      1,
      key,
      raw,
      JSON.stringify(consuming),
      String(ttlMs),
    );
    if (result === 1) return { kind: 'ok', pending: consuming };
    if (result === 0) return { kind: 'expired' };
    // Raced: re-check
    const again = await this.getPending(token);
    if (!again) return { kind: 'expired' };
    if (again.status === 'consuming') return { kind: 'consumed' };
    return { kind: 'consumed' };
  }

  async deletePending(token: string): Promise<void> {
    await this.redis.del(this.pendingKey(token));
  }
}
