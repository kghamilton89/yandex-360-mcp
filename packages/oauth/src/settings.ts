import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export type Env = Record<string, string | undefined>;

export interface OAuthSettings {
  user: string;
  clientId?: string;
  clientSecret?: string;
  /** A pre-issued access token. Used as-is, never refreshed. */
  staticToken?: string;
  /** Space-separated scopes. Omitted from the request when unset, which grants the app's configured permissions. */
  scope?: string;
  oauthUrl: string;
  tokenFile: string;
  /** Shown in errors that require logging in again, e.g. "npx yandex-mail-mcp login". */
  loginCommand?: string;
}

export class AuthError extends Error {}

export function configDir(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'yandex-360-mcp');
}

/** Token files are keyed by account and app, so Mail and Calendar share one login per app. */
export function defaultTokenFile(user: string, clientId: string | undefined, env: Env = process.env): string {
  const safeUser = user.toLowerCase().replace(/[^a-z0-9._@-]/g, '_');
  const app = clientId ? createHash('sha256').update(clientId).digest('hex').slice(0, 12) : 'static';
  return path.join(configDir(env), 'oauth', `${safeUser}-${app}.json`);
}

/**
 * True when the environment selects OAuth: YANDEX_AUTH=oauth, or (with YANDEX_AUTH unset)
 * a client ID or static token is present.
 */
export function wantsOAuth(env: Env): boolean {
  const mode = env.YANDEX_AUTH?.trim().toLowerCase();
  if (mode === 'oauth') return true;
  if (mode === 'password' || mode === 'app-password') return false;
  if (mode) throw new AuthError(`Invalid YANDEX_AUTH: ${env.YANDEX_AUTH} (use "oauth" or "password")`);
  return Boolean(env.YANDEX_OAUTH_CLIENT_ID || env.YANDEX_OAUTH_TOKEN);
}

export function oauthSettingsFromEnv(user: string, env: Env = process.env, loginCommand?: string): OAuthSettings {
  const clientId = env.YANDEX_OAUTH_CLIENT_ID || undefined;
  const staticToken = env.YANDEX_OAUTH_TOKEN || undefined;
  if (!clientId && !staticToken) {
    throw new AuthError(
      'OAuth is selected but neither YANDEX_OAUTH_CLIENT_ID nor YANDEX_OAUTH_TOKEN is set. ' +
        'Register an app at https://oauth.yandex.com/client/new and set its ClientID.',
    );
  }
  return {
    user,
    clientId,
    clientSecret: env.YANDEX_OAUTH_CLIENT_SECRET || undefined,
    staticToken,
    scope: env.YANDEX_OAUTH_SCOPE || undefined,
    oauthUrl: (env.YANDEX_OAUTH_URL || 'https://oauth.yandex.com').replace(/\/+$/, ''),
    tokenFile: env.YANDEX_OAUTH_TOKEN_FILE || defaultTokenFile(user, clientId, env),
    loginCommand,
  };
}
