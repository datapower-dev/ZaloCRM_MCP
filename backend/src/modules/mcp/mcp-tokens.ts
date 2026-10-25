/**
 * mcp-tokens.ts — personal access tokens for the MCP endpoint (Claude Code).
 * Format: zcc_<48 hex>. Only SHA-256 is stored. Every request re-checks
 * revocation, expiry, user status, org switches and the claude.use permission,
 * so changing permissions takes effect immediately.
 */
import crypto from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { sha256Hex } from '../../shared/utils/crypto.js';
import { getOrgConfig, permissionsFor, type AuthUser, type OrgConfig, type RolePermissions } from '../settings/org-config.js';

export const MCP_SCOPES = ['read', 'write', 'send'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
const TOKEN_RE = /^zcc_[0-9a-f]{48}$/;

export function newTokenValue(): { token: string; hash: string; hint: string } {
  const token = `zcc_${crypto.randomBytes(24).toString('hex')}`;
  return { token, hash: sha256Hex(token), hint: `${token.slice(0, 8)}…${token.slice(-4)}` };
}

/** Scopes this user may hold right now, given org config + role permissions. */
export function availableScopes(cfg: OrgConfig, perms: RolePermissions): Record<McpScope, boolean> {
  return {
    read: true,
    write: cfg.mcp.allowWrite,
    send: cfg.mcp.allowSend && perms['mcp.send'],
  };
}

export interface McpContext {
  tokenId: string;
  user: AuthUser & { fullName: string; email: string };
  scopes: Set<McpScope>;
  perms: RolePermissions;
  cfg: OrgConfig;
}

export type VerifyResult = { ok: true; ctx: McpContext } | { ok: false; status: number; error: string };

const lastTouch = new Map<string, number>();

export async function verifyMcpToken(raw: string | undefined): Promise<VerifyResult> {
  if (!raw || !TOKEN_RE.test(raw)) return { ok: false, status: 401, error: 'Thiếu hoặc sai định dạng token (Authorization: Bearer zcc_…)' };
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { user: { select: { id: true, role: true, orgId: true, email: true, fullName: true, isActive: true } } },
  });
  if (!row || row.revokedAt) return { ok: false, status: 401, error: 'Token không hợp lệ hoặc đã bị thu hồi' };
  if (row.expiresAt && row.expiresAt < new Date()) return { ok: false, status: 401, error: 'Token đã hết hạn' };
  if (!row.user.isActive) return { ok: false, status: 403, error: 'Tài khoản đã bị vô hiệu hoá' };

  const cfg = await getOrgConfig(row.orgId);
  if (!cfg.claude.enabled || !cfg.mcp.enabled) return { ok: false, status: 403, error: 'Claude Code / MCP đang tắt cho tổ chức' };
  const perms = permissionsFor(row.user, cfg);
  if (!perms['claude.use']) return { ok: false, status: 403, error: 'Bạn không còn quyền dùng Claude Code' };

  const avail = availableScopes(cfg, perms);
  const tokenScopes = (Array.isArray(row.scopes) ? row.scopes : []) as string[];
  const scopes = new Set<McpScope>(MCP_SCOPES.filter((s) => tokenScopes.includes(s) && avail[s]));

  const now = Date.now();
  if ((lastTouch.get(row.id) ?? 0) < now - 60_000) {
    lastTouch.set(row.id, now);
    prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return {
    ok: true,
    ctx: { tokenId: row.id, user: row.user, scopes, perms, cfg },
  };
}
