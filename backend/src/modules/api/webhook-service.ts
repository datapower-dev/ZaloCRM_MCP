/**
 * webhook-service.ts — fire-and-forget webhook delivery for org-configured endpoints.
 * Signs payloads with HMAC-SHA256 if webhook_secret is configured.
 * The target URL is re-validated against SSRF rules on every delivery
 * (DNS may have changed since the URL was saved).
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { config } from '../../config/index.js';
import { assertSafeWebhookUrl } from '../../shared/utils/url-guard.js';
import crypto from 'node:crypto';

export async function emitWebhook(orgId: string, event: string, data: any): Promise<void> {
  if (!config.webhooksEnabled) return;
  try {
    const urlSetting = await prisma.appSetting.findFirst({
      where: { orgId, settingKey: 'webhook_url' },
    });
    if (!urlSetting?.valuePlain) return;

    let target: string;
    try {
      target = await assertSafeWebhookUrl(urlSetting.valuePlain);
    } catch (err) {
      logger.warn(`[webhook] Refusing to deliver ${event}: ${(err as Error).message}`);
      return;
    }

    const secretSetting = await prisma.appSetting.findFirst({
      where: { orgId, settingKey: 'webhook_secret' },
    });

    const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    const signature = secretSetting?.valuePlain
      ? crypto.createHmac('sha256', secretSetting.valuePlain).update(payload).digest('hex')
      : '';

    // Fire and forget — never block the caller
    fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
      },
      body: payload,
      redirect: 'manual', // a redirect to an internal address must not be followed
      signal: AbortSignal.timeout(10000),
    }).catch((err) => logger.warn(`[webhook] Failed to deliver ${event}:`, err));
  } catch (err) {
    logger.error('[webhook] Error emitting webhook:', err);
  }
}
