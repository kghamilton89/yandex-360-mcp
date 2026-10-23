#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAuthCommand, runAuthCli } from 'yandex-360-oauth';
import { OAUTH_PROFILE } from './config.js';
import { registerMailTools } from './tools.js';

const command = process.argv[2];
if (isAuthCommand(command)) {
  process.exit(
    await runAuthCli(process.argv.slice(2), {
      program: 'yandex-mail-mcp',
      userVars: ['YANDEX_MAIL_USER', 'YANDEX_USER'],
      profile: OAUTH_PROFILE,
    }),
  );
}

const server = new McpServer(
  { name: 'yandex-mail', version: '0.2.0' },
  {
    instructions:
      'Tools for a Yandex 360 mailbox over IMAP/SMTP. Messages are addressed by folder + UID: use ' +
      'search_messages to find UIDs, then get_message to read. Draft with create_draft unless the user ' +
      'has explicitly asked to send.',
  },
);
registerMailTools(server);
await server.connect(new StdioServerTransport());
