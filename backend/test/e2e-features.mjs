/**
 * e2e-features.mjs — end-to-end checks for Kênh Tư Vấn, Ca khó, Cấu hình/phân quyền,
 * Claude Code + MCP and the Telegram bot logic, against a running backend.
 *
 * Run from backend/ (after test/e2e-local.mjs has created the test accounts):
 *   node --env-file=.env --import tsx test/e2e-features.mjs
 * Idempotent: resets the config it changes and removes the data it creates.
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { prisma } = await import('../src/shared/database/prisma-client.ts');
const { handleIncomingMessage } = await import('../src/modules/chat/message-handler.ts');
const { handleUpdate, renderOverview, renderOverdue } = await import('../src/modules/telegram/telegram-bot.ts');
const { createLinkCode, consumeLinkCode } = await import('../src/modules/telegram/telegram-store.ts');
const { notifyOrgChats } = await import('../src/modules/telegram/telegram-notify.ts');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function api(method, path, { token, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const login = async (email, password) => (await api('POST', '/api/v1/auth/login', { body: { email, password } })).data.token;

async function mcpClient(token) {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const toolText = (r) => r.content?.[0]?.text ?? '';

const owner = await login('owner@local.test', 'Owner2026x');
const admin = await login('admin@local.test', 'Admin2026x');
const member = await login('member@local.test', 'Member2026x');
const org2 = await login('other@org2.test', 'Other2026x');
if (!owner || !admin || !member || !org2) { console.error('Run test/e2e-local.mjs first (test accounts missing).'); process.exit(2); }

const ownerUser = await prisma.user.findUnique({ where: { email: 'owner@local.test' } });
const memberUser = await prisma.user.findUnique({ where: { email: 'member@local.test' } });
const orgId = ownerUser.orgId;
const zalo = await prisma.zaloAccount.findFirst({ where: { orgId, displayName: 'Zalo test' } });
const created = { conversations: [], contacts: [] };

try {
  // ── 1. Config & permissions ────────────────────────────────────────────────
  const meMember = await api('GET', '/api/v1/config/me', { token: member });
  check('member default perms: view channels, create ca khó, no manage/claude',
    meMember.data.permissions['channels.view'] && meMember.data.permissions['escalations.create'] &&
    !meMember.data.permissions['channels.manage'] && !meMember.data.permissions['claude.use']);
  check('member cannot read org config', (await api('GET', '/api/v1/config', { token: member })).status === 403);
  check('admin cannot change permissions (owner only)', (await api('PUT', '/api/v1/config/permissions', { token: admin, body: { member: { 'channels.manage': true } } })).status === 403);
  check('unknown permission key rejected', (await api('PUT', '/api/v1/config/permissions', { token: owner, body: { member: { 'root.all': true } } })).status === 400);
  check('SLA overdue < warn rejected', (await api('PUT', '/api/v1/config/sla', { token: admin, body: { warnMinutes: 60, overdueMinutes: 30 } })).status === 400);
  check('SLA bad time format rejected', (await api('PUT', '/api/v1/config/sla', { token: admin, body: { workStart: '25:00' } })).status === 400);
  const slaOk = await api('PUT', '/api/v1/config/sla', { token: admin, body: { warnMinutes: 15, overdueMinutes: 60 } });
  check('admin saves SLA', slaOk.status === 200 && slaOk.data.config.sla.warnMinutes === 15);
  const full = await api('GET', '/api/v1/config', { token: owner });
  check('config exposes MCP endpoint, not secrets', full.status === 200 && full.data.mcpEndpoint.endsWith('/mcp') && full.data.telegram.hasToken === false && !JSON.stringify(full.data).includes('bot_token'));

  // ── 2. Kênh Tư Vấn ─────────────────────────────────────────────────────────
  const mkConv = async (threadType, name, ai = false) => {
    const contact = await prisma.contact.create({ data: { orgId, fullName: name, zaloUid: 'e2e-' + randomUUID() } });
    const conv = await prisma.conversation.create({
      data: { orgId, zaloAccountId: zalo.id, contactId: contact.id, threadType, externalThreadId: 'e2e-' + randomUUID().slice(0, 12), lastMessageAt: new Date(Date.now() - 3 * 3600_000), isReplied: false, aiAssist: ai },
    });
    created.contacts.push(contact.id); created.conversations.push(conv.id);
    return conv;
  };
  const g1 = await mkConv('group', 'E2E Nhóm A');
  const p1 = await mkConv('user', 'E2E Khách P2P', true);
  await prisma.message.create({ data: { conversationId: g1.id, senderType: 'contact', senderName: 'Khách 1', content: 'Cho hỏi giá?', sentAt: new Date() } });

  const groups = await api('GET', '/api/v1/channels?type=group&search=E2E', { token: owner });
  check('owner lists group channels with question count', groups.status === 200 && groups.data.channels.some((c) => c.id === g1.id && c.questionCount === 1));
  const p2p = await api('GET', '/api/v1/channels?type=user&search=E2E', { token: owner });
  check('P2P tab separated from groups', p2p.data.channels.some((c) => c.id === p1.id) && !p2p.data.channels.some((c) => c.id === g1.id));
  const memberList = await api('GET', '/api/v1/channels?type=group&search=E2E', { token: member });
  check('member sees channels of granted Zalo account', memberList.status === 200 && memberList.data.channels.some((c) => c.id === g1.id));
  check('org2 sees none of org1 channels', (await api('GET', '/api/v1/channels?search=E2E', { token: org2 })).data.total === 0);
  check('member cannot toggle channel (no channels.manage)', (await api('PATCH', `/api/v1/channels/${g1.id}`, { token: member, body: { listening: false } })).status === 403);
  check('org2 cannot toggle org1 channel', (await api('PATCH', `/api/v1/channels/${g1.id}`, { token: org2, body: { listening: false } })).status === 404);
  check('invalid supporter rejected', (await api('PATCH', `/api/v1/channels/${g1.id}`, { token: owner, body: { supporterUserId: randomUUID() } })).status === 400);
  const assign = await api('PATCH', `/api/v1/channels/${g1.id}`, { token: owner, body: { supporterUserId: memberUser.id } });
  check('owner assigns supporter', assign.status === 200 && assign.data.supporter?.id === memberUser.id);
  const mute = await api('PATCH', `/api/v1/channels/${g1.id}`, { token: owner, body: { listening: false } });
  check('owner mutes channel', mute.status === 200 && mute.data.listening === false);

  const before = await prisma.message.count({ where: { conversationId: g1.id } });
  const r1 = await handleIncomingMessage({ accountId: zalo.id, senderUid: 'u1', senderName: 'Khách 1', content: 'tin bị bỏ qua', contentType: 'text', msgId: 'm-' + randomUUID(), timestamp: Date.now(), isSelf: false, threadId: g1.externalThreadId, threadType: 'group' });
  check('muted channel: incoming message ignored (not stored)', r1 === null && (await prisma.message.count({ where: { conversationId: g1.id } })) === before);
  await api('PATCH', `/api/v1/channels/${g1.id}`, { token: owner, body: { listening: true } });
  const r2 = await handleIncomingMessage({ accountId: zalo.id, senderUid: 'u1', senderName: 'Khách 1', content: 'tin được lưu', contentType: 'text', msgId: 'm-' + randomUUID(), timestamp: Date.now(), isSelf: false, threadId: g1.externalThreadId, threadType: 'group' });
  check('listening channel: incoming message stored', !!r2 && (await prisma.message.count({ where: { conversationId: g1.id } })) === before + 1);

  const bulk = await api('POST', '/api/v1/channels/bulk', { token: owner, body: { ids: [g1.id, p1.id], aiAssist: true } });
  check('bulk enable AI assist', bulk.status === 200 && bulk.data.updated === 2);
  await api('PATCH', `/api/v1/channels/${g1.id}`, { token: owner, body: { aiAssist: false } });

  // ── 3. Ca khó ──────────────────────────────────────────────────────────────
  const clr = await api('PUT', '/api/v1/config/escalation', { token: owner, body: { managerConversationId: null } });
  check('manager group setting can be cleared (null)', clr.status === 200 && clr.data.config.escalation.managerConversationId === null);
  check('ca khó requires title', (await api('POST', `/api/v1/conversations/${p1.id}/escalations`, { token: member, body: { title: '' } })).status === 400);
  const esc1 = await api('POST', `/api/v1/conversations/${p1.id}/escalations`, { token: member, body: { title: 'E2E xin duyệt giảm 15%', detail: 'Khách mua 10 máy', category: 'approval', priority: 'high' } });
  check('member creates ca khó', esc1.status === 201 && esc1.data.escalation.status === 'open');
  check('no Zalo manager → Zalo delivery skipped with reason', esc1.data.delivery.zalo.startsWith('skipped') && esc1.data.delivery.zalo.includes('Zalo quản lí'), esc1.data.delivery.zalo);
  check('no Telegram bot → Telegram skipped', esc1.data.delivery.telegram.startsWith('skipped'), esc1.data.delivery.telegram);
  const escId = esc1.data.escalation.id;
  check('org2 cannot create ca khó on org1 conversation', (await api('POST', `/api/v1/conversations/${p1.id}/escalations`, { token: org2, body: { title: 'x' } })).status === 404);
  check('member cannot approve (no escalations.resolve)', (await api('PATCH', `/api/v1/escalations/${escId}`, { token: member, body: { status: 'approved' } })).status === 403);

  check('member cannot set Zalo manager', (await api('POST', `/api/v1/zalo-accounts/${zalo.id}/manager`, { token: member, body: { isManager: true } })).status === 403);
  const setMgr = await api('POST', `/api/v1/zalo-accounts/${zalo.id}/manager`, { token: owner, body: { isManager: true } });
  check('owner selects Zalo quản lí', setMgr.status === 200 && (await prisma.zaloAccount.count({ where: { orgId, isManager: true } })) === 1);
  const zl = await api('GET', '/api/v1/zalo-accounts', { token: owner });
  check('Zalo list shows isManager', zl.data.find((a) => a.id === zalo.id)?.isManager === true);
  const resend = await api('POST', `/api/v1/escalations/${escId}/resend`, { token: member });
  check('resend: conversation on manager account asks to choose a group', resend.status === 200 && resend.data.zalo.includes('chọn nhóm'), resend.data.zalo);
  check('managerConversationId must belong to manager account', (await api('PUT', '/api/v1/config/escalation', { token: owner, body: { managerConversationId: randomUUID() } })).status === 400);
  const setThread = await api('PUT', '/api/v1/config/escalation', { token: owner, body: { managerConversationId: g1.id } });
  check('owner picks manager group for ca khó', setThread.status === 200);
  const resend2 = await api('POST', `/api/v1/escalations/${escId}/resend`, { token: owner });
  check('resend to manager group → fails clearly when Zalo offline', resend2.data.zalo.startsWith('failed') && resend2.data.zalo.includes('chưa kết nối'), resend2.data.zalo);

  const listMember = await api('GET', '/api/v1/escalations?status=open', { token: member });
  check('member sees own ca khó', listMember.data.items.some((e) => e.id === escId) && listMember.data.canResolve === false);
  check('org2 sees no ca khó', (await api('GET', '/api/v1/escalations', { token: org2 })).data.total === 0);
  const approve = await api('PATCH', `/api/v1/escalations/${escId}`, { token: admin, body: { status: 'approved', resolution: 'Đồng ý 15%' } });
  check('admin approves ca khó', approve.status === 200 && approve.data.status === 'approved' && approve.data.resolvedVia === 'web');
  const notif = await api('GET', '/api/v1/notifications', { token: owner });
  check('notifications use SLA warn minutes from config', notif.data.notifications.some((n) => n.id === 'unreplied' && n.detail.includes('15 phút')));
  const kpi = await api('GET', '/api/v1/dashboard/kpi', { token: owner });
  check('dashboard KPI has overdue + open ca khó', typeof kpi.data.overdueConversations === 'number' && typeof kpi.data.openEscalations === 'number');

  // ── 4. Claude Code + MCP ───────────────────────────────────────────────────
  const meClaude = await api('GET', '/api/v1/claude-code/me', { token: member });
  check('member not allowed Claude Code by default', meClaude.data.allowed === false && meClaude.data.reasons.length > 0);
  check('member cannot create MCP token', (await api('POST', '/api/v1/claude-code/tokens', { token: member, body: { name: 'x' } })).status === 403);
  check('admin cannot grant Claude Code per user (owner only)', (await api('PUT', '/api/v1/config/claude', { token: admin, body: { allowedUserIds: [memberUser.id] } })).status === 403);
  const grant = await api('PUT', '/api/v1/config/claude', { token: owner, body: { allowedUserIds: [memberUser.id] } });
  check('owner grants Claude Code to member', grant.status === 200);
  check('member cannot request send scope', (await api('POST', '/api/v1/claude-code/tokens', { token: member, body: { name: 'x', scopes: ['read', 'send'] } })).status === 403);
  check('bad scope rejected', (await api('POST', '/api/v1/claude-code/tokens', { token: member, body: { name: 'x', scopes: ['root'] } })).status === 400);
  const mt = await api('POST', '/api/v1/claude-code/tokens', { token: member, body: { name: 'E2E member', scopes: ['read', 'write'], expiresInDays: 0 } });
  check('member creates read+write token; capped to org TTL; command shown once',
    mt.status === 201 && /^zcc_[0-9a-f]{48}$/.test(mt.data.token) && mt.data.expiresAt && mt.data.command.includes('claude mcp add --transport http zalocrm'));
  const row = await prisma.mcpToken.findUnique({ where: { id: mt.data.id } });
  check('MCP token stored as hash only', row.tokenHash.length === 64 && !JSON.stringify(row).includes(mt.data.token));

  // raw HTTP checks
  const noTok = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' });
  check('MCP without token → 401 + WWW-Authenticate', noTok.status === 401 && !!noTok.headers.get('www-authenticate'));
  const badOrigin = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Authorization: `Bearer ${mt.data.token}` }, body: '{}' });
  check('MCP from foreign browser origin → 403', badOrigin.status === 403);
  check('GET /mcp → 405 (stateless)', (await fetch(`${BASE}/mcp`)).status === 405);

  const mc = await mcpClient(mt.data.token);
  const chans = JSON.parse(toolText(await mc.callTool({ name: 'list_channels', arguments: { search: 'E2E' } })));
  check('MCP list_channels only returns AI-assist channels', chans.some((c) => c.id === p1.id) && !chans.some((c) => c.id === g1.id));
  const gm = await mc.callTool({ name: 'get_messages', arguments: { conversationId: g1.id } });
  check('MCP get_messages refused on non-AI channel', gm.isError === true);
  const sc = await mc.callTool({ name: 'search_contacts', arguments: { query: 'E2E' } });
  const scList = JSON.parse(toolText(sc));
  check('MCP search_contacts limited to AI-assist channels', scList.some((c) => c.fullName === 'E2E Khách P2P') && !scList.some((c) => c.fullName === 'E2E Nhóm A'));
  const up = await mc.callTool({ name: 'update_contact', arguments: { contactId: p1.contactId, status: 'interested', notes: 'Claude ghi chú' } });
  check('MCP update_contact (write scope)', !up.isError && JSON.parse(toolText(up)).status === 'interested');
  const ce = await mc.callTool({ name: 'create_escalation', arguments: { conversationId: p1.id, title: 'E2E từ Claude', priority: 'urgent' } });
  const ceData = ce.isError ? null : JSON.parse(toolText(ce));
  check('MCP create_escalation (source=mcp)', !!ceData && (await prisma.escalation.findUnique({ where: { id: ceData.id } })).source === 'mcp');
  const ue = await mc.callTool({ name: 'update_escalation', arguments: { escalationId: ceData?.id ?? randomUUID(), status: 'resolved' } });
  check('MCP update_escalation denied without escalations.resolve', ue.isError === true && toolText(ue).includes('quyền'));
  const sm = await mc.callTool({ name: 'send_message', arguments: { conversationId: p1.id, content: 'hi' } });
  check('MCP send_message denied without send scope', sm.isError === true);
  const bad = await mc.callTool({ name: 'get_contact', arguments: { contactId: 'not-a-uuid' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  check('MCP validates tool input', bad.isError === true);
  await mc.close();
  const logs = await api('GET', '/api/v1/claude-code/logs', { token: member });
  // 7 tool executions above (the malformed-input call is rejected by the MCP SDK before the tool runs)
  check('MCP calls are audit-logged', logs.data.logs.length >= 7 && logs.data.logs.some((l) => l.tool === 'send_message' && !l.ok),
    `${logs.data.logs.length} entries`);

  // permission revoked → token stops working immediately
  await api('PUT', '/api/v1/config/claude', { token: owner, body: { allowedUserIds: [] } });
  const revoked = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${mt.data.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('token rejected right after Claude Code permission removed', revoked.status === 403);
  await api('PUT', '/api/v1/config/claude', { token: owner, body: { allowedUserIds: [memberUser.id] } });
  const adminTokens = await api('GET', '/api/v1/claude-code/tokens', { token: admin });
  check('admin sees all org tokens', adminTokens.data.tokens.some((t) => t.id === mt.data.id));
  check('member cannot list all tokens', (await api('GET', '/api/v1/claude-code/tokens', { token: member })).status === 403);
  check('admin revokes member token', (await api('DELETE', `/api/v1/claude-code/tokens/${mt.data.id}`, { token: admin })).status === 200);
  const after = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${mt.data.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  check('revoked token → 401', after.status === 401);

  // ── 5. Telegram (no real bot needed) ───────────────────────────────────────
  check('invalid bot token format rejected', (await api('PUT', '/api/v1/config/telegram/token', { token: owner, body: { token: 'abc' } })).status === 400);
  check('member cannot set bot token', (await api('PUT', '/api/v1/config/telegram/token', { token: member, body: { token: '123456:' + 'a'.repeat(35) } })).status === 403);
  check('link code requires a bot', (await api('POST', '/api/v1/config/telegram/link-code', { token: owner })).status === 400);
  const nr = await notifyOrgChats(orgId, 'x');
  check('notify skipped cleanly without bot', nr.sent === 0 && !!nr.skipped);
  const lc = createLinkCode(orgId, ownerUser.id);
  check('link code is single use + org bound', !consumeLinkCode('other-org', lc.code) && !!consumeLinkCode(orgId, lc.code) && !consumeLinkCode(orgId, lc.code));
  let called = false;
  await handleUpdate(orgId, 'fake-token', { update_id: 1, message: { text: '/tongquan', chat: { id: -100999, type: 'group' } } }).catch(() => { called = true; });
  check('unlinked Telegram group gets no data (no API call)', called === false);
  const ov = await renderOverview(orgId);
  check('Telegram /tongquan renders overview', ov.includes('Tổng quan') && ov.includes('Ca khó đang chờ'));
  const od = await renderOverdue(orgId);
  check('Telegram /quahan lists overdue (> 60 phút)', od.includes('E2E Khách P2P') || od.includes('60 phút'), od.split('\n')[0]);
} finally {
  // ── cleanup ────────────────────────────────────────────────────────────────
  await prisma.escalation.deleteMany({ where: { conversationId: { in: created.conversations } } });
  await prisma.conversation.deleteMany({ where: { id: { in: created.conversations } } });
  await prisma.contact.deleteMany({ where: { id: { in: created.contacts } } });
  await prisma.zaloAccount.updateMany({ where: { orgId }, data: { isManager: false } });
  await api('PUT', '/api/v1/config/escalation', { token: owner, body: { managerConversationId: null } });
  await api('PUT', '/api/v1/config/sla', { token: owner, body: { warnMinutes: 30, overdueMinutes: 120 } });
  await api('PUT', '/api/v1/config/claude', { token: owner, body: { allowedUserIds: [] } });
  await prisma.mcpToken.updateMany({ where: { orgId, name: 'E2E member' }, data: { revokedAt: new Date() } });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join(' | '));
await prisma.$disconnect();
process.exit(failed.length ? 1 : 0);
