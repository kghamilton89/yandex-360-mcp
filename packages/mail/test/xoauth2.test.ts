import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeToken } from 'yandex-360-oauth';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailConfig } from '../src/config.js';
import { ImapFlow } from 'imapflow';
import { MailService } from '../src/mail.js';

// Minimal IMAP server that answers like Yandex (capability line taken from imap.yandex.com).
function mockImap(expectedToken: string) {
  const seen: string[] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let pendingAuthTag: string | undefined;
    sock.write('* OK IMAP4rev1 ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (pendingAuthTag) {
          const tag = pendingAuthTag;
          pendingAuthTag = undefined;
          const payload = Buffer.from(line, 'base64').toString();
          seen.push(`PAYLOAD ${JSON.stringify(payload)}`);
          const ok = payload === `user=me@yandex.ru\x01auth=Bearer ${expectedToken}\x01\x01`;
          sock.write(ok ? `${tag} OK AUTHENTICATE completed\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          continue;
        }
        const [tag, cmd = '', arg] = line.split(' ');
        seen.push(`${cmd.toUpperCase()}${arg ? ` ${arg}` : ''}`);
        switch (cmd.toUpperCase()) {
          case 'CAPABILITY':
            sock.write(`* CAPABILITY IMAP4rev1 CHILDREN UNSELECT LITERAL+ NAMESPACE XLIST UIDPLUS ENABLE ID AUTH=PLAIN AUTH=XOAUTH2 MOVE\r\n${tag} OK CAPABILITY completed\r\n`);
            break;
          case 'AUTHENTICATE':
            pendingAuthTag = tag;
            sock.write('+ \r\n');
            break;
          case 'LOGOUT':
            sock.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
            sock.end();
            break;
          default:
            sock.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  return new Promise<{ port: number; seen: string[]; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, seen, close: () => server.close() })),
  );
}

let close: (() => void) | undefined;
afterEach(() => close?.());

const connect = (port: number, accessToken: string) => {
  const client = new ImapFlow({ host: '127.0.0.1', port, secure: false, auth: { user: 'me@yandex.ru', accessToken }, logger: false });
  client.on('error', () => {});
  return client;
};

describe('XOAUTH2 login', () => {
  it('sends the Yandex XOAUTH2 payload', async () => {
    const srv = await mockImap('TOKEN-1');
    close = srv.close;
    const client = connect(srv.port, 'TOKEN-1');
    await client.connect();
    expect(client.authenticated).toBeTruthy();
    await client.logout();
    expect(srv.seen).toContain('AUTHENTICATE XOAUTH2');
    expect(srv.seen).toContain(`PAYLOAD ${JSON.stringify('user=me@yandex.ru\x01auth=Bearer TOKEN-1\x01\x01')}`);
  });

  it('reports a rejected token as an authentication failure', async () => {
    const srv = await mockImap('TOKEN-1');
    close = srv.close;
    const client = connect(srv.port, 'WRONG');
    const err = await client.connect().then(() => undefined, (e: unknown) => e as { authenticationFailed?: boolean });
    expect(err?.authenticationFailed).toBe(true);
  });
});

describe('MailService with OAuth', () => {
  it('refreshes once and retries when IMAP rejects a not-yet-expired token', async () => {
    const imap = await mockImap('FRESH');
    const refreshCalls: string[] = [];
    const oauth = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      refreshCalls.push(new URLSearchParams(body).get('refresh_token') ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'FRESH', refresh_token: 'RT-2', expires_in: 3600 }));
    });
    await new Promise<void>((r) => oauth.listen(0, '127.0.0.1', r));
    close = () => {
      imap.close();
      oauth.close();
    };
    const dir = await mkdtemp(path.join(tmpdir(), 'ymail-'));
    const tokenFile = path.join(dir, 'token.json');
    await writeToken(tokenFile, {
      client_id: 'cid',
      user: 'me@yandex.ru',
      access_token: 'REVOKED',
      refresh_token: 'RT-1',
      expires_at: Date.now() + 3600_000,
      updated_at: Date.now(),
    });
    const cfg: MailConfig = {
      user: 'me@yandex.ru',
      auth: {
        type: 'oauth',
        oauth: { user: 'me@yandex.ru', clientId: 'cid', oauthUrl: `http://127.0.0.1:${(oauth.address() as net.AddressInfo).port}`, tokenFile },
      },
      imap: { host: '127.0.0.1', port: imap.port, secure: false },
      smtp: { host: '127.0.0.1', port: 1, secure: false },
      readOnly: false,
      saveSent: false,
    };
    const folders = await new MailService(cfg).listFolders();
    expect(Array.isArray(folders)).toBe(true);
    expect(refreshCalls).toEqual(['RT-1']);
    const payloads = imap.seen.filter((l) => l.startsWith('PAYLOAD'));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toContain('Bearer REVOKED');
    expect(payloads[1]).toContain('Bearer FRESH');
  });
});
