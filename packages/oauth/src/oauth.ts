import { createHash, randomBytes } from 'node:crypto';
import { AuthError, type OAuthSettings, missingScopes } from './settings.js';
import { type StoredToken, readToken, withFileLock, writeToken } from './store.js';

/** Page that shows the user a code to paste back; must be a registered Redirect URI of the app. */
export const VERIFICATION_CODE_REDIRECT = 'https://oauth.yandex.com/verification_code';

const REFRESH_MARGIN_MS = 5 * 60_000;

type Fetch = typeof fetch;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface LoginRequest {
  url: string;
  verifier: string;
  state: string;
}

export function createLoginRequest(settings: OAuthSettings, redirectUri = VERIFICATION_CODE_REDIRECT): LoginRequest {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(12));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    login_hint: settings.user,
    force_confirm: 'yes',
    state,
  });
  if (settings.scope) params.set('scope', settings.scope);
  return { url: `${settings.oauthUrl}/authorize?${params}`, verifier, state };
}

async function tokenRequest(settings: OAuthSettings, body: Record<string, string>, fetchImpl: Fetch): Promise<TokenResponse> {
  const params = new URLSearchParams({ ...body, client_id: settings.clientId });
  if (settings.clientSecret) params.set('client_secret', settings.clientSecret);
  let res: Response;
  try {
    res = await fetchImpl(`${settings.oauthUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params,
    });
  } catch (err) {
    throw new AuthError(`Could not reach ${settings.oauthUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    throw new AuthError(`Yandex OAuth token request failed: ${detail}`);
  }
  return data;
}

function toStored(settings: OAuthSettings, data: TokenResponse, previous?: StoredToken): StoredToken {
  const now = Date.now();
  return {
    client_id: settings.clientId,
    user: settings.user,
    access_token: data.access_token!,
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expires_at: data.expires_in ? now + data.expires_in * 1000 : undefined,
    scope: data.scope ?? previous?.scope,
    updated_at: now,
  };
}

/** Exchanges the code the user pasted for tokens and saves them. */
export async function completeLogin(
  settings: OAuthSettings,
  code: string,
  verifier: string,
  fetchImpl: Fetch = fetch,
): Promise<StoredToken> {
  const cleaned = code.trim();
  if (!cleaned) throw new AuthError('No code entered');
  const data = await tokenRequest(settings, { grant_type: 'authorization_code', code: cleaned, code_verifier: verifier }, fetchImpl);
  const token = toStored(settings, data);
  await writeToken(settings.tokenFile, token);
  return token;
}

const needsRefresh = (t: StoredToken, now = Date.now()) => t.expires_at !== undefined && now >= t.expires_at - REFRESH_MARGIN_MS;
const isExpired = (t: StoredToken, now = Date.now()) => t.expires_at !== undefined && now >= t.expires_at;

/**
 * Supplies a valid access token: the static token if configured, otherwise the stored token.
 *
 * Yandex only refreshes tokens for requests that carry the app's client secret, and the shared
 * app ships without one, so by default an expired login (tokens last about a year) asks the
 * user to log in again. With YANDEX_OAUTH_CLIENT_SECRET set, tokens are refreshed (under a
 * cross-process lock) shortly before they expire.
 */
export class TokenProvider {
  constructor(
    private readonly settings: OAuthSettings,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get user(): string {
    return this.settings.user;
  }

  /** Whether a rejected or expiring token can be renewed without the user logging in again. */
  get canRefresh(): boolean {
    return !this.settings.staticToken && Boolean(this.settings.clientSecret);
  }

  private loginHint(): string {
    const cmd = this.settings.loginCommand ?? 'the server\'s login command';
    return `Run \`${cmd}\` with the same environment variables.`;
  }

  private async load(): Promise<StoredToken> {
    const token = await readToken(this.settings.tokenFile);
    if (!token) throw new AuthError(`Not logged in to Yandex OAuth as ${this.settings.user}. ${this.loginHint()}`);
    if (token.client_id !== this.settings.clientId || token.user.toLowerCase() !== this.settings.user.toLowerCase()) {
      throw new AuthError(`Token file ${this.settings.tokenFile} belongs to a different account or app. ${this.loginHint()}`);
    }
    // Yandex reports the granted scope; older or hand-made token files may not have it.
    const missing = token.scope ? missingScopes(token.scope, this.settings.scope, this.settings.implies) : [];
    if (missing.length) {
      throw new AuthError(
        `The saved Yandex login doesn't include ${missing.join(', ')}, which this server's settings need ` +
          `(for example after turning read-only mode off). ${this.loginHint()}`,
      );
    }
    return token;
  }

  async getAccessToken(): Promise<string> {
    if (this.settings.staticToken) return this.settings.staticToken;
    const token = await this.load();
    if (this.canRefresh) return needsRefresh(token) ? this.refresh(false) : token.access_token;
    if (isExpired(token)) {
      throw new AuthError(
        `The Yandex login for ${this.settings.user} expired on ${new Date(token.expires_at!).toISOString().slice(0, 10)} ` +
          `(logins last about a year). ${this.loginHint()}`,
      );
    }
    return token.access_token;
  }

  /** Refreshes the token. With force=false, skips the request if another process already refreshed it. */
  async refresh(force = true): Promise<string> {
    if (this.settings.staticToken) throw new AuthError('YANDEX_OAUTH_TOKEN is a static token and cannot be refreshed');
    if (!this.settings.clientSecret) {
      throw new AuthError(`Yandex rejected the saved login and it can't be renewed automatically. ${this.loginHint()}`);
    }
    return withFileLock(this.settings.tokenFile, async () => {
      const current = await this.load();
      if (!force && !needsRefresh(current)) return current.access_token;
      if (!current.refresh_token) {
        throw new AuthError(`The OAuth token has expired and there is no refresh token. ${this.loginHint()}`);
      }
      let data: TokenResponse;
      try {
        data = await tokenRequest(this.settings, { grant_type: 'refresh_token', refresh_token: current.refresh_token }, this.fetchImpl);
      } catch (err) {
        if (err instanceof AuthError) throw new AuthError(`${err.message}. ${this.loginHint()}`);
        throw err;
      }
      const next = toStored(this.settings, data, current);
      await writeToken(this.settings.tokenFile, next);
      return next.access_token;
    });
  }
}
