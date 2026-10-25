/**
 * mcp-smoke.mjs — connects to the local MCP endpoint with the official MCP client,
 * like Claude Code does, and calls a few tools.
 * Run from backend/:  node --env-file=.env test/mcp-smoke.mjs   (needs a running backend)
 * Uses the owner test account from test/e2e-local.mjs.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'owner@local.test', password: 'Owner2026x' }),
}).then((r) => r.json());
const jwt = login.token;
const created = await fetch(`${BASE}/api/v1/claude-code/tokens`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ name: 'mcp-smoke', scopes: ['read', 'write'], expiresInDays: 1 }),
}).then((r) => r.json());
if (!created.token) { console.error('token create failed', created); process.exit(1); }

const client = new Client({ name: 'mcp-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${created.token}` } },
});
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const ov = await client.callTool({ name: 'crm_overview', arguments: {} });
console.log('crm_overview:', ov.content[0].text.slice(0, 200).replace(/\s+/g, ' '));
const send = await client.callTool({ name: 'send_message', arguments: { conversationId: '00000000-0000-4000-8000-000000000000', content: 'x' } });
console.log('send_message without send scope → isError:', send.isError, '|', send.content[0].text);
await client.close();

await fetch(`${BASE}/api/v1/claude-code/tokens/${created.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } });
console.log('token revoked');
