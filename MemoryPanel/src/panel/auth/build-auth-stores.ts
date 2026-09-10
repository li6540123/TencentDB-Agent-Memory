import type Redis from 'ioredis';
import type { PanelAuthConfig } from '../config/panel-config.js';
import { FileIdentityStore, type IdentityStore } from './identity-store.js';
import {
  MemoryOauth2EphemeralStore,
  RedisOauth2EphemeralStore,
  type Oauth2EphemeralStore,
} from './oauth2-ephemeral-store.js';
import { createRedisFromAuthConfig } from './redis-client.js';
import { RedisIdentityStore } from './redis-identity-store.js';
import { RedisSessionStore } from './redis-session-store.js';
import { MemorySessionStore, type SessionStore } from './session-store.js';

export interface AuthStores {
  sessions: SessionStore;
  identities: IdentityStore;
  ephemeral: Oauth2EphemeralStore;
  /** Connected Redis client when sessionStore=redis; caller may quit on shutdown. */
  redis?: Redis;
}

/** Build session / identity / OAuth2 ephemeral stores from Panel auth config. */
export function buildAuthStores(config: PanelAuthConfig, sessionSecret: string): AuthStores {
  if (config.sessionStore === 'redis') {
    if (!config.redis) {
      throw new Error('PANEL_SESSION_STORE=redis but redis connection config is missing');
    }
    const redis = createRedisFromAuthConfig(config);
    const redisConfig = { ...config, sessionSecret };
    return {
      sessions: new RedisSessionStore(redis, redisConfig),
      identities: new RedisIdentityStore(redis, redisConfig),
      ephemeral: new RedisOauth2EphemeralStore(redis, config),
      redis,
    };
  }
  return {
    sessions: new MemorySessionStore(config.sessionTtlSeconds),
    identities: new FileIdentityStore(config.identityStorePath),
    ephemeral: new MemoryOauth2EphemeralStore(),
  };
}
