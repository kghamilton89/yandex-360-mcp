import { type DAVCalendar, type DAVCalendarObject, createDAVClient } from 'tsdav';
import { TokenProvider } from 'yandex-360-oauth';
import { type CalendarConfig, LOGIN_COMMAND } from './config.js';
import {
  type EventInput,
  type EventInstance,
  type EventPatch,
  buildEvent,
  expandEvents,
  patchEvent,
  summarizeObject,
} from './ical.js';
import { addDays, formatInZone, parseInputTime, startOfDate, wallTimeIn, formatDate } from './time.js';

type Client = Awaited<ReturnType<typeof createDAVClient>>;

export interface ListEventsInput {
  calendar?: string;
  start?: string;
  end?: string;
  query?: string;
  limit: number;
}

export type ListedEvent = EventInstance & { calendar: string; url: string; etag?: string };

const CACHE_MS = 60_000;

function calendarName(c: DAVCalendar): string {
  if (typeof c.displayName === 'string' && c.displayName) return c.displayName;
  return decodeURIComponent(new URL(c.url).pathname.split('/').filter(Boolean).pop() ?? c.url);
}

function supportsEvents(c: DAVCalendar): boolean {
  return !c.components || c.components.length === 0 || c.components.includes('VEVENT');
}

function pathOf(url: string, base: string): string {
  return new URL(url, base).pathname.replace(/\/+$/, '');
}

async function check(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  if (res.status === 412) throw new Error(`${action} failed: the event was changed by someone else (ETag mismatch). Fetch it again and retry.`);
  if (res.status === 401 || res.status === 403) throw new Error(`${action} failed: not authorized (HTTP ${res.status}). Check the Calendar credentials.`);
  const body = await res.text().catch(() => '');
  throw new Error(`${action} failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`);
}

const isAuthError = (msg: string) => /\b(401|403)\b|unauthori|forbidden/i.test(msg);

export class CalendarService {
  /** The DAV client is tied to the token it was created with, since tsdav resolves auth headers once. */
  private client?: { token?: string; promise: Promise<Client> };
  private cache?: { at: number; calendars: DAVCalendar[] };
  private readonly tokens?: TokenProvider;

  constructor(private readonly cfg: CalendarConfig) {
    if (cfg.auth.type === 'oauth') this.tokens = new TokenProvider(cfg.auth.oauth);
  }

  private createClient(token: string | undefined): Promise<Client> {
    const base = { serverUrl: this.cfg.serverUrl, defaultAccountType: 'caldav' as const };
    if (token) {
      return createDAVClient({
        ...base,
        credentials: { username: this.cfg.user },
        authMethod: 'Custom',
        authFunction: async () => ({ Authorization: `OAuth ${token}` }),
      });
    }
    const password = this.cfg.auth.type === 'password' ? this.cfg.auth.password : '';
    return createDAVClient({ ...base, credentials: { username: this.cfg.user, password }, authMethod: 'Basic' });
  }

  private authFailedMessage(): string {
    return this.cfg.auth.type === 'oauth'
      ? `OAuth authentication failed. The token may be revoked or the app may lack Calendar (CalDAV) permission. Run \`${LOGIN_COMMAND}\` again.`
      : 'Authentication failed. Check YANDEX_USER and that YANDEX_CALENDAR_APP_PASSWORD is a "Calendar" app password.';
  }

  private describeConnectError(err: unknown): Error {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(isAuthError(msg) ? this.authFailedMessage() : `Could not connect to ${this.cfg.serverUrl}: ${msg}`);
  }

