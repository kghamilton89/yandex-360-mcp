import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthError,
  DEFAULT_CLIENT_ID,
  TokenProvider,
  completeLogin,
  createLoginRequest,
  defaultTokenFile,
  oauthSettingsFromEnv,
  readToken,
  runAuthCli,
  wantsOAuth,
  writeToken,
  type OAuthSettings,
  type ServiceProfile,
} from '../src/index.js';

let dir: string;
let settings: OAuthSettings;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'yoauth-'));
  settings = {
    user: 'me@example.com',
    clientId: 'client-123',
    oauthUrl: 'https://oauth.test',
    tokenFile: path.join(dir, 'oauth', 'token.json'),
    loginCommand: 'npx yandex-mail-mcp login',
  };
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
});

/** Fake token endpoint. `handler` gets the parsed form body. */
function fakeFetch(handler: (body: URLSearchParams) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>) {
  const calls: URLSearchParams[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe('https://oauth.test/token');
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    const r = await handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

const MAIL: ServiceProfile = {
  service: 'mail',
  scope: 'mail:imap_full mail:smtp',
  permissions: ['Mail over IMAP', 'Mail over SMTP'],
  loginCommand: 'npx yandex-mail-mcp login',
};

describe('settings', () => {
  it('defaults to OAuth unless an app password is configured', () => {
    expect(wantsOAuth({}, false)).toBe(true);
    expect(wantsOAuth({}, true)).toBe(false);
    expect(wantsOAuth({ YANDEX_OAUTH_CLIENT_ID: 'x' }, true)).toBe(true);
    expect(wantsOAuth({ YANDEX_OAUTH_TOKEN: 't' }, true)).toBe(true);
    expect(wantsOAuth({ YANDEX_AUTH: 'password' }, false)).toBe(false);
    expect(wantsOAuth({ YANDEX_AUTH: 'OAuth' }, true)).toBe(true);
    expect(() => wantsOAuth({ YANDEX_AUTH: 'kerberos' }, false)).toThrow(AuthError);
  });
  it('uses the shared app and the server\'s own scope by default', () => {
    const s = oauthSettingsFromEnv('me@example.com', MAIL, { XDG_CONFIG_HOME: '/cfg' });
    expect(s.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(s.scope).toBe('mail:imap_full mail:smtp');
    expect(s.loginCommand).toBe('npx yandex-mail-mcp login');
    expect(s.tokenFile).toMatch(/^\/cfg\/yandex-360-mcp\/oauth\/me@example\.com-[0-9a-f]{12}-mail\.json$/);
  });
  it('lets the environment override the app and scope', () => {
    const s = oauthSettingsFromEnv('me@example.com', MAIL, { YANDEX_OAUTH_CLIENT_ID: 'mine', YANDEX_OAUTH_SCOPE: 'mail:imap_ro' });
    expect(s.clientId).toBe('mine');
    expect(s.scope).toBe('mail:imap_ro');
  });
  it('keeps a separate token file per account, app and server', () => {
    const a = defaultTokenFile('Me@Example.com', 'app1', 'mail', { XDG_CONFIG_HOME: '/cfg' });
    expect(a).toMatch(/^\/cfg\/yandex-360-mcp\/oauth\/me@example\.com-[0-9a-f]{12}-mail\.json$/);
    expect(defaultTokenFile('me@example.com', 'app2', 'mail', { XDG_CONFIG_HOME: '/cfg' })).not.toBe(a);
    expect(defaultTokenFile('me@example.com', 'app1', 'calendar', { XDG_CONFIG_HOME: '/cfg' })).not.toBe(a);
  });
});

describe('login', () => {
  it('builds a PKCE S256 authorize URL', () => {
    const req = createLoginRequest({ ...settings, scope: 'mail:imap_full mail:smtp' });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe('https://oauth.test/authorize');
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('client-123');
    expect(q.get('redirect_uri')).toBe('https://oauth.yandex.com/verification_code');
    expect(q.get('login_hint')).toBe('me@example.com');
    expect(q.get('scope')).toBe('mail:imap_full mail:smtp');
    expect(q.get('code_challenge_method')).toBe('S256');
    const expected = createHash('sha256').update(req.verifier).digest('base64url');
    expect(q.get('code_challenge')).toBe(expected);
    expect(req.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('omits scope when not configured', () => {
    expect(new URL(createLoginRequest(settings).url).searchParams.has('scope')).toBe(false);
  });

  it('exchanges the code with the verifier and stores the token privately', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, token_type: 'bearer' } }));
    const token = await completeLogin(settings, ' 1234567 \n', 'verifier-abc', impl);
    expect(Object.fromEntries(calls[0]!)).toEqual({
      grant_type: 'authorization_code',
      code: '1234567',
      code_verifier: 'verifier-abc',
      client_id: 'client-123',
    });
    expect(token).toMatchObject({ access_token: 'AT1', refresh_token: 'RT1', user: 'me@example.com', client_id: 'client-123' });
    expect(token.expires_at! - Date.now()).toBeGreaterThan(3500_000);
    expect((await stat(settings.tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(settings.tokenFile))).mode & 0o777).toBe(0o700);
  });

  it('sends the client secret when configured', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { access_token: 'AT' } }));
    await completeLogin({ ...settings, clientSecret: 's3cret' }, '1234567', 'v', impl);
    expect(calls[0]!.get('client_secret')).toBe('s3cret');
  });

  it('surfaces Yandex errors', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Code has expired' } }));
    await expect(completeLogin(settings, '1234567', 'v', impl)).rejects.toThrow(/Code has expired/);
  });
});

