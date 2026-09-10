import { createHash, randomBytes } from 'node:crypto';
import type { PanelOAuth2JsonPaths } from '../config/panel-config.js';
import type { ExternalIdentity, RedirectOAuth2Provider } from './types.js';

export interface Oauth2ProviderConfig {
  enabled: boolean;
  displayName: string;
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appUrl: string;
  redirectUri: string;
  scope: string;
  pkce: boolean;
  /**
   * Core `meta_users.auth_provider` 域标识（与 Provider `id` 分离）。
   * 默认 `iam`；未传时回落为 `iam`。
   */
  authProviderDomain?: string;
  jsonPaths: PanelOAuth2JsonPaths;
  /** 可注入，便于单测 mock。默认 `globalThis.fetch`。 */
  fetchImpl?: typeof fetch;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * 简易 dotted path（非完整 JSONPath）：`email` / `data.email`。
 * 空 path → undefined。
 */
export function readDottedPath(source: unknown, path: string): unknown {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  let current: unknown = source;
  for (const segment of trimmed.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asTrimmedString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeEmail(value: unknown): string | undefined {
  const text = asTrimmedString(value);
  return text ? text.toLowerCase() : undefined;
}

export class Oauth2Provider implements RedirectOAuth2Provider {
  readonly id = 'oauth2';
  readonly type = 'oauth2' as const;
  readonly kind = 'redirect-oauth2' as const;
  readonly displayName: string;
  readonly authProviderDomain: string;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: Oauth2ProviderConfig) {
    this.displayName = config.displayName || '公司IAM登录';
    this.authProviderDomain = config.authProviderDomain?.trim() || 'iam';
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    if (config.enabled) {
      if (!config.clientId || !config.clientSecret) {
        throw new Error('OAuth2 client_id and client_secret are required when oauth2 auth is enabled');
      }
      if (!config.authorizationUrl || !config.tokenUrl || !config.userinfoUrl) {
        throw new Error('OAuth2 authorization/token/userinfo URLs are required when oauth2 auth is enabled');
      }
    }
  }

  /**
   * AuthProvider 遗留表面；OAuth2 登录必须走 `prepareAuthorize`（需要 state / 可选 PKCE）。
   */
  buildLoginUrl(_callbackUrl: string): string {
    throw new Error('Oauth2Provider requires prepareAuthorize; do not call buildLoginUrl');
  }

  /** MVP：无 IdP 登出端点，本地清会话后回到 returnTo。 */
  buildLogoutUrl(returnTo: string): string {
    return returnTo || '/';
  }

  async prepareAuthorize(input: {
    state: string;
    redirectUri: string;
    nonce?: string;
  }): Promise<{ url: string; codeVerifier?: string }> {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
    });
    const scope = this.config.scope.trim();
    if (scope) params.set('scope', scope);

    let codeVerifier: string | undefined;
    if (this.config.pkce) {
      codeVerifier = base64Url(randomBytes(32));
      const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
    }

    const base = this.config.authorizationUrl;
    const url = `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
    return { url, codeVerifier };
  }

  async authenticateFromCallback(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    expectedNonce?: string;
  }): Promise<ExternalIdentity | null> {
    const accessToken = await this.exchangeCode(input);
    if (!accessToken) return null;
    const userinfo = await this.fetchUserinfo(accessToken);
    if (!userinfo || typeof userinfo !== 'object') return null;
    return this.mapUserinfo(userinfo as Record<string, unknown>);
  }

  private async exchangeCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    if (input.codeVerifier) {
      body.set('code_verifier', input.codeVerifier);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    const accessToken = asTrimmedString((payload as Record<string, unknown>).access_token);
    return accessToken ?? null;
  }

  private async fetchUserinfo(accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.userinfoUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private mapUserinfo(userinfo: Record<string, unknown>): ExternalIdentity | null {
    const paths = this.config.jsonPaths;
    const email = normalizeEmail(readDottedPath(userinfo, paths.email));
    if (!email) return null;

    // 认人键锁死为规范化 email（与 SUBJECT_JSONPATH 默认 email 对齐）。
    const subject = email;
    const loginRaw = asTrimmedString(readDottedPath(userinfo, paths.login));
    const loginName = loginRaw || email.split('@')[0] || email;
    const displayName =
      asTrimmedString(readDottedPath(userinfo, paths.name)) || loginName;

    return {
      providerId: this.id,
      subject,
      loginName,
      displayName,
      email,
      claims: userinfo,
    };
  }
}
