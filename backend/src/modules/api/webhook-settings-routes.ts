/**
 * webhook-settings-routes.ts — Manage webhook URL/secret and public API key generation.
 * All routes require JWT auth AND owner/admin role (a webhook can forward every
 * message of the organization, an API key can read every contact).
 *
 * API keys are stored as SHA-256 hashes (`public_api_key_hash`) plus a short
 * display hint (`public_api_key_hint`). The plaintext key is shown exactly once.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { logger } from '../../shared/utils/logger.js';
import { emitWebhook } from './webhook-service.js';
import { assertSafeWebhookUrl } from '../../shared/utils/url-guard.js';
import { sha256Hex } from '../../shared/utils/crypto.js';
import crypto from 'node:crypto';

const MAX_URL_LENGTH = 2048;
const MAX_SECRET_LENGTH = 256;

export async function webhookSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);
  app.addHook('preHandler', requireRole('owner', 'admin'));

  // GET /api/v1/settings/webhook — retrieve current webhook config
  app.get('/api/v1/settings/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const [urlSetting, secretSetting] = await Promise.all([
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_url' } }),
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_secret' } }),
      ]);

      return {
        url: urlSetting?.valuePlain ?? null,
        // Mask secret — show only last 4 chars
        secret: secretSetting?.valuePlain
          ? `${'*'.repeat(Math.max(0, secretSetting.valuePlain.length - 4))}${secretSetting.valuePlain.slice(-4)}`
          : null,
      };
    } catch (err) {
      logger.error('[webhook-settings] GET error:', err);
      return reply.status(500).send({ error: 'Failed to fetch webhook settings' });
    }
  });

  // PUT /api/v1/settings/webhook — save webhook URL and secret
  app.put('/api/v1/settings/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const { orgId, email } = request.user!;
    const body = (request.body ?? {}) as { url?: unknown; secret?: unknown };

    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (rawUrl.length > MAX_URL_LENGTH) {
      return reply.status(400).send({ error: 'Webhook URL quá dài' });
    }
    let url = '';
    if (rawUrl) {
      try {
        url = await assertSafeWebhookUrl(rawUrl);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    }

    let secret: string | undefined;
    if (body.secret !== undefined) {
      if (typeof body.secret !== 'string' || body.secret.length > MAX_SECRET_LENGTH) {
        return reply.status(400).send({ error: 'Webhook secret không hợp lệ' });
      }
      // A masked value coming back from the UI ("****abcd") means "unchanged"
      secret = body.secret.startsWith('****') ? undefined : body.secret;
    }

    try {
      await Promise.all([
        upsertSetting(orgId, 'webhook_url', url),
        secret !== undefined ? upsertSetting(orgId, 'webhook_secret', secret) : Promise.resolve(),
      ]);
      logger.info(`[webhook-settings] Webhook ${url ? 'set to ' + new URL(url).host : 'cleared'} by ${email}`);
      return { success: true };
    } catch (err) {
      logger.error('[webhook-settings] PUT error:', err);
      return reply.status(500).send({ error: 'Failed to save webhook settings' });
    }
  });

  // POST /api/v1/settings/webhook/test — deliver a test event to configured URL
  app.post('/api/v1/settings/webhook/test', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const setting = await prisma.appSetting.findFirst({ where: { orgId, settingKey: 'webhook_url' } });
      if (!setting?.valuePlain) {
        return reply.status(400).send({ error: 'No webhook URL configured' });
      }

      await emitWebhook(orgId, 'webhook.test', { message: 'Test event from Zalo CRM', orgId });
      return { success: true, sentTo: setting.valuePlain };
    } catch (err) {
      logger.error('[webhook-settings] Test error:', err);
      return reply.status(500).send({ error: 'Failed to send test webhook' });
    }
  });

  // POST /api/v1/settings/api-key/generate — generate new public API key (shown once)
  app.post('/api/v1/settings/api-key/generate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId, email } = request.user!;

      const newKey = `zcrm_${crypto.randomBytes(24).toString('hex')}`;
      const hint = `${newKey.slice(0, 9)}…${newKey.slice(-4)}`;
      // Sequential, atomic: hash + hint written together, legacy plaintext key removed
      await prisma.$transaction([
        upsertSettingOp(orgId, 'public_api_key_hash', sha256Hex(newKey)),
        upsertSettingOp(orgId, 'public_api_key_hint', hint),
        prisma.appSetting.deleteMany({ where: { orgId, settingKey: 'public_api_key' } }),
      ]);
      logger.info(`[webhook-settings] Public API key rotated by ${email}`);

      return { key: newKey };
    } catch (err) {
      logger.error('[webhook-settings] Generate API key error:', err);
      return reply.status(500).send({ error: 'Failed to generate API key' });
    }
  });

  // DELETE /api/v1/settings/api-key — revoke public API key
  app.delete('/api/v1/settings/api-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId, email } = request.user!;
      await prisma.appSetting.deleteMany({
        where: { orgId, settingKey: { in: ['public_api_key', 'public_api_key_hash', 'public_api_key_hint'] } },
      });
      logger.info(`[webhook-settings] Public API key revoked by ${email}`);
      return { success: true };
    } catch (err) {
      logger.error('[webhook-settings] Revoke API key error:', err);
      return reply.status(500).send({ error: 'Failed to revoke API key' });
    }
  });

  // GET /api/v1/settings/api-key — retrieve masked API key hint
  app.get('/api/v1/settings/api-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { orgId } = request.user!;

      const [hint, legacy] = await Promise.all([
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'public_api_key_hint' } }),
        prisma.appSetting.findFirst({ where: { orgId, settingKey: 'public_api_key' } }),
      ]);
      if (hint?.valuePlain) return { key: hint.valuePlain, legacy: false };
      if (legacy?.valuePlain) {
        const k = legacy.valuePlain;
        return { key: `${k.slice(0, 9)}…${k.slice(-4)}`, legacy: true };
      }
      return { key: null, legacy: false };
    } catch (err) {
      logger.error('[webhook-settings] GET API key error:', err);
      return reply.status(500).send({ error: 'Failed to fetch API key' });
    }
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────

function upsertSettingOp(orgId: string, settingKey: string, value: string) {
  return prisma.appSetting.upsert({
    where: { orgId_settingKey: { orgId, settingKey } },
    create: { orgId, settingKey, valuePlain: value },
    update: { valuePlain: value },
  });
}

async function upsertSetting(orgId: string, settingKey: string, value: string): Promise<void> {
  await upsertSettingOp(orgId, settingKey, value);
}