  private async connect(token: string | undefined): Promise<Client> {
    try {
      return await this.createClient(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const canRefresh = Boolean(this.tokens?.canRefresh);
      if (!isAuthError(msg) || !canRefresh) throw this.describeConnectError(err);
      // A token can be revoked before it expires: refresh once and retry.
      const fresh = await this.tokens!.refresh(true);
      try {
        const client = await this.createClient(fresh);
        this.client = { token: fresh, promise: Promise.resolve(client) };
        return client;
      } catch (retryErr) {
        throw this.describeConnectError(retryErr);
      }
    }
  }

  private async getClient(): Promise<Client> {
    const token = this.tokens ? await this.tokens.getAccessToken() : undefined;
    if (this.client && this.client.token === token) return this.client.promise;
    const holder = { token, promise: this.connect(token) };
    this.client = holder;
    holder.promise.catch(() => {
      if (this.client === holder) this.client = undefined;
    });
    return holder.promise;
  }

  private async calendars(refresh = false): Promise<DAVCalendar[]> {
    if (!refresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.calendars;
    const client = await this.getClient();
    const calendars = (await client.fetchCalendars()).filter(supportsEvents);
    this.cache = { at: Date.now(), calendars };
    return calendars;
  }

  private async resolveCalendar(ref: string | undefined): Promise<DAVCalendar> {
    const calendars = await this.calendars();
    const wanted = ref ?? this.cfg.defaultCalendar;
    if (!wanted) {
      const first = calendars[0];
      if (!first) throw new Error('No calendars found for this account');
      return first;
    }
    const byUrl = calendars.find((c) => c.url === wanted || pathOf(c.url, this.cfg.serverUrl) === pathOf(wanted, this.cfg.serverUrl));
    const byName = calendars.find((c) => calendarName(c).toLowerCase() === wanted.toLowerCase());
    const found = byUrl ?? byName;
    if (!found) throw new Error(`Calendar "${wanted}" not found. Available: ${calendars.map(calendarName).join(', ')}`);
    return found;
  }

  private async calendarForObject(url: string): Promise<DAVCalendar> {
    const target = pathOf(url, this.cfg.serverUrl);
    const match = (await this.calendars()).find((c) => target.startsWith(`${pathOf(c.url, this.cfg.serverUrl)}/`));
    if (!match) throw new Error(`No calendar contains event URL ${url}`);
    return match;
  }

  private async fetchObject(url: string): Promise<{ calendar: DAVCalendar; object: DAVCalendarObject }> {
    const calendar = await this.calendarForObject(url);
    const client = await this.getClient();
    const absolute = new URL(url, this.cfg.serverUrl).href;
    const objects = await client.fetchCalendarObjects({ calendar, objectUrls: [absolute] }).catch((err: unknown) => {
      if (err instanceof Error && /\b404\b/.test(err.message)) return [];
      throw err;
    });
    const object = objects.find((o) => pathOf(o.url, this.cfg.serverUrl) === pathOf(absolute, this.cfg.serverUrl) && o.data);
    if (!object) throw new Error(`Event not found: ${url}`);
    return { calendar, object };
  }

  async listCalendars() {
    const calendars = await this.calendars(true);
    const fallback = calendars[0]?.url;
    return calendars.map((c) => ({
      name: calendarName(c),
      url: c.url,
      description: c.description || undefined,
      color: c.calendarColor || undefined,
      default: this.cfg.defaultCalendar
        ? calendarName(c).toLowerCase() === this.cfg.defaultCalendar.toLowerCase() || c.url === this.cfg.defaultCalendar
        : c.url === fallback,
    }));
  }

  private defaultRange(start?: string, end?: string): { from: Date; to: Date } {
    const tz = this.cfg.timezone;
    const toInstant = (v: string, isEnd: boolean) => {
      const t = parseInputTime(v, tz);
      // A bare end date includes that whole day.
      return t.kind === 'date' ? startOfDate(isEnd ? addDays(t.date, 1) : t.date, tz) : t.instant;
    };
    const today = formatDate(wallTimeIn(new Date(), tz));
    const from = start ? toInstant(start, false) : startOfDate(today, tz);
    const to = end ? toInstant(end, true) : new Date(from.getTime() + 7 * 86400_000);
    if (to <= from) throw new Error('end must be after start');
    return { from, to };
  }

  async listEvents(input: ListEventsInput) {
    const { from, to } = this.defaultRange(input.start, input.end);
    const client = await this.getClient();
    const calendars = input.calendar ? [await this.resolveCalendar(input.calendar)] : await this.calendars();
    const tz = this.cfg.timezone;
    const events: (ListedEvent & { sortKey: number })[] = [];
    const errors: string[] = [];

    await Promise.all(
      calendars.map(async (calendar) => {
        try {
          const objects = await client.fetchCalendarObjects({
            calendar,
            timeRange: { start: from.toISOString(), end: to.toISOString() },
          });
          for (const o of objects) {
            if (!o.data) continue;
            try {
              for (const ev of expandEvents(o.data, from, to, tz)) {
                const sortKey = ev.allDay ? startOfDate(ev.start, tz).getTime() : new Date(ev.start).getTime();
                events.push({ ...ev, calendar: calendarName(calendar), url: o.url, etag: o.etag, sortKey });
              }
            } catch (err) {
              errors.push(`${o.url}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          errors.push(`${calendarName(calendar)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    const q = input.query?.toLowerCase();
    const filtered = q
      ? events.filter((e) => [e.summary, e.description, e.location].some((f) => f?.toLowerCase().includes(q)))
      : events;
    filtered.sort((a, b) => a.sortKey - b.sortKey || a.summary.localeCompare(b.summary));
    const page = filtered.slice(0, input.limit).map(({ sortKey: _sortKey, ...e }) => e);
    return {
      timezone: tz,
      range: { start: formatInZone(from, tz), end: formatInZone(to, tz) },
      total: filtered.length,
      count: page.length,
      events: page,
      ...(errors.length ? { errors } : {}),
    };
  }

  async getEvent(url: string, includeRaw: boolean) {
    const { calendar, object } = await this.fetchObject(url);
    return {
      calendar: calendarName(calendar),
      url: object.url,
      etag: object.etag,
      ...summarizeObject(object.data, this.cfg.timezone),
      ...(includeRaw ? { ics: object.data as string } : {}),
    };
  }

  async createEvent(input: EventInput, calendarRef?: string) {
    const calendar = await this.resolveCalendar(calendarRef);
    const { uid, ics } = buildEvent(input, this.cfg.timezone, this.cfg.user);
    const client = await this.getClient();
    const filename = `${uid}.ics`;
    const res = await client.createCalendarObject({ calendar, filename, iCalString: ics });
    await check(res, 'Create event');
    const url = new URL(filename, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href;
    return {
      calendar: calendarName(calendar),
      url,
      etag: res.headers.get('etag') ?? undefined,
      ...summarizeObject(ics, this.cfg.timezone),
    };
  }

  async updateEvent(url: string, patch: EventPatch, etag?: string) {
    const { calendar, object } = await this.fetchObject(url);
    const data = patchEvent(object.data, patch, this.cfg.timezone);
    const client = await this.getClient();
    const res = await client.updateCalendarObject({ calendarObject: { url: object.url, data, etag: etag ?? object.etag } });
    await check(res, 'Update event');
    return {
      calendar: calendarName(calendar),
      url: object.url,
      etag: res.headers.get('etag') ?? undefined,
      ...summarizeObject(data, this.cfg.timezone),
    };
  }

  async deleteEvent(url: string, etag?: string) {
    const { object } = await this.fetchObject(url);
    const client = await this.getClient();
    const res = await client.deleteCalendarObject({ calendarObject: { url: object.url, etag: etag ?? object.etag } });
    await check(res, 'Delete event');
    return { deleted: true, url: object.url };
  }
}
