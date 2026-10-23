# yandex-360-mcp

[MCP](https://modelcontextprotocol.io) servers for **Yandex 360**. Each service is its own small server, so you install only the ones you want.

| Package | Service | Protocol | npm |
| --- | --- | --- | --- |
| [`yandex-mail-mcp`](packages/mail) | Mail | IMAP + SMTP | `npx -y yandex-mail-mcp` |
| [`yandex-calendar-mcp`](packages/calendar) | Calendar | CalDAV | `npx -y yandex-calendar-mcp` |

Both servers sign in with one command through Yandex OAuth, and each asks only for its own permissions. App passwords work too, and both servers support a read-only mode. [`yandex-360-oauth`](packages/oauth) is the small shared package that handles the login.

> Yandex 360's public API covers organization administration, not mailbox or calendar contents. That's why these servers use the standard protocols Yandex exposes for mail and calendar clients.

## Quick start (Claude Code)

Log in once per server. Your browser opens on Yandex, and each server asks only for its own permissions:

```sh
YANDEX_USER=you@yourdomain.com npx yandex-mail-mcp login
YANDEX_USER=you@yourdomain.com npx yandex-calendar-mcp login
```

Logins last about a year. Run the same command again when a tool reports that the login expired.

Then add them, with no password in the config:

```sh
claude mcp add -s user yandex-mail -e YANDEX_USER=you@yourdomain.com -- npx -y yandex-mail-mcp
claude mcp add -s user yandex-calendar \
  -e YANDEX_USER=you@yourdomain.com -e YANDEX_CALENDAR_TIMEZONE=Europe/Moscow \
  -- npx -y yandex-calendar-mcp
```

Prefer app passwords? Each package README covers that, along with the tool list, all options, and JSON config for Claude Desktop, Cursor and others.

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

## Releasing

Each package is versioned and released on its own. Releases are staged by GitHub Actions and go live only after a maintainer approves them with 2FA:

1. Bump `version` in the package's `package.json` (and the version string in its `src/index.ts`), then commit.
2. Push a tag named `<package>@<version>`, e.g. `git tag yandex-mail-mcp@0.2.1 && git push origin yandex-mail-mcp@0.2.1`.
3. The [release workflow](.github/workflows/release.yml) builds, tests, checks that the tag matches `package.json`, and runs `npm stage publish`. npm trusts the workflow through OIDC, so no npm token is stored in GitHub, and the trust only allows staging.
4. Approve the staged version on npmjs.com (package, then **Staged Packages**) or with `npm stage approve <id>`.

Release `yandex-360-oauth` before a server version that needs a newer one.

## License

MIT
