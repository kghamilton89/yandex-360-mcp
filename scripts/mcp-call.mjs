// Drives a built server over stdio with the official MCP client.
// Usage: node scripts/mcp-call.mjs <server-entry.js> '<json array of [tool, args]>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [entry, callsJson] = process.argv.slice(2);
const client = new Client({ name: 'mcp-call', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: process.env, stderr: 'inherit' }));
const calls = JSON.parse(callsJson ?? '[]');
const results = [];
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args ?? {} });
  const text = res.content?.[0]?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  results.push({ name, isError: Boolean(res.isError), data });
}
console.log(JSON.stringify(results, null, 2));
await client.close();
