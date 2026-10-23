export interface Endpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface MailConfig {
  user: string;
  password: string;
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

/**
 * Reads configuration from the environment. Mail-specific variables win over the
 * shared YANDEX_USER / YANDEX_APP_PASSWORD pair.
 */
export function loadConfig(env: Env = process.env): MailConfig {
  const user = env.YANDEX_MAIL_USER ?? env.YANDEX_USER;
  const password = env.YANDEX_MAIL_APP_PASSWORD ?? env.YANDEX_APP_PASSWORD;
  if (!user || !password) {
    throw new ConfigError(
      'Missing credentials. Set YANDEX_USER (your full Yandex 360 address) and YANDEX_MAIL_APP_PASSWORD ' +
        '(an app password of type "Mail" created at https://id.yandex.ru/security/app-passwords).',
    );
  }
  return {
    user,
    password,
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
