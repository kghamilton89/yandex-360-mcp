import type { AddressObject, EmailAddress } from 'mailparser';

export interface Address {
  name?: string;
  address: string;
}

export interface SearchCriteria {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  text?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
}

/** IMAP SEARCH object in the shape imapflow expects. */
export type ImapSearch = Record<string, unknown>;

export function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date for ${field}: ${value}`);
  return date;
}

export function buildSearchQuery(c: SearchCriteria): ImapSearch {
  const q: ImapSearch = {};
  if (c.from) q.from = c.from;
  if (c.to) q.to = c.to;
  if (c.subject) q.subject = c.subject;
  if (c.body) q.body = c.body;
  if (c.text) q.text = c.text;
  if (c.since) q.since = parseDate(c.since, 'since');
  if (c.before) q.before = parseDate(c.before, 'before');
  if (c.unread !== undefined) q.seen = !c.unread;
  if (c.flagged !== undefined) q.flagged = c.flagged;
  if (Object.keys(q).length === 0) q.all = true;
  return q;
}

/** Newest-first page of UIDs. IMAP returns UIDs in ascending order. */
export function pageUids(uids: number[], limit: number, offset: number): number[] {
  const sorted = [...uids].sort((a, b) => b - a);
  return sorted.slice(offset, offset + limit);
}

export function flattenAddresses(input: AddressObject | AddressObject[] | undefined): Address[] {
  if (!input) return [];
  const objects = Array.isArray(input) ? input : [input];
  const out: Address[] = [];
  const walk = (list: EmailAddress[]) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) out.push(a.name ? { name: a.name, address: a.address } : { address: a.address });
    }
  };
  for (const o of objects) walk(o.value);
  return out;
}

/** imapflow envelope addresses use { name, address }. */
export function envelopeAddresses(list: { name?: string; address?: string }[] | undefined): Address[] {
  return (list ?? [])
    .filter((a): a is { name?: string; address: string } => Boolean(a.address))
    .map((a) => (a.name ? { name: a.name, address: a.address } : { address: a.address }));
}

export function formatAddress(a: Address): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export function replySubject(subject: string | undefined): string {
  const s = (subject ?? '').trim();
  return /^(re|ответ)\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Recipients for a reply-all: original sender plus To/Cc, minus ourselves and duplicates. */
export function replyAllRecipients(
  sender: Address[],
  to: Address[],
  cc: Address[],
  self: string,
): { to: Address[]; cc: Address[] } {
  const seen = new Set<string>([self.toLowerCase()]);
  const keep = (list: Address[]) =>
    list.filter((a) => {
      const key = a.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const primary = keep(sender);
  const rest = keep([...to, ...cc]);
  return { to: primary, cc: rest };
}

export function references(inReplyTo: string | undefined, refs: string | string[] | undefined): string[] {
  const list = Array.isArray(refs) ? [...refs] : refs ? refs.split(/\s+/).filter(Boolean) : [];
  if (inReplyTo && !list.includes(inReplyTo)) list.push(inReplyTo);
  return list;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
