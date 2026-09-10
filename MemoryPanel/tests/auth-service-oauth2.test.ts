import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PanelAuthError,
  PanelAuthService,
} from '../src/panel/auth/service.js';
import { encryptSecret } from '../src/panel/auth/identity-store.js';
import type { ExternalIdentity } from '../src/panel/auth/types.js';
import type { PanelAuthConfig } from '../src/panel/config/panel-config.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { MetaKernelPort } from '../src/panel/kernel/ports/meta-kernel-port.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import type { Logger } from '../src/panel/infra/logger.js';

const SESSION_SECRET = 'test-session-secret-32bytes-long!!';

function ok<T>(data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: 'req', data };
}

function makeIdentity(overrides: Partial<ExternalIdentity> = {}): ExternalIdentity {
  return {
    providerId: 'oauth2',
    subject: 'alice@example.com',
    loginName: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    claims: {},
    ...overrides,
  };
}

function makeConfig(identityStorePath: string): PanelAuthConfig {
  return {
    userKeyEnabled: true,
    idpEnabled: true,
    sessionTtlSeconds: 3600,
    sessionCookieName: 'tdai_idp_session',
    sessionSecure: false,
    sessionSecret: SESSION_SECRET,
    identityStorePath,
    sessionStore: 'local',
    woa: {
      enabled: false,
      appToken: '',
      safeMode: false,
      requireSignature: false,
      appUrl: '',
      loginUrl: '',
      logoutUrl: '',
      paasId: '',
      defaultTeamId: '',
      defaultRole: 'member',
      authProvider: 'woa',
    },
    oauth2: {
      enabled: true,
      displayName: '公司IAM登录',
      clientId: 'cid',
      clientSecret: 'csecret',
      authorizationUrl: 'https://idp.example/authorize',
      tokenUrl: 'https://idp.example/token',
      userinfoUrl: 'https://idp.example/userinfo',
      appUrl: 'http://hub.example:8125',
      redirectUri: 'http://hub.example:8125/api/v1/auth/idp/oauth2/callback',
      scope: 'openid',
      pkce: false,
      authProviderDomain: 'iam',
      jsonPaths: { subject: 'email', login: 'username', name: 'nickname', email: 'email' },
    },
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => makeLogger(),
  };
}

function makeInstances(): InstanceRegistry {
  return new InstanceRegistry([
    {
      instance_id: 'inst-1',
      name: 'test',
      gateway_endpoint: 'http://core.example:8080',
      api_key: 'admin-api-key',
    },
  ]);
}

function seedBinding(identityStorePath: string, plainUserKey: string): void {
  writeFileSync(
    identityStorePath,
    JSON.stringify({
      version: 1,
      bindings: [
        {
          instanceId: 'inst-1',
          providerId: 'oauth2',
          externalSubject: 'alice@example.com',
          coreUserId: 'usr-1',
          encryptedUserKey: encryptSecret(plainUserKey, SESSION_SECRET),
          displayName: 'Alice',
          updatedAt: new Date().toISOString(),
        },
      ],
    }),
    'utf8',
  );
}

