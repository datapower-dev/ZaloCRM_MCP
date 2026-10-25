/**
 * config-routes.ts — "Cấu hình": MCP, Claude Code, phân quyền, Telegram bot,
 * thời gian phản hồi (SLA), kênh, ca khó.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { config as appConfig } from '../../config/index.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import {
  getOrgConfig, patchOrgConfig, permissionsFor, PERMISSION_KEYS, PERMISSION_LABELS,
  type OrgConfig, type RolePermissions,
} from './org-config.js';
import { createLinkCode, deleteBotToken, isValidBotToken, loadBotToken, saveBotToken } from '../telegram/telegram-store.js';
import { tgCall } from '../telegram/telegram-client.js';
import { notifyOrgChats } from '../telegram/telegram-notify.js';
import { startTelegramForOrg, stopTelegramForOrg, telegramWorkerRunning } from '../telegram/telegram-bot.js';

export function mcpEndpointUrl(): string {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL;
  return appConfig.isProduction ? `${appConfig.appUrl}/mcp` : `http://127.0.0.1:${appConfig.port}/mcp`;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isBool = (v: unknown) => typeof v === 'boolean';
const intIn = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Validates one section patch; returns error text or null. */
async function validateSection(orgId: string, section: string, body: any): Promise<string | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Dữ liệu không hợp lệ';
  const bools = (keys: string[]) => keys.every((k) => body[k] === undefined || isBool(body[k]));
  switch (section) {
    case 'permissions':
      for (const role of Object.keys(body)) {
        if (role !== 'admin' && role !== 'member') return 'Chỉ cấu hình được vai trò admin và member';
        const perms = body[role];
        if (!perms || typeof perms !== 'object') return 'Quyền không hợp lệ';
        for (const [k, v] of Object.entries(perms)) {
          if (!PERMISSION_KEYS.includes(k as any) || !isBool(v)) return `Quyền không hợp lệ: ${k}`;
        }
      }
      return null;
    case 'claude':
      if (!bools(['enabled'])) return 'enabled phải là true/false';
      if (body.maxTokensPerUser !== undefined && !intIn(body.maxTokensPerUser, 1, 50)) return 'Số token tối đa 1–50';
      if (body.tokenTtlDays !== undefined && !intIn(body.tokenTtlDays, 0, 365)) return 'Hạn token 0–365 ngày';
      if (body.allowedUserIds !== undefined) {
        if (!Array.isArray(body.allowedUserIds) || body.allowedUserIds.length > 500) return 'allowedUserIds không hợp lệ';
        const n = await prisma.user.count({ where: { orgId, id: { in: body.allowedUserIds.filter((x: unknown) => typeof x === 'string') } } });
        if (n !== body.allowedUserIds.length) return 'Có người dùng không thuộc tổ chức';
      }
      return null;
    case 'mcp':
      return bools(['enabled', 'requireAiAssist', 'allowWrite', 'allowSend']) ? null : 'Giá trị phải là true/false';
    case 'sla':
      if (body.warnMinutes !== undefined && !intIn(body.warnMinutes, 1, 1440)) return 'Cảnh báo chưa trả lời: 1–1440 phút';
      if (body.overdueMinutes !== undefined && !intIn(body.overdueMinutes, 1, 10080)) return 'Quá hạn: 1–10080 phút';
      if (body.workStart !== undefined && !HHMM.test(body.workStart)) return 'Giờ bắt đầu dạng HH:mm';
      if (body.workEnd !== undefined && !HHMM.test(body.workEnd)) return 'Giờ kết thúc dạng HH:mm';
      if (!bools(['notifyTelegram'])) return 'notifyTelegram phải là true/false';
      {
        const cur = (await getOrgConfig(orgId)).sla;
        const warn = body.warnMinutes ?? cur.warnMinutes;
        const over = body.overdueMinutes ?? cur.overdueMinutes;
        if (over < warn) return 'Thời gian quá hạn phải ≥ thời gian cảnh báo';
      }
      return null;
    case 'channels':
      return bools(['listenNewGroups', 'listenNewP2P', 'aiAssistNew']) ? null : 'Giá trị phải là true/false';
    case 'escalation':
      if (!bools(['notifyZalo', 'notifyTelegram'])) return 'Giá trị phải là true/false';
      if (body.managerConversationId !== undefined && body.managerConversationId !== null) {
        if (typeof body.managerConversationId !== 'string') return 'Hội thoại không hợp lệ';
        const conv = await prisma.conversation.findFirst({
          where: { id: body.managerConversationId, orgId, zaloAccount: { isManager: true } },
          select: { id: true },
        });
        if (!conv) return 'Hội thoại phải thuộc tài khoản Zalo quản lí';
      }
      return null;
    case 'telegram':
      return bools(['enabled', 'notifyEscalations', 'dailySummary']) ? null : 'Giá trị phải là true/false';
    default:
      return 'Mục cấu hình không tồn tại';
  }
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/config/me — my effective permissions (any signed-in user)
  app.get('/api/v1/config/me', async (request) => {
    const user = request.user!;
    const cfg = await getOrgConfig(user.orgId);
    return {
      role: user.role,
      permissions: permissionsFor(user, cfg),
      claudeEnabled: cfg.claude.enabled && cfg.mcp.enabled,
      sla: cfg.sla,
    };
  });

  // GET /api/v1/config — full org config (owner/admin)
  app.get('/api/v1/config', { preHandler: requireRole('owner', 'admin') }, async (request) => {
    const user = request.user!;
    const cfg = await getOrgConfig(user.orgId);
    const bot = await loadBotToken(user.orgId);
    const [chats, manager] = await Promise.all([
      prisma.telegramChat.findMany({ where: { orgId: user.orgId }, orderBy: { createdAt: 'asc' } }),
      prisma.zaloAccount.findFirst({ where: { orgId: user.orgId, isManager: true }, select: { id: true, displayName: true, zaloUid: true } }),
    ]);
    return {
      config: cfg,
      permissionKeys: PERMISSION_KEYS.map((k) => ({ key: k, label: PERMISSION_LABELS[k] })),
      mcpEndpoint: mcpEndpointUrl(),
      telegram: {
        hasToken: !!bot,
        botUsername: bot?.botUsername ?? null,
        running: telegramWorkerRunning(user.orgId),
        chats,
      },
      managerAccount: manager,
    };
  });

  // PUT /api/v1/config/:section — update one section (owner/admin; permissions owner only)
  app.put('/api/v1/config/:section', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { section } = request.params as { section: keyof OrgConfig };
    if ((section === 'permissions' || section === 'claude') && user.role !== 'owner') {
      return reply.status(403).send({ error: 'Chỉ owner được đổi phân quyền và quyền Claude Code' });
    }
    const err = await validateSection(user.orgId, section, request.body);
    if (err) return reply.status(400).send({ error: err });
    const cfg = await patchOrgConfig(user.orgId, section, request.body as any);
    logger.info(`[config] ${user.email} updated section "${section}"`);
    if (section === 'telegram') {
      if (cfg.telegram.enabled) startTelegramForOrg(user.orgId).catch(() => {});
      else stopTelegramForOrg(user.orgId);
    }
    return { config: cfg };
  });

  // ── Telegram bot token / link / chats ─────────────────────────────────────
  app.put('/api/v1/config/telegram/token', {
    preHandler: requireRole('owner', 'admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const token = String((request.body as any)?.token ?? '').trim();
    if (!isValidBotToken(token)) return reply.status(400).send({ error: 'Bot token không đúng định dạng (lấy từ @BotFather)' });
    let me: { username: string };
    try {
      me = await tgCall(token, 'getMe');
    } catch (err) {
      return reply.status(400).send({ error: `Telegram từ chối token: ${(err as Error).message}` });
    }
    await saveBotToken(user.orgId, token, me.username);
    await patchOrgConfig(user.orgId, 'telegram', { enabled: true });
    await startTelegramForOrg(user.orgId);
    logger.info(`[config] ${user.email} set Telegram bot @${me.username}`);
    return { botUsername: me.username, running: telegramWorkerRunning(user.orgId) };
  });

  app.delete('/api/v1/config/telegram/token', { preHandler: requireRole('owner', 'admin') }, async (request) => {
    const user = request.user!;
    stopTelegramForOrg(user.orgId);
    await deleteBotToken(user.orgId);
    await patchOrgConfig(user.orgId, 'telegram', { enabled: false });
    logger.info(`[config] ${user.email} removed Telegram bot token`);
    return { success: true };
  });

  app.post('/api/v1/config/telegram/link-code', { preHandler: requireRole('owner', 'admin') }, async (request, reply) => {
    const user = request.user!;
    const bot = await loadBotToken(user.orgId);
    if (!bot) return reply.status(400).send({ error: 'Chưa cấu hình bot token' });
    const { code, expiresAt } = createLinkCode(user.orgId, user.id);
    return { code, expiresAt, botUsername: bot.botUsername, deepLink: `https://t.me/${bot.botUsername}?start=${code}` };
  });

  app.post('/api/v1/config/telegram/test', {
    preHandler: requireRole('owner', 'admin'),
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request) => {
    return notifyOrgChats(request.user!.orgId, '✅ Tin thử từ ZaloCRM — bot hoạt động bình thường.');
  });

  app.patch('/api/v1/config/telegram/chats/:id', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const canAct = (request.body as any)?.canAct;
    if (!isBool(canAct)) return reply.status(400).send({ error: 'canAct phải là true/false' });
    const r = await prisma.telegramChat.updateMany({ where: { id, orgId: user.orgId }, data: { canAct } });
    if (!r.count) return reply.status(404).send({ error: 'Không tìm thấy chat' });
    return { success: true };
  });

  app.delete('/api/v1/config/telegram/chats/:id', { preHandler: requireRole('owner', 'admin') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const r = await prisma.telegramChat.deleteMany({ where: { id, orgId: user.orgId } });
    if (!r.count) return reply.status(404).send({ error: 'Không tìm thấy chat' });
    logger.info(`[config] ${user.email} unlinked Telegram chat ${id}`);
    return { success: true };
  });

  // Conversations of the manager Zalo account (to choose where ca khó are posted)
  app.get('/api/v1/config/manager-threads', { preHandler: requireRole('owner', 'admin') }, async (request) => {
    const user = request.user!;
    const search = String((request.query as any)?.search ?? '').trim().slice(0, 100);
    const rows = await prisma.conversation.findMany({
      where: {
        orgId: user.orgId,
        zaloAccount: { isManager: true },
        ...(search ? { contact: { fullName: { contains: search, mode: 'insensitive' as const } } } : {}),
      },
      select: { id: true, threadType: true, externalThreadId: true, contact: { select: { fullName: true } } },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: 50,
    });
    return {
      threads: rows.map((r) => ({
        id: r.id,
        title: `${r.contact?.fullName || r.externalThreadId} (${r.threadType === 'group' ? 'nhóm' : 'P2P'})`,
      })),
    };
  });
}

export type { RolePermissions };
