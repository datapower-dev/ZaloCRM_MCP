/**
 * Auth routes — setup, login, and profile endpoints.
 * Registered as a Fastify plugin via app.register(authRoutes).
 */
import type { FastifyInstance } from 'fastify';
import { authMiddleware } from './auth-middleware.js';
import { validatePassword } from './password-policy.js';
import { logger } from '../../shared/utils/logger.js';
import {
  checkSetupStatus,
  setup,
  login,
  getProfile,
} from './auth-service.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/setup/status — check if first-run setup is needed
  app.get('/api/v1/setup/status', async () => {
    return checkSetupStatus();
  });

  // POST /api/v1/setup — create org + owner user, return JWT
  app.post<{
    Body: { orgName: string; fullName: string; email: string; password: string };
  }>('/api/v1/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { orgName, fullName, email, password } = request.body ?? ({} as any);
    if (!orgName || !fullName || !email || !password) {
      return reply.status(400).send({ error: 'Missing required fields' });
    }
    const pwError = validatePassword(password);
    if (pwError) return reply.status(400).send({ error: pwError });
    const payload = await setup(String(orgName).slice(0, 200), String(fullName).slice(0, 200), String(email), password);
    const token = app.jwt.sign(payload);
    logger.info(`[auth] Setup completed by ${payload.email} from ${request.ip}`);
    return { token, user: payload };
  });

  // POST /api/v1/auth/login — verify credentials, return JWT
  // Brute-force protection: 10 attempts / minute / IP on top of the global limit
  app.post<{
    Body: { email: string; password: string };
  }>('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { email, password } = request.body ?? ({} as any);
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return reply.status(400).send({ error: 'Missing email or password' });
    }
    try {
      const payload = await login(email, password);
      const token = app.jwt.sign(payload);
      logger.info(`[auth] Login ok ${payload.email} from ${request.ip}`);
      return { token, user: payload };
    } catch (err) {
      logger.warn(`[auth] Login failed for ${email.slice(0, 100)} from ${request.ip}`);
      throw err;
    }
  });

  // GET /api/v1/profile — return current user (requires auth)
  app.get('/api/v1/profile', { preHandler: authMiddleware }, async (request) => {
    const user = request.user as { id: string; email: string; role: string; orgId: string };
    return getProfile(user.id);
  });
}
