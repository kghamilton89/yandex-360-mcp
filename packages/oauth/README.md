# yandex-360-oauth

Yandex OAuth for the [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp) servers: the `login` / `logout` / `auth-status` commands, the token store, and automatic refresh. You don't install it directly. `yandex-mail-mcp` and `yandex-calendar-mcp` depend on it.

- **Login:** authorization code with PKCE (S256), using Yandex's `https://oauth.yandex.com/verification_code` page. The user approves access in the browser and pastes the code back into the terminal. No client secret or local web server is needed.
- **Storage:** one JSON file per account and app under `$XDG_CONFIG_HOME/yandex-360-mcp/oauth/` (default `~/.config/...`). The directory is 0700 and the file is 0600, written atomically.
- **Refresh:** happens 5 minutes before expiry, under a cross-process file lock. Yandex rotates refresh tokens, so when Mail and Calendar refresh at the same moment, only one token request is sent.

## License

MIT
