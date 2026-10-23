#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMailTools } from './tools.js';

const server = new McpServer(
  { name: 'yandex-mail', version: '0.1.0' },
  {
    instructions:
      'Tools for a Yandex 360 mailbox over IMAP/SMTP. Messages are addressed by folder + UID: use ' +
      'search_messages to find UIDs, then get_message to read. Draft with create_draft unless the user ' +
      'has explicitly asked to send.',
  },
);
registerMailTools(server);
await server.connect(new StdioServerTransport());
