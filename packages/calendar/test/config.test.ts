import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('requires a user and credentials', () => {
    expect(() => loadConfig({})).toThrow(/Missing YANDEX_USER/);
    expect(() => loadConfig({ YANDEX_USER: 'a@x' })).toThrow(/YANDEX_CALENDAR_APP_PASSWORD.*YANDEX_OAUTH_CLIENT_ID/);
  });
  it('uses an app password by default', () => {
    const c = loadConfig({ YANDEX_USER: 'a@x', YANDEX_CALENDAR_APP_PASSWORD: 'p', YANDEX_CALENDAR_TIMEZONE: 'Europe/Moscow' });
    expect(c.auth).toEqual({ type: 'password', password: 'p' });
    expect(c.serverUrl).toBe('https://caldav.yandex.ru');
    expect(c.timezone).toBe('Europe/Moscow');
  });
  it('switches to OAuth when a client ID is set and shares the token file with Mail', () => {
    const env = { YANDEX_USER: 'a@x', YANDEX_OAUTH_CLIENT_ID: 'cid', XDG_CONFIG_HOME: '/cfg' };
    const c = loadConfig(env);
    expect(c.auth.type).toBe('oauth');
    if (c.auth.type !== 'oauth') return;
    expect(c.auth.oauth.loginCommand).toBe('npx yandex-calendar-mcp login');
    expect(c.auth.oauth.tokenFile).toMatch(/^\/cfg\/yandex-360-mcp\/oauth\/a@x-[0-9a-f]{12}\.json$/);
  });
  it('rejects an invalid time zone and auth mode', () => {
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_APP_PASSWORD: 'p', YANDEX_CALENDAR_TIMEZONE: 'Nowhere/City' })).toThrow(/TIMEZONE/);
    expect(() => loadConfig({ YANDEX_USER: 'a@x', YANDEX_AUTH: 'magic' })).toThrow(/YANDEX_AUTH/);
  });
});
