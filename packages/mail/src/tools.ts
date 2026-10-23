import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ConfigError, type MailConfig, loadConfig } from './config.js';
import { MailService } from './mail.js';

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  const e = err as { authenticationFailed?: boolean; responseText?: string; responseCode?: number };
  if (e?.authenticationFailed || e?.responseCode === 535) {
    message =
      'Authentication failed. Check YANDEX_USER and YANDEX_MAIL_APP_PASSWORD (it must be a "Mail" app password), ' +
      'and that IMAP is enabled at https://mail.yandex.com/#setup/client.';
  } else if (e?.responseText) {
    message = `${message}: ${e.responseText}`;
  }
  return { isError: true, content: [{ type: 'text', text: message }] };
}

const folder = z.string().default('INBOX').describe('Folder path as returned by list_folders, e.g. "INBOX", "Sent"');
const uids = z.array(z.number().int().positive()).min(1).describe('Message UIDs within the folder');
const addresses = z.array(z.string().min(3)).describe('Addresses, e.g. "a@example.com" or "Ann <a@example.com>"');

const composeShape = {
  to: addresses.optional().describe('Recipients. Optional when replying: defaults to the original sender'),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  subject: z.string().optional().describe('Subject. Defaults to "Re: <original>" when replying'),
  text: z.string().optional().describe('Plain-text body'),
  html: z.string().optional().describe('HTML body (optional, sent alongside text)'),
  attachments: z.array(z.string()).optional().describe('Absolute paths of local files to attach'),
  reply_to: z
    .object({
      folder: z.string().default('INBOX'),
      uid: z.number().int().positive(),
      all: z.boolean().default(false).describe('Reply to all original recipients'),
    })
    .optional()
    .describe('Make this a threaded reply to an existing message'),
};

type ComposeArgs = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: string[];
  reply_to?: { folder: string; uid: number; all: boolean };
};

const toCompose = ({ reply_to, ...rest }: ComposeArgs) => ({ ...rest, replyTo: reply_to });

export function registerMailTools(server: McpServer, env: Record<string, string | undefined> = process.env) {
  // Config is resolved lazily so the server still starts (and reports a clear error) without credentials.
  let service: MailService | undefined;
  let config: MailConfig | undefined;
  const get = () => {
    if (!service) {
      config = loadConfig(env);
      service = new MailService(config);
    }
    return service;
  };
  const run = async (fn: (s: MailService) => Promise<unknown>) => {
    try {
      return ok(await fn(get()));
    } catch (err) {
      return fail(err);
    }
  };

  let readOnly = false;
  try {
    readOnly = loadConfig(env).readOnly;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
  }

  server.registerTool(
    'list_folders',
    {
      title: 'List mail folders',
      description: 'List all mailbox folders with message and unread counts.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => run((s) => s.listFolders()),
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Search a folder and return message summaries, newest first. With no criteria, lists the latest messages. ' +
        'Criteria are combined with AND.',
      inputSchema: {
        folder,
        from: z.string().optional().describe('Sender address or name contains'),
        to: z.string().optional().describe('Recipient address or name contains'),
        subject: z.string().optional().describe('Subject contains'),
        body: z.string().optional().describe('Body contains'),
        text: z.string().optional().describe('Headers or body contain'),
        since: z.string().optional().describe('On or after this date (ISO 8601, e.g. 2026-10-01)'),
        before: z.string().optional().describe('Before this date (ISO 8601)'),
        unread: z.boolean().optional().describe('true = only unread, false = only read'),
        flagged: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ folder, limit, offset, ...criteria }) => run((s) => s.search(folder, criteria, limit, offset)),
  );

  server.registerTool(
    'get_message',
    {
      title: 'Read message',
      description: 'Fetch one message: headers, plain-text body and attachment list. Does not mark it read unless asked.',
      inputSchema: {
        folder,
        uid: z.number().int().positive(),
        mark_as_read: z.boolean().default(false),
        max_chars: z.number().int().min(500).max(200_000).default(20_000).describe('Truncate the body after this many characters'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ folder, uid, mark_as_read, max_chars }) =>
      run((s) => s.getMessage(folder, uid, { markAsRead: mark_as_read, maxChars: max_chars })),
  );

  if (readOnly) return;

  server.registerTool(
    'save_attachment',
    {
      title: 'Save attachment',
      description: 'Save one attachment of a message to a local directory. Never overwrites existing files.',
      inputSchema: {
        folder,
        uid: z.number().int().positive(),
        index: z.number().int().min(0).describe('Attachment index from get_message'),
        directory: z.string().default('~/Downloads'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ folder, uid, index, directory }) => run((s) => s.saveAttachment(folder, uid, index, directory)),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send email',
      description:
        'Send an email from the configured Yandex 360 account. Set reply_to to send a threaded reply. ' +
        'Prefer create_draft when the user has not explicitly approved the final text.',
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run((s) => s.send(toCompose(args))),
  );

  server.registerTool(
    'create_draft',
    {
      title: 'Create draft',
      description: 'Save a message to the Drafts folder without sending it. Supports reply_to for threaded reply drafts.',
      inputSchema: composeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => run((s) => s.createDraft(toCompose(args))),
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move messages',
      description: 'Move messages to another folder (e.g. archive or spam).',
      inputSchema: { folder, uids, destination: z.string().describe('Destination folder path') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder, uids, destination }) => run((s) => s.move(folder, uids, destination)),
  );

  server.registerTool(
    'set_flags',
    {
      title: 'Mark read/unread or flagged',
      description: 'Mark messages read/unread and/or flagged/unflagged.',
      inputSchema: { folder, uids, read: z.boolean().optional(), flagged: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder, uids, read, flagged }) => run((s) => s.setFlags(folder, uids, { read, flagged })),
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Move messages to Trash. With permanent=true (or when already in Trash) they are expunged and cannot be recovered.',
      inputSchema: { folder, uids, permanent: z.boolean().default(false) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ folder, uids, permanent }) => run((s) => s.delete(folder, uids, permanent)),
  );
}
