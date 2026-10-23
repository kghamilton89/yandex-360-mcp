import MailComposer from 'nodemailer/lib/mail-composer';
import { describe, expect, it } from 'vitest';

// Guards the nodemailer behaviour MailService relies on: Bcc is dropped from sent
// messages but kept in drafts, and the envelope still includes Bcc recipients.
async function build(keepBcc: boolean) {
  const node = new MailComposer({
    from: { name: 'Me', address: 'me@yandex.ru' },
    to: ['a@x.com'],
    bcc: ['hidden@x.com'],
    subject: 'Привет',
    text: 'body',
    inReplyTo: '<orig@x>',
    references: ['<root@x>', '<orig@x>'],
  }).compile();
  node.keepBcc = keepBcc;
  return { raw: (await node.build()).toString(), envelope: node.getEnvelope(), id: node.messageId() };
}

describe('MailComposer usage', () => {
  it('omits Bcc header when sending', async () => {
    const { raw, envelope, id } = await build(false);
    expect(raw).not.toMatch(/^Bcc:/im);
    expect(envelope.to).toEqual(['a@x.com', 'hidden@x.com']);
    expect(envelope.from).toBe('me@yandex.ru');
    expect(raw).toMatch(/^In-Reply-To: <orig@x>/m);
    expect(raw).toMatch(/^References: <root@x> <orig@x>/m);
    expect(id).toMatch(/^<.+@.+>$/);
  });
  it('keeps Bcc header for drafts', async () => {
    const { raw } = await build(true);
    expect(raw).toMatch(/^Bcc: hidden@x.com/im);
  });
});
