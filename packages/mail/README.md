# yandex-mail-mcp

An [MCP](https://modelcontextprotocol.io) server for **Yandex 360 Mail** (personal Yandex Mail and Yandex 360 for Business domains). It talks to your mailbox over IMAP and SMTP, so it needs no OAuth app. You only need an app password.

It's one half of [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp). The Calendar server, [`yandex-calendar-mcp`](https://www.npmjs.com/package/yandex-calendar-mcp), installs separately.

## Setup

1. **Enable IMAP.** In Yandex Mail, open **Settings → Email clients** ([mail.yandex.com/#setup/client](https://mail.yandex.com/#setup/client)) and turn on *From the imap.yandex.com server via IMAP* with *App passwords and OAuth tokens*.
2. **Create an app password** of type **Mail** at [id.yandex.ru/security/app-passwords](https://id.yandex.ru/security/app-passwords).
3. **Add the server to your MCP client.**

Claude Code:

```sh
claude mcp add -s user yandex-mail \
  -e YANDEX_USER=you@yourdomain.com \
  -e YANDEX_MAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx \
  -- npx -y yandex-mail-mcp
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "yandex-mail": {
      "command": "npx",
      "args": ["-y", "yandex-mail-mcp"],
      "env": {
        "YANDEX_USER": "you@yourdomain.com",
        "YANDEX_MAIL_APP_PASSWORD": "xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

Requires Node.js 22 or newer.

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
| `YANDEX_MAIL_APP_PASSWORD` | required | A **Mail** app password. Falls back to `YANDEX_APP_PASSWORD` |
| `YANDEX_MAIL_READ_ONLY` | `false` | `true` registers only `list_folders`, `search_messages` and `get_message` |
| `YANDEX_MAIL_FROM_NAME` | none | Display name on outgoing mail |
| `YANDEX_MAIL_SAVE_SENT` | `false` | Appends a copy of sent mail to Sent. Turn this on if sent messages don't show up there |
| `YANDEX_IMAP_HOST` / `YANDEX_IMAP_PORT` | `imap.yandex.com` / `993` | IMAP over TLS |
| `YANDEX_SMTP_HOST` / `YANDEX_SMTP_PORT` | `smtp.yandex.com` / `465` | Port 465 uses implicit TLS, other ports use STARTTLS |
| `YANDEX_SMTP_SECURE` | auto | Forces implicit TLS on (`true`) or off (`false`) |

## Notes

- **Security:** the app password grants full mailbox access. Store it the way your MCP client stores secrets, and use `YANDEX_MAIL_READ_ONLY=true` if you only want the assistant to read.
- **Attachments:** `send_message` reads `attachments` from local paths, and `save_attachment` writes local files. Both run with your user's permissions.
- **Connections:** each tool call opens and closes its own IMAP connection, so nothing goes stale between calls.

## License

MIT
