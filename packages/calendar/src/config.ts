import { isValidTimeZone, systemTimeZone } from './time.js';

export interface CalendarConfig {
  user: string;
  password: string;
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

/**
 * Reads configuration from the environment. Calendar-specific variables win over the
 * shared YANDEX_USER / YANDEX_APP_PASSWORD pair.
 */
export function loadConfig(env: Env = process.env): CalendarConfig {
  const user = env.YANDEX_CALENDAR_USER ?? env.YANDEX_USER;
  const password = env.YANDEX_CALENDAR_APP_PASSWORD ?? env.YANDEX_APP_PASSWORD;
  if (!user || !password) {
    throw new ConfigError(
      'Missing credentials. Set YANDEX_USER (your full Yandex 360 address) and YANDEX_CALENDAR_APP_PASSWORD ' +
        '(an app password of type "Calendar" created at https://id.yandex.ru/security/app-passwords).',
    );
  }
  const timezone = env.YANDEX_CALENDAR_TIMEZONE || systemTimeZone();
  if (!isValidTimeZone(timezone)) throw new ConfigError(`Invalid YANDEX_CALENDAR_TIMEZONE: ${timezone}`);
  return {
    user,
    password,
    serverUrl: env.YANDEX_CALDAV_URL || 'https://caldav.yandex.ru',
    timezone,
    defaultCalendar: env.YANDEX_CALENDAR_DEFAULT || undefined,
    readOnly: flag(env.YANDEX_CALENDAR_READ_ONLY),
  };
}
