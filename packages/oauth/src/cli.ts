import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { completeLogin, createLoginRequest } from './oauth.js';
import { AuthError, type Env, oauthSettingsFromEnv } from './settings.js';
import { deleteToken, readToken } from './store.js';

export interface AuthCliOptions {
  /** npm/bin name, e.g. "yandex-mail-mcp". */
  program: string;
  /** Environment variables checked in order for the account address. */
  userVars: string[];
  /** App permissions to tick when registering the OAuth app. */
  permissions: string[];
  env?: Env;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  openUrl?: (url: string) => void;
  fetchImpl?: typeof fetch;
}

export const AUTH_COMMANDS = ['login', 'logout', 'auth-status'] as const;

export function isAuthCommand(arg: string | undefined): boolean {
  return arg !== undefined && (AUTH_COMMANDS as readonly string[]).includes(arg);
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed as well; failing to open a browser is not an error.
  }
}

function fmtTime(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : 'no expiry reported';
}

/** Runs `login`, `logout` or `auth-status`. Returns the process exit code. */
export async function runAuthCli(argv: string[], opts: AuthCliOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const out = opts.output ?? process.stdout;
  const print = (line = '') => out.write(`${line}\n`);
  const [command, ...flags] = argv;
  const loginCommand = `npx ${opts.program} login`;

  try {
    const user = opts.userVars.map((v) => env[v]).find(Boolean);
    if (!user) throw new AuthError(`Set ${opts.userVars.at(-1)} to your full Yandex 360 address first.`);
    const settings = oauthSettingsFromEnv(user, { ...env, YANDEX_OAUTH_TOKEN: undefined }, loginCommand);

    if (command === 'logout') {
      const removed = await deleteToken(settings.tokenFile);
      print(removed ? `Removed ${settings.tokenFile}` : `No saved token for ${user}.`);
      print('To revoke access entirely, remove the app at https://id.yandex.ru/personal/data-access');
      return 0;
    }

    if (command === 'auth-status') {
      const token = await readToken(settings.tokenFile);
      if (!token) {
        print(`Not logged in as ${user}. Run: ${loginCommand}`);
        return 1;
      }
      print(`Account:       ${token.user}`);
      print(`Token file:    ${settings.tokenFile}`);
      print(`Expires:       ${fmtTime(token.expires_at)}`);
      print(`Refreshable:   ${token.refresh_token ? 'yes' : 'no'}`);
      if (token.scope) print(`Scope:         ${token.scope}`);
      print(`Last updated:  ${fmtTime(token.updated_at)}`);
      return 0;
    }

    // login
    const request = createLoginRequest(settings);
    print(`Signing in to Yandex as ${user}.`);
    print();
    print(`The OAuth app (ClientID ${settings.clientId}) needs these permissions:`);
    for (const p of opts.permissions) print(`  - ${p}`);
    print(`and "https://oauth.yandex.com/verification_code" as a Redirect URI.`);
    print();
    print('Open this URL, approve access, then paste the code Yandex shows you:');
    print();
    print(`  ${request.url}`);
    print();
    if (!flags.includes('--no-browser')) (opts.openUrl ?? openInBrowser)(request.url);

    const rl = createInterface({ input: opts.input ?? process.stdin, output: out, terminal: false });
    let code: string;
    try {
      code = await rl.question('Code: ');
    } finally {
      rl.close();
    }
    const token = await completeLogin(settings, code, request.verifier, opts.fetchImpl);
    print();
    print(`Logged in. Token saved to ${settings.tokenFile} (expires ${fmtTime(token.expires_at)}).`);
    if (token.scope) print(`Granted scope: ${token.scope}`);
    print('Both yandex-mail-mcp and yandex-calendar-mcp use this login when they share the same ClientID.');
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    (opts.output ?? process.stderr).write(`Error: ${message}\n`);
    return 1;
  }
}
