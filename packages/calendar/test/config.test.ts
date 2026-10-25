import { describe, expect, it } from 'vitest';
import { DEFAULT_CLIENT_ID } from 'yandex-360-oauth';
import { loadConfig, oauthProfileFromEnv } from '../src/config.js';

describe('loadConfig', () => {
  it('requires a user, and defaults to OAuth with the shared app', () => {
    expect(() => loadConfig({})).toThrow(/Missing YANDEX_USER/);
    const c = loadConfig({ YANDEX_USER: 'a@x' });
    expect(c.auth.type).toBe('oauth');
    if (c.auth.type !== 'oauth') return;
    expect(c.auth.oauth.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(c.auth.oauth.scope).toBe('calendar:events.read calendar:events.write');
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_AUTH: 'password' })).toThrow(/YANDEX_CALENDAR_APP_PASSWORD/);
  });
  it('uses an app password when one is set', () => {
    const c = loadConfig({ YANDEX_USER: 'a@x', YANDEX_CALENDAR_APP_PASSWORD: 'p', YANDEX_CALENDAR_TIMEZONE: 'Europe/Moscow' });
    expect(c.auth).toEqual({ type: 'password', password: 'p' });
    expect(c.serverUrl).toBe('https://caldav.yandex.ru');
    expect(c.timezone).toBe('Europe/Moscow');
  });
  it('uses your own OAuth app when a client ID is set, with a token file separate from Mail', () => {
    const env = { YANDEX_USER: 'a@x', YANDEX_OAUTH_CLIENT_ID: 'cid', XDG_CONFIG_HOME: '/cfg' };
    const c = loadConfig(env);
    expect(c.auth.type).toBe('oauth');
    if (c.auth.type !== 'oauth') return;
    expect(c.auth.oauth.loginCommand).toBe('npx yandex-calendar-mcp login');
    expect(c.auth.oauth.tokenFile).toMatch(/^\/cfg\/yandex-360-mcp\/oauth\/a@x-[0-9a-f]{12}-calendar\.json$/);
  });
  it('asks only to read events in read-only mode', () => {
    const c = loadConfig({ YANDEX_USER: 'a@x', YANDEX_CALENDAR_READ_ONLY: 'true' });
    expect(c.readOnly).toBe(true);
    if (c.auth.type !== 'oauth') throw new Error('expected OAuth');
    expect(c.auth.oauth.scope).toBe('calendar:events.read');
    expect(c.auth.oauth.implies?.['calendar:all']).toContain('calendar:events.write');
    expect(oauthProfileFromEnv({ YANDEX_CALENDAR_READ_ONLY: '1' }).permissions).toEqual(['Reading events in your calendars']);
  });
  it('rejects an invalid time zone and auth mode', () => {
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_APP_PASSWORD: 'p', YANDEX_CALENDAR_TIMEZONE: 'Nowhere/City' })).toThrow(/TIMEZONE/);
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_AUTH: 'magic' })).toThrow(/YANDEX_AUTH/);
  });
});
