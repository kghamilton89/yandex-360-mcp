import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  buildSearchQuery,
  flattenAddresses,
  htmlToText,
  pageUids,
  references,
  replyAllRecipients,
  replySubject,
  truncate,
} from '../src/format.js';

describe('buildSearchQuery', () => {
  it('defaults to all', () => {
    expect(buildSearchQuery({})).toEqual({ all: true });
  });
  it('maps criteria', () => {
    const q = buildSearchQuery({ from: 'bob', unread: true, flagged: false, since: '2026-10-01' });
    expect(q).toMatchObject({ from: 'bob', seen: false, flagged: false });
    expect(q.since).toBeInstanceOf(Date);
    expect(q.all).toBeUndefined();
  });
  it('rejects bad dates', () => {
    expect(() => buildSearchQuery({ before: 'yesterday-ish' })).toThrow(/Invalid date/);
  });
});

describe('pageUids', () => {
  it('returns newest first with offset', () => {
    expect(pageUids([1, 5, 3, 9, 7], 2, 0)).toEqual([9, 7]);
    expect(pageUids([1, 5, 3, 9, 7], 2, 2)).toEqual([5, 3]);
    expect(pageUids([], 10, 0)).toEqual([]);
  });
});

describe('replies', () => {
  it('prefixes subject once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('Ответ: Привет')).toBe('Ответ: Привет');
    expect(replySubject(undefined)).toBe('Re: ');
  });
  it('builds reply-all without self or duplicates', () => {
    const r = replyAllRecipients(
      [{ address: 'Boss@x.com' }],
      [{ address: 'me@yandex.ru' }, { address: 'ann@x.com' }, { address: 'boss@x.com' }],
      [{ address: 'cc@x.com' }],
      'ME@yandex.ru',
    );
    expect(r.to.map((a) => a.address)).toEqual(['Boss@x.com']);
    expect(r.cc.map((a) => a.address)).toEqual(['ann@x.com', 'cc@x.com']);
  });
  it('chains references', () => {
    expect(references('<b>', '<a>')).toEqual(['<a>', '<b>']);
    expect(references('<b>', ['<a>', '<b>'])).toEqual(['<a>', '<b>']);
    expect(references(undefined, undefined)).toEqual([]);
  });
});

describe('flattenAddresses', () => {
  it('flattens groups and arrays', () => {
    const out = flattenAddresses([
      { value: [{ name: 'A', address: 'a@x' }, { name: 'G', group: [{ name: '', address: 'g@x' }] }], html: '', text: '' },
      { value: [{ name: '', address: 'b@x' }], html: '', text: '' },
    ]);
    expect(out).toEqual([{ name: 'A', address: 'a@x' }, { address: 'g@x' }, { address: 'b@x' }]);
  });
});

describe('text helpers', () => {
  it('strips html', () => {
    expect(htmlToText('<style>x{}</style><p>Hi&nbsp;<b>there</b></p><br>a &amp; b')).toBe('Hi there\n\na & b');
  });
  it('truncates', () => {
    expect(truncate('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncate('ab', 3)).toEqual({ text: 'ab', truncated: false });
  });
});

describe('loadConfig', () => {
  it('requires credentials', () => {
    expect(() => loadConfig({})).toThrow(/Missing credentials/);
  });
  it('prefers mail-specific vars and applies defaults', () => {
    const c = loadConfig({ YANDEX_USER: 'a@x', YANDEX_APP_PASSWORD: 'p', YANDEX_MAIL_USER: 'm@x', YANDEX_MAIL_READ_ONLY: 'true' });
    expect(c.user).toBe('m@x');
    expect(c.imap).toEqual({ host: 'imap.yandex.com', port: 993, secure: true });
    expect(c.smtp).toEqual({ host: 'smtp.yandex.com', port: 465, secure: true });
    expect(c.readOnly).toBe(true);
    expect(c.saveSent).toBe(false);
  });
  it('uses STARTTLS for port 587', () => {
    const c = loadConfig({ YANDEX_USER: 'a@x', YANDEX_APP_PASSWORD: 'p', YANDEX_SMTP_PORT: '587' });
    expect(c.smtp.secure).toBe(false);
  });
});
