# yandex-360-mcp

[MCP](https://modelcontextprotocol.io) servers for **Yandex 360**. Each service is its own small server, so you install only the ones you want.

| Package | Service | Protocol | npm |
| --- | --- | --- | --- |
| [`yandex-mail-mcp`](packages/mail) | Mail | IMAP + SMTP | `npx -y yandex-mail-mcp` |
| [`yandex-calendar-mcp`](packages/calendar) | Calendar | CalDAV | `npx -y yandex-calendar-mcp` |
| [`yandex-disk-mcp`](packages/disk) | Disk | Disk REST API | `npx -y yandex-disk-mcp` |

Each server signs in with one command through Yandex OAuth and asks only for its own permissions, narrowed further in read-only mode. Mail and Calendar also accept app passwords. Every server has a read-only mode, and Disk can be limited to its own folder. [`yandex-360-oauth`](packages/oauth) is the small shared package that handles the login.

> Yandex 360's public API covers organization administration, not mailbox or calendar contents. That's why the Mail and Calendar servers use the standard protocols Yandex exposes for mail and calendar clients. Disk has its own REST API.

## Quick start (Claude Code)

Log in once per server. Your browser opens on Yandex, and each server asks only for its own permissions:

```sh
YANDEX_USER=you@yourdomain.com npx yandex-mail-mcp login
YANDEX_USER=you@yourdomain.com npx yandex-calendar-mcp login
YANDEX_USER=you@yourdomain.com npx yandex-disk-mcp login
```

Logins last about a year. Run the same command again when a tool reports that the login expired.

Then add them, with no password in the config:

```sh
claude mcp add -s user yandex-mail -e YANDEX_USER=you@yourdomain.com -- npx -y yandex-mail-mcp
claude mcp add -s user yandex-calendar \
  -e YANDEX_USER=you@yourdomain.com -e YANDEX_CALENDAR_TIMEZONE=Europe/Moscow \
  -- npx -y yandex-calendar-mcp
claude mcp add -s user yandex-disk -e YANDEX_USER=you@yourdomain.com -- npx -y yandex-disk-mcp
```

Install only the ones you want. Prefer app passwords for Mail or Calendar? Each package README covers that, along with the tool list, all options, and JSON config for Claude Desktop, Cursor and others.

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

### Release notes for maintainers

Things that are easy to miss when you come back to upgrade these tools:

- **Bump the version in two places.** The server version is in both `package.json` and the `McpServer` constructor in `src/index.ts` (mail, calendar and disk). The workflow checks only `package.json`, so a missed `src/index.ts` ships quietly with the old number.
- **On 0.x, caret ranges pin the minor version.** The servers depend on `"yandex-360-oauth": "^0.1.x"`, which accepts 0.1.x only. If you release `yandex-360-oauth@0.2.0`, update that range in every server and release them too, or they keep installing 0.1.x.
- **Order matters for oauth changes.** Push the `yandex-360-oauth@…` tag, approve it, and wait until `npm view yandex-360-oauth version` shows it. Only then tag the servers. CI runs `npm ci` against the lockfile, so run `npm install` after bumping and commit `package-lock.json`.
- **One tag means one package.** For several packages, push one tag per package. Each tag runs its own workflow and stages its own version.
- **npm is slow to show new versions.** After approval, `npm view` and `npx` can return the old version for a few minutes. Add `--prefer-online` to check the current state.
- **`npm stage` doesn't understand workspaces.** Run `npm stage list` and `npm stage approve` with the package name, or from inside `packages/<name>`, not from the repo root.
- **Trusted publishing is already set up.** Each package trusts `release.yml` in this repo, for staging only (`npm trust github <pkg> --file release.yml --repo kghamilton89/yandex-360-mcp --allow-stage-publish`). A **new** package needs that command run once, after a first manual `npm publish`. Renaming `release.yml` or the repo breaks the trust.
- **Re-pushing an existing version is harmless.** The workflow notices the version is already on npm and skips it. To redo a failed release, delete and re-push the tag (`git push origin :refs/tags/<tag>`, then push again).
- **Manual publishing still works** with `npm publish` from the package folder, using your own npm login and 2FA. Run `npm run build` first, since `dist/` isn't committed.
- **OAuth app.** All servers use the shared Yandex OAuth app (`DEFAULT_CLIENT_ID` in `packages/oauth/src/settings.ts`), managed at [oauth.yandex.com](https://oauth.yandex.com). A new scope must be added to the app first, then to the server's `OAUTH_PROFILE` in `src/config.ts`. Users then run `login` again, because existing tokens don't gain new scopes.

## License

MIT
