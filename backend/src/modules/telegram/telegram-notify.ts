/**
 * telegram-notify.ts — push messages to every Telegram chat linked to an org.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { getOrgConfig } from '../settings/org-config.js';
import { loadBotToken } from './telegram-store.js';
import { tgCall } from './telegram-client.js';

export interface NotifyResult {
  sent: number;
  failed: number;
  skipped?: string;
}

export async function notifyOrgChats(
  orgId: string,
  html: string,
  replyMarkup?: Record<string, unknown>,
): Promise<NotifyResult> {
  const cfg = await getOrgConfig(orgId);
  if (!cfg.telegram.enabled) return { sent: 0, failed: 0, skipped: 'Telegram bot đang tắt' };
  const bot = await loadBotToken(orgId);
  if (!bot) return { sent: 0, failed: 0, skipped: 'Chưa cấu hình bot token' };
  const chats = await prisma.telegramChat.findMany({ where: { orgId }, select: { chatId: true } });
  if (chats.length === 0) return { sent: 0, failed: 0, skipped: 'Chưa liên kết chat Telegram nào' };

  let sent = 0;
  let failed = 0;
  for (const c of chats) {
    try {
      await tgCall(bot.token, 'sendMessage', {
        chat_id: c.chatId,
        text: html.slice(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      sent++;
    } catch (err) {
      failed++;
      logger.warn(`[telegram] send to chat ${c.chatId} failed: ${(err as Error).message}`);
    }
  }
  return { sent, failed };
}
