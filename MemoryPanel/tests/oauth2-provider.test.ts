import { describe, expect, it, vi } from 'vitest';
import { Oauth2Provider, readDottedPath } from '../src/panel/auth/oauth2-provider.js';

const defaultPaths = {
  subject: 'email',
  login: 'username',
  name: 'nickname',
  email: 'email',
};

function makeProvider(overrides: Partial<ConstructorParameters<typeof Oauth2Provider>[0]> = {}) {
  return new Oauth2Provider({
    enabled: true,
    displayName: '公司IAM登录',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    authorizationUrl: 'https://idp.example/oauth/authorize',
    tokenUrl: 'https://idp.example/oauth/token',
    userinfoUrl: 'https://idp.example/oauth/userinfo',
    appUrl: 'http://hub.example:8125',
    redirectUri: 'http://hub.example:8125/api/v1/auth/idp/oauth2/callback',
    scope: 'openid profile',
    pkce: false,
    authProviderDomain: 'iam',
    jsonPaths: defaultPaths,
    ...overrides,
  });
}

describe('readDottedPath', () => {
  it('reads nested dotted paths', () => {
    expect(readDottedPath({ data: { email: 'a@b.com' } }, 'data.email')).toBe('a@b.com');
    expect(readDottedPath({ email: 'a@b.com' }, 'email')).toBe('a@b.com');
    expect(readDottedPath({ data: {} }, 'data.email')).toBeUndefined();
  });
});

describe('Oauth2Provider', () => {
  it('prepareAuthorize builds URL-encoded authorize query without PKCE by default', async () => {
    const provider = makeProvider();
    const { url, codeVerifier } = await provider.prepareAuthorize({
      state: 'state with spaces',
      redirectUri: 'http://hub.example:8125/api/v1/auth/idp/oauth2/callback',
    });

    expect(codeVerifier).toBeUndefined();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://idp.example/oauth/authorize');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('client-id');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://hub.example:8125/api/v1/auth/idp/oauth2/callback',
    );
    expect(parsed.searchParams.get('state')).toBe('state with spaces');
    expect(parsed.searchParams.get('scope')).toBe('openid profile');
    expect(parsed.searchParams.get('code_challenge')).toBeNull();
    // URL encoding: spaces become + or %20 in query string
    expect(url).toMatch(/state=state(\+|%20)with(\+|%20)spaces/);
  });

  it('authenticateFromCallback POSTs form-urlencoded token body and maps userinfo', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/token')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        });
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('code')).toBe('auth-code');
        expect(body.get('redirect_uri')).toBe('http://hub.example/callback');
        expect(body.get('client_id')).toBe('client-id');
        expect(body.get('client_secret')).toBe('client-secret');
        return new Response(JSON.stringify({ access_token: 'access-tok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/userinfo')) {
        expect(init?.method).toBe('GET');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer access-tok',
          Accept: 'application/json',
        });
        return new Response(JSON.stringify({
          email: '  Alice@Example.COM ',
          username: 'alice',
          nickname: 'Alice',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const provider = makeProvider({ fetchImpl: fetchImpl as typeof fetch });
    const identity = await provider.authenticateFromCallback({
      code: 'auth-code',
      redirectUri: 'http://hub.example/callback',
    });

    expect(identity).toEqual({
      providerId: 'oauth2',
      subject: 'alice@example.com',
      loginName: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      claims: {
        email: '  Alice@Example.COM ',
        username: 'alice',
        nickname: 'Alice',
      },
    });
    expect(provider.authProviderDomain).toBe('iam');
  });

  it('fails when userinfo has no email', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({ username: 'alice' }), { status: 200 });
    });

    const provider = makeProvider({ fetchImpl: fetchImpl as typeof fetch });
    const identity = await provider.authenticateFromCallback({
      code: 'c',
      redirectUri: 'http://hub.example/callback',
    });
    expect(identity).toBeNull();
  });

  it('reads nested data.email when EMAIL_JSONPATH is configured', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/token')) {
        return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { email: 'Nested@Corp.COM', username: 'nested' },
        nickname: 'Nested User',
      }), { status: 200 });
    });

    const provider = makeProvider({
      fetchImpl: fetchImpl as typeof fetch,
      jsonPaths: {
        subject: 'data.email',
        login: 'data.username',
        name: 'nickname',
        email: 'data.email',
      },
    });
    const identity = await provider.authenticateFromCallback({
      code: 'c',
      redirectUri: 'http://hub.example/callback',
    });

    expect(identity?.email).toBe('nested@corp.com');
    expect(identity?.subject).toBe('nested@corp.com');
    expect(identity?.loginName).toBe('nested');
    expect(identity?.displayName).toBe('Nested User');
  });

  it('omits scope when empty and includes PKCE when enabled', async () => {
    const provider = makeProvider({ scope: '', pkce: true });
    const { url, codeVerifier } = await provider.prepareAuthorize({
      state: 's',
      redirectUri: 'http://hub.example/callback',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBeNull();
    expect(codeVerifier).toBeTruthy();
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
  });
});
