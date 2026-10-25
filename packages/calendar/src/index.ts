#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAuthCommand, runAuthCli } from 'yandex-360-oauth';
import { oauthProfileFromEnv } from './config.js';
import { registerCalendarTools } from './tools.js';

const command = process.argv[2];
if (isAuthCommand(command)) {
  process.exit(
    await runAuthCli(process.argv.slice(2), {
      program: 'yandex-calendar-mcp',
      userVars: ['YANDEX_CALENDAR_USER', 'YANDEX_USER'],
      profile: oauthProfileFromEnv(),
    }),
  );
}

const server = new McpServer(
  { name: 'yandex-calendar', version: '0.3.0' },
  {
    instructions:
      'Tools for Yandex 360 Calendar over CalDAV. Events are addressed by URL: use list_events to find them. ' +
      'Times are returned in the configured time zone; all-day events use inclusive YYYY-MM-DD dates.' +
      ' If a tool says the Yandex login expired or was rejected, tell the user to run the login command shown in the error in a terminal; logins last about a year and are not renewed automatically.',
  },
);
registerCalendarTools(server);
await server.connect(new StdioServerTransport());
