/**
 * escalation-service.ts — "Ca khó": create, deliver (Zalo quản lí + Telegram), update status.
 */
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { emitWebhook } from '../api/webhook-service.js';
import { getOrgConfig } from '../settings/org-config.js';
import { notifyOrgChats } from '../telegram/telegram-notify.js';
import { esc } from '../telegram/telegram-client.js';

export const PRIORITIES = ['normal', 'high', 'urgent'] as const;
export const CATEGORIES = ['complex', 'approval'] as const;
export const STATUSES = ['open', 'approved', 'rejected', 'resolved'] as const;
export type EscalationStatus = (typeof STATUSES)[number];

const PRIORITY_LABEL: Record<string, string> = { normal: 'Bình thường', high: 'Cao', urgent: 'KHẨN' };
const CATEGORY_LABEL: Record<string, string> = { complex: 'Yêu cầu phức tạp', approval: 'Cần phê duyệt' };
export const STATUS_LABEL: Record<string, string> = {
  open: 'Đang chờ', approved: 'Đã duyệt', rejected: 'Từ chối', resolved: 'Đã xử lý',
};

let io: Server | null = null;
export function setEscalationIO(server: Server) {
  io = server;
}

const ESCALATION_INCLUDE = {
  conversation: {
    select: {
      id: true,
      threadType: true,
      externalThreadId: true,
      zaloAccountId: true,
      contact: { select: { id: true, fullName: true, phone: true } },
      zaloAccount: { select: { id: true, displayName: true } },
    },
  },
  createdBy: { select: { id: true, fullName: true } },
  resolvedBy: { select: { id: true, fullName: true } },
} as const;

export interface CreateEscalationInput {
  orgId: string;
  userId: string | null;
  conversationId: string;
  title: string;
  detail?: string | null;
  priority?: string;
  category?: string;
  source?: 'web' | 'mcp';
}

export function validateEscalationInput(body: Record<string, unknown>): string | null {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return 'Tiêu đề là bắt buộc';
  if (title.length > 200) return 'Tiêu đề tối đa 200 ký tự';
  if (body.detail !== undefined && body.detail !== null && (typeof body.detail !== 'string' || body.detail.length > 4000)) {
    return 'Chi tiết tối đa 4000 ký tự';
  }
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority as any)) return 'Mức độ không hợp lệ';
  if (body.category !== undefined && !CATEGORIES.includes(body.category as any)) return 'Loại không hợp lệ';
  return null;
}

export async function createEscalation(input: CreateEscalationInput) {
  const esc0 = await prisma.escalation.create({
    data: {
      orgId: input.orgId,
      conversationId: input.conversationId,
      createdByUserId: input.userId,
      title: input.title.trim().slice(0, 200),
      detail: input.detail?.trim().slice(0, 4000) || null,
      priority: input.priority ?? 'normal',
      category: input.category ?? 'complex',
      source: input.source ?? 'web',
    },
    include: ESCALATION_INCLUDE,
  });
  logger.info(`[escalation] ${esc0.id} created (${esc0.priority}) for conversation ${input.conversationId}`);

  const delivery = await deliverEscalation(esc0.id);
  const full = await prisma.escalation.findUniqueOrThrow({ where: { id: esc0.id }, include: ESCALATION_INCLUDE });
  io?.to(`org:${input.orgId}`).emit('escalation:new', { id: full.id, title: full.title, priority: full.priority });
  emitWebhook(input.orgId, 'escalation.created', { escalationId: full.id, title: full.title, priority: full.priority, conversationId: input.conversationId }).catch(() => {});
  return { escalation: full, delivery };
}

