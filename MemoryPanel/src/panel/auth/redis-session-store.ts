import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { PanelAuthConfig } from '../config/panel-config.js';
import { decryptSecret, encryptSecret } from './identity-store.js';
import { authRedisKeyPrefix } from './redis-client.js';
import type { IdpSession, SessionStore } from './session-store.js';

function hashUserKey(userKey: string): string {
  return createHash('sha256').update(userKey, 'utf8').digest('hex');
}

/**
 * Redis-backed IdP Cookie session store.
 * Value is encryptSecret(JSON.stringify(session)) — userKey is never plaintext in Redis.
 * Reverse index: `{prefix}by-userkey:{instanceId}:{sha256(userKey)}` → Set of session tokens.
 */
export class RedisSessionStore implements SessionStore {
  private readonly prefix: string;
  private readonly ttlSeconds: number;
  private readonly sessionSecret: string;

  constructor(
    private readonly redis: Redis,
    config: Pick<PanelAuthConfig, 'sessionTtlSeconds' | 'sessionSecret' | 'redis'>,
  ) {
    this.prefix = authRedisKeyPrefix(config as PanelAuthConfig);
    this.ttlSeconds = config.sessionTtlSeconds;
    this.sessionSecret = config.sessionSecret;
  }

  private sessKey(token: string): string {
    return `${this.prefix}sess:${token}`;
  }

  private byUserKey(instanceId: string, userKey: string): string {
    return `${this.prefix}by-userkey:${instanceId}:${hashUserKey(userKey)}`;
  }

  async create(input: Omit<IdpSession, 'token' | 'createdAt' | 'expiresAt'>): Promise<IdpSession> {
    const now = Date.now();
    const session: IdpSession = {
      ...input,
      token: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
    };
    const encrypted = encryptSecret(JSON.stringify(session), this.sessionSecret);
    const pipeline = this.redis.pipeline();
    pipeline.set(this.sessKey(session.token), encrypted, 'EX', this.ttlSeconds);
    const indexKey = this.byUserKey(session.instanceId, session.userKey);
    pipeline.sadd(indexKey, session.token);
    pipeline.expire(indexKey, this.ttlSeconds);
    await pipeline.exec();
    return session;
  }

  async get(token: string | undefined): Promise<IdpSession | null> {
    if (!token) return null;
    const raw = await this.redis.get(this.sessKey(token));
    if (!raw) return null;
    let session: IdpSession;
    try {
      session = JSON.parse(decryptSecret(raw, this.sessionSecret)) as IdpSession;
    } catch {
      await this.redis.del(this.sessKey(token));
      return null;
    }
    if (!session || typeof session.token !== 'string' || session.expiresAt <= Date.now()) {
      await this.destroy(token);
      return null;
    }
    return session;
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    const key = this.sessKey(token);
    const raw = await this.redis.get(key);
    let userKey: string | undefined;
    let instanceId: string | undefined;
    if (raw) {
      try {
        const parsed = JSON.parse(decryptSecret(raw, this.sessionSecret)) as Partial<IdpSession>;
        userKey = typeof parsed.userKey === 'string' ? parsed.userKey : undefined;
        instanceId = typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined;
      } catch {
        /* ignore corrupt blob */
      }
    }
    const pipeline = this.redis.pipeline();
    pipeline.del(key);
    if (userKey && instanceId) {
      pipeline.srem(this.byUserKey(instanceId, userKey), token);
    }
    await pipeline.exec();
  }
}
