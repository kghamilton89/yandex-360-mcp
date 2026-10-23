import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export type Env = Record<string, string | undefined>;

/**
 * ClientID of the shared "Yandex 360 MCP" OAuth app. A ClientID is public: with PKCE there is
 * no client secret, and tokens go straight from Yandex to the user's machine.
 */
export const DEFAULT_CLIENT_ID = '41664599d8d042f587ea2723aa3c2768';

/** What one server asks for. Each server requests only its own permissions and keeps its own token. */
export interface ServiceProfile {
  /** Short name used in the token file name, e.g. "mail". */
  service: string;
  /** Space-separated scopes this server requests, e.g. "mail:imap_full mail:smtp". */
  scope: string;
  /** Human-readable permissions, shown before login. */
  permissions: string[];
  /** Shown in errors that require logging in again, e.g. "npx yandex-mail-mcp login". */
  loginCommand: string;
}

export interface OAuthSettings {
  user: string;
  clientId: string;
  clientSecret?: string;
  /** A pre-issued access token. Used as-is, never refreshed. */
  staticToken?: string;
  /** Space-separated scopes to request. */
  scope?: string;
  oauthUrl: string;
  tokenFile: string;
  loginCommand?: string;
}

export class AuthError extends Error {}

export function configDir(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'yandex-360-mcp');
}

/** Token files are keyed by account, app and server, so each server holds only its own permissions. */
export function defaultTokenFile(user: string, clientId: string, service: string, env: Env = process.env): string {
  const safeUser = user.toLowerCase().replace(/[^a-z0-9._@-]/g, '_');
  const app = createHash('sha256').update(clientId).digest('hex').slice(0, 12);
  const safeService = service.toLowerCase().replace(/[^a-z0-9-]/g, '_');
  return path.join(configDir(env), 'oauth', `${safeUser}-${app}-${safeService}.json`);
}

/**
 * Chooses OAuth or an app password. YANDEX_AUTH decides when set. Otherwise OAuth is used
 * unless an app password is configured (and no OAuth client ID or token is), so OAuth with the
 * shared app is the default.
 */
export function wantsOAuth(env: Env, hasPassword: boolean): boolean {
  const mode = env.YANDEX_AUTH?.trim().toLowerCase();
  if (mode === 'oauth') return true;
  if (mode === 'password' || mode === 'app-password') return false;
  if (mode) throw new AuthError(`Invalid YANDEX_AUTH: ${env.YANDEX_AUTH} (use "oauth" or "password")`);
  if (env.YANDEX_OAUTH_CLIENT_ID || env.YANDEX_OAUTH_TOKEN) return true;
  return !hasPassword;
}

export function oauthSettingsFromEnv(user: string, profile: ServiceProfile, env: Env = process.env): OAuthSettings {
  const clientId = env.YANDEX_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID;
  return {
    user,
    clientId,
    clientSecret: env.YANDEX_OAUTH_CLIENT_SECRET || undefined,
    staticToken: env.YANDEX_OAUTH_TOKEN || undefined,
    scope: env.YANDEX_OAUTH_SCOPE || profile.scope,
    oauthUrl: (env.YANDEX_OAUTH_URL || 'https://oauth.yandex.com').replace(/\/+$/, ''),
    tokenFile: env.YANDEX_OAUTH_TOKEN_FILE || defaultTokenFile(user, clientId, profile.service, env),
    loginCommand: profile.loginCommand,
  };
}
