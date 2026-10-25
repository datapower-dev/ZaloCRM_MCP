/**
 * Zalo Socket.IO event handlers + connection authentication.
 *
 * Every socket must present a valid JWT (socket.handshake.auth.token or
 * `Authorization: Bearer …` header). On connect the socket automatically joins
 * its organization room `org:<orgId>`; all server→client events are emitted to
 * that room only. Clients may additionally subscribe to `account:<id>` rooms
 * (QR login progress) but only for Zalo accounts that belong to their org.
 */
import type { FastifyInstance } from 'fastify';
import type { Server, Socket } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { accountRoom, orgRoom } from './zalo-pool.js';

export interface SocketUser {
  id: string;
  email: string;
  role: string;
  orgId: string;
}

function extractToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  if (auth && typeof auth.token === 'string' && auth.token) return auth.token;
  const header = socket.handshake.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

export function registerZaloSocketHandlers(io: Server, app: FastifyInstance): void {
  // ── Authentication middleware ─────────────────────────────────────────────
  io.use((socket, next) => {
    const token = extractToken(socket);
    if (!token) return next(new Error('Unauthorized'));
    try {
      const user = app.jwt.verify<SocketUser>(token);
      if (!user?.id || !user?.orgId) return next(new Error('Unauthorized'));
      (socket.data as { user: SocketUser }).user = user;
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket.data as { user: SocketUser }).user;
    socket.join(orgRoom(user.orgId));
    logger.debug(`Socket ${socket.id} connected as ${user.email} → ${orgRoom(user.orgId)}`);

    // Subscribe to QR/status updates for a specific Zalo account (must belong to the org)
    socket.on('zalo:subscribe', async (data: { accountId?: string }) => {
      const accountId = typeof data?.accountId === 'string' ? data.accountId : '';
      if (!accountId) return;
      try {
        const account = await prisma.zaloAccount.findFirst({
          where: { id: accountId, orgId: user.orgId },
          select: { id: true },
        });
        if (!account) {
          socket.emit('zalo:error', { accountId, error: 'Không có quyền theo dõi tài khoản này' });
          return;
        }
        socket.join(accountRoom(accountId));
        logger.debug(`Socket ${socket.id} joined ${accountRoom(accountId)}`);
      } catch (err) {
        logger.warn('[socket] zalo:subscribe failed:', err);
      }
    });

    // Unsubscribe from a specific account room
    socket.on('zalo:unsubscribe', (data: { accountId?: string }) => {
      const accountId = typeof data?.accountId === 'string' ? data.accountId : '';
      if (!accountId) return;
      socket.leave(accountRoom(accountId));
    });

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${socket.id}`);
    });
  });
}
