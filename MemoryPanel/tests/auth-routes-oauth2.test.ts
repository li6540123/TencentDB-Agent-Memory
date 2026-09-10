import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelAuthService } from '../src/panel/auth/service.js';
import { encryptSecret } from '../src/panel/auth/identity-store.js';
import type { ExternalIdentity } from '../src/panel/auth/types.js';
import type { PanelAuthConfig } from '../src/panel/config/panel-config.js';
import { InstanceRegistry } from '../src/panel/config/instance-registry.js';
import type { MetaKernelPort } from '../src/panel/kernel/ports/meta-kernel-port.js';
import type { MetaEnvelope } from '../src/panel/kernel/envelope.js';
import type { Logger } from '../src/panel/infra/logger.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
import { registerAuthRoutes } from '../src/panel/http/routes/auth.js';

const SESSION_SECRET = 'test-session-secret-32bytes-long!!';

function ok<T>(data: T): MetaEnvelope<T> {
  return { code: 0, message: 'ok', request_id: 'req', data };
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

describe('oauth2 auth routes', () => {
  let tempDir: string | undefined;
  let service: PanelAuthService;
  let app: Hono;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-routes-oauth2-'));
    const identityStorePath = join(tempDir, 'identities.json');
    const authConfig = makeConfig(identityStorePath);

    fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (href.includes('/userinfo')) {
        return new Response(
          JSON.stringify({
            email: 'alice@example.com',
            username: 'alice',
            nickname: 'Alice',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const invoke: MetaKernelPort['invoke'] = async (action, body) => {
      if (action === 'user/find-by-external') return ok(null);
      if (action === 'user/create') {
        return ok({
          user_id: 'usr-new',
          default_user_key: 'sk-mem-autogen-key-1',
          username: 'alice',
          email: 'alice@example.com',
          display_name: 'Alice',
          user_type: 'human',
        });
      }
      if (action === 'user/bind-external') return ok({ user_id: 'usr-new' });
      if (action === 'user-key/create') return ok({ key_value: 'sk-mem-autogen-key-1' });
      if (action === 'auth/verify') {
        return ok({
          valid: true,
          user_id: 'usr-new',
          user: {
            user_id: 'usr-new',
            username: 'alice',
            email: 'alice@example.com',
            display_name: 'Alice',
            user_type: 'human',
          },
        });
      }
      if (action === 'user/update') return ok({ user_id: body.user_id });
      if (action === 'user/get') return ok({ user_id: body.user_id, external_id: body.user_id });
      return ok(null);
    };

    service = new PanelAuthService({
      config: authConfig,
      instances: makeInstances(),
      metaKernel: { invoke },
      logger: makeLogger(),
    });

    app = new Hono();
    registerAuthRoutes(app, {
      auth: service,
      config: { auth: authConfig },
    } as PanelDeps);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('login redirects to IdP with state; disabled oauth2 redirects home', async () => {
    const login = await app.request('/auth/idp/oauth2/login?instance_id=inst-1');
    expect(login.status).toBe(302);
    const location = login.headers.get('location') ?? '';
    expect(location).toContain('https://idp.example/authorize');
    expect(location).toContain('state=');
    expect(location).toContain('client_id=cid');

    // callback without prior state → 302 /?sso_error=invalid_state（勿吐 JSON）
    const missing = await app.request('/auth/idp/oauth2/callback?code=abc&state=no-such-state');
    expect(missing.status).toBe(302);
    expect(missing.headers.get('location')).toBe('/?sso_error=invalid_state');
  });

  it('callback without state redirects with sso_error=invalid_state', async () => {
    const res = await app.request('/auth/idp/oauth2/callback?code=abc');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?sso_error=invalid_state');
  });

  it('callback IdP error query redirects with sso_error=idp_error', async () => {
    const res = await app.request('/auth/idp/oauth2/callback?error=access_denied&state=whatever');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?sso_error=idp_error');
  });

  it('callback first login redirects to /?pending= and consumes state once', async () => {
    const login = await app.request('/auth/idp/oauth2/login?instance_id=inst-1&return_to=/teams');
    const authorizeUrl = new URL(login.headers.get('location')!);
    const state = authorizeUrl.searchParams.get('state')!;

    const cb = await app.request(`/auth/idp/oauth2/callback?code=auth-code&state=${state}`);
    expect(cb.status).toBe(302);
    const dest = cb.headers.get('location') ?? '';
    expect(dest.startsWith('/?pending=')).toBe(true);
    expect(cb.headers.get('set-cookie')).toBeNull();

    const pendingToken = new URL(dest, 'http://hub.local').searchParams.get('pending')!;
    const pending = await app.request(`/auth/idp/oauth2/pending?pending=${pendingToken}`);
    expect(pending.status).toBe(200);
    const view = await pending.json();
    expect(view.email).toBe('alice@example.com');
    expect(view.mode).toBe('create_or_bind');

    // state 一次性：重放 → 302 sso_error（勿吐 JSON）
    const replay = await app.request(`/auth/idp/oauth2/callback?code=auth-code&state=${state}`);
    expect(replay.status).toBe(302);
    expect(replay.headers.get('location')).toBe('/?sso_error=invalid_state');
  });

  it('callback existing user sets session Cookie and redirects to return_to', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-routes-oauth2-existing-'));
    const identityStorePath = join(tempDir, 'identities.json');
    seedBinding(identityStorePath, 'sk-mem-existing-user-key');
    const authConfig = makeConfig(identityStorePath);

    fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 'at-1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (href.includes('/userinfo')) {
        return new Response(
          JSON.stringify({
            email: 'alice@example.com',
            username: 'alice',
            nickname: 'Alice',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const existingService = new PanelAuthService({
      config: authConfig,
      instances: makeInstances(),
      metaKernel: {
        invoke: async (action, body) => {
          if (action === 'auth/verify') {
            return ok({
              valid: true,
              user_id: 'usr-1',
              user: {
                user_id: 'usr-1',
                username: 'alice',
                email: 'alice@example.com',
                display_name: 'Alice',
                user_type: 'human',
              },
            });
          }
          if (action === 'user/update') return ok({ user_id: body.user_id });
          return ok(null);
        },
      },
      logger: makeLogger(),
    });
    const existingApp = new Hono();
    registerAuthRoutes(existingApp, {
      auth: existingService,
      config: { auth: authConfig },
    } as PanelDeps);

    const login = await existingApp.request('/auth/idp/oauth2/login?instance_id=inst-1&return_to=/teams');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;

    const cb = await existingApp.request(`/auth/idp/oauth2/callback?code=auth-code&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/teams');
    const setCookie = cb.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tdai_idp_session=');
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('GET pending returns pending_expired for missing/expired token', async () => {
    const missing = await app.request('/auth/idp/oauth2/pending?pending=gone');
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toBe('pending_expired');

    const created = service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });
    // 强制过期
    (created as { expiresAt: number }).expiresAt = Date.now() - 1;

    const expired = await app.request(`/auth/idp/oauth2/pending?pending=${created.pendingToken}`);
    expect(expired.status).toBe(400);
    expect((await expired.json()).message).toBe('pending_expired');
  });

  it('concurrent consume returns pending_consumed on second confirm-create', async () => {
    const pending = service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });

    // 先占坑
    service.consumeOauth2Pending(pending.pendingToken);

    const second = await app.request('/auth/idp/oauth2/confirm-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending_token: pending.pendingToken }),
    });
    expect(second.status).toBe(409);
    expect((await second.json()).message).toBe('pending_consumed');
  });

  it('confirm-create success sets SameSite=Lax session cookie', async () => {
    const pending = service.createOauth2Pending({
      instanceId: 'inst-1',
      identity: makeIdentity(),
      mode: 'create_or_bind',
    });

    const res = await app.request('/auth/idp/oauth2/confirm-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pending_token: pending.pendingToken }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('tdai_idp_session=');
    expect(setCookie).toContain('SameSite=Lax');
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user_key).toBeTruthy();
  });

  it('login/callback redirect home when oauth2 disabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'auth-routes-oauth2-off-'));
    const identityStorePath = join(tempDir, 'identities.json');
    const authConfig = makeConfig(identityStorePath);
    authConfig.oauth2.enabled = false;
    // idp still true but no oauth2 provider registered
    const offService = new PanelAuthService({
      config: authConfig,
      instances: makeInstances(),
      metaKernel: { invoke: async () => ok(null) },
      logger: makeLogger(),
    });
    const offApp = new Hono();
    registerAuthRoutes(offApp, {
      auth: offService,
      config: { auth: authConfig },
    } as PanelDeps);

    const login = await offApp.request('/auth/idp/oauth2/login?instance_id=inst-1');
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/');

    const cb = await offApp.request('/auth/idp/oauth2/callback?code=x&state=y');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
  });
});
