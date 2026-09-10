import Redis from 'ioredis';
import type { PanelAuthConfig, PanelAuthRedisConfig } from '../config/panel-config.js';

/** Build an ioredis client from Panel auth Redis settings (URL preferred). */
export function createRedisFromAuthConfig(config: PanelAuthConfig): Redis {
  const redis = config.redis;
  if (!redis) {
    throw new Error('PANEL_SESSION_STORE=redis but redis config is missing');
  }
  return createRedisClient(redis);
}

export function createRedisClient(redis: PanelAuthRedisConfig): Redis {
  if (redis.url) {
    return new Redis(redis.url, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
  }
  return new Redis({
    host: redis.host || '127.0.0.1',
    port: redis.port || 6379,
    password: redis.password || undefined,
    db: redis.db ?? 0,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });
}

export function authRedisKeyPrefix(config: PanelAuthConfig): string {
  return config.redis?.keyPrefix ?? 'panel:';
}
