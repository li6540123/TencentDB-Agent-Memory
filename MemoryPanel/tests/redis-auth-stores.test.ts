import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/panel/auth/identity-store.js';
import {
  MemoryOauth2EphemeralStore,
  RedisOauth2EphemeralStore,
  type Oauth2PendingState,
} from '../src/panel/auth/oauth2-ephemeral-store.js';
import { RedisIdentityStore } from '../src/panel/auth/redis-identity-store.js';
import { RedisSessionStore } from '../src/panel/auth/redis-session-store.js';
import type { ExternalIdentity } from '../src/panel/auth/types.js';

const SESSION_SECRET = 'test-session-secret-32bytes-long!!';
const PREFIX = 'panel:';

/** Minimal in-memory fake covering the ioredis methods the stores use. */
class FakeRedis {
  private readonly kv = new Map<string, { value: string; expiresAt?: number }>();
  private readonly sets = new Map<string, Set<string>>();

  private alive(key: string): { value: string; expiresAt?: number } | undefined {
    const entry = this.kv.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    let expiresAt: number | undefined;
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1] * 1000;
    } else if (args[0] === 'PX' && typeof args[1] === 'number') {
      expiresAt = Date.now() + args[1];
    }
    this.kv.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) {
      if (this.kv.delete(key)) n += 1;
      if (this.sets.delete(key)) n += 1;
    }
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.alive(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async ttl(key: string): Promise<number> {
    const entry = this.alive(key);
    if (!entry) return -2;
    if (entry.expiresAt === undefined) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added += 1;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let n = 0;
    for (const m of members) {
      if (set.delete(m)) n += 1;
    }
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const api = {
      set: (...args: Parameters<FakeRedis['set']>) => {
        ops.push(() => this.set(...args));
        return api;
      },
      del: (...args: Parameters<FakeRedis['del']>) => {
        ops.push(() => this.del(...args));
        return api;
      },
      sadd: (...args: Parameters<FakeRedis['sadd']>) => {
        ops.push(() => this.sadd(...args));
        return api;
      },
      srem: (...args: Parameters<FakeRedis['srem']>) => {
        ops.push(() => this.srem(...args));
        return api;
      },
      expire: (...args: Parameters<FakeRedis['expire']>) => {
        ops.push(() => this.expire(...args));
        return api;
      },
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return api;
  }

  async eval(script: string, numKeys: number, ...args: string[]): Promise<number> {
    // CONSUME_PENDING_LUA: compare-and-set with PX ttl
    void script;
    const key = args[0];
    const expected = args[numKeys];
    const next = args[numKeys + 1];
    const ttlMs = Number(args[numKeys + 2]);
    const cur = await this.get(key);
    if (!cur) return 0;
    if (cur !== expected) return -1;
    await this.set(key, next, 'PX', ttlMs);
    return 1;
  }

  /** Test helper: inspect raw string values. */
  rawGet(key: string): string | null {
    return this.alive(key)?.value ?? null;
  }
}

function asRedis(fake: FakeRedis): import('ioredis').default {
  return fake as unknown as import('ioredis').default;
}

function makeIdentity(email = 'alice+sso@example.com'): ExternalIdentity {
  return {
    providerId: 'oauth2',
    subject: email,
    loginName: 'alice',
    displayName: 'Alice',
    email,
    claims: {},
  };
}

describe('Redis IdP stores (fake ioredis)', () => {
  it('session create/get/destroy roundtrip encrypts payload', async () => {
    const fake = new FakeRedis();
    const store = new RedisSessionStore(asRedis(fake), {
      sessionTtlSeconds: 3600,
      sessionSecret: SESSION_SECRET,
      redis: { host: '127.0.0.1', port: 6379, password: '', db: 0, keyPrefix: PREFIX },
    });

    const created = await store.create({
      instanceId: 'inst-1',
      coreUserId: 'usr-1',
      userKey: 'sk-mem-secret-key-value',
      providerId: 'oauth2',
      externalSubject: 'alice@example.com',
      displayName: 'Alice',
    });

    const raw = fake.rawGet(`${PREFIX}sess:${created.token}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('sk-mem-secret-key-value');

    const loaded = await store.get(created.token);
    expect(loaded?.userKey).toBe('sk-mem-secret-key-value');
    expect(loaded?.coreUserId).toBe('usr-1');

    const hash = createHash('sha256').update('sk-mem-secret-key-value', 'utf8').digest('hex');
    expect(await fake.smembers(`${PREFIX}by-userkey:inst-1:${hash}`)).toContain(created.token);

    await store.destroy(created.token);
    expect(await store.get(created.token)).toBeNull();
    expect(await fake.smembers(`${PREFIX}by-userkey:inst-1:${hash}`)).not.toContain(created.token);
  });

  it('pending consume twice → second fails; state deleted after take', async () => {
    const fake = new FakeRedis();
    const ephemeral = new RedisOauth2EphemeralStore(asRedis(fake), {
      redis: { host: '127.0.0.1', port: 6379, password: '', db: 0, keyPrefix: PREFIX },
    });

    await ephemeral.putLoginState({
      state: 'state-1',
      instanceId: 'inst-1',
      returnTo: '/',
      expiresAt: Date.now() + 60_000,
    });
    const taken = await ephemeral.takeLoginState('state-1');
    expect(taken?.state).toBe('state-1');
    expect(await ephemeral.takeLoginState('state-1')).toBeNull();
    expect(fake.rawGet(`${PREFIX}oauth2-state:state-1`)).toBeNull();

    const pending: Oauth2PendingState = {
      pendingToken: 'pend-1',
      instanceId: 'inst-1',
      providerId: 'oauth2',
      externalSubject: 'alice@example.com',
      identity: makeIdentity('alice@example.com'),
      returnTo: '/',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'open',
      mode: 'create_or_bind',
    };
    await ephemeral.putPending(pending);
    const first = await ephemeral.consumePending('pend-1');
    expect(first.kind).toBe('ok');
    const second = await ephemeral.consumePending('pend-1');
    expect(second.kind).toBe('consumed');
  });

  it('identity key uses encodeURIComponent(email)', async () => {
    const fake = new FakeRedis();
    const store = new RedisIdentityStore(asRedis(fake), {
      sessionSecret: SESSION_SECRET,
      redis: { host: '127.0.0.1', port: 6379, password: '', db: 0, keyPrefix: PREFIX },
    });
    const email = 'alice+sso@example.com';
    await store.save({
      instanceId: 'inst-1',
      providerId: 'oauth2',
      externalSubject: email,
      coreUserId: 'usr-1',
      encryptedUserKey: encryptSecret('sk-mem-abc', SESSION_SECRET),
      updatedAt: new Date().toISOString(),
    });

    const expectedKey = `${PREFIX}identity:inst-1:oauth2:${encodeURIComponent(email)}`;
    expect(store.identityKey('inst-1', 'oauth2', email)).toBe(expectedKey);
    expect(fake.rawGet(expectedKey)).toBeTruthy();
    expect(fake.rawGet(`${PREFIX}identity:inst-1:oauth2:${email}`)).toBeNull();

    const found = await store.find('inst-1', 'oauth2', email);
    expect(found?.coreUserId).toBe('usr-1');
  });

  it('memory ephemeral consume is also race-safe for sequential double-consume', async () => {
    const store = new MemoryOauth2EphemeralStore();
    const pending: Oauth2PendingState = {
      pendingToken: 'm-1',
      instanceId: 'inst-1',
      providerId: 'oauth2',
      externalSubject: 'a@b.c',
      identity: makeIdentity('a@b.c'),
      returnTo: '/',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'open',
      mode: 'bind_only',
    };
    await store.putPending(pending);
    expect((await store.consumePending('m-1')).kind).toBe('ok');
    expect((await store.consumePending('m-1')).kind).toBe('consumed');
  });
});
