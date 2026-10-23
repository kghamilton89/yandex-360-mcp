import { AuthError, type OAuthSettings, oauthSettingsFromEnv, wantsOAuth } from 'yandex-360-oauth';

export interface Endpoint {
  host: string;
  port: number;
  secure: boolean;
}

export type MailAuth = { type: 'password'; password: string } | { type: 'oauth'; oauth: OAuthSettings };

export const LOGIN_COMMAND = 'npx yandex-mail-mcp login';

export interface MailConfig {
  user: string;
  auth: MailAuth;
  fromName?: string;
  imap: Endpoint;
  smtp: Endpoint;
  readOnly: boolean;
  saveSent: boolean;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function port(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new ConfigError(`Invalid port: ${value}`);
  return n;
}

function resolveAuth(user: string, env: Env): MailAuth {
  try {
    if (wantsOAuth(env)) return { type: 'oauth', oauth: oauthSettingsFromEnv(user, env, LOGIN_COMMAND) };
  } catch (err) {
    if (err instanceof AuthError) throw new ConfigError(err.message);
    throw err;
  }
  const password = env.YANDEX_MAIL_APP_PASSWORD ?? env.YANDEX_APP_PASSWORD;
  if (!password) {
    throw new ConfigError(
      'Missing credentials. Set YANDEX_MAIL_APP_PASSWORD (an app password of type "Mail" created at ' +
        'https://id.yandex.ru/security/app-passwords), or set YANDEX_OAUTH_CLIENT_ID to use OAuth.',
    );
  }
  return { type: 'password', password };
}

/**
 * Reads configuration from the environment. Mail-specific variables win over the
 * shared YANDEX_USER / YANDEX_APP_PASSWORD pair. OAuth is used when YANDEX_OAUTH_CLIENT_ID
 * or YANDEX_OAUTH_TOKEN is set (or YANDEX_AUTH=oauth).
 */
export function loadConfig(env: Env = process.env): MailConfig {
  const user = env.YANDEX_MAIL_USER ?? env.YANDEX_USER;
  if (!user) throw new ConfigError('Missing YANDEX_USER: set it to your full Yandex 360 address.');
  return {
    user,
    auth: resolveAuth(user, env),
    fromName: env.YANDEX_MAIL_FROM_NAME || undefined,
    imap: {
      host: env.YANDEX_IMAP_HOST || 'imap.yandex.com',
      port: port(env.YANDEX_IMAP_PORT, 993),
      secure: true,
    },
    smtp: {
      host: env.YANDEX_SMTP_HOST || 'smtp.yandex.com',
      port: port(env.YANDEX_SMTP_PORT, 465),
      // Implicit TLS on 465, STARTTLS otherwise (e.g. 587), unless overridden.
      secure: env.YANDEX_SMTP_SECURE
        ? flag(env.YANDEX_SMTP_SECURE)
        : env.YANDEX_SMTP_PORT
          ? Number(env.YANDEX_SMTP_PORT) === 465
          : true,
    },
    readOnly: flag(env.YANDEX_MAIL_READ_ONLY),
    saveSent: flag(env.YANDEX_MAIL_SAVE_SENT),
  };
}
