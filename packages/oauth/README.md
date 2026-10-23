# yandex-360-oauth

Yandex OAuth for the [yandex-360-mcp](https://github.com/kghamilton89/yandex-360-mcp) servers: the `login` / `logout` / `auth-status` commands, the token store, and automatic refresh. You don't install it directly. `yandex-mail-mcp` and `yandex-calendar-mcp` depend on it.

- **Login:** authorization code with PKCE (S256), using Yandex's `https://oauth.yandex.com/verification_code` page. The user approves access in the browser and pastes the code back into the terminal. No client secret or local web server is needed.
- **App:** the shared "Yandex 360 MCP" app by default (ClientID `41664599d8d042f587ea2723aa3c2768`). Each server requests only its own scopes.
- **Storage:** one JSON file per account, app and server under `$XDG_CONFIG_HOME/yandex-360-mcp/oauth/` (default `~/.config/...`). The directory is 0700 and the file is 0600, written atomically.
- **Expiry:** Yandex logins last about a year, and Yandex only refreshes them for requests that carry the app's client secret. With the shared app (no secret), an expired login produces an error naming the login command to run. With `YANDEX_OAUTH_CLIENT_SECRET` set, the token is refreshed 5 minutes before expiry under a cross-process file lock, so concurrent servers send only one refresh request even though Yandex rotates refresh tokens.

## License

MIT
