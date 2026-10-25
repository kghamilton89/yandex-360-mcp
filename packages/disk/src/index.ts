#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isAuthCommand, runAuthCli } from 'yandex-360-oauth';
import { oauthProfileFromEnv } from './config.js';
import { registerDiskTools } from './tools.js';

const command = process.argv[2];
if (isAuthCommand(command)) {
  let profile;
  try {
    profile = oauthProfileFromEnv();
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  process.exit(
    await runAuthCli(process.argv.slice(2), {
      program: 'yandex-disk-mcp',
      userVars: ['YANDEX_DISK_USER', 'YANDEX_USER'],
      profile,
    }),
  );
}

const server = new McpServer(
  { name: 'yandex-disk', version: '0.1.0' },
  {
    instructions:
      'Tools for Yandex Disk. Paths look like "/Documents/notes.md" ("/" is the root). read_file and edit_file work on UTF-8 ' +
      'text; use download_file for PDFs, images and Office files. To change part of a text file, prefer edit_file over ' +
      'rewriting it with write_file. delete moves items to the Disk trash unless permanently is set.' +
      ' If a tool says the Yandex login expired or was rejected, tell the user to run the login command shown in the error in a terminal; logins last about a year and are not renewed automatically.',
  },
);
registerDiskTools(server);
await server.connect(new StdioServerTransport());
