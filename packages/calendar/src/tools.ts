import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CalendarService } from './calendar.js';
import { ConfigError, loadConfig } from './config.js';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
}

const TIME_HELP =
  'Use "YYYY-MM-DD" for all-day events, "YYYY-MM-DDTHH:MM" for a local time in the event time zone, ' +
  'or a full ISO 8601 timestamp with offset.';

const calendarRef = z.string().optional().describe('Calendar name or URL from list_calendars. Defaults to the default calendar');
const eventUrl = z.string().describe('Event URL from list_events or get_event');
const etag = z.string().optional().describe('ETag from list_events/get_event; the change fails if the event was modified since');

export function registerCalendarTools(server: McpServer, env: Record<string, string | undefined> = process.env) {
  // Config is resolved lazily so the server still starts (and reports a clear error) without credentials.
  let service: CalendarService | undefined;
  const run = async (fn: (s: CalendarService) => Promise<unknown>) => {
    try {
      service ??= new CalendarService(loadConfig(env));
      return ok(await fn(service));
    } catch (err) {
      return fail(err);
    }
  };

  let readOnly = false;
  try {
    readOnly = loadConfig(env).readOnly;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  server.registerTool(
    'list_calendars',
    {
      title: 'List calendars',
      description: 'List the event calendars in the Yandex 360 account.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run((s) => s.listCalendars()),
  );

  server.registerTool(
    'list_events',
    {
      title: 'List events',
      description:
        'List event occurrences in a time range across all calendars (or one), sorted by start. Recurring events are ' +
        'expanded into individual occurrences. Defaults to the next 7 days from the start of today. ' +
        'All-day events use inclusive YYYY-MM-DD start/end dates; timed events are shown in the configured time zone.',
      inputSchema: {
        calendar: calendarRef.describe('Only this calendar (name or URL). Defaults to all calendars'),
        start: z.string().optional().describe(`Range start. ${TIME_HELP}`),
        end: z.string().optional().describe('Range end (a bare date includes that whole day)'),
        query: z.string().optional().describe('Only events whose title, description or location contains this text'),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => run((s) => s.listEvents(args)),
  );

  server.registerTool(
    'get_event',
    {
      title: 'Get event',
      description: 'Fetch one event (series-level for recurring events) with attendees, recurrence rule and ETag.',
      inputSchema: { url: eventUrl, include_raw: z.boolean().default(false).describe('Also return the raw iCalendar data') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ url, include_raw }) => run((s) => s.getEvent(url, include_raw)),
  );

  if (readOnly) return;

  const timezone = z.string().optional().describe('IANA time zone, e.g. "Europe/Moscow". Defaults to the configured zone');

  server.registerTool(
    'create_event',
    {
      title: 'Create event',
      description:
        `Create an event. ${TIME_HELP} An all-day end date is inclusive. Without an end, timed events last 1 hour ` +
        'and all-day events 1 day. Adding attendees may make Yandex email them invitations.',
      inputSchema: {
        calendar: calendarRef,
        summary: z.string().min(1).describe('Title'),
        start: z.string(),
        end: z.string().optional(),
        timezone,
        location: z.string().optional(),
        description: z.string().optional(),
        attendees: z.array(z.string().email()).optional().describe('Attendee email addresses'),
        rrule: z.string().optional().describe('RFC 5545 recurrence rule, e.g. "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"'),
        reminder_minutes: z.number().int().min(0).max(40320).optional().describe('Popup reminder this many minutes before'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ calendar, reminder_minutes, ...input }) =>
      run((s) => s.createEvent({ ...input, reminderMinutes: reminder_minutes }, calendar)),
  );

  server.registerTool(
    'update_event',
    {
      title: 'Update event',
      description:
        'Change fields of an event. For recurring events this edits the whole series. Moving the start keeps the ' +
        'duration unless end is also given. Pass null to clear location, description, rrule or reminder.',
      inputSchema: {
        url: eventUrl,
        etag,
        summary: z.string().min(1).optional(),
        start: z.string().optional().describe(TIME_HELP),
        end: z.string().optional(),
        timezone,
        location: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        rrule: z.string().nullable().optional(),
        reminder_minutes: z.number().int().min(0).max(40320).nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ url, etag, reminder_minutes, ...patch }) =>
      run((s) => s.updateEvent(url, { ...patch, reminderMinutes: reminder_minutes }, etag)),
  );

  server.registerTool(
    'delete_event',
    {
      title: 'Delete event',
      description: 'Delete an event. For recurring events this deletes the entire series. Cannot be undone.',
      inputSchema: { url: eventUrl, etag },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ url, etag }) => run((s) => s.deleteEvent(url, etag)),
  );
}