async function recentExcerpt(conversationId: string): Promise<string[]> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, isDeleted: false },
    orderBy: { sentAt: 'desc' },
    take: 5,
    select: { senderType: true, senderName: true, content: true, contentType: true },
  });
  return msgs.reverse().map((m) => {
    const who = m.senderType === 'self' ? 'NV' : m.senderName || 'KH';
    const text = m.contentType === 'text' ? (m.content || '') : `[${m.contentType}]`;
    return `${who}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  });
}

function plainSummary(e: any, excerpt: string[], createdBy: string): string {
  const conv = e.conversation;
  const lines = [
    `⚠️ CA KHÓ [${PRIORITY_LABEL[e.priority] ?? e.priority}] — ${CATEGORY_LABEL[e.category] ?? e.category}`,
    `Tiêu đề: ${e.title}`,
    conv ? `Khách/Nhóm: ${conv.contact?.fullName || conv.externalThreadId}${conv.contact?.phone ? ' (' + conv.contact.phone + ')' : ''}` : '',
    conv ? `Kênh: ${conv.zaloAccount?.displayName || 'Zalo'} · ${conv.threadType === 'group' ? 'Nhóm' : 'P2P'}` : '',
    `Người chuyển: ${createdBy}`,
    e.detail ? `Chi tiết: ${e.detail}` : '',
    excerpt.length ? `Tin gần nhất:\n${excerpt.join('\n')}` : '',
    `Mã: ${e.id.slice(0, 8)}`,
  ];
  return lines.filter(Boolean).join('\n').slice(0, 3900);
}

function htmlSummary(e: any, excerpt: string[], createdBy: string): string {
  const conv = e.conversation;
  const lines = [
    `⚠️ <b>CA KHÓ</b> [${esc(PRIORITY_LABEL[e.priority] ?? e.priority)}] — ${esc(CATEGORY_LABEL[e.category] ?? e.category)}`,
    `<b>${esc(e.title)}</b>`,
    conv ? `👤 ${esc(conv.contact?.fullName || conv.externalThreadId)}${conv.contact?.phone ? ' · ' + esc(conv.contact.phone) : ''}` : '',
    conv ? `💬 ${esc(conv.zaloAccount?.displayName || 'Zalo')} · ${conv.threadType === 'group' ? 'Nhóm' : 'P2P'}` : '',
    `🙋 ${esc(createdBy)}`,
    e.detail ? `📝 ${esc(e.detail)}` : '',
    excerpt.length ? `<i>${esc(excerpt.join('\n'))}</i>` : '',
    `<code>${esc(e.id.slice(0, 8))}</code>`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function escalationKeyboard(id: string) {
  return {
    inline_keyboard: [[
      { text: '✅ Duyệt', callback_data: `esc:approved:${id}` },
      { text: '❌ Từ chối', callback_data: `esc:rejected:${id}` },
      { text: '✔️ Đã xử lý', callback_data: `esc:resolved:${id}` },
    ]],
  };
}

/** Sends to Zalo quản lí and Telegram; stores delivery status on the row. */
export async function deliverEscalation(id: string): Promise<{ zalo: string; telegram: string }> {
  const e = await prisma.escalation.findUniqueOrThrow({ where: { id }, include: ESCALATION_INCLUDE });
  const cfg = await getOrgConfig(e.orgId);
  const excerpt = e.conversationId ? await recentExcerpt(e.conversationId) : [];
  const createdBy = e.createdBy?.fullName || (e.source === 'mcp' ? 'Claude Code' : 'Hệ thống');

  // ── Zalo quản lí ──────────────────────────────────────────────────────────
  let zalo = 'skipped: tắt trong cấu hình';
  if (cfg.escalation.notifyZalo) {
    zalo = await deliverZalo(e, cfg.escalation.managerConversationId, plainSummary(e, excerpt, createdBy));
  }

  // ── Telegram ──────────────────────────────────────────────────────────────
  let telegram = 'skipped: tắt trong cấu hình';
  if (cfg.escalation.notifyTelegram && cfg.telegram.notifyEscalations) {
    try {
      const r = await notifyOrgChats(e.orgId, htmlSummary(e, excerpt, createdBy), escalationKeyboard(e.id));
      telegram = r.skipped ? `skipped: ${r.skipped}` : r.failed && !r.sent ? `failed: ${r.failed} chat lỗi` : `sent: ${r.sent} chat`;
    } catch (err) {
      telegram = `failed: ${(err as Error).message}`.slice(0, 200);
    }
  }

  await prisma.escalation.update({ where: { id }, data: { zaloDelivery: zalo.slice(0, 250), telegramDelivery: telegram.slice(0, 250) } });
  logger.info(`[escalation] ${id} delivery zalo="${zalo}" telegram="${telegram}"`);
  return { zalo, telegram };
}

async function deliverZalo(e: any, managerConversationId: string | null, text: string): Promise<string> {
  const manager = await prisma.zaloAccount.findFirst({
    where: { orgId: e.orgId, isManager: true },
    select: { id: true, zaloUid: true, displayName: true },
  });
  if (!manager) return 'skipped: chưa chọn tài khoản Zalo quản lí';

  try {
    // Mode 1: manager account posts into a chosen conversation (e.g. managers' group)
    if (managerConversationId) {
      const target = await prisma.conversation.findFirst({
        where: { id: managerConversationId, orgId: e.orgId, zaloAccountId: manager.id },
        select: { externalThreadId: true, threadType: true },
      });
      if (!target?.externalThreadId) return 'failed: hội thoại nhận ca khó không còn thuộc Zalo quản lí';
      const api = zaloPool.getApi(manager.id);
      if (!api) return 'failed: Zalo quản lí chưa kết nối';
      const lim = zaloRateLimiter.checkLimits(manager.id);
      if (!lim.allowed) return `failed: ${lim.reason}`;
      zaloRateLimiter.recordSend(manager.id);
      await api.sendMessage({ msg: text }, target.externalThreadId, target.threadType === 'group' ? 1 : 0);
      return `sent: Zalo quản lí → ${target.threadType === 'group' ? 'nhóm' : 'hội thoại'} đã chọn`;
    }

    // Mode 2: the conversation's own Zalo account messages the manager account directly
    const senderId: string | undefined = e.conversation?.zaloAccountId;
    if (!senderId) return 'skipped: ca khó không gắn hội thoại';
    if (senderId === manager.id) return 'skipped: hội thoại thuộc chính Zalo quản lí — hãy chọn nhóm nhận ca khó trong Cấu hình';
    if (!manager.zaloUid) return 'failed: Zalo quản lí chưa đăng nhập lần nào (thiếu UID)';
    const api = zaloPool.getApi(senderId);
    if (!api) return 'failed: Zalo của hội thoại chưa kết nối';
    const lim = zaloRateLimiter.checkLimits(senderId);
    if (!lim.allowed) return `failed: ${lim.reason}`;
    zaloRateLimiter.recordSend(senderId);
    await api.sendMessage({ msg: text }, manager.zaloUid, 0);
    return `sent: → ${manager.displayName || 'Zalo quản lí'}`;
  } catch (err) {
    return `failed: ${String((err as Error)?.message || err)}`.slice(0, 200);
  }
}

export async function updateEscalationStatus(args: {
  orgId: string;
  id: string;
  status: EscalationStatus;
  resolution?: string | null;
  actorUserId?: string | null;
  actorName: string;
  via: 'web' | 'telegram' | 'mcp';
}) {
  const existing = await prisma.escalation.findFirst({ where: { id: args.id, orgId: args.orgId }, select: { id: true, status: true, title: true } });
  if (!existing) return null;
  const done = args.status !== 'open';
  const updated = await prisma.escalation.update({
    where: { id: args.id },
    data: {
      status: args.status,
      resolution: args.resolution?.trim().slice(0, 2000) || undefined,
      resolvedByUserId: done ? args.actorUserId ?? null : null,
      resolvedByName: done ? args.actorName.slice(0, 120) : null,
      resolvedVia: done ? args.via : null,
      resolvedAt: done ? new Date() : null,
    },
    include: ESCALATION_INCLUDE,
  });
  logger.info(`[escalation] ${args.id} ${existing.status} → ${args.status} by ${args.actorName} via ${args.via}`);
  io?.to(`org:${args.orgId}`).emit('escalation:updated', { id: updated.id, status: updated.status });
  emitWebhook(args.orgId, 'escalation.updated', { escalationId: updated.id, status: updated.status, via: args.via }).catch(() => {});

  // Tell Telegram when the change did not come from Telegram itself
  if (args.via !== 'telegram') {
    const cfg = await getOrgConfig(args.orgId);
    if (cfg.telegram.notifyEscalations) {
      notifyOrgChats(
        args.orgId,
        `📌 Ca khó <code>${esc(updated.id.slice(0, 8))}</code> «${esc(updated.title)}» → <b>${esc(STATUS_LABEL[updated.status])}</b> bởi ${esc(args.actorName)}${updated.resolution ? '\n' + esc(updated.resolution) : ''}`,
      ).catch(() => {});
    }
  }
  return updated;
}

export { ESCALATION_INCLUDE };
