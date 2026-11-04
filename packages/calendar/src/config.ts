import { AuthError, type OAuthSettings, type ServiceProfile, oauthSettingsFromEnv, wantsOAuth } from 'yandex-360-oauth';
import { isValidTimeZone, systemTimeZone } from './time.js';

export type CalendarAuth = { type: 'password'; password: string } | { type: 'oauth'; oauth: OAuthSettings };

const LOGIN = 'npx yandex-calendar-mcp login';

/** Logins made before the scopes were narrowed asked for calendar:all, which covers both. */
const IMPLIES = { 'calendar:all': ['calendar:events.read', 'calendar:events.write'] };

/** The permissions this server asks for: events only, and read-only access in read-only mode. */
export function oauthProfile(readOnly: boolean): ServiceProfile {
  return {
    service: 'calendar',
    scope: readOnly ? 'calendar:events.read' : 'calendar:events.read calendar:events.write',
    permissions: readOnly
      ? ['Reading events in your calendars']
      : ['Reading events in your calendars', 'Creating, editing and deleting events'],
    loginCommand: LOGIN,
    implies: IMPLIES,
  };
}

/** Profile for the current environment, so `login` asks for what the configured mode needs. */
export function oauthProfileFromEnv(env: Env = process.env): ServiceProfile {
  return oauthProfile(flag(env.YANDEX_CALENDAR_READ_ONLY));
}

export const LOGIN_COMMAND = LOGIN;

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

function resolveAuth(user: string, env: Env, readOnly: boolean): CalendarAuth {
  const password = env.YANDEX_CALENDAR_APP_PASSWORD ?? env.YANDEX_APP_PASSWORD;
  try {
    if (wantsOAuth(env, Boolean(password))) return { type: 'oauth', oauth: oauthSettingsFromEnv(user, oauthProfile(readOnly), env) };
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
  const readOnly = flag(env.YANDEX_CALENDAR_READ_ONLY);
  const auth = resolveAuth(user, env, readOnly);
  const timezone = env.YANDEX_CALENDAR_TIMEZONE || systemTimeZone();
  if (!isValidTimeZone(timezone)) throw new ConfigError(`Invalid YANDEX_CALENDAR_TIMEZONE: ${timezone}`);
  return {
    user,
    auth,
    serverUrl: env.YANDEX_CALDAV_URL || 'https://caldav.yandex.ru',
    timezone,
    defaultCalendar: env.YANDEX_CALENDAR_DEFAULT || undefined,
    readOnly,
  };
}
