# yandex-calendar-mcp

An [MCP](https://modelcontextprotocol.io) server for **Yandex 360 Calendar** (personal Yandex Calendar and Yandex 360 for Business domains). It talks to CalDAV, so it needs no OAuth app. You only need an app password.

It's one half of [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp). The Mail server, [`yandex-mail-mcp`](https://www.npmjs.com/package/yandex-mail-mcp), installs separately.

## Setup

1. **Create an app password** of type **Calendar** at [id.yandex.ru/security/app-passwords](https://id.yandex.ru/security/app-passwords).
2. **Add the server to your MCP client.**

Claude Code:

```sh
claude mcp add -s user yandex-calendar \
  -e YANDEX_USER=you@yourdomain.com \
  -e YANDEX_CALENDAR_APP_PASSWORD=xxxxxxxxxxxxxxxx \
  -e YANDEX_CALENDAR_TIMEZONE=Europe/Moscow \
  -- npx -y yandex-calendar-mcp
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "yandex-calendar": {
      "command": "npx",
      "args": ["-y", "yandex-calendar-mcp"],
      "env": {
        "YANDEX_USER": "you@yourdomain.com",
        "YANDEX_CALENDAR_APP_PASSWORD": "xxxxxxxxxxxxxxxx",
        "YANDEX_CALENDAR_TIMEZONE": "Europe/Moscow"
      }
    }
  }
}
```

Requires Node.js 22 or newer.

## Tools

| Tool | What it does | Read-only mode |
| --- | --- | --- |
| `list_calendars` | Your event calendars, with names and URLs | ✓ |
| `list_events` | Events in a time range (default: the next 7 days) across all calendars or one. Recurring events are expanded into occurrences. Optional text filter | ✓ |
| `get_event` | One event at series level: recurrence rule, attendees, ETag, and the raw iCalendar if asked | ✓ |
| `create_event` | Timed or all-day events, with location, description, attendees, recurrence (`RRULE`) and a reminder | |
| `update_event` | Changes any field. Moving the start keeps the duration. `null` clears a field. Edits the whole series for recurring events | |
| `delete_event` | Deletes the event (the whole series for recurring events) | |

### Times

- **Input:** `2026-10-24` means an all-day date. `2026-10-24T10:00` is a local time in the event's time zone. A full ISO timestamp with an offset (`2026-10-24T10:00:00+03:00`) is taken as given.
- **Output:** timed events come back in `YANDEX_CALENDAR_TIMEZONE` with an explicit offset.
- **All-day ranges are inclusive** in both directions. A trip from the 24th to the 26th has `start: 2026-10-24` and `end: 2026-10-26`.
- **Recurring events** are written with a `TZID` and matching `VTIMEZONE`, so a weekly 09:00 meeting stays at 09:00 across daylight-saving changes.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `YANDEX_USER` | required | Your full address. `YANDEX_CALENDAR_USER` overrides it for this server |
| `YANDEX_CALENDAR_APP_PASSWORD` | required | A **Calendar** app password. Falls back to `YANDEX_APP_PASSWORD` |
| `YANDEX_CALENDAR_TIMEZONE` | system zone | IANA zone for reading local-time input and formatting output |
| `YANDEX_CALENDAR_DEFAULT` | first calendar | Name or URL of the calendar `create_event` uses when none is given |
| `YANDEX_CALENDAR_READ_ONLY` | `false` | `true` registers only `list_calendars`, `list_events` and `get_event` |
| `YANDEX_CALDAV_URL` | `https://caldav.yandex.ru` | CalDAV server |

## Notes

- **Write safety:** writes use the event's ETag, so editing an event that changed in the meantime fails instead of silently overwriting it.
- **Invitations:** adding `attendees` sets you as organizer, and Yandex may email invitations to the attendees.
- **Recurring events:** `update_event` and `delete_event` act on the whole series. Editing a single occurrence isn't supported yet.

## License

MIT
