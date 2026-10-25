/**
 * telegram-bot.ts — one long-polling worker per organization that configured a bot token.
 * Long polling (getUpdates) needs no public URL, so it works on a local host.
 *
 * Commands (only from linked chats, except /start <code>):
 *   /start <code>   link this chat (code from Cấu hình → Telegram)
 *   /tongquan       dashboard overview
 *   /cakho          open "ca khó" with approve / reject / resolve buttons
 *   /quahan         conversations overdue per SLA
 *   /help
 * Plus: SLA overdue alerts (every 5 min, working hours) and an optional 08:00 summary.
 */
import cron from 'node-cron';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { getOrgConfig, isWorkingTime } from '../settings/org-config.js';
import { getOrgOverview, listOverdueConversations } from '../dashboard/overview-service.js';
import { escalationKeyboard, STATUS_LABEL, updateEscalationStatus, type EscalationStatus } from '../escalations/escalation-service.js';
import { consumeLinkCode, listOrgsWithBot, loadBotToken } from './telegram-store.js';
import { notifyOrgChats } from './telegram-notify.js';
import { esc, tgCall } from './telegram-client.js';

interface Worker {
  orgId: string;
  token: string;
  abort: AbortController;
  offset: number;
  running: boolean;
}

const workers = new Map<string, Worker>();
const fmtVnd = (n: number) => n.toLocaleString('vi-VN') + 'đ';
const ago = (d: Date | null) => {
  if (!d) return '—';
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  return m < 60 ? `${m} phút` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};

// ── Command handlers (exported for tests) ─────────────────────────────────────

export async function renderOverview(orgId: string): Promise<string> {
  const o = await getOrgOverview(orgId);
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
  return [
    `📊 <b>Tổng quan — ${esc(org?.name ?? '')}</b>`,
    `💬 Tin nhắn hôm nay: <b>${o.messagesToday}</b> (khách hỏi ${o.incomingToday})`,
    `⏳ Chưa trả lời: <b>${o.unreplied}</b> · quá ${o.sla.warnMinutes}′: ${o.waitingOverWarn} · quá hạn ${o.sla.overdueMinutes}′: <b>${o.overdue}</b>`,
    `⚠️ Ca khó đang chờ: <b>${o.openEscalations}</b>`,
    `👥 Khách mới 7 ngày: ${o.newContactsWeek} / tổng ${o.totalContacts}`,
    `🛒 Đơn hôm nay: ${o.ordersToday} · doanh thu hoàn thành ${fmtVnd(o.revenueToday)}`,
    `📱 Zalo kết nối: ${o.zaloConnected}/${o.zaloTotal} · kênh đang nghe ${o.channelsListening} · AI assist ${o.channelsAiAssist}`,
  ].join('\n');
}

export async function renderOverdue(orgId: string): Promise<string> {
  const cfg = await getOrgConfig(orgId);
  const rows = await listOverdueConversations(orgId, 15);
  if (rows.length === 0) return `✅ Không có hội thoại nào quá hạn ${cfg.sla.overdueMinutes} phút.`;
  return [
    `⏰ <b>Quá hạn phản hồi (> ${cfg.sla.overdueMinutes} phút)</b>`,
    ...rows.map((r, i) =>
      `${i + 1}. ${esc(r.contact?.fullName || 'Khách')} · ${esc(r.zaloAccount?.displayName || 'Zalo')}${r.threadType === 'group' ? ' (nhóm)' : ''} — chờ ${ago(r.lastMessageAt)}${r.supporter ? ' · ' + esc(r.supporter.fullName) : ''}`),
  ].join('\n');
}

async function sendOpenEscalations(token: string, chatId: string, orgId: string) {
  const items = await prisma.escalation.findMany({
    where: { orgId, status: 'open' },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    take: 10,
    include: { conversation: { select: { contact: { select: { fullName: true } }, zaloAccount: { select: { displayName: true } } } }, createdBy: { select: { fullName: true } } },
  });
  if (items.length === 0) {
    await tgCall(token, 'sendMessage', { chat_id: chatId, text: '✅ Không có ca khó nào đang chờ.' });
    return;
  }
  await tgCall(token, 'sendMessage', { chat_id: chatId, text: `⚠️ <b>${items.length} ca khó đang chờ</b>`, parse_mode: 'HTML' });
  for (const e of items) {
    const text = [
      `<b>${esc(e.title)}</b> [${e.priority === 'urgent' ? 'KHẨN' : e.priority === 'high' ? 'Cao' : 'Thường'}]`,
      `👤 ${esc(e.conversation?.contact?.fullName || '—')} · ${esc(e.conversation?.zaloAccount?.displayName || '')}`,
      `🙋 ${esc(e.createdBy?.fullName || 'Claude Code')} · ${ago(e.createdAt)} trước`,
      e.detail ? `📝 ${esc(e.detail.slice(0, 500))}` : '',
      `<code>${e.id.slice(0, 8)}</code>`,
    ].filter(Boolean).join('\n');
    await tgCall(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: escalationKeyboard(e.id) });
  }
}

