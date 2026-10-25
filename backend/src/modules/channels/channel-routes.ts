/**
 * channel-routes.ts — "Kênh Tư Vấn": list group / P2P conversations with
 * listening + AI-assist toggles and supporter assignment.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requirePermission } from '../settings/org-config.js';
import { conversationScope } from './channel-access.js';

type Q = Record<string, string | undefined>;

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/channels?type=group|user&search=&accountId=&status=listening|muted|ai|unassigned&page=&limit=
  app.get('/api/v1/channels', { preHandler: requirePermission('channels.view') }, async (request: FastifyRequest) => {
    const user = request.user!;
    const q = request.query as Q;
    const page = Math.max(1, parseInt(q.page || '1') || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50') || 50));

    const scope = await conversationScope(user);
    const and: Record<string, unknown>[] = [scope];
    if (q.type === 'group' || q.type === 'user') and.push({ threadType: q.type });
    if (q.accountId) and.push({ zaloAccountId: q.accountId });
    if (q.status === 'listening') and.push({ listening: true });
    if (q.status === 'muted') and.push({ listening: false });
    if (q.status === 'ai') and.push({ aiAssist: true });
    if (q.status === 'unassigned') and.push({ supporterUserId: null });
    const search = (q.search || '').trim().slice(0, 100);
    if (search) {
      and.push({
        OR: [
          { externalThreadId: { contains: search } },
          { contact: { fullName: { contains: search, mode: 'insensitive' } } },
          { contact: { phone: { contains: search } } },
        ],
      });
    }
    const where = { AND: and };

    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        select: {
          id: true,
          threadType: true,
          externalThreadId: true,
          lastMessageAt: true,
          unreadCount: true,
          isReplied: true,
          listening: true,
          aiAssist: true,
          supporterUserId: true,
          contact: { select: { id: true, fullName: true, avatarUrl: true } },
          zaloAccount: { select: { id: true, displayName: true } },
          supporter: { select: { id: true, fullName: true } },
        },
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.conversation.count({ where }),
    ]);

    // "Số lượt hỏi" = incoming messages per conversation
    const counts = rows.length
      ? await prisma.message.groupBy({
          by: ['conversationId'],
          where: { conversationId: { in: rows.map((r) => r.id) }, senderType: 'contact' },
          _count: true,
        })
      : [];
    const countMap = new Map(counts.map((c) => [c.conversationId, c._count]));

    return {
      channels: rows.map((r) => ({ ...r, questionCount: countMap.get(r.id) ?? 0 })),
      total,
      page,
      limit,
    };
  });

  // GET /api/v1/channels/summary — counts for the header chips
  app.get('/api/v1/channels/summary', { preHandler: requirePermission('channels.view') }, async (request) => {
    const scope = await conversationScope(request.user!);
    const count = (extra: Record<string, unknown>) => prisma.conversation.count({ where: { AND: [scope, extra] } });
    const [groups, p2p, listening, muted, ai, unassigned] = await Promise.all([
      count({ threadType: 'group' }),
      count({ threadType: 'user' }),
      count({ listening: true }),
      count({ listening: false }),
      count({ aiAssist: true }),
      count({ supporterUserId: null }),
    ]);
    return { groups, p2p, listening, muted, ai, unassigned };
  });

  // PATCH /api/v1/channels/:id — { listening?, aiAssist?, supporterUserId? }
  app.patch('/api/v1/channels/:id', { preHandler: requirePermission('channels.manage') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { listening?: unknown; aiAssist?: unknown; supporterUserId?: unknown };

    const scope = await conversationScope(user);
    const conv = await prisma.conversation.findFirst({ where: { AND: [scope, { id }] }, select: { id: true } });
    if (!conv) return reply.status(404).send({ error: 'Không tìm thấy kênh' });

    const data = await buildUpdate(user.orgId, body);
    if ('error' in data) return reply.status(400).send({ error: data.error });

    const updated = await prisma.conversation.update({
      where: { id },
      data: data.update,
      select: {
        id: true, listening: true, aiAssist: true, supporterUserId: true,
        supporter: { select: { id: true, fullName: true } },
      },
    });
    logger.info(`[channels] ${user.email} updated ${id}: ${JSON.stringify(data.update)}`);
    return updated;
  });

  // POST /api/v1/channels/bulk — { ids: string[], listening?, aiAssist?, supporterUserId? }
  app.post('/api/v1/channels/bulk', { preHandler: requirePermission('channels.manage') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as { ids?: unknown; listening?: unknown; aiAssist?: unknown; supporterUserId?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500 || !body.ids.every((x) => typeof x === 'string')) {
      return reply.status(400).send({ error: 'ids phải là mảng 1–500 phần tử' });
    }
    const data = await buildUpdate(user.orgId, body);
    if ('error' in data) return reply.status(400).send({ error: data.error });
    const scope = await conversationScope(user);
    const res = await prisma.conversation.updateMany({
      where: { AND: [scope, { id: { in: body.ids as string[] } }] },
      data: data.update,
    });
    logger.info(`[channels] ${user.email} bulk-updated ${res.count} channel(s): ${JSON.stringify(data.update)}`);
    return { updated: res.count };
  });
}

async function buildUpdate(
  orgId: string,
  body: { listening?: unknown; aiAssist?: unknown; supporterUserId?: unknown },
): Promise<{ update: Record<string, unknown> } | { error: string }> {
  const update: Record<string, unknown> = {};
  if (body.listening !== undefined) {
    if (typeof body.listening !== 'boolean') return { error: 'listening phải là true/false' };
    update.listening = body.listening;
  }
  if (body.aiAssist !== undefined) {
    if (typeof body.aiAssist !== 'boolean') return { error: 'aiAssist phải là true/false' };
    update.aiAssist = body.aiAssist;
  }
  if (body.supporterUserId !== undefined) {
    if (body.supporterUserId === null || body.supporterUserId === '') {
      update.supporterUserId = null;
    } else if (typeof body.supporterUserId === 'string') {
      const u = await prisma.user.findFirst({ where: { id: body.supporterUserId, orgId, isActive: true }, select: { id: true } });
      if (!u) return { error: 'Người hỗ trợ không thuộc tổ chức' };
      update.supporterUserId = u.id;
    } else {
      return { error: 'supporterUserId không hợp lệ' };
    }
  }
  if (Object.keys(update).length === 0) return { error: 'Không có thay đổi' };
  return { update };
}
