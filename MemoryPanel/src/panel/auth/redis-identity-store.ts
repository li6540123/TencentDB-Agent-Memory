import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { PanelAuthConfig } from '../config/panel-config.js';
import {
  decryptSecret,
  type IdentityBinding,
  type IdentityStore,
} from './identity-store.js';
import { authRedisKeyPrefix } from './redis-client.js';

/** Identity binding TTL: 90 days; refreshed on SSO hit. */
export const IDENTITY_TTL_SECONDS = 90 * 24 * 60 * 60;

function hashUserKey(userKey: string): string {
  return createHash('sha256').update(userKey, 'utf8').digest('hex');
}

/**
 * Redis identity binding cache.
 * Keys use encodeURIComponent(email/subject) so `@` / `+` stay unambiguous.
 */
export class RedisIdentityStore implements IdentityStore {
  private readonly prefix: string;
  private readonly sessionSecret: string;

  constructor(
    private readonly redis: Redis,
    config: Pick<PanelAuthConfig, 'sessionSecret' | 'redis'>,
  ) {
    this.prefix = authRedisKeyPrefix(config as PanelAuthConfig);
    this.sessionSecret = config.sessionSecret;
  }

  /** Public for tests — exact Redis key for an identity binding. */
  identityKey(instanceId: string, providerId: string, externalSubject: string): string {
    return `${this.prefix}identity:${instanceId}:${providerId}:${encodeURIComponent(externalSubject)}`;
  }

  private reverseKey(instanceId: string, userKeyHash: string): string {
    return `${this.prefix}identity-by-userkey:${instanceId}:${userKeyHash}`;
  }

  async find(
    instanceId: string,
    providerId: string,
    externalSubject: string,
  ): Promise<IdentityBinding | null> {
    const key = this.identityKey(instanceId, providerId, externalSubject);
    const raw = await this.redis.get(key);
    if (!raw) return null;
    let binding: IdentityBinding;
    try {
      binding = JSON.parse(raw) as IdentityBinding;
    } catch {
      await this.redis.del(key);
      return null;
    }
    // SSO hit: renew 90d TTL on primary + reverse index.
    await this.redis.expire(key, IDENTITY_TTL_SECONDS);
    try {
      const plain = decryptSecret(binding.encryptedUserKey, this.sessionSecret);
      await this.redis.expire(this.reverseKey(instanceId, hashUserKey(plain)), IDENTITY_TTL_SECONDS);
    } catch {
      /* reverse renew best-effort */
    }
    return binding;
  }

  async save(binding: IdentityBinding): Promise<void> {
    const key = this.identityKey(binding.instanceId, binding.providerId, binding.externalSubject);
    const pipeline = this.redis.pipeline();
    pipeline.set(key, JSON.stringify(binding), 'EX', IDENTITY_TTL_SECONDS);
    try {
      const plain = decryptSecret(binding.encryptedUserKey, this.sessionSecret);
      const rev = this.reverseKey(binding.instanceId, hashUserKey(plain));
      pipeline.set(rev, key, 'EX', IDENTITY_TTL_SECONDS);
    } catch {
      /* reverse index optional if decrypt fails — primary still saved */
    }
    await pipeline.exec();
  }

  async remove(instanceId: string, providerId: string, externalSubject: string): Promise<void> {
    const key = this.identityKey(instanceId, providerId, externalSubject);
    const raw = await this.redis.get(key);
    const pipeline = this.redis.pipeline();
    pipeline.del(key);
    if (raw) {
      try {
        const binding = JSON.parse(raw) as IdentityBinding;
        const plain = decryptSecret(binding.encryptedUserKey, this.sessionSecret);
        pipeline.del(this.reverseKey(instanceId, hashUserKey(plain)));
      } catch {
        /* ignore */
      }
    }
    await pipeline.exec();
  }
}