const HELP = [
  '🤖 <b>ZaloCRM bot</b>',
  '/tongquan — tổng quan dashboard',
  '/cakho — ca khó đang chờ (kèm nút Duyệt / Từ chối / Đã xử lý)',
  '/quahan — hội thoại quá hạn phản hồi',
  '/help — trợ giúp',
].join('\n');

export async function handleUpdate(orgId: string, token: string, update: any): Promise<void> {
  // ── Inline button ─────────────────────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat?.id ?? '');
    const chat = await prisma.telegramChat.findFirst({ where: { orgId, chatId } });
    const m = /^esc:(approved|rejected|resolved):([0-9a-f-]{36})$/.exec(cq.data || '');
    if (!chat || !chat.canAct || !m) {
      await tgCall(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Chat này không có quyền thao tác', show_alert: true }).catch(() => {});
      return;
    }
    const actor = [cq.from?.first_name, cq.from?.last_name].filter(Boolean).join(' ') || cq.from?.username || 'Telegram';
    const updated = await updateEscalationStatus({
      orgId, id: m[2], status: m[1] as EscalationStatus, actorName: `${actor} (Telegram)`, via: 'telegram',
    });
    await tgCall(token, 'answerCallbackQuery', {
      callback_query_id: cq.id,
      text: updated ? `Đã chuyển: ${STATUS_LABEL[updated.status]}` : 'Không tìm thấy ca khó',
    }).catch(() => {});
    if (updated && cq.message) {
      await tgCall(token, 'editMessageText', {
        chat_id: chatId,
        message_id: cq.message.message_id,
        text: `${cq.message.text ?? ''}\n\n➡️ ${STATUS_LABEL[updated.status]} — ${actor}`.slice(0, 4000),
      }).catch(() => {});
    }
    return;
  }

  const msg = update.message;
  if (!msg?.text || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text: string = msg.text.trim();
  const [cmdRaw, arg] = text.split(/\s+/, 2);
  const cmd = cmdRaw.split('@')[0].toLowerCase();

  if (cmd === '/start' && arg) {
    const link = consumeLinkCode(orgId, arg);
    if (!link) {
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: '❌ Mã liên kết không đúng hoặc đã hết hạn.' });
      return;
    }
    const title = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || chatId;
    await prisma.telegramChat.upsert({
      where: { orgId_chatId: { orgId, chatId } },
      create: { orgId, chatId, title, linkedByUserId: link.userId },
      update: { title, linkedByUserId: link.userId },
    });
    logger.info(`[telegram] chat ${chatId} (${title}) linked to org ${orgId}`);
    await tgCall(token, 'sendMessage', { chat_id: chatId, text: `✅ Đã liên kết với ZaloCRM.\n\n${HELP}`, parse_mode: 'HTML' });
    return;
  }

  const linked = await prisma.telegramChat.findFirst({ where: { orgId, chatId }, select: { id: true } });
  if (!linked) {
    // Unknown chats get no data at all
    if (msg.chat.type === 'private') {
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: 'Chat chưa được liên kết. Vào ZaloCRM → Cấu hình → Telegram để lấy mã, rồi gửi /start <mã>.' }).catch(() => {});
    }
    return;
  }

  switch (cmd) {
    case '/tongquan':
    case '/dashboard':
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: await renderOverview(orgId), parse_mode: 'HTML' });
      break;
    case '/cakho':
      await sendOpenEscalations(token, chatId, orgId);
      break;
    case '/quahan':
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: await renderOverdue(orgId), parse_mode: 'HTML' });
      break;
    case '/help':
    case '/start':
      await tgCall(token, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML' });
      break;
    default:
      break;
  }
}

// ── Polling workers ───────────────────────────────────────────────────────────

