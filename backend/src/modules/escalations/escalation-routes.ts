/**
 * escalation-routes.ts — REST API for "Ca khó".
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { hasPermission, requirePermission } from '../settings/org-config.js';
import { canSeeConversation, conversationScope } from '../channels/channel-access.js';
import {
  createEscalation, deliverEscalation, updateEscalationStatus, validateEscalationInput,
  ESCALATION_INCLUDE, STATUSES, type EscalationStatus,
} from './escalation-service.js';

export async function escalationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // POST /api/v1/conversations/:id/escalations — chuyển ca khó từ một hội thoại
  app.post('/api/v1/conversations/:id/escalations', {
    preHandler: requirePermission('escalations.create'),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const err = validateEscalationInput(body);
    if (err) return reply.status(400).send({ error: err });

    const conv = await canSeeConversation(user, id);
    if (!conv) return reply.status(404).send({ error: 'Không tìm thấy hội thoại' });

    const result = await createEscalation({
      orgId: user.orgId,
      userId: user.id,
      conversationId: id,
      title: String(body.title),
      detail: (body.detail as string) ?? null,
      priority: body.priority as string | undefined,
      category: body.category as string | undefined,
    });
    return reply.status(201).send(result);
  });

  // GET /api/v1/escalations?status=&mine=1&page=&limit=
  app.get('/api/v1/escalations', async (request: FastifyRequest) => {
    const user = request.user!;
    const q = request.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(q.page || '1') || 1);
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || '30') || 30));

    const where: Record<string, unknown> = { orgId: user.orgId };
    if (q.status && STATUSES.includes(q.status as EscalationStatus)) where.status = q.status;
    // Users without "resolve" only see ca khó they created or that belong to channels they can see
    const canResolve = await hasPermission(user, 'escalations.resolve');
    if (!canResolve || q.mine === '1') {
      const scope = await conversationScope(user);
      where.OR = [{ createdByUserId: user.id }, ...(q.mine === '1' ? [] : [{ conversation: scope }])];
    }
    const [items, total, open] = await Promise.all([
      prisma.escalation.findMany({ where, include: ESCALATION_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.escalation.count({ where }),
      prisma.escalation.count({ where: { ...where, status: 'open' } }),
    ]);
    return { items, total, open, page, limit, canResolve };
  });

  // PATCH /api/v1/escalations/:id — { status, resolution }
  app.patch('/api/v1/escalations/:id', { preHandler: requirePermission('escalations.resolve') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { status?: unknown; resolution?: unknown };
    if (!STATUSES.includes(body.status as EscalationStatus)) return reply.status(400).send({ error: 'Trạng thái không hợp lệ' });
    if (body.resolution !== undefined && body.resolution !== null && (typeof body.resolution !== 'string' || body.resolution.length > 2000)) {
      return reply.status(400).send({ error: 'Ghi chú tối đa 2000 ký tự' });
    }
    const me = await prisma.user.findUnique({ where: { id: user.id }, select: { fullName: true } });
    const updated = await updateEscalationStatus({
      orgId: user.orgId,
      id,
      status: body.status as EscalationStatus,
      resolution: (body.resolution as string) ?? null,
      actorUserId: user.id,
      actorName: me?.fullName || user.email,
      via: 'web',
    });
    if (!updated) return reply.status(404).send({ error: 'Không tìm thấy ca khó' });
    return updated;
  });

  // POST /api/v1/escalations/:id/resend — gửi lại Zalo/Telegram
  app.post('/api/v1/escalations/:id/resend', {
    preHandler: requirePermission('escalations.create'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const e = await prisma.escalation.findFirst({ where: { id, orgId: user.orgId }, select: { id: true, createdByUserId: true } });
    if (!e) return reply.status(404).send({ error: 'Không tìm thấy ca khó' });
    if (e.createdByUserId !== user.id && !(await hasPermission(user, 'escalations.resolve'))) {
      return reply.status(403).send({ error: 'Không có quyền' });
    }
    return deliverEscalation(id);
  });
}
