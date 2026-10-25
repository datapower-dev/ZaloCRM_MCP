/**
 * Zalo account management routes.
 * All endpoints require authentication. Creating accounts needs owner/admin;
 * login / reconnect / delete need owner/admin or `admin` permission on that account.
 * Session credentials are never returned to the client.
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { requireZaloAccess } from './zalo-access-middleware.js';
import { zaloPool } from './zalo-pool.js';
import { parseSession } from './zalo-session.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

export async function zaloRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin require auth
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/zalo-accounts — list accounts with live status from pool
  app.get('/api/v1/zalo-accounts', async (request) => {
    const user = request.user!;
    const where: Record<string, unknown> = { orgId: user.orgId };

    // Members only see accounts they were granted access to
    if (user.role === 'member') {
      const access = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      where.id = { in: access.map((a) => a.zaloAccountId) };
    }

    const accounts = await prisma.zaloAccount.findMany({
      where,
      select: {
        id: true,
        zaloUid: true,
        displayName: true,
        avatarUrl: true,
        phone: true,
        status: true,
        lastConnectedAt: true,
        createdAt: true,
        ownerUserId: true,
        sessionData: true,
        owner: { select: { id: true, fullName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Merge live status from pool; never expose session credentials — only whether one exists
    return accounts.map(({ sessionData, ...a }) => ({
      ...a,
      hasSession: parseSession(sessionData) !== null,
      liveStatus: zaloPool.getStatus(a.id),
    }));
  });

  // POST /api/v1/zalo-accounts — create a new account record (owner/admin)
  app.post<{ Body: { displayName?: string } }>(
    '/api/v1/zalo-accounts',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { displayName } = request.body ?? {};

      const account = await prisma.zaloAccount.create({
        data: {
          orgId: user.orgId,
          ownerUserId: user.id,
          displayName: typeof displayName === 'string' ? displayName.slice(0, 100) : null,
          status: 'qr_pending',
        },
        select: { id: true, displayName: true, status: true, createdAt: true },
      });

      logger.info(`Zalo account created ${account.id} by ${user.email}`);
      return reply.status(201).send(account);
    },
  );

  // POST /api/v1/zalo-accounts/:id/login — initiate QR login
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/login',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      // Fire-and-forget — QR delivered via Socket.IO (account room, org-scoped)
      zaloPool.loginQR(id).catch(() => {
        // errors are emitted via socket; no need to crash here
      });

      return { message: 'QR login initiated — subscribe to account:' + id + ' socket room' };
    },
  );

  // POST /api/v1/zalo-accounts/:id/reconnect — force reconnect using saved session
  app.post<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/reconnect',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, sessionData: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      const session = parseSession(account.sessionData);
      if (!session) {
        return reply.status(400).send({ error: 'No saved session — please login with QR first' });
      }

      // Fire-and-forget — result emitted via Socket.IO
      zaloPool.reconnect(id, session).catch(() => {});

      return { message: 'Reconnect initiated' };
    },
  );

  // DELETE /api/v1/zalo-accounts/:id — disconnect and delete record
  app.delete<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id',
    { preHandler: requireZaloAccess('admin') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      zaloPool.disconnect(id);
      await prisma.zaloAccount.delete({ where: { id } });
      logger.info(`Zalo account deleted ${id} by ${user.email}`);

      return reply.status(204).send();
    },
  );

  // GET /api/v1/zalo-accounts/:id/status — live status from pool
  app.get<{ Params: { id: string } }>(
    '/api/v1/zalo-accounts/:id/status',
    { preHandler: requireZaloAccess('read') },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.user!;

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true, status: true },
      });
      if (!account) {
        return reply.status(404).send({ error: 'Account not found' });
      }

      return { accountId: id, liveStatus: zaloPool.getStatus(id) };
    },
  );
}
