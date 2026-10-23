import { AuthError, type OAuthSettings, type ServiceProfile, oauthSettingsFromEnv, wantsOAuth } from 'yandex-360-oauth';
import { isValidTimeZone, systemTimeZone } from './time.js';

export type CalendarAuth = { type: 'password'; password: string } | { type: 'oauth'; oauth: OAuthSettings };

export const OAUTH_PROFILE: ServiceProfile = {
  service: 'calendar',
  scope: 'calendar:all',
  permissions: ['Reading and changing your calendars and to-do lists (CalDAV)'],
  loginCommand: 'npx yandex-calendar-mcp login',
};

export const LOGIN_COMMAND = OAUTH_PROFILE.loginCommand;

export interface CalendarConfig {
  user: string;
  auth: CalendarAuth;
  serverUrl: string;
  timezone: string;
  defaultCalendar?: string;
  readOnly: boolean;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function resolveAuth(user: string, env: Env): CalendarAuth {
  const password = env.YANDEX_CALENDAR_APP_PASSWORD ?? env.YANDEX_APP_PASSWORD;
  try {
    if (wantsOAuth(env, Boolean(password))) return { type: 'oauth', oauth: oauthSettingsFromEnv(user, OAUTH_PROFILE, env) };
  } catch (err) {
    if (err instanceof AuthError) throw new ConfigError(err.message);
    throw err;
  }
  if (!password) {
    throw new ConfigError(
      'YANDEX_AUTH=password needs YANDEX_CALENDAR_APP_PASSWORD (an app password of type "Calendar" created at ' +
        'https://id.yandex.ru/security/app-passwords).',
    );
  }
  return { type: 'password', password };
}

/**
 * Reads configuration from the environment. Calendar-specific variables win over the
 * shared YANDEX_USER / YANDEX_APP_PASSWORD pair. OAuth with the shared app is the default;
 * setting an app password (without OAuth variables) switches to it.
 */
export function loadConfig(env: Env = process.env): CalendarConfig {
  const user = env.YANDEX_CALENDAR_USER ?? env.YANDEX_USER;
  if (!user) throw new ConfigError('Missing YANDEX_USER: set it to your full Yandex 360 address.');
  const auth = resolveAuth(user, env);
  const timezone = env.YANDEX_CALENDAR_TIMEZONE || systemTimeZone();
  if (!isValidTimeZone(timezone)) throw new ConfigError(`Invalid YANDEX_CALENDAR_TIMEZONE: ${timezone}`);
  return {
    user,
    auth,
    serverUrl: env.YANDEX_CALDAV_URL || 'https://caldav.yandex.ru',
    timezone,
    defaultCalendar: env.YANDEX_CALENDAR_DEFAULT || undefined,
    readOnly: flag(env.YANDEX_CALENDAR_READ_ONLY),
  };
}
