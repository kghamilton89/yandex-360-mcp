# yandex-mail-mcp

An [MCP](https://modelcontextprotocol.io) server for **Yandex 360 Mail** (personal Yandex Mail and Yandex 360 for Business domains). It talks to your mailbox over IMAP and SMTP. You sign in with one command through Yandex OAuth, so no password goes in your MCP config. App passwords work too.

It's one half of [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp). The Calendar server, [`yandex-calendar-mcp`](https://www.npmjs.com/package/yandex-calendar-mcp), installs separately.

## Setup

1. **Enable IMAP.** In Yandex Mail, open **Settings → Email clients** ([mail.yandex.com/#setup/client](https://mail.yandex.com/#setup/client)) and turn on *From the imap.yandex.com server via IMAP* with *App passwords and OAuth tokens*.
2. **Log in** once, in a terminal. Your browser opens on Yandex, you approve access, and you paste back the code it shows:
   ```sh
   YANDEX_USER=you@yourdomain.com npx yandex-mail-mcp login
   ```
   The server asks only for reading and deleting mail over IMAP (`mail:imap_full`) and sending over SMTP (`mail:smtp`). The token is saved in `~/.config/yandex-360-mcp/oauth/`, readable only by you.
3. **Add the server to your MCP client.** Only your address goes in the config, with no password.

Claude Code:

```sh
claude mcp add -s user yandex-mail -e YANDEX_USER=you@yourdomain.com -- npx -y yandex-mail-mcp
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "yandex-mail": {
      "command": "npx",
      "args": ["-y", "yandex-mail-mcp"],
      "env": { "YANDEX_USER": "you@yourdomain.com" }
    }
  }
}
```

`npx yandex-mail-mcp auth-status` shows the saved login and when it expires, and `npx yandex-mail-mcp logout` deletes it.

> **Log in again about once a year.** Yandex logins last about a year, and Yandex only renews them for apps that send a client secret, which the shared app can't safely ship. When the login expires, every tool returns an error saying so, with the command to run (`npx yandex-mail-mcp login`), so your assistant can tell you what to do. Your own OAuth app with `YANDEX_OAUTH_CLIENT_SECRET` set renews automatically.

Requires Node.js 22 or newer.

### Using an app password instead

If you'd rather not use OAuth, create an app password of type **Mail** at [id.yandex.ru/security/app-passwords](https://id.yandex.ru/security/app-passwords). Then skip the login and add `-e YANDEX_MAIL_APP_PASSWORD=...` to the config. Setting a password switches the server to it.

### Using your own OAuth app

By default, login goes through the shared "Yandex 360 MCP" app. Its ClientID is public, and with PKCE there's no client secret. Tokens go straight from Yandex to your machine and never pass through the app's owner. To use your own app instead, register one at [oauth.yandex.com/client/new](https://oauth.yandex.com/client/new) with redirect URI `https://oauth.yandex.com/verification_code` and the `mail:imap_full` and `mail:smtp` permissions. Then set `YANDEX_OAUTH_CLIENT_ID` for both `login` and the server. If you get a token some other way, pass it as `YANDEX_OAUTH_TOKEN`. It's used as-is and never refreshed.

## Tools

| Tool | What it does | Read-only mode |
| --- | --- | --- |
| `list_folders` | Folders with message and unread counts | ✓ |
| `search_messages` | Search by sender, recipient, subject, body, date range, unread or flagged. Newest first, paginated | ✓ |
| `get_message` | Headers, plain-text body (HTML is converted) and attachment list. Doesn't mark the message read unless asked | ✓ |
| `save_attachment` | Saves an attachment to a local directory (default `~/Downloads`). Never overwrites | |
| `send_message` | Sends mail. Optional `reply_to` makes it a threaded reply or reply-all. Supports local file attachments | |
| `create_draft` | Same inputs as `send_message`, but saves to Drafts instead of sending | |
| `move_messages` | Moves messages to another folder | |
| `set_flags` | Marks read/unread and flagged/unflagged | |
| `delete_messages` | Moves to Trash. `permanent: true` expunges | |

Messages are addressed by **folder + UID**. `search_messages` returns UIDs, and the other tools take them.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `YANDEX_USER` | required | Your full address. `YANDEX_MAIL_USER` overrides it for this server |
| `YANDEX_MAIL_APP_PASSWORD` | none |  A **Mail** app password. Falls back to `YANDEX_APP_PASSWORD` |
| `YANDEX_OAUTH_CLIENT_ID` | shared app | Your own OAuth app's ClientID |
| `YANDEX_OAUTH_TOKEN` | none | A pre-issued access token (OAuth without the login step, no refresh) |
| `YANDEX_AUTH` | auto | Forces `oauth` or `password`. By default OAuth is used unless an app password is set |
| `YANDEX_OAUTH_CLIENT_SECRET` | none | Your own app's secret. Lets the server renew the login automatically instead of asking you to log in again each year |
| `YANDEX_OAUTH_SCOPE` | `mail:imap_full mail:smtp` | Scopes to request (only with your own app) |
| `YANDEX_OAUTH_TOKEN_FILE` | `~/.config/yandex-360-mcp/oauth/<user>-<app>-<server>.json` | Where the token is stored |
| `YANDEX_MAIL_READ_ONLY` | `false` | `true` registers only `list_folders`, `search_messages` and `get_message` |
| `YANDEX_MAIL_FROM_NAME` | none | Display name on outgoing mail |
| `YANDEX_MAIL_SAVE_SENT` | `true` | Saves a copy of sent mail to Sent. Yandex doesn't do this for mail sent over SMTP. Set `false` if you see duplicates |
| `YANDEX_IMAP_HOST` / `YANDEX_IMAP_PORT` | `imap.yandex.com` / `993` | IMAP over TLS |
| `YANDEX_SMTP_HOST` / `YANDEX_SMTP_PORT` | `smtp.yandex.com` / `465` | Port 465 uses implicit TLS, other ports use STARTTLS |
| `YANDEX_SMTP_SECURE` | auto | Forces implicit TLS on (`true`) or off (`false`) |

## Notes

- **Security:** an app password or `mail:imap_full` token grants full mailbox access. Use `YANDEX_MAIL_READ_ONLY=true` if you only want the assistant to read.
- **Revoking access:** if Yandex rejects or expires the login, the error tells you to run `login` again (with your own app and its client secret, the server first renews it once on its own). To cut off access entirely, remove the app at [id.yandex.ru/personal/data-access](https://id.yandex.ru/personal/data-access).
- **Attachments:** `send_message` reads `attachments` from local paths, and `save_attachment` writes local files. Both run with your user's permissions.
- **Connections:** each tool call opens and closes its own IMAP connection, so nothing goes stale between calls.

## License

MIT
