import { AuthError, type OAuthSettings, type ServiceProfile, oauthSettingsFromEnv } from 'yandex-360-oauth';

const LOGIN = 'npx yandex-disk-mcp login';

/** "full" sees the whole Disk; "app-folder" only sees Applications/<app name>. */
export type DiskAccess = 'full' | 'app-folder';

export interface DiskConfig {
  user: string;
  oauth: OAuthSettings;
  access: DiskAccess;
  readOnly: boolean;
  apiUrl: string;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

function parseAccess(value: string | undefined): DiskAccess {
  const v = value?.trim().toLowerCase();
  if (!v || v === 'full') return 'full';
  if (v === 'app-folder' || v === 'app_folder' || v === 'app') return 'app-folder';
  throw new ConfigError(`Invalid YANDEX_DISK_ACCESS: ${value} (use "full" or "app-folder")`);
}

/**
 * The permissions this server asks for. Disk info (space used and free) is always included.
 * Full access asks to read, plus write unless read-only; app-folder access is one scope that
 * covers reading and writing inside the app's own folder only.
 */
export function oauthProfile(access: DiskAccess, readOnly: boolean): ServiceProfile {
  const info = 'Seeing how much space your Disk has and uses';
  if (access === 'app-folder') {
    return {
      service: 'disk-app-folder',
      scope: 'cloud_api:disk.app_folder cloud_api:disk.info',
      permissions: ['Reading and writing files in its own folder on your Disk (Applications), and nothing else', info],
      loginCommand: LOGIN,
    };
  }
  return {
    service: 'disk',
    scope: readOnly ? 'cloud_api:disk.read cloud_api:disk.info' : 'cloud_api:disk.read cloud_api:disk.write cloud_api:disk.info',
    permissions: readOnly
      ? ['Reading all files on your Disk', info]
      : ['Reading all files on your Disk', 'Creating, changing, moving and deleting files on your Disk', info],
    loginCommand: LOGIN,
  };
}

/** Profile for the current environment, so `login` asks for what the configured mode needs. */
export function oauthProfileFromEnv(env: Env = process.env): ServiceProfile {
  return oauthProfile(parseAccess(env.YANDEX_DISK_ACCESS), flag(env.YANDEX_DISK_READ_ONLY));
}

/**
 * Reads configuration from the environment. Disk's REST API accepts only OAuth, so there is no
 * app-password mode. App-folder access keeps its own token, so switching modes needs no logout.
 */
export function loadConfig(env: Env = process.env): DiskConfig {
  const user = env.YANDEX_DISK_USER ?? env.YANDEX_USER;
  if (!user) throw new ConfigError('Missing YANDEX_USER: set it to your full Yandex address.');
  if (env.YANDEX_AUTH && !/^oauth$/i.test(env.YANDEX_AUTH.trim())) {
    throw new ConfigError('Yandex Disk only supports OAuth: run `npx yandex-disk-mcp login` instead of using an app password.');
  }
  const access = parseAccess(env.YANDEX_DISK_ACCESS);
  const readOnly = flag(env.YANDEX_DISK_READ_ONLY);
  let oauth: OAuthSettings;
  try {
    oauth = oauthSettingsFromEnv(user, oauthProfile(access, readOnly), env);
  } catch (err) {
    if (err instanceof AuthError) throw new ConfigError(err.message);
    throw err;
  }
  return {
    user,
    oauth,
    access,
    readOnly,
    apiUrl: (env.YANDEX_DISK_API_URL || 'https://cloud-api.yandex.net').replace(/\/+$/, ''),
  };
}

export const LOGIN_COMMAND = LOGIN;