async function pollLoop(w: Worker) {
  let backoff = 1000;
  while (w.running) {
    try {
      const updates = await tgCall<any[]>(w.token, 'getUpdates', {
        offset: w.offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      }, { timeoutMs: 40_000, signal: w.abort.signal });
      backoff = 1000;
      for (const u of updates) {
        w.offset = u.update_id + 1;
        try {
          await handleUpdate(w.orgId, w.token, u);
        } catch (err) {
          logger.warn(`[telegram] update ${u.update_id} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (!w.running) break;
      const e = err as Error & { code?: number };
      if (e.code === 401 || e.code === 404) {
        logger.error(`[telegram] org ${w.orgId}: bot token rejected — stopping worker`);
        w.running = false;
        break;
      }
      if (e.code === 409) logger.warn('[telegram] another process is polling this bot (409); retrying');
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export async function startTelegramForOrg(orgId: string): Promise<void> {
  stopTelegramForOrg(orgId);
  const cfg = await getOrgConfig(orgId);
  if (!cfg.telegram.enabled) return;
  const bot = await loadBotToken(orgId);
  if (!bot) return;
  // Long polling and webhooks are exclusive; make sure no webhook is set
  await tgCall(bot.token, 'deleteWebhook', { drop_pending_updates: false }).catch(() => {});
  await tgCall(bot.token, 'setMyCommands', {
    commands: [
      { command: 'tongquan', description: 'Tổng quan dashboard' },
      { command: 'cakho', description: 'Ca khó đang chờ' },
      { command: 'quahan', description: 'Hội thoại quá hạn phản hồi' },
      { command: 'help', description: 'Trợ giúp' },
    ],
  }).catch(() => {});
  const w: Worker = { orgId, token: bot.token, abort: new AbortController(), offset: 0, running: true };
  workers.set(orgId, w);
  pollLoop(w);
  logger.info(`[telegram] worker started for org ${orgId} (@${bot.botUsername})`);
}

export function stopTelegramForOrg(orgId: string): void {
  const w = workers.get(orgId);
  if (!w) return;
  w.running = false;
  w.abort.abort();
  workers.delete(orgId);
}

export function telegramWorkerRunning(orgId: string): boolean {
  return workers.get(orgId)?.running ?? false;
}

// ── Schedules ─────────────────────────────────────────────────────────────────

const alerted = new Map<string, number>(); // conversationId → lastMessageAt ms already alerted

async function slaTick() {
  for (const orgId of await listOrgsWithBot()) {
    try {
      const cfg = await getOrgConfig(orgId);
      if (!cfg.telegram.enabled || !cfg.sla.notifyTelegram || !isWorkingTime(cfg)) continue;
      const rows = await listOverdueConversations(orgId, 20);
      const fresh = rows.filter((r) => r.lastMessageAt && alerted.get(r.id) !== r.lastMessageAt.getTime());
      if (fresh.length === 0) continue;
      for (const r of fresh) alerted.set(r.id, r.lastMessageAt!.getTime());
      await notifyOrgChats(orgId, [
        `⏰ <b>${fresh.length} hội thoại mới quá hạn ${cfg.sla.overdueMinutes} phút</b>`,
        ...fresh.slice(0, 10).map((r) => `• ${esc(r.contact?.fullName || 'Khách')} · ${esc(r.zaloAccount?.displayName || 'Zalo')} — chờ ${ago(r.lastMessageAt)}${r.supporter ? ' · ' + esc(r.supporter.fullName) : ''}`),
        'Gõ /quahan để xem danh sách đầy đủ.',
      ].join('\n'));
    } catch (err) {
      logger.warn(`[telegram] SLA tick failed for org ${orgId}: ${(err as Error).message}`);
    }
  }
  if (alerted.size > 5000) alerted.clear();
}

async function dailySummary() {
  for (const orgId of await listOrgsWithBot()) {
    const cfg = await getOrgConfig(orgId);
    if (!cfg.telegram.enabled || !cfg.telegram.dailySummary) continue;
    notifyOrgChats(orgId, `☀️ Chào buổi sáng!\n\n${await renderOverview(orgId)}`).catch(() => {});
  }
}

export async function startTelegramService(): Promise<void> {
  for (const orgId of await listOrgsWithBot()) {
    startTelegramForOrg(orgId).catch((err) => logger.warn(`[telegram] start failed for ${orgId}: ${(err as Error).message}`));
  }
  cron.schedule('*/5 * * * *', () => { slaTick().catch(() => {}); });
  cron.schedule('0 1 * * *', () => { dailySummary().catch(() => {}); }); // 01:00 UTC = 08:00 VN
  logger.info('[telegram] service started (SLA alerts every 5 min, daily summary 08:00 VN)');
}
