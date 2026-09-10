import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_BACKUP = { ...process.env };

function clearPanelAuthEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('PANEL_AUTH_')
      || key === 'METADATA_EXTERNAL_AUTH_PROVIDER'
    ) {
      delete process.env[key];
    }
  }
}

async function loadAuthConfig() {
  const mod = await import('../src/panel/config/panel-config.js');
  return mod.loadPanelConfig().auth;
}

describe('panel-config oauth2', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    process.env = { ...ENV_BACKUP };
    vi.resetModules();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('throws when oauth2 is enabled but required secrets are missing', async () => {
    clearPanelAuthEnv();
    process.env.PANEL_AUTH_MODE = 'user_key,oauth2';
    process.env.PANEL_AUTH_OAUTH2_CLIENT_ID = 'test-client-id';

    await expect(loadAuthConfig()).rejects.toThrow(/PANEL_AUTH_OAUTH2_CLIENT_SECRET/);
  });

  it('enables idp session without woa when oauth2 is fully configured', async () => {
    clearPanelAuthEnv();
    tempDir = mkdtempSync(join(tmpdir(), 'panel-auth-oauth2-'));
    process.env.PANEL_AUTH_MODE = 'user_key,oauth2';
    process.env.PANEL_AUTH_IDENTITY_STORE_PATH = join(tempDir, 'identities.json');
    process.env.PANEL_AUTH_SESSION_SECRET_FILE = join(tempDir, 'session-secret');
    process.env.PANEL_AUTH_OAUTH2_CLIENT_ID = 'test-client-id';
    process.env.PANEL_AUTH_OAUTH2_CLIENT_SECRET = 'test-client-secret';
    process.env.PANEL_AUTH_OAUTH2_AUTHORIZATION_URL = 'https://idp.example/authorize';
    process.env.PANEL_AUTH_OAUTH2_TOKEN_URL = 'https://idp.example/token';
    process.env.PANEL_AUTH_OAUTH2_USERINFO_URL = 'https://idp.example/userinfo';
    process.env.PANEL_AUTH_OAUTH2_APP_URL = 'http://hub.example:8125/';

    const auth = await loadAuthConfig();

    expect(auth.idpEnabled).toBe(true);
    expect(auth.oauth2.enabled).toBe(true);
    expect(auth.woa.enabled).toBe(false);
    expect(auth.sessionSecret).not.toBe('');
    expect(auth.oauth2.redirectUri).toBe('http://hub.example:8125/api/v1/auth/idp/oauth2/callback');
    expect(auth.sessionSecure).toBe(false);
  });

  it('ignores leftover oauth2 app url for sessionSecure when only woa is enabled', async () => {
    clearPanelAuthEnv();
    tempDir = mkdtempSync(join(tmpdir(), 'panel-auth-oauth2-'));
    process.env.PANEL_AUTH_MODE = 'user_key,woa';
    process.env.PANEL_AUTH_IDENTITY_STORE_PATH = join(tempDir, 'identities.json');
    process.env.PANEL_AUTH_SESSION_SECRET_FILE = join(tempDir, 'session-secret');
    process.env.PANEL_AUTH_WOA_APP_URL = 'https://hub.example';
    process.env.PANEL_AUTH_OAUTH2_APP_URL = 'http://leftover-oauth2.example';

    const auth = await loadAuthConfig();

    expect(auth.woa.enabled).toBe(true);
    expect(auth.oauth2.enabled).toBe(false);
    expect(auth.sessionSecure).toBe(true);
  });

  it('uses oauth2 app url for sessionSecure when woa is disabled', async () => {
    clearPanelAuthEnv();
    tempDir = mkdtempSync(join(tmpdir(), 'panel-auth-oauth2-'));
    process.env.PANEL_AUTH_MODE = 'user_key,oauth2';
    process.env.PANEL_AUTH_IDENTITY_STORE_PATH = join(tempDir, 'identities.json');
    process.env.PANEL_AUTH_SESSION_SECRET_FILE = join(tempDir, 'session-secret');
    process.env.PANEL_AUTH_OAUTH2_CLIENT_ID = 'test-client-id';
    process.env.PANEL_AUTH_OAUTH2_CLIENT_SECRET = 'test-client-secret';
    process.env.PANEL_AUTH_OAUTH2_AUTHORIZATION_URL = 'https://idp.example/authorize';
    process.env.PANEL_AUTH_OAUTH2_TOKEN_URL = 'https://idp.example/token';
    process.env.PANEL_AUTH_OAUTH2_USERINFO_URL = 'https://idp.example/userinfo';
    process.env.PANEL_AUTH_OAUTH2_APP_URL = 'https://hub.example';

    const auth = await loadAuthConfig();

    expect(auth.sessionSecure).toBe(true);
  });
});