describe('TokenProvider', () => {
  const store = (overrides: Partial<Parameters<typeof writeToken>[1]> = {}) =>
    writeToken(settings.tokenFile, {
      client_id: 'client-123',
      user: 'me@example.com',
      access_token: 'AT-old',
      refresh_token: 'RT-old',
      expires_at: Date.now() + 3600_000,
      updated_at: Date.now(),
      ...overrides,
    });

  it('returns a static token without touching disk', async () => {
    const p = new TokenProvider({ ...settings, staticToken: 'STATIC' });
    expect(await p.getAccessToken()).toBe('STATIC');
  });

  it('asks to log in when there is no token', async () => {
    await expect(new TokenProvider(settings).getAccessToken()).rejects.toThrow(/npx yandex-mail-mcp login/);
  });

  it('rejects a token for another account or app', async () => {
    await store({ client_id: 'other-app' });
    await expect(new TokenProvider(settings).getAccessToken()).rejects.toThrow(/different account or app/);
  });

  it('asks to log in again when the saved login lacks a scope the settings need', async () => {
    await store({ scope: 'calendar:events.read' });
    const p = (scope: string) => new TokenProvider({ ...settings, scope, implies: { 'calendar:all': ['calendar:events.read', 'calendar:events.write'] } });
    expect(await p('calendar:events.read').getAccessToken()).toBe('AT-old');
    await expect(p('calendar:events.read calendar:events.write').getAccessToken()).rejects.toThrow(
      /doesn't include calendar:events.write.*npx yandex-mail-mcp login/,
    );
    await store({ scope: 'calendar:all' });
    expect(await p('calendar:events.read calendar:events.write').getAccessToken()).toBe('AT-old');
    await store({ scope: undefined });
    expect(await p('anything').getAccessToken()).toBe('AT-old');
  });

  it('uses a valid stored token without refreshing', async () => {
    await store();
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    expect(await new TokenProvider(settings, impl).getAccessToken()).toBe('AT-old');
    expect(calls).toHaveLength(0);
  });

  it('without a client secret, uses the token until it expires and then asks to log in again', async () => {
    await store({ expires_at: Date.now() + 60_000 });
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    const p = new TokenProvider(settings, impl);
    expect(p.canRefresh).toBe(false);
    expect(await p.getAccessToken()).toBe('AT-old');
    await store({ expires_at: Date.parse('2027-10-23T12:00:00Z') - 400 * 86400_000 });
    await expect(p.getAccessToken()).rejects.toThrow(/expired on \d{4}-\d{2}-\d{2} \(logins last about a year\)\. Run `npx yandex-mail-mcp login`/);
    await expect(p.refresh()).rejects.toThrow(/can't be renewed automatically.*npx yandex-mail-mcp login/);
    expect(calls).toHaveLength(0);
  });

  it('refreshes near expiry and saves the rotated refresh token', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() + 60_000 });
    const { impl, calls } = fakeFetch((b) => {
      expect(b.get('grant_type')).toBe('refresh_token');
      expect(b.get('refresh_token')).toBe('RT-old');
      return { json: { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 7200 } };
    });
    expect(await new TokenProvider(settings, impl).getAccessToken()).toBe('AT-new');
    expect(calls).toHaveLength(1);
    expect(await readToken(settings.tokenFile)).toMatchObject({ access_token: 'AT-new', refresh_token: 'RT-new' });
  });

  it('keeps the old refresh token if none is returned', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() - 1 });
    const { impl } = fakeFetch(() => ({ json: { access_token: 'AT-new', expires_in: 7200 } }));
    await new TokenProvider(settings, impl).getAccessToken();
    expect((await readToken(settings.tokenFile))?.refresh_token).toBe('RT-old');
  });

  it('refreshes only once when several processes race', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() - 1 });
    let n = 0;
    const { impl, calls } = fakeFetch(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 100));
      return { json: { access_token: `AT-${n}`, refresh_token: `RT-${n}`, expires_in: 7200 } };
    });
    const providers = Array.from({ length: 5 }, () => new TokenProvider(settings, impl));
    const tokens = await Promise.all(providers.map((p) => p.getAccessToken()));
    expect(calls).toHaveLength(1);
    expect(new Set(tokens)).toEqual(new Set(['AT-1']));
  });

  it('explains how to recover from a failed refresh', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() - 1 });
    const { impl } = fakeFetch(() => ({ status: 400, json: { error: 'invalid_grant', error_description: 'Refresh token expired' } }));
    await expect(new TokenProvider(settings, impl).getAccessToken()).rejects.toThrow(/Refresh token expired.*npx yandex-mail-mcp login/);
  });

  it('requires login again when expired without a refresh token', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() - 1, refresh_token: undefined });
    await expect(new TokenProvider(settings).getAccessToken()).rejects.toThrow(/no refresh token/);
  });

  it('recovers from a stale lock', async () => {
    settings.clientSecret = 'secret';
    await store({ expires_at: Date.now() - 1 });
    const { mkdir, utimes } = await import('node:fs/promises');
    await mkdir(`${settings.tokenFile}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${settings.tokenFile}.lock`, old, old);
    const { impl } = fakeFetch(() => ({ json: { access_token: 'AT-new', expires_in: 7200 } }));
    expect(await new TokenProvider(settings, impl).getAccessToken()).toBe('AT-new');
  });
});

