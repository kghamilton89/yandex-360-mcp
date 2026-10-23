import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { TokenProvider } from 'yandex-360-oauth';
import type { MailConfig } from './config.js';
import {
  type Address,
  type SearchCriteria,
  buildSearchQuery,
  envelopeAddresses,
  flattenAddresses,
  htmlToText,
  pageUids,
  references,
  replyAllRecipients,
  replySubject,
  truncate,
} from './format.js';

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: string[];
  replyTo?: { folder: string; uid: number; all?: boolean };
}

type SpecialUse = '\\Sent' | '\\Drafts' | '\\Trash' | '\\Junk';

// Used when the server does not advertise SPECIAL-USE; the first name is created if none exist.
const FALLBACK_NAMES: Record<SpecialUse, string[]> = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', 'Отправленные'],
  '\\Drafts': ['Drafts', 'Черновики'],
  '\\Trash': ['Trash', 'Deleted Items', 'Deleted Messages', 'Удаленные', 'Удалённые'],
  '\\Junk': ['Spam', 'Junk', 'Спам'],
};

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

function isoDate(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  const date = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function bodyText(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text;
  if (typeof parsed.html === 'string') return htmlToText(parsed.html);
  return '';
}

const OAUTH_CAPABILITIES = ['AUTH=OAUTHBEARER', 'AUTH=XOAUTH', 'AUTH=XOAUTH2'];

/**
 * Yandex accepts AUTHENTICATE XOAUTH2 but does not list it in CAPABILITY, and imapflow only
 * uses OAuth when it is advertised. Declare it just before authenticating with a token.
 */
export class YandexImapFlow extends ImapFlow {
  async run(command: string, ...args: unknown[]): Promise<unknown> {
    const opts = args[1] as { accessToken?: string } | undefined;
    if (command.toUpperCase() === 'AUTHENTICATE' && opts?.accessToken && !OAUTH_CAPABILITIES.some((c) => this.capabilities.has(c))) {
      this.capabilities.set('AUTH=XOAUTH2', true);
    }
    const run = (ImapFlow.prototype as unknown as { run: (this: ImapFlow, command: string, ...args: unknown[]) => Promise<unknown> }).run;
    return run.call(this, command, ...args);
  }
}

function isAuthFailure(err: unknown): boolean {
  const e = err as { authenticationFailed?: boolean; responseCode?: number; code?: string };
  return Boolean(e?.authenticationFailed) || e?.responseCode === 535 || e?.code === 'EAUTH';
}

export class MailService {
  private readonly tokens?: TokenProvider;

  constructor(private readonly cfg: MailConfig) {
    if (cfg.auth.type === 'oauth') this.tokens = new TokenProvider(cfg.auth.oauth);
  }

  /**
   * Runs `fn` with fresh credentials. With OAuth, an authentication failure triggers one
   * forced token refresh and a retry, which covers tokens revoked before their expiry.
   */
  private async withCredentials<T>(fn: (auth: { user: string; pass?: string; accessToken?: string }) => Promise<T>): Promise<T> {
    const user = this.cfg.user;
    if (this.cfg.auth.type === 'password') return fn({ user, pass: this.cfg.auth.password });
    const tokens = this.tokens!;
    try {
      return await fn({ user, accessToken: await tokens.getAccessToken() });
    } catch (err) {
      if (!isAuthFailure(err) || this.cfg.auth.oauth.staticToken) throw err;
      return fn({ user, accessToken: await tokens.refresh(true) });
    }
  }

  private async connectImap(): Promise<ImapFlow> {
    return this.withCredentials(async (auth) => {
      const client = new YandexImapFlow({
        host: this.cfg.imap.host,
        port: this.cfg.imap.port,
        secure: this.cfg.imap.secure,
        auth: auth.accessToken ? { user: auth.user, accessToken: auth.accessToken } : { user: auth.user, pass: auth.pass },
        logger: false,
      });
      // Socket errors after a failed command are surfaced through the command's promise.
      client.on('error', () => {});
      await client.connect();
      return client;
    });
  }

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.connectImap();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  private async withFolder<T>(
    folder: string,
    readOnly: boolean,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(folder, { readOnly });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  private async specialFolder(client: ImapFlow, use: SpecialUse): Promise<string> {
    const folders = await client.list();
    const special = folders.find((f) => f.specialUse === use);
    if (special) return special.path;
    const names = FALLBACK_NAMES[use];
    const byName = names
      .map((n) => folders.find((f) => f.path.toLowerCase() === n.toLowerCase() || f.name.toLowerCase() === n.toLowerCase()))
      .find(Boolean);
    if (byName) return byName.path;
    const created = await client.mailboxCreate(names[0]!);
    return created.path;
  }

  async listFolders() {
    return this.withImap(async (client) => {
      const folders = await client.list({ statusQuery: { messages: true, unseen: true } });
      return folders.map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse,
        messages: f.status?.messages,
        unread: f.status?.unseen,
      }));
    });
  }

  async search(folder: string, criteria: SearchCriteria, limit: number, offset: number) {
    const query = buildSearchQuery(criteria);
    return this.withFolder(folder, true, async (client) => {
      const uids = (await client.search(query, { uid: true })) || [];
      const page = pageUids(uids, limit, offset);
      const messages = [];
      if (page.length > 0) {
        for await (const m of client.fetch(
          page,
          { uid: true, envelope: true, flags: true, internalDate: true, size: true },
          { uid: true },
        )) {
          messages.push({
            uid: m.uid,
            date: isoDate(m.envelope?.date) ?? isoDate(m.internalDate),
            from: envelopeAddresses(m.envelope?.from),
            to: envelopeAddresses(m.envelope?.to),
            subject: m.envelope?.subject ?? '',
            unread: !m.flags?.has('\\Seen'),
            flagged: Boolean(m.flags?.has('\\Flagged')),
            size: m.size,
          });
        }
        messages.sort((a, b) => b.uid - a.uid);
      }
      return { folder, total: uids.length, offset, count: messages.length, messages };
    });
  }

  private async fetchParsed(client: ImapFlow, uid: number) {
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
    if (!msg || !msg.source) throw new Error(`Message UID ${uid} not found`);
    return { msg, parsed: await simpleParser(msg.source) };
  }

  async getMessage(folder: string, uid: number, opts: { markAsRead: boolean; maxChars: number }) {
    return this.withFolder(folder, !opts.markAsRead, async (client) => {
      const { msg, parsed } = await this.fetchParsed(client, uid);
      if (opts.markAsRead) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const body = truncate(bodyText(parsed), opts.maxChars);
      return {
        folder,
        uid,
        date: isoDate(parsed.date),
        from: flattenAddresses(parsed.from),
        to: flattenAddresses(parsed.to),
        cc: flattenAddresses(parsed.cc),
        replyTo: flattenAddresses(parsed.replyTo),
        subject: parsed.subject ?? '',
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        unread: opts.markAsRead ? false : !msg.flags?.has('\\Seen'),
        flagged: Boolean(msg.flags?.has('\\Flagged')),
        text: body.text,
        truncated: body.truncated,
        attachments: parsed.attachments.map((a, index) => ({
          index,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      };
    });
  }

  async saveAttachment(folder: string, uid: number, index: number, directory: string) {
    return this.withFolder(folder, true, async (client) => {
      const { parsed } = await this.fetchParsed(client, uid);
      const att = parsed.attachments[index];
      if (!att) throw new Error(`Message UID ${uid} has no attachment at index ${index}`);
      const dir = path.resolve(expandHome(directory));
      await mkdir(dir, { recursive: true });
      const base = path.basename(att.filename || `attachment-${index}`);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let target = path.join(dir, base);
      for (let n = 1; await stat(target).then(() => true, () => false); n++) {
        target = path.join(dir, `${stem} (${n})${ext}`);
      }
      await writeFile(target, att.content, { flag: 'wx' });
      return { path: target, filename: att.filename, contentType: att.contentType, size: att.size };
    });
  }

  /** Builds nodemailer message options, resolving reply threading from the original message. */
  private async compose(input: ComposeInput) {
    let to: Address[] | string[] = input.to ?? [];
    let cc: Address[] | string[] = input.cc ?? [];
    let subject = input.subject;
    let threading: { inReplyTo?: string; references?: string[] } = {};

    if (input.replyTo) {
      const { folder, uid, all } = input.replyTo;
      const original = await this.withFolder(folder, true, async (c) => (await this.fetchParsed(c, uid)).parsed);
      const replyTarget = flattenAddresses(original.replyTo).length
        ? flattenAddresses(original.replyTo)
        : flattenAddresses(original.from);
      if (!input.to?.length) {
        if (all) {
          const r = replyAllRecipients(replyTarget, flattenAddresses(original.to), flattenAddresses(original.cc), this.cfg.user);
          to = r.to;
          if (!input.cc?.length) cc = r.cc;
        } else {
          to = replyTarget;
        }
      }
      subject ??= replySubject(original.subject);
      threading = {
        inReplyTo: original.messageId,
        references: references(original.messageId, original.references),
      };
    }

    if (to.length === 0 && !(input.bcc?.length)) throw new Error('At least one recipient is required');
    if (!input.text && !input.html) throw new Error('Provide text and/or html for the message body');

    const attachments = [];
    for (const p of input.attachments ?? []) {
      const file = path.resolve(expandHome(p));
      const s = await stat(file).catch(() => null);
      if (!s?.isFile()) throw new Error(`Attachment not found or not a file: ${file}`);
      attachments.push({ path: file, filename: path.basename(file) });
    }

    return {
      from: this.cfg.fromName ? { name: this.cfg.fromName, address: this.cfg.user } : this.cfg.user,
      to,
      cc,
      bcc: input.bcc ?? [],
      subject: subject ?? '',
      text: input.text,
      html: input.html,
      attachments,
      ...threading,
    };
  }

  private static async build(mail: ConstructorParameters<typeof MailComposer>[0], keepBcc: boolean) {
    const node = new MailComposer(mail).compile();
    node.keepBcc = keepBcc;
    const raw = await node.build();
    return { raw, envelope: node.getEnvelope(), messageId: node.messageId() };
  }

  async send(input: ComposeInput) {
    const mail = await this.compose(input);
    const { raw, envelope, messageId } = await MailService.build(mail, false);
    const info = await this.withCredentials(async (auth) => {
      const transport = nodemailer.createTransport({
        host: this.cfg.smtp.host,
        port: this.cfg.smtp.port,
        secure: this.cfg.smtp.secure,
        auth: auth.accessToken
          ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
          : { user: auth.user, pass: auth.pass },
      });
      try {
        return await transport.sendMail({ envelope, raw });
      } finally {
        transport.close();
      }
    });
    let savedTo: string | undefined;
    if (this.cfg.saveSent) {
      savedTo = await this.withImap(async (client) => {
        const sent = await this.specialFolder(client, '\\Sent');
        await client.append(sent, raw, ['\\Seen']);
        return sent;
      });
    }
    return {
      messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      savedToSent: savedTo ?? false,
    };
  }

  async createDraft(input: ComposeInput) {
    const mail = await this.compose(input);
    const { raw, messageId } = await MailService.build(mail, true);
    return this.withImap(async (client) => {
      const drafts = await this.specialFolder(client, '\\Drafts');
      const res = await client.append(drafts, raw, ['\\Draft', '\\Seen']);
      return { folder: drafts, uid: res ? res.uid : undefined, messageId };
    });
  }

  async move(folder: string, uids: number[], destination: string) {
    return this.withFolder(folder, false, async (client) => {
      const res = await client.messageMove(uids.join(','), destination, { uid: true });
      if (!res) throw new Error('Move failed');
      return { moved: uids.length, destination: res.destination, uidMap: res.uidMap ? Object.fromEntries(res.uidMap) : undefined };
    });
  }

  async setFlags(folder: string, uids: number[], flags: { read?: boolean; flagged?: boolean }) {
    return this.withFolder(folder, false, async (client) => {
      const range = uids.join(',');
      const apply = async (flag: string, on: boolean | undefined) => {
        if (on === undefined) return;
        if (on) await client.messageFlagsAdd(range, [flag], { uid: true });
        else await client.messageFlagsRemove(range, [flag], { uid: true });
      };
      await apply('\\Seen', flags.read);
      await apply('\\Flagged', flags.flagged);
      return { updated: uids.length, ...flags };
    });
  }

  async delete(folder: string, uids: number[], permanent: boolean) {
    return this.withImap(async (client) => {
      const trash = await this.specialFolder(client, '\\Trash');
      const lock = await client.getMailboxLock(folder);
      try {
        const range = uids.join(',');
        if (permanent || folder === trash) {
          await client.messageDelete(range, { uid: true });
          return { deleted: uids.length, permanent: true };
        }
        const res = await client.messageMove(range, trash, { uid: true });
        if (!res) throw new Error('Move to Trash failed');
        return { deleted: uids.length, permanent: false, movedTo: trash };
      } finally {
        lock.release();
      }
    });
  }
}
