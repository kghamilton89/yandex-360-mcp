# yandex-disk-mcp

An [MCP](https://modelcontextprotocol.io) server for **Yandex Disk** (personal accounts and Yandex 360 for Business). It browses, reads, writes, edits, moves and shares files through the official Disk REST API. You sign in with one command through Yandex OAuth, so no password goes in your MCP config.

It's part of [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp). The Mail and Calendar servers install separately.

## Setup

1. **Log in** once, in a terminal. Your browser opens on Yandex, you approve access, and you paste back the code it shows:
   ```sh
   YANDEX_USER=you@yourdomain.com npx yandex-disk-mcp login
   ```
   The server asks only for Disk permissions (see [Access modes](#access-modes)). The token is saved in `~/.config/yandex-360-mcp/oauth/`, readable only by you.
2. **Add the server to your MCP client.** Only your address goes in the config.

Claude Code:

```sh
claude mcp add -s user yandex-disk -e YANDEX_USER=you@yourdomain.com -- npx -y yandex-disk-mcp
```

Claude Desktop, Cursor and other JSON-configured clients:

```json
{
  "mcpServers": {
    "yandex-disk": {
      "command": "npx",
      "args": ["-y", "yandex-disk-mcp"],
      "env": { "YANDEX_USER": "you@yourdomain.com" }
    }
  }
}
```

`npx yandex-disk-mcp auth-status` shows the saved login and when it expires, and `npx yandex-disk-mcp logout` deletes it.

> **Log in again about once a year.** Yandex logins last about a year, and Yandex only renews them for apps that send a client secret, which the shared app can't safely ship. When the login expires, every tool returns an error saying so, with the command to run (`npx yandex-disk-mcp login`), so your assistant can tell you what to do.

Disk's API only accepts OAuth, so unlike Mail and Calendar there's no app-password option. Requires Node.js 22 or newer.

## Access modes

Pick the narrowest mode that works for you. Set the same variables for `login` and in the MCP config, because the login asks for exactly what the mode needs.

| Mode | Set | The server can | Yandex permissions |
| --- | --- | --- | --- |
| Full (default) | nothing | Read and change anything on your Disk | `cloud_api:disk.read`, `cloud_api:disk.write`, `cloud_api:disk.info` |
| Full, read-only | `YANDEX_DISK_READ_ONLY=true` | Read anything, change nothing | `cloud_api:disk.read`, `cloud_api:disk.info` |
| App folder | `YANDEX_DISK_ACCESS=app-folder` | Read and change only its own folder, **Applications/Yandex 360 MCP**. The rest of your Disk is invisible to it | `cloud_api:disk.app_folder`, `cloud_api:disk.info` |

App-folder mode suits an assistant that keeps its own notes and files without seeing your other documents. Combine it with `YANDEX_DISK_READ_ONLY=true` to hide the writing tools too. It keeps a separate login, so you can switch between modes without logging out. Turning read-only off later makes the tools ask you to run `login` again, because the saved login can't write.

`cloud_api:disk.info` lets the server show how much space is used and free. It doesn't give access to any files.

## Tools

| Tool | What it does | Read-only mode |
| --- | --- | --- |
| `disk_info` | Space used and free, and the access mode | ✓ |
| `list_folder` | Files and folders in a folder, with paging and sorting | ✓ |
| `get_info` | Size, dates, type, checksums and public link of one item | ✓ |
| `find_files` | Files whose **name** contains some text. Yandex has no search API, so this scans the file list (20,000 files by default). Contents aren't searched | ✓ |
| `recent_files` | Most recently uploaded files | ✓ |
| `read_file` | Reads a UTF-8 text file, 1 MB by default and up to 5 MB | ✓ |
| `download_file` | Saves a file to this computer (`~/Downloads` by default; folders arrive as a zip). Never overwrites local files | ✓ |
| `list_trash` | Items in the Disk trash, with where they came from | ✓ |
| `write_file` | Creates a text file. Won't replace an existing one unless `overwrite` is set. Creates missing folders | |
| `edit_file` | Changes a text file by replacing exact text, in one or more edits saved together | |
| `upload_file` | Uploads a local file | |
| `create_folder` | Creates a folder (and missing parents) | |
| `copy`, `move` | Copy, move or rename files and folders | |
| `delete` | Moves to the Disk trash, or deletes permanently if asked | |
| `restore_from_trash` | Puts a trashed item back | |
| `publish`, `unpublish` | Creates or removes a public link | |

Paths look like `/Documents/notes.md`, and `/` is the root (of the app folder, in app-folder mode). Paths the tools return, such as `disk:/Documents/notes.md`, work as input too.

### Editing files

Disk stores files whole, so `edit_file` downloads the file, applies the replacements and uploads the result. Before uploading, it checks that nobody changed the file in the meantime, and it saves nothing if any replacement fails. That suits text, Markdown, CSV, JSON and code. Word, Excel and PDF files are binary: `read_file` refuses them, and you can download, change and upload them instead.

### Long operations

Copying, moving or deleting a large folder can take a while on Yandex's side. The tools wait up to 30 seconds and then return `status: "in progress"`. The operation keeps running on Yandex and finishes on its own.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `YANDEX_USER` | required | Your full address. `YANDEX_DISK_USER` overrides it for this server |
| `YANDEX_DISK_ACCESS` | `full` | `full` or `app-folder` (see [Access modes](#access-modes)) |
| `YANDEX_DISK_READ_ONLY` | `false` | Only the reading tools, and a login that can't write |
| `YANDEX_OAUTH_CLIENT_ID` | shared app | Your own OAuth app's ClientID |
| `YANDEX_OAUTH_CLIENT_SECRET` | none | Your own app's secret. Lets the server renew the login automatically |
| `YANDEX_OAUTH_TOKEN` | none | A pre-issued access token (no login step, never refreshed) |
| `YANDEX_OAUTH_SCOPE` | per mode | Scopes to request (only with your own app) |
| `YANDEX_OAUTH_TOKEN_FILE` | per account and mode | Where the login is saved |
| `YANDEX_DISK_API_URL` | `https://cloud-api.yandex.net` | API base URL, for testing |

### Using your own OAuth app

By default, login goes through the shared "Yandex 360 MCP" app. Its ClientID is public, and with PKCE there's no client secret. Tokens go straight from Yandex to your machine and never pass through the app's owner. To use your own app, register one at [oauth.yandex.com/client/new](https://oauth.yandex.com/client/new) with redirect URI `https://oauth.yandex.com/verification_code` and the Disk permissions of your mode, then set `YANDEX_OAUTH_CLIENT_ID` for both `login` and the server. In app-folder mode, the folder is named after your app.

## License

MIT
