/**
 * Main application entry point.
 * Bootstraps Fastify server with all plugins, Socket.IO, and route handlers.
 * The process never exits on runtime errors — all are caught and logged.
 * It DOES refuse to start when required secrets are missing (see config).
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Prisma } from '@prisma/client';
import { config } from './config/index.js';
import { prisma } from './shared/database/prisma-client.js';
import { logger } from './shared/utils/logger.js';
import { authRoutes } from './modules/auth/auth-routes.js';
import { zaloRoutes } from './modules/zalo/zalo-routes.js';
import { chatRoutes } from './modules/chat/chat-routes.js';
import { contactRoutes } from './modules/contacts/contact-routes.js';
import { contactSubResourceRoutes } from './modules/contacts/contact-sub-resource-routes.js';
import { appointmentRoutes } from './modules/contacts/appointment-routes.js';
import { startAppointmentReminder } from './modules/contacts/appointment-reminder.js';
import { dashboardRoutes } from './modules/dashboard/dashboard-routes.js';
import { reportRoutes } from './modules/dashboard/report-routes.js';
import { userRoutes } from './modules/auth/user-routes.js';
import { teamRoutes } from './modules/auth/team-routes.js';
import { orgRoutes } from './modules/auth/org-routes.js';
import { zaloAccessRoutes } from './modules/zalo/zalo-access-routes.js';
import { zaloSyncRoutes } from './modules/zalo/zalo-sync-routes.js';
import { zaloPool } from './modules/zalo/zalo-pool.js';
import { registerZaloSocketHandlers } from './modules/zalo/zalo-socket.js';
import { migrateLegacySessions, parseSession } from './modules/zalo/zalo-session.js';
import { notificationRoutes } from './modules/notifications/notification-routes.js';
import { searchRoutes } from './modules/search/search-routes.js';
import { startZaloHealthCheck } from './modules/zalo/zalo-health-check.js';
import { publicApiRoutes } from './modules/api/public-api-routes.js';
import { webhookSettingsRoutes } from './modules/api/webhook-settings-routes.js';
import { orderRoutes } from './modules/orders/order-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap() {
  const app = Fastify({
    logger: false,
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 1 * 1024 * 1024, // 1 MB JSON bodies are plenty for this API
  });

  // ── Plugins ──────────────────────────────────────────────────────────────

  // CORS: only the configured frontend origin(s). Non-browser clients send no
  // Origin header and are unaffected (they still need a JWT / API key).
  await app.register(cors, {
    origin: config.allowedOrigins,
    credentials: true,
  });

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });

  // Global rate limit keyed by client IP only. (Keying by an *unauthenticated*
  // header such as x-api-key would let a client dodge the limit by rotating it.)
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // Basic security headers
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.isProduction) {
      reply.header('Cache-Control', reply.getHeader('Cache-Control') ?? 'no-store');
    }
  });

  // Serve compiled frontend assets in production
  if (config.isProduction) {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../static'),
      prefix: '/',
    });
  }

  // ── Socket.IO ─────────────────────────────────────────────────────────────

  const io = new Server(app.server, {
    cors: {
      origin: config.allowedOrigins,
      credentials: true,
    },
    // Keep payloads small; the server only pushes notifications/messages.
    maxHttpBufferSize: 64 * 1024,
  });

  // Attach io to app so route handlers can emit events
  app.decorate('io', io);

  // Pass io to zalo pool for real-time event emission
  zaloPool.setIO(io);

  // JWT-authenticated sockets, auto-joined to their org room
  registerZaloSocketHandlers(io, app);

  // ── Routes ────────────────────────────────────────────────────────────────

  await app.register(authRoutes);
  await app.register(zaloRoutes);
  await app.register(chatRoutes);
  await app.register(contactRoutes);
  await app.register(contactSubResourceRoutes);
  await app.register(appointmentRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(userRoutes);
  await app.register(teamRoutes);
  await app.register(orgRoutes);
  await app.register(zaloAccessRoutes);
  await app.register(zaloSyncRoutes);
  await app.register(notificationRoutes);
  await app.register(searchRoutes);
  if (config.publicApiEnabled) {
    await app.register(publicApiRoutes);
  } else {
    logger.info('Public API (X-API-Key) disabled via PUBLIC_API_ENABLED=false');
  }
  await app.register(webhookSettingsRoutes);
  await app.register(orderRoutes);

  // Liveness/readiness probe — also checks DB connectivity
  app.get('/health', async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  });

  // API version banner
  app.get('/api/v1/status', async () => {
    return { version: '1.1.0', name: 'Zalo CRM' };
  });

  // SPA fallback — serve index.html for non-API routes in production
  if (config.isProduction) {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // ── Error handler ─────────────────────────────────────────────────────────

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // Never leak internals (Prisma/SQL/stack) to clients
      logger.error(`Request error ${request.method} ${request.url}:`, error);
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
    reply.status(status).send({ error: error.message || 'Request failed' });
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Zalo CRM running on http://${config.host}:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}; allowed origins: ${config.allowedOrigins.join(', ')}`);
    startAppointmentReminder(io);
    startZaloHealthCheck();
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }

  // Encrypt any plaintext sessions left by older versions
  try {
    await migrateLegacySessions();
  } catch (err) {
    logger.error('Failed to migrate legacy sessions:', err);
  }

  // Reconnect Zalo accounts that have saved sessions (staggered to avoid rate limits)
  try {
    const accounts = await prisma.zaloAccount.findMany({
      where: { sessionData: { not: Prisma.JsonNull } },
      select: { id: true, sessionData: true },
    });
    logger.info(`Attempting reconnect for ${accounts.length} Zalo account(s)`);
    for (const account of accounts) {
      const session = parseSession(account.sessionData);
      if (session) {
        // Stagger reconnects: 10 seconds between each account to avoid rate limits
        await new Promise((r) => setTimeout(r, 10_000));
        zaloPool.reconnect(account.id, session).catch((err) => {
          logger.warn(`Auto-reconnect failed for account ${account.id}:`, err);
        });
      }
    }
  } catch (err) {
    logger.error('Failed to load accounts for reconnect:', err);
  }
}

// Keep process alive — log but never crash on unhandled errors
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

bootstrap();
