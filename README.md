# yandex-360-mcp

[MCP](https://modelcontextprotocol.io) servers for **Yandex 360**. Each service is its own small server, so you install only the ones you want.

| Package | Service | Protocol | npm |
| --- | --- | --- | --- |
| [`yandex-mail-mcp`](packages/mail) | Mail | IMAP + SMTP | `npx -y yandex-mail-mcp` |
| [`yandex-calendar-mcp`](packages/calendar) | Calendar | CalDAV | `npx -y yandex-calendar-mcp` |

Both servers sign in with either a Yandex app password or OAuth, and both support a read-only mode. With OAuth, one login covers both servers, and the token stays out of your MCP config. [`yandex-360-oauth`](packages/oauth) is the small shared package that handles it.

> Yandex 360's public API covers organization administration, not mailbox or calendar contents. That's why these servers use the standard protocols Yandex exposes for mail and calendar clients.

## Quick start (Claude Code)

Create one app password per service at [id.yandex.ru/security/app-passwords](https://id.yandex.ru/security/app-passwords): type **Mail** for the Mail server, type **Calendar** for the Calendar server. Then:

```sh
claude mcp add -s user yandex-mail \
  -e YANDEX_USER=you@yourdomain.com -e YANDEX_MAIL_APP_PASSWORD=... \
  -- npx -y yandex-mail-mcp

claude mcp add -s user yandex-calendar \
  -e YANDEX_USER=you@yourdomain.com -e YANDEX_CALENDAR_APP_PASSWORD=... \
  -e YANDEX_CALENDAR_TIMEZONE=Europe/Moscow \
  -- npx -y yandex-calendar-mcp
```

Prefer OAuth? Register an app at [oauth.yandex.com/client/new](https://oauth.yandex.com/client/new) with redirect URI `https://oauth.yandex.com/verification_code`, then run `npx yandex-mail-mcp login` and pass `YANDEX_OAUTH_CLIENT_ID` instead of a password. The package READMEs walk through it.

See each package's README for the tool list, all options, and JSON config for Claude Desktop, Cursor and others.

## Development

```sh
npm install
npm run build
npm test
```

`scripts/mcp-call.mjs` drives a built server through the official MCP client, which makes end-to-end testing easy against local servers such as [Radicale](https://radicale.org) (CalDAV) or [GreenMail](https://greenmail-mail-test.github.io/greenmail/) (IMAP/SMTP):

```sh
YANDEX_USER=me@test.local YANDEX_CALENDAR_APP_PASSWORD=secret YANDEX_CALDAV_URL=http://127.0.0.1:5232 \
  node scripts/mcp-call.mjs packages/calendar/dist/index.js '[["list_calendars"],["list_events",{}]]'
```

Each package is versioned and published on its own. Publish `yandex-360-oauth` first, since both servers depend on it: `npm publish -w yandex-360-oauth`, then `-w yandex-mail-mcp` and `-w yandex-calendar-mcp`.

## License

MIT
