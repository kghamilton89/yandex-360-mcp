# yandex-calendar-mcp

An [MCP](https://modelcontextprotocol.io) server for **Yandex 360 Calendar** (personal Yandex Calendar and Yandex 360 for Business domains). It talks to CalDAV. Sign in with an [app password](#setup) (simplest) or [OAuth](#oauth-instead-of-an-app-password) (no password stored in your MCP config).

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

## OAuth instead of an app password

With OAuth, your MCP config holds only a ClientID. The token lives in a private file (`~/.config/yandex-360-mcp/oauth/`, mode 0600) and refreshes automatically.

1. **Register an OAuth app** at [oauth.yandex.com/client/new](https://oauth.yandex.com/client/new):
   - Redirect URI: `https://oauth.yandex.com/verification_code`
   - Permissions: the **Calendar (CalDAV)** read/write permission. Add the Mail IMAP and SMTP permissions too if you also use `yandex-mail-mcp`, and one login then covers both servers.
2. **Log in** once, in a terminal. This opens your browser, and you paste back the code Yandex shows:
   ```sh
   YANDEX_USER=you@yourdomain.com YANDEX_OAUTH_CLIENT_ID=<ClientID> npx yandex-calendar-mcp login
   ```
3. **Add the server** with the same two variables and no password:
   ```sh
   claude mcp add -s user yandex-calendar \
     -e YANDEX_USER=you@yourdomain.com -e YANDEX_OAUTH_CLIENT_ID=<ClientID> \
     -e YANDEX_CALENDAR_TIMEZONE=Europe/Moscow \
     -- npx -y yandex-calendar-mcp
   ```

`npx yandex-calendar-mcp auth-status` shows the saved token, and `npx yandex-calendar-mcp logout` deletes it. The login uses PKCE, so no client secret is needed. If you get a token some other way, pass it as `YANDEX_OAUTH_TOKEN` instead. It's used as-is and never refreshed.

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
| `YANDEX_CALENDAR_APP_PASSWORD` | required for app-password auth | A **Calendar** app password. Falls back to `YANDEX_APP_PASSWORD` |
| `YANDEX_OAUTH_CLIENT_ID` | none | Your OAuth app's ClientID. Setting it switches the server to OAuth |
| `YANDEX_OAUTH_TOKEN` | none | A pre-issued access token (OAuth without the login step, no refresh) |
| `YANDEX_AUTH` | auto | Forces `oauth` or `password` when both kinds of credentials are set |
| `YANDEX_OAUTH_CLIENT_SECRET` | none | Only needed if your app requires it. PKCE logins don't |
| `YANDEX_OAUTH_SCOPE` | app's permissions | Requests specific scopes instead of all the app's permissions |
| `YANDEX_OAUTH_TOKEN_FILE` | `~/.config/yandex-360-mcp/oauth/<user>-<app>.json` | Where the token is stored |
| `YANDEX_CALENDAR_TIMEZONE` | system zone | IANA zone for reading local-time input and formatting output |
| `YANDEX_CALENDAR_DEFAULT` | first calendar | Name or URL of the calendar `create_event` uses when none is given |
| `YANDEX_CALENDAR_READ_ONLY` | `false` | `true` registers only `list_calendars`, `list_events` and `get_event` |
| `YANDEX_CALDAV_URL` | `https://caldav.yandex.ru` | CalDAV server |

## Notes

- **Revoking access:** a revoked or expired OAuth token is refreshed once automatically. If that fails, the error tells you to run `login` again. To cut off access entirely, remove the app at [id.yandex.ru/personal/data-access](https://id.yandex.ru/personal/data-access).
- **Write safety:** writes use the event's ETag, so editing an event that changed in the meantime fails instead of silently overwriting it.
- **Invitations:** adding `attendees` sets you as organizer, and Yandex may email invitations to the attendees.
- **Recurring events:** `update_event` and `delete_event` act on the whole series. Editing a single occurrence isn't supported yet.

## License

MIT
