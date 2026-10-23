#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAuthCommand, runAuthCli } from 'yandex-360-oauth';
import { OAUTH_PROFILE } from './config.js';
import { registerCalendarTools } from './tools.js';

const command = process.argv[2];
if (isAuthCommand(command)) {
  process.exit(
    await runAuthCli(process.argv.slice(2), {
      program: 'yandex-calendar-mcp',
      userVars: ['YANDEX_CALENDAR_USER', 'YANDEX_USER'],
      profile: OAUTH_PROFILE,
    }),
  );
}

const server = new McpServer(
  { name: 'yandex-calendar', version: '0.2.0' },
  {
    instructions:
      'Tools for Yandex 360 Calendar over CalDAV. Events are addressed by URL: use list_events to find them. ' +
      'Times are returned in the configured time zone; all-day events use inclusive YYYY-MM-DD dates.',
  },
);
registerCalendarTools(server);
await server.connect(new StdioServerTransport());