describe('PanelAuthService oauth2', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function setup(invoke: MetaKernelPort['invoke'], opts?: { seedKey?: string }) {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-oauth2-'));
    const identityStorePath = join(tempDir, 'identities.json');
    if (opts?.seedKey) seedBinding(identityStorePath, opts.seedKey);
    const logger = makeLogger();
    const service = new PanelAuthService({
      config: makeConfig(identityStorePath),
      instances: makeInstances(),
      metaKernel: { invoke },
      logger,
    });
    return { service, logger };
  }

  it('dual-lookup tries iam before omitting provider', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { service } = setup(async (action, body) => {
      if (action === 'user/find-by-external') {
        calls.push({ ...body });
        if (body.auth_provider === 'iam') return ok({ user_id: 'usr-iam' });
        return ok(null);
      }
      if (action === 'user-key/create') return ok({ key_value: 'sk-mem-new-key-iam-hit' });
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user: { user_id: 'usr-iam', username: 'alice', display_name: 'Alice', user_type: 'human' },
        });
      }
      if (action === 'user/update') return ok({ user_id: 'usr-iam' });
      throw new Error(`unexpected action ${action}`);
    });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('authenticated');
    expect(calls).toEqual([
      { external_id: 'alice@example.com', auth_provider: 'iam' },
    ]);
  });

  it('dual-lookup falls back to omit-provider when iam misses', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { service } = setup(async (action, body) => {
      if (action === 'user/find-by-external') {
        calls.push({ ...body });
        if (!body.auth_provider) return ok({ user_id: 'usr-local' });
        return ok(null);
      }
      if (action === 'user-key/create') return ok({ key_value: 'sk-mem-new-key-local-hit' });
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user: { user_id: 'usr-local', username: 'alice', display_name: 'Alice', user_type: 'human' },
        });
      }
      if (action === 'user/update') return ok({ user_id: 'usr-local' });
      throw new Error(`unexpected action ${action}`);
    });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('authenticated');
    expect(calls).toEqual([
      { external_id: 'alice@example.com', auth_provider: 'iam' },
      { external_id: 'alice@example.com' },
    ]);
  });

  it('binding with invalid key mints a new key instead of permanent 401', async () => {
    const actions: string[] = [];
    const { service } = setup(async (action, body) => {
      actions.push(action);
      if (action === 'auth/verify') {
        const key = String(body.user_key ?? '');
        if (key === 'sk-mem-revoked-old-key') {
          return { code: 0, message: 'ok', request_id: 'r', data: { valid: false } };
        }
        return ok({
          valid: true,
          user: { user_id: 'usr-1', username: 'alice', display_name: 'Alice', user_type: 'human' },
        });
      }
      if (action === 'user/find-by-external') {
        if (body.auth_provider === 'iam') return ok({ user_id: 'usr-1' });
        return ok(null);
      }
      if (action === 'user-key/create') return ok({ key_value: 'sk-mem-fresh-minted-keyxx' });
      if (action === 'user/update') return ok({ user_id: 'usr-1' });
      throw new Error(`unexpected action ${action}`);
    }, { seedKey: 'sk-mem-revoked-old-key' });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('authenticated');
    if (result.kind === 'authenticated') {
      expect(result.session.userKey).toBe('sk-mem-fresh-minted-keyxx');
      expect(result.session.coreUserId).toBe('usr-1');
    }
    expect(actions).toContain('user/find-by-external');
    expect(actions).toContain('user-key/create');
  });

  it('still authenticates when user/update fails', async () => {
    const { service, logger } = setup(async (action, body) => {
      if (action === 'user/find-by-external') {
        if (body.auth_provider === 'iam') return ok({ user_id: 'usr-1' });
        return ok(null);
      }
      if (action === 'user-key/create') return ok({ key_value: 'sk-mem-profile-sync-key' });
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user: { user_id: 'usr-1', username: 'alice', display_name: 'Alice', user_type: 'human' },
        });
      }
      if (action === 'user/update') {
        throw new Error('core unavailable');
      }
      throw new Error(`unexpected action ${action}`);
    });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('authenticated');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('key-limit mint failure yields pending mode=bind_only', async () => {
    const { service } = setup(async (action, body) => {
      if (action === 'user/find-by-external') {
        if (body.auth_provider === 'iam') return ok({ user_id: 'usr-1' });
        return ok(null);
      }
      if (action === 'user-key/create') {
        return { code: 400, message: 'active key limit reached', request_id: 'r', data: null };
      }
      throw new Error(`unexpected action ${action}`);
    });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('pending');
    if (result.kind === 'pending') {
      expect(result.pending.mode).toBe('bind_only');
      expect((await service.getOauth2PendingView(result.pending.pendingToken)).mode).toBe('bind_only');
    }
  });

  it('consumeOauth2Pending is open→consuming then rejects second consume', async () => {
    const { service } = setup(async () => ok(null));
    const pending = await service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });
    const first = await service.consumeOauth2Pending(pending.pendingToken);
    expect(first.status).toBe('consuming');
    await expect(service.consumeOauth2Pending(pending.pendingToken)).rejects.toBeInstanceOf(PanelAuthError);
    try {
      await service.consumeOauth2Pending(pending.pendingToken);
    } catch (err) {
      expect(err).toBeInstanceOf(PanelAuthError);
      expect((err as PanelAuthError).code).toBe('pending_consumed');
    }
    await service.deleteOauth2Pending(pending.pendingToken);
    expect(await service.getOauth2Pending(pending.pendingToken)).toBeNull();
  });

  it('true first login yields pending create_or_bind', async () => {
    const { service } = setup(async (action) => {
      if (action === 'user/find-by-external') return ok(null);
      throw new Error(`unexpected action ${action}`);
    });

    const result = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });

    expect(result.kind).toBe('pending');
    if (result.kind === 'pending') {
      expect(result.pending.mode).toBe('create_or_bind');
    }
  });

  it('confirmOauth2Create clears stale binding instead of WOA hard 401', async () => {
    const { service } = setup(async (action, body) => {
      if (action === 'auth/verify') {
        const key = String(body.user_key ?? '');
        if (key === 'sk-mem-revoked-stale-key') {
          return { code: 0, message: 'ok', request_id: 'r', data: { valid: false } };
        }
        if (key === 'sk-mem-brand-new-created') {
          return ok({
            valid: true,
            user: { user_id: 'usr-new', username: 'alice', display_name: 'Alice', user_type: 'human' },
          });
        }
        return { code: 0, message: 'ok', request_id: 'r', data: { valid: false } };
      }
      if (action === 'user/find-by-external') return ok(null);
      if (action === 'user/create') {
        return ok({ user_id: 'usr-new', default_user_key: 'sk-mem-brand-new-created' });
      }
      if (action === 'user/bind-external') return ok({ user_id: 'usr-new' });
      if (action === 'user/update') return ok({ user_id: 'usr-new' });
      throw new Error(`unexpected action ${action}`);
    }, { seedKey: 'sk-mem-revoked-stale-key' });

    // Stale binding + Core miss → create_or_bind pending (binding file still present).
    const resolved = await service.resolveOauth2Login({
      instanceId: 'inst-1',
      identity: makeIdentity(),
    });
    expect(resolved.kind).toBe('pending');
    if (resolved.kind !== 'pending') return;

    const created = await service.confirmOauth2Create({
      pendingToken: resolved.pending.pendingToken,
    });
    expect(created.userKeyDisplay).toBe('sk-mem-brand-new-created');
    expect(created.session.coreUserId).toBe('usr-new');
  });

  it('previewOauth2Bind rejects identity_already_bound', async () => {
    const { service } = setup(async (action, body) => {
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user: { user_id: 'usr-target', username: 'bob', user_type: 'human' },
        });
      }
      if (action === 'user/find-by-external') {
        // IAM identity already on another account
        if (body.auth_provider === 'iam') return ok({ user_id: 'usr-other' });
        return ok(null);
      }
      throw new Error(`unexpected action ${action}`);
    });

    const pending = await service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });

    await expect(
      service.previewOauth2Bind({
        pendingToken: pending.pendingToken,
        userKey: 'sk-mem-existing-key',
      }),
    ).rejects.toMatchObject({ code: 'identity_already_bound', status: 409 });
  });

  it('previewOauth2Bind rejects target_already_bound_other_identity using Core admin public shape', async () => {
    // Use real Core toPublicUser so this fails if admin visibility regresses
    // (no invented external_id on a hand-rolled public user).
    const { toPublicUser } = await import(
      '../../MemoryCore/src/metadata/service/user-visibility.js'
    );

    const targetEntity = {
      user_id: 'usr-target',
      user_type: 'normal' as const,
      username: 'bob',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'active' as const,
      auth_provider: 'iam',
      external_id: 'other-person@example.com',
      display_name: 'Bob',
      email: 'bob@example.com',
      password: null,
      raw_profile_json: '{}',
      metadata_json: '{}',
    };
    const adminPublic = toPublicUser(targetEntity, {
      token: 'sk-admin',
      userId: 'usr-admin',
      isAdmin: false,
      isSystemAdmin: true,
    });
    expect(adminPublic.external_id).toBe('other-person@example.com');

    const { service } = setup(async (action, body) => {
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user: { user_id: 'usr-target', username: 'bob', user_type: 'human' },
        });
      }
      if (action === 'user/find-by-external') return ok(null);
      if (action === 'user/get') {
        expect(body.user_id).toBe('usr-target');
        return ok(adminPublic);
      }
      throw new Error(`unexpected action ${action}`);
    });

    const pending = await service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity({ subject: 'alice@example.com', email: 'alice@example.com' }),
      mode: 'create_or_bind',
    });

    await expect(
      service.previewOauth2Bind({
        pendingToken: pending.pendingToken,
        userKey: 'sk-mem-existing-key',
      }),
    ).rejects.toMatchObject({ code: 'target_already_bound_other_identity', status: 409 });
  });

  it('getOauth2PendingView returns pending_consumed while consuming', async () => {
    const { service } = setup(async () => ok(null));
    const pending = await service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });
    await service.consumeOauth2Pending(pending.pendingToken);
    try {
      await service.getOauth2PendingView(pending.pendingToken);
      expect.fail('expected pending_consumed');
    } catch (err) {
      expect(err).toBeInstanceOf(PanelAuthError);
      expect((err as PanelAuthError).code).toBe('pending_consumed');
    }
  });
});
