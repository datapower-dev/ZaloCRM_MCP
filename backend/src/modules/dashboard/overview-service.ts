/**
 * overview-service.ts — org overview numbers shared by the web dashboard,
 * the Telegram bot (/tongquan) and the MCP tool crm_overview.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { getOrgConfig } from '../settings/org-config.js';

export function vnDayRange(now = new Date()) {
  const off = 7 * 3600_000;
  const vn = new Date(now.getTime() + off);
  const start = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - off);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export interface OrgOverview {
  messagesToday: number;
  incomingToday: number;
  unreplied: number;
  waitingOverWarn: number;
  overdue: number;
  openEscalations: number;
  newContactsWeek: number;
  totalContacts: number;
  zaloConnected: number;
  zaloTotal: number;
  ordersToday: number;
  revenueToday: number;
  channelsListening: number;
  channelsAiAssist: number;
  sla: { warnMinutes: number; overdueMinutes: number };
}

export async function getOrgOverview(orgId: string): Promise<OrgOverview> {
  const cfg = await getOrgConfig(orgId);
  const { start, end } = vnDayRange();
  const now = Date.now();
  const warnBefore = new Date(now - cfg.sla.warnMinutes * 60_000);
  const overdueBefore = new Date(now - cfg.sla.overdueMinutes * 60_000);
  const weekAgo = new Date(now - 7 * 86_400_000);

  const unrepliedWhere = { orgId, isReplied: false, listening: true };
  const [
    messagesToday, incomingToday, unreplied, waitingOverWarn, overdue, openEscalations,
    newContactsWeek, totalContacts, accounts, ordersToday, revenue, channelsListening, channelsAiAssist,
  ] = await Promise.all([
    prisma.message.count({ where: { conversation: { orgId }, sentAt: { gte: start, lt: end } } }),
    prisma.message.count({ where: { conversation: { orgId }, senderType: 'contact', sentAt: { gte: start, lt: end } } }),
    prisma.conversation.count({ where: unrepliedWhere }),
    prisma.conversation.count({ where: { ...unrepliedWhere, lastMessageAt: { lt: warnBefore } } }),
    prisma.conversation.count({ where: { ...unrepliedWhere, lastMessageAt: { lt: overdueBefore } } }),
    prisma.escalation.count({ where: { orgId, status: 'open' } }),
    prisma.contact.count({ where: { orgId, createdAt: { gte: weekAgo } } }),
    prisma.contact.count({ where: { orgId } }),
    prisma.zaloAccount.findMany({ where: { orgId }, select: { id: true } }),
    prisma.order.count({ where: { orgId, createdAt: { gte: start, lt: end } } }),
    prisma.order.aggregate({ where: { orgId, status: 'completed', createdAt: { gte: start, lt: end } }, _sum: { totalAmount: true } }),
    prisma.conversation.count({ where: { orgId, listening: true } }),
    prisma.conversation.count({ where: { orgId, aiAssist: true } }),
  ]);

  return {
    messagesToday,
    incomingToday,
    unreplied,
    waitingOverWarn,
    overdue,
    openEscalations,
    newContactsWeek,
    totalContacts,
    zaloConnected: accounts.filter((a) => zaloPool.getStatus(a.id) === 'connected').length,
    zaloTotal: accounts.length,
    ordersToday,
    revenueToday: Number(revenue._sum.totalAmount ?? 0),
    channelsListening,
    channelsAiAssist,
    sla: { warnMinutes: cfg.sla.warnMinutes, overdueMinutes: cfg.sla.overdueMinutes },
  };
}

export async function listOverdueConversations(orgId: string, limit = 10) {
  const cfg = await getOrgConfig(orgId);
  const before = new Date(Date.now() - cfg.sla.overdueMinutes * 60_000);
  return prisma.conversation.findMany({
    where: { orgId, isReplied: false, listening: true, lastMessageAt: { lt: before } },
    select: {
      id: true,
      threadType: true,
      lastMessageAt: true,
      unreadCount: true,
      contact: { select: { fullName: true } },
      zaloAccount: { select: { displayName: true } },
      supporter: { select: { fullName: true } },
    },
    orderBy: { lastMessageAt: 'asc' },
    take: limit,
  });
}