describe('runAuthCli', () => {
  const env = () => ({ XDG_CONFIG_HOME: dir, YANDEX_USER: 'me@example.com', YANDEX_OAUTH_CLIENT_ID: 'client-123', YANDEX_OAUTH_URL: 'https://oauth.test' });
  const opts = (extra: Partial<Parameters<typeof runAuthCli>[1]> = {}) => {
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => (text += c));
    return { output, text: () => text, base: { program: 'yandex-mail-mcp', userVars: ['YANDEX_MAIL_USER', 'YANDEX_USER'], profile: MAIL, env: env(), output, ...extra } };
  };

  it('logs in, reports status and logs out', async () => {
    const input = new PassThrough();
    const opened: string[] = [];
    const { impl, calls } = fakeFetch(() => ({ json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } }));
    const o = opts({ input, fetchImpl: impl, openUrl: (u) => opened.push(u) });
    const done = runAuthCli(['login'], o.base);
    input.end('7654321\n');
    expect(await done).toBe(0);
    expect(opened).toHaveLength(1);
    expect(o.text()).toContain(opened[0]!);
    expect(o.text()).toContain('Mail over IMAP');
    expect(o.text()).toContain('Using your own OAuth app (ClientID client-123)');
    expect(o.text()).toContain('Run this login again after that (Yandex logins last about a year)');
    expect(new URL(opened[0]!).searchParams.get('scope')).toBe('mail:imap_full mail:smtp');
    expect(o.text()).toMatch(/Logged in\. Token saved to .*yandex-360-mcp\/oauth\/me@example\.com-[0-9a-f]{12}-mail\.json/);
    expect(calls[0]!.get('code')).toBe('7654321');

    const s = opts();
    expect(await runAuthCli(['auth-status'], s.base)).toBe(0);
    expect(s.text()).toMatch(/Account:\s+me@example\.com/);
    expect(s.text()).toMatch(/Auto-renews:\s+no, run login again/);

    const l = opts();
    expect(await runAuthCli(['logout'], l.base)).toBe(0);
    expect(l.text()).toContain('Removed');
    const s2 = opts();
    expect(await runAuthCli(['auth-status'], s2.base)).toBe(1);
  });

  it('uses the shared app without extra setup text', async () => {
    const input = new PassThrough();
    const opened: string[] = [];
    const { impl } = fakeFetch(() => ({ json: { access_token: 'AT' } }));
    const { YANDEX_OAUTH_CLIENT_ID: _drop, ...shared } = env();
    const o = opts({ env: shared, input, fetchImpl: impl, openUrl: (u) => opened.push(u) });
    const done = runAuthCli(['login'], o.base);
    input.end('1234567\n');
    expect(await done).toBe(0);
    expect(new URL(opened[0]!).searchParams.get('client_id')).toBe(DEFAULT_CLIENT_ID);
    expect(o.text()).not.toContain('Using your own OAuth app');
  });

  it('fails clearly without a user', async () => {
    const o = opts({ env: { YANDEX_OAUTH_CLIENT_ID: 'x' } });
    expect(await runAuthCli(['login'], o.base)).toBe(1);
    expect(o.text()).toContain('Set YANDEX_USER');
  });

  it('can skip opening a browser', async () => {
    const input = new PassThrough();
    const opened: string[] = [];
    const { impl } = fakeFetch(() => ({ json: { access_token: 'AT' } }));
    const o = opts({ input, fetchImpl: impl, openUrl: (u) => opened.push(u) });
    const done = runAuthCli(['login', '--no-browser'], o.base);
    input.end('1234567\n');
    expect(await done).toBe(0);
    expect(opened).toHaveLength(0);
  });
});

describe('store', () => {
  it('rejects malformed token files', async () => {
    const f = path.join(dir, 'bad.json');
    await writeFile(f, '{"nope":true}');
    await expect(readToken(f)).rejects.toThrow(/Malformed/);
    expect(await readFile(f, 'utf8')).toContain('nope');
  });
});
