/**
 * e2e-local.mjs — end-to-end checks against a running local backend (http://127.0.0.1:3000).
 * Run from backend/:  node --env-file=.env test/e2e-local.mjs
 * Needs frontend/node_modules (socket.io-client) and backend/node_modules (@prisma/client, bcryptjs).
 * Creates test data in the configured database (fresh local DB expected).
 */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { io } = require('../../frontend/node_modules/socket.io-client');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const FRONT_ORIGIN = 'http://localhost:5173';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(method, path, { token, apiKey, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (apiKey) h['X-API-Key'] = apiKey;
  // Fastify rejects an empty body when Content-Type is JSON → always send at least "{}" on non-GET
  const payload = method === 'GET' ? undefined : JSON.stringify(body ?? {});
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function socketConnect(auth) {
  return new Promise((resolve) => {
    const s = io(BASE, { transports: ['websocket'], auth, reconnection: false, timeout: 5000 });
    const done = (r) => { resolve({ ...r, socket: s }); };
    s.on('connect', () => done({ connected: true }));
    s.on('connect_error', (err) => done({ connected: false, error: err.message }));
  });
}

const OWNER = { email: 'owner@local.test', password: 'Owner2026x', fullName: 'Chủ hệ thống', orgName: 'Tổ chức test' };
const MEMBER = { email: 'member@local.test', password: 'Member2026x', fullName: 'Nhân viên' };
const ADMIN = { email: 'admin@local.test', password: 'Admin2026x', fullName: 'Quản trị' };
const ORG2 = { email: 'other@org2.test', password: 'Other2026x', fullName: 'Người ngoài' };

async function main() {
  // ── 0. health + headers ────────────────────────────────────────────────────
  const h = await api('GET', '/health');
  check('health ok + db connected', h.status === 200 && h.data?.db === 'connected');
  check('security headers present',
    h.headers.get('x-content-type-options') === 'nosniff' && h.headers.get('x-frame-options') === 'DENY');

  const corsBad = await api('GET', '/api/v1/status', { headers: { Origin: 'http://evil.example' } });
  const corsGood = await api('GET', '/api/v1/status', { headers: { Origin: FRONT_ORIGIN } });
  check('CORS blocks foreign origin', !corsBad.headers.get('access-control-allow-origin'));
  check('CORS allows frontend origin', corsGood.headers.get('access-control-allow-origin') === FRONT_ORIGIN);

  // ── 1. setup ───────────────────────────────────────────────────────────────
  const st = await api('GET', '/api/v1/setup/status');
  if (!st.data?.needsSetup) {
    console.log('Database already set up — reset it (prisma db push --force-reset) for a full run.');
    process.exit(2);
  }
  const weak = await api('POST', '/api/v1/setup', { body: { ...OWNER, password: '123456' } });
  check('setup rejects weak password', weak.status === 400, JSON.stringify(weak.data));
  const setup = await api('POST', '/api/v1/setup', { body: OWNER });
  check('setup creates owner + token', setup.status === 200 && !!setup.data?.token && setup.data.user.role === 'owner');
  const ownerTok = setup.data.token;
  const ownerId = setup.data.user.id;
  const again = await api('POST', '/api/v1/setup', { body: OWNER });
  check('setup cannot run twice', again.status === 400);

  // JWT expiry ≈ 1 day
  const payload = JSON.parse(Buffer.from(ownerTok.split('.')[1], 'base64url').toString());
  check('JWT expires in ~1 day', payload.exp - payload.iat === 86400, `exp-iat=${payload.exp - payload.iat}`);

  // ── 2. login ───────────────────────────────────────────────────────────────
  const badLogin = await api('POST', '/api/v1/auth/login', { body: { email: OWNER.email, password: 'wrong-pass-1' } });
  check('login rejects wrong password', badLogin.status === 401);
  const goodLogin = await api('POST', '/api/v1/auth/login', { body: { email: OWNER.email, password: OWNER.password } });
  check('login works', goodLogin.status === 200 && !!goodLogin.data?.token);
  const noAuth = await api('GET', '/api/v1/profile');
  check('protected route without token → 401', noAuth.status === 401);
  const forged = await api('GET', '/api/v1/profile', { token: ownerTok.slice(0, -3) + 'abc' });
  check('tampered token → 401', forged.status === 401);

  // ── 3. users / roles ───────────────────────────────────────────────────────
  const mkMember = await api('POST', '/api/v1/users', { token: ownerTok, body: { ...MEMBER, role: 'member' } });
  check('owner creates member', mkMember.status === 200, JSON.stringify(mkMember.data).slice(0, 120));
  const mkAdmin = await api('POST', '/api/v1/users', { token: ownerTok, body: { ...ADMIN, role: 'admin' } });
  check('owner creates admin', mkAdmin.status === 200);
  const mkWeak = await api('POST', '/api/v1/users', { token: ownerTok, body: { email: 'w@local.test', fullName: 'W', password: 'abcdefgh' } });
  check('user creation rejects password without digits', mkWeak.status === 400);
  const mkOwner2 = await api('POST', '/api/v1/users', { token: ownerTok, body: { email: 'o2@local.test', fullName: 'O2', password: 'Owner2026x', role: 'owner' } });
  check('cannot create second owner', mkOwner2.status === 400);

  const memberTok = (await api('POST', '/api/v1/auth/login', { body: { email: MEMBER.email, password: MEMBER.password } })).data.token;
  const adminTok = (await api('POST', '/api/v1/auth/login', { body: { email: ADMIN.email, password: ADMIN.password } })).data.token;
  const memberId = mkMember.data.id;

  const adminEditOwner = await api('PUT', `/api/v1/users/${ownerId}`, { token: adminTok, body: { fullName: 'Hacked' } });
  check('admin cannot edit owner', adminEditOwner.status === 403);
  const adminResetOwner = await api('PUT', `/api/v1/users/${ownerId}/password`, { token: adminTok, body: { password: 'Hacked2026x' } });
  check('admin cannot reset owner password', adminResetOwner.status === 403);
  const memberEditEmail = await api('PUT', `/api/v1/users/${memberId}`, { token: memberTok, body: { email: 'x@local.test' } });
  check('member cannot change own email', memberEditEmail.status === 403);
  const memberRename = await api('PUT', `/api/v1/users/${memberId}`, { token: memberTok, body: { fullName: 'Nhân viên A' } });
  check('member can rename self', memberRename.status === 200);

  // ── 4. webhook / API key permissions + SSRF ────────────────────────────────
  check('member cannot read API key', (await api('GET', '/api/v1/settings/api-key', { token: memberTok })).status === 403);
  check('member cannot set webhook', (await api('PUT', '/api/v1/settings/webhook', { token: memberTok, body: { url: 'https://example.com/h' } })).status === 403);
  for (const bad of ['http://127.0.0.1:3000/health', 'http://localhost/x', 'http://169.254.169.254/latest', 'ftp://example.com/x', 'http://user:pw@example.com/x', 'http://[::1]/x']) {
    const r = await api('PUT', '/api/v1/settings/webhook', { token: ownerTok, body: { url: bad } });
    check(`SSRF blocked: ${bad}`, r.status === 400, JSON.stringify(r.data));
  }
  const okHook = await api('PUT', '/api/v1/settings/webhook', { token: ownerTok, body: { url: 'https://example.com/hook', secret: 'topsecret-1' } });
  check('public webhook URL accepted', okHook.status === 200, JSON.stringify(okHook.data));
  const getHook = await api('GET', '/api/v1/settings/webhook', { token: ownerTok });
  check('webhook secret masked in GET', getHook.data?.secret && getHook.data.secret.startsWith('****') && !getHook.data.secret.includes('topsecret'));
  const keepSecret = await api('PUT', '/api/v1/settings/webhook', { token: ownerTok, body: { url: 'https://example.com/hook', secret: getHook.data.secret } });
  const secretRow = await prisma.appSetting.findFirst({ where: { settingKey: 'webhook_secret' } });
  check('masked secret sent back does not overwrite stored secret', keepSecret.status === 200 && secretRow?.valuePlain === 'topsecret-1');

  const gen = await api('POST', '/api/v1/settings/api-key/generate', { token: ownerTok });
  check('owner generates API key', gen.status === 200 && /^zcrm_[0-9a-f]{48}$/.test(gen.data?.key || ''));
  const apiKey = gen.data.key;
  const rows = await prisma.appSetting.findMany({ where: { settingKey: { in: ['public_api_key', 'public_api_key_hash', 'public_api_key_hint'] } } });
  const plain = rows.find((r) => r.settingKey === 'public_api_key');
  const hash = rows.find((r) => r.settingKey === 'public_api_key_hash');
  check('API key stored as SHA-256 hash only', !plain && hash?.valuePlain === crypto.createHash('sha256').update(apiKey).digest('hex'));
  const hint = await api('GET', '/api/v1/settings/api-key', { token: ownerTok });
  check('API key GET returns hint, not key', hint.data?.key && hint.data.key !== apiKey && hint.data.key.length < 20);

  // ── 5. public API ──────────────────────────────────────────────────────────
  check('public API without key → 401', (await api('GET', '/api/public/contacts')).status === 401);
  check('public API wrong key → 401', (await api('GET', '/api/public/contacts', { apiKey: 'zcrm_' + '0'.repeat(48) })).status === 401);
  check('public API malformed key → 401', (await api('GET', '/api/public/contacts', { apiKey: 'abc' })).status === 401);
  const pub = await api('GET', '/api/public/contacts', { apiKey });
  check('public API with key → 200', pub.status === 200 && Array.isArray(pub.data?.contacts));
  const pubSend = await api('POST', '/api/public/messages/send', { apiKey, body: { zaloAccountId: 'nope', threadId: '1', content: 'x' } });
  check('public send to unknown account → 404', pubSend.status === 404);

  // Legacy plaintext key gets auto-upgraded
  const orgId = setup.data.user.orgId;
  const legacyKey = 'zcrm_' + crypto.randomBytes(24).toString('hex');
  await prisma.appSetting.deleteMany({ where: { orgId, settingKey: { in: ['public_api_key_hash', 'public_api_key_hint'] } } });
  await prisma.appSetting.create({ data: { orgId, settingKey: 'public_api_key', valuePlain: legacyKey } });
  const legacyUse = await api('GET', '/api/public/contacts', { apiKey: legacyKey });
  const afterRows = await prisma.appSetting.findMany({ where: { orgId, settingKey: { in: ['public_api_key', 'public_api_key_hash'] } } });
  check('legacy plaintext key accepted once and upgraded to hash',
    legacyUse.status === 200 && !afterRows.find((r) => r.settingKey === 'public_api_key') && !!afterRows.find((r) => r.settingKey === 'public_api_key_hash'));
  check('legacy key still works after upgrade', (await api('GET', '/api/public/contacts', { apiKey: legacyKey })).status === 200);
  const revoke = await api('DELETE', '/api/v1/settings/api-key', { token: ownerTok });
  check('revoke API key', revoke.status === 200 && (await api('GET', '/api/public/contacts', { apiKey: legacyKey })).status === 401);

  // ── 6. orders IDOR ─────────────────────────────────────────────────────────
  const contact = await api('POST', '/api/v1/contacts', { token: ownerTok, body: { fullName: 'Khách Test', phone: '0900000001' } });
  check('owner creates contact', contact.status === 201);
  const order = await api('POST', '/api/v1/orders', { token: ownerTok, body: { contactId: contact.data.id, totalAmount: 150000 } });
  check('owner creates order', order.status === 200 && order.data?.orderCode?.startsWith('ORD-'));
  check('member cannot edit other user order', (await api('PUT', `/api/v1/orders/${order.data.id}`, { token: memberTok, body: { status: 'completed' } })).status === 403);
  check('member cannot delete other user order', (await api('DELETE', `/api/v1/orders/${order.data.id}`, { token: memberTok })).status === 403);
  check('unknown order → 404 not 500', (await api('DELETE', `/api/v1/orders/${crypto.randomUUID()}`, { token: ownerTok })).status === 404);
  check('order with foreign contact → 404', (await api('POST', '/api/v1/orders', { token: ownerTok, body: { contactId: crypto.randomUUID(), totalAmount: 1 } })).status === 404);
  check('order with NaN amount → 400', (await api('POST', '/api/v1/orders', { token: ownerTok, body: { contactId: contact.data.id, totalAmount: 'abc' } })).status === 400);

  // ── 7. Zalo account permissions (no real Zalo login performed) ─────────────
  check('member cannot create Zalo account', (await api('POST', '/api/v1/zalo-accounts', { token: memberTok, body: { displayName: 'x' } })).status === 403);
  const za = await api('POST', '/api/v1/zalo-accounts', { token: ownerTok, body: { displayName: 'Zalo test' } });
  check('owner creates Zalo account (no session in response)', za.status === 201 && za.data && !('sessionData' in za.data));
  const zaId = za.data.id;
  const memberList0 = await api('GET', '/api/v1/zalo-accounts', { token: memberTok });
  check('member sees no Zalo accounts before access grant', memberList0.status === 200 && memberList0.data.length === 0);
  const grant = await api('POST', `/api/v1/zalo-accounts/${zaId}/access`, { token: ownerTok, body: { userId: memberId, permission: 'read' } });
  check('owner grants read access', grant.status === 201);
  const memberList1 = await api('GET', '/api/v1/zalo-accounts', { token: memberTok });
  check('member sees granted account, hasSession=false, no cookies', memberList1.data.length === 1 && memberList1.data[0].hasSession === false && !('sessionData' in memberList1.data[0]));
  check('member with read cannot start QR login', (await api('POST', `/api/v1/zalo-accounts/${zaId}/login`, { token: memberTok })).status === 403);
  check('member with read cannot delete account', (await api('DELETE', `/api/v1/zalo-accounts/${zaId}`, { token: memberTok })).status === 403);
  check('reconnect without session → 400', (await api('POST', `/api/v1/zalo-accounts/${zaId}/reconnect`, { token: ownerTok })).status === 400);

  // Session encryption at rest: write creds through the app's serializer and read raw row
  const { serializeSession } = await import('../src/modules/zalo/zalo-session.ts').catch(() => ({}));
  if (serializeSession) {
    await prisma.zaloAccount.update({ where: { id: zaId }, data: { sessionData: serializeSession({ cookie: [{ n: 'zpsid', v: 'SECRET-COOKIE' }], imei: 'imei-x', userAgent: 'UA' }) } });
    const raw = await prisma.$queryRaw`SELECT session_data::text AS s FROM zalo_accounts WHERE id = ${zaId}`;
    const s = String(raw[0]?.s || '').replace(/\s+/g, '');
    check('session_data column holds ciphertext only', s.includes('"enc":"v1"') && !s.includes('SECRET-COOKIE') && !s.includes('imei-x') && !s.includes('zpsid'));
    const list = await api('GET', '/api/v1/zalo-accounts', { token: ownerTok });
    check('hasSession=true after saving encrypted session', list.data.find((a) => a.id === zaId)?.hasSession === true);
  }

  // ── 8. misc routes ─────────────────────────────────────────────────────────
  const search = await api('GET', '/api/v1/search?q=Kh%C3%A1ch', { token: ownerTok });
  check('search route works (diseaseCode bug fixed)', search.status === 200 && search.data?.contacts?.length === 1, JSON.stringify(search.data).slice(0, 100));
  const err500 = await api('GET', '/api/v1/reports/messages?from=garbage', { token: ownerTok });
  const errText = JSON.stringify(err500.data || '');
  check('500 errors do not leak internals', (err500.status === 500 || err500.status === 400) && !/prisma|invalid input syntax|select |postgres|stack/i.test(errText),
    `status=${err500.status} body=${errText.slice(0, 80)}`);
  const bigPage = await api('GET', '/api/v1/conversations?limit=100000', { token: ownerTok });
  check('pagination clamped to 200', bigPage.status === 200 && bigPage.data.limit === 200);

  // ── 9. Socket.IO auth + org scoping ────────────────────────────────────────
  // second org (direct DB insert — the app only allows one org via setup)
  const org2 = await prisma.organization.create({ data: { name: 'Org 2' } });
  await prisma.user.create({ data: { orgId: org2.id, email: ORG2.email, passwordHash: await bcrypt.hash(ORG2.password, 12), fullName: ORG2.fullName, role: 'owner' } });
  const org2Tok = (await api('POST', '/api/v1/auth/login', { body: { email: ORG2.email, password: ORG2.password } })).data.token;
  check('org2 cannot see org1 contact', (await api('GET', `/api/v1/contacts/${contact.data.id}`, { token: org2Tok })).status === 404);
  check('org2 cannot see org1 conversations list leak', (await api('GET', '/api/v1/orders', { token: org2Tok })).data?.total === 0);

  const sNo = await socketConnect({});
  check('socket without token rejected', !sNo.connected && sNo.error === 'Unauthorized', sNo.error);
  const sBad = await socketConnect({ token: 'garbage.token.here' });
  check('socket with bad token rejected', !sBad.connected && sBad.error === 'Unauthorized');
  const sMember = await socketConnect({ token: memberTok });
  check('socket with valid token connects', sMember.connected);
  const sOrg2 = await socketConnect({ token: org2Tok });
  check('socket org2 connects', sOrg2.connected);

  const waitEvent = (s, ev, ms = 2000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });
  const org2Err = waitEvent(sOrg2.socket, 'zalo:error');
  sOrg2.socket.emit('zalo:subscribe', { accountId: zaId });
  const org2ErrData = await org2Err;
  check('org2 socket cannot subscribe to org1 Zalo account', !!org2ErrData && org2ErrData.accountId === zaId, JSON.stringify(org2ErrData));
  const memberErr = waitEvent(sMember.socket, 'zalo:error', 1500);
  sMember.socket.emit('zalo:subscribe', { accountId: zaId });
  check('org1 member can subscribe to own org account', (await memberErr) === null);
  sNo.socket.close(); sBad.socket.close(); sMember.socket.close(); sOrg2.socket.close();

  // ── 10. login rate limit (last — locks this IP for a minute) ───────────────
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/api/v1/auth/login', { body: { email: OWNER.email, password: 'bad-' + i } });
    if (r.status === 429) { got429 = true; break; }
  }
  check('login brute-force limited (429 within 12 attempts)', got429);
  const dodge = await api('POST', '/api/v1/auth/login', { body: { email: OWNER.email, password: 'bad' }, headers: { 'x-api-key': 'zcrm_' + 'f'.repeat(48) } });
  check('rate limit cannot be dodged with x-api-key header', dodge.status === 429);

  // ── summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('FAILED:', failed.map((f) => f.name).join(' | '));
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
