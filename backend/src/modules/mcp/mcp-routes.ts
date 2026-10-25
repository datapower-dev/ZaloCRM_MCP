/**
 * mcp-routes.ts — POST /mcp : MCP Streamable HTTP endpoint (stateless, JSON responses)
 * plus the "Claude Code" management API (tokens, logs).
 *
 * Connect Claude Code:
 *   claude mcp add --transport http zalocrm <endpoint> --header "Authorization: Bearer zcc_…"
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Server as IOServer } from 'socket.io';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { config as appConfig } from '../../config/index.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { getOrgConfig, permissionsFor, requirePermission } from '../settings/org-config.js';
import { mcpEndpointUrl } from '../settings/config-routes.js';
import { availableScopes, MCP_SCOPES, newTokenValue, verifyMcpToken, type McpScope } from './mcp-tokens.js';
import { buildMcpServer } from './mcp-tools.js';

function jsonRpcError(reply: FastifyReply, status: number, message: string) {
  if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="zalocrm-mcp"');
  return reply.status(status).send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

export async function mcpEndpointRoutes(app: FastifyInstance): Promise<void> {
  const io = (app as any).io as IOServer | null;

  app.post('/mcp', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    // Browsers must not be able to drive this endpoint (DNS-rebinding / CSRF)
    const origin = request.headers.origin;
    if (origin && !appConfig.allowedOrigins.includes(origin)) return jsonRpcError(reply, 403, 'Origin không được phép');

    const auth = request.headers.authorization;
    const raw = typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined;
    const v = await verifyMcpToken(raw);
    if (!v.ok) {
      logger.warn(`[mcp] rejected request from ${request.ip}: ${v.error}`);
      return jsonRpcError(reply, v.status, v.error);
    }

    const server = buildMcpServer(v.ctx, io);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      logger.error('[mcp] request failed:', err);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  // Stateless server: no SSE stream, no sessions
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply.status(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}

export async function claudeCodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  // GET /api/v1/claude-code/me — status, available scopes, my tokens
  app.get('/api/v1/claude-code/me', async (request) => {
    const user = request.user!;
    const cfg = await getOrgConfig(user.orgId);
    const perms = permissionsFor(user, cfg);
    const [tokens, aiChannels] = await Promise.all([
      prisma.mcpToken.findMany({
        where: { userId: user.id, revokedAt: null },
        select: { id: true, name: true, hint: true, scopes: true, expiresAt: true, lastUsedAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.conversation.count({ where: { orgId: user.orgId, aiAssist: true } }),
    ]);
    const reasons: string[] = [];
    if (!cfg.claude.enabled) reasons.push('Claude Code đang tắt cho tổ chức');
    if (!cfg.mcp.enabled) reasons.push('Máy chủ MCP đang tắt');
    if (!perms['claude.use']) reasons.push('Bạn chưa được cấp quyền dùng Claude Code');
    return {
      allowed: reasons.length === 0,
      reasons,
      endpoint: mcpEndpointUrl(),
      scopes: availableScopes(cfg, perms),
      maxTokensPerUser: cfg.claude.maxTokensPerUser,
      tokenTtlDays: cfg.claude.tokenTtlDays,
      requireAiAssist: cfg.mcp.requireAiAssist,
      aiAssistChannels: aiChannels,
      tokens: tokens.map((t) => ({ ...t, expired: !!t.expiresAt && t.expiresAt < new Date() })),
    };
  });

  // POST /api/v1/claude-code/tokens — { name, scopes, expiresInDays? }  (token shown once)
  app.post('/api/v1/claude-code/tokens', {
    preHandler: requirePermission('claude.use'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const cfg = await getOrgConfig(user.orgId);
    if (!cfg.claude.enabled || !cfg.mcp.enabled) return reply.status(403).send({ error: 'Claude Code / MCP đang tắt cho tổ chức' });
    const body = (request.body ?? {}) as { name?: unknown; scopes?: unknown; expiresInDays?: unknown };

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name) return reply.status(400).send({ error: 'Đặt tên cho token (VD: Laptop văn phòng)' });
    const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : ['read'];
    const avail = availableScopes(cfg, permissionsFor(user, cfg));
    for (const s of scopes) {
      if (!MCP_SCOPES.includes(s as McpScope)) return reply.status(400).send({ error: `Scope không hợp lệ: ${String(s)}` });
      if (!avail[s as McpScope]) return reply.status(403).send({ error: `Bạn/tổ chức chưa cho phép scope "${s}"` });
    }
    if (!scopes.includes('read')) scopes.unshift('read');

    const max = cfg.claude.tokenTtlDays;
    let days = body.expiresInDays === undefined ? max : Number(body.expiresInDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) return reply.status(400).send({ error: 'Hạn dùng 0–365 ngày' });
    if (max > 0 && (days === 0 || days > max)) days = max; // org cap
    const active = await prisma.mcpToken.count({
      where: { userId: user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (active >= cfg.claude.maxTokensPerUser) {
      return reply.status(400).send({ error: `Đã đạt tối đa ${cfg.claude.maxTokensPerUser} token. Thu hồi bớt token cũ.` });
    }

    const t = newTokenValue();
    const row = await prisma.mcpToken.create({
      data: {
        orgId: user.orgId, userId: user.id, name, tokenHash: t.hash, hint: t.hint, scopes,
        expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : null,
      },
      select: { id: true, name: true, hint: true, scopes: true, expiresAt: true, createdAt: true },
    });
    logger.info(`[claude-code] ${user.email} created MCP token ${row.id} scopes=${scopes.join(',')}`);
    const endpoint = mcpEndpointUrl();
    return reply.status(201).send({
      ...row,
      token: t.token,
      command: `claude mcp add --transport http zalocrm ${endpoint} --header "Authorization: Bearer ${t.token}"`,
    });
  });

  // DELETE /api/v1/claude-code/tokens/:id — revoke (own token; owner/admin any token in org)
  app.delete('/api/v1/claude-code/tokens/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const isAdmin = user.role === 'owner' || user.role === 'admin';
    const r = await prisma.mcpToken.updateMany({
      where: { id, orgId: user.orgId, revokedAt: null, ...(isAdmin ? {} : { userId: user.id }) },
      data: { revokedAt: new Date() },
    });
    if (!r.count) return reply.status(404).send({ error: 'Không tìm thấy token' });
    logger.info(`[claude-code] ${user.email} revoked MCP token ${id}`);
    return { success: true };
  });

  // GET /api/v1/claude-code/tokens — all tokens in org (owner/admin)
  app.get('/api/v1/claude-code/tokens', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    if (user.role !== 'owner' && user.role !== 'admin') return reply.status(403).send({ error: 'Không có quyền' });
    const tokens = await prisma.mcpToken.findMany({
      where: { orgId: user.orgId },
      select: {
        id: true, name: true, hint: true, scopes: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true,
        user: { select: { id: true, fullName: true, email: true, role: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return { tokens };
  });

  // GET /api/v1/claude-code/logs?limit=&all=1 — MCP call audit log
  app.get('/api/v1/claude-code/logs', async (request) => {
    const user = request.user!;
    const q = request.query as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50') || 50));
    const isAdmin = user.role === 'owner' || user.role === 'admin';
    const where = { orgId: user.orgId, ...(isAdmin && q.all === '1' ? {} : { userId: user.id }) };
    const logs = await prisma.mcpCallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, tool: true, ok: true, error: true, durationMs: true, createdAt: true, userId: true, token: { select: { name: true, hint: true } } },
    });
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(logs.map((l) => l.userId).filter(Boolean) as string[])] } }, select: { id: true, fullName: true } });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return { logs: logs.map((l) => ({ ...l, userName: l.userId ? names.get(l.userId) ?? null : null })) };
  });
}
