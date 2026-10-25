/**
 * org-config.ts — per-organization configuration (stored as one JSON row in
 * app_settings, key "org_config") and the role-permission matrix.
 *
 * Sections: permissions, claude, mcp, sla, channels, escalation, telegram.
 * Secrets (Telegram bot token) are NOT stored here — see telegram-store.ts.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';

export const PERMISSION_KEYS = [
  'channels.view',
  'channels.manage',
  'escalations.create',
  'escalations.resolve',
  'claude.use',
  'mcp.send',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'channels.view': 'Xem Kênh Tư Vấn',
  'channels.manage': 'Bật/tắt kênh, gán người hỗ trợ',
  'escalations.create': 'Chuyển Ca khó',
  'escalations.resolve': 'Duyệt / xử lý Ca khó',
  'claude.use': 'Dùng Claude Code (tạo token MCP)',
  'mcp.send': 'Cho phép Claude Code gửi tin nhắn Zalo',
};

export type RolePermissions = Record<PermissionKey, boolean>;

export interface OrgConfig {
  permissions: { admin: RolePermissions; member: RolePermissions };
  claude: {
    enabled: boolean;
    allowedUserIds: string[]; // explicit grants regardless of role
    maxTokensPerUser: number;
    tokenTtlDays: number; // 0 = never expires
  };
  mcp: {
    enabled: boolean;
    requireAiAssist: boolean; // MCP only sees channels with AI assist on
    allowWrite: boolean; // update contacts, create ca khó
    allowSend: boolean; // send Zalo messages
  };
  sla: {
    warnMinutes: number; // "chưa trả lời" warning
    overdueMinutes: number; // "quá hạn" → Telegram alert
    workStart: string; // HH:mm (Asia/Ho_Chi_Minh)
    workEnd: string;
    notifyTelegram: boolean;
  };
  channels: {
    listenNewGroups: boolean;
    listenNewP2P: boolean;
    aiAssistNew: boolean;
  };
  escalation: {
    notifyZalo: boolean;
    notifyTelegram: boolean;
    // Conversation (of the manager Zalo account) that receives ca khó, e.g. a managers' group.
    // Empty → sent P2P from the conversation's Zalo account to the manager account.
    managerConversationId: string | null;
  };
  telegram: {
    enabled: boolean;
    notifyEscalations: boolean;
    dailySummary: boolean; // 08:00 overview message
  };
}

const MEMBER_DEFAULT: RolePermissions = {
  'channels.view': true,
  'channels.manage': false,
  'escalations.create': true,
  'escalations.resolve': false,
  'claude.use': false,
  'mcp.send': false,
};
const ADMIN_DEFAULT: RolePermissions = {
  'channels.view': true,
  'channels.manage': true,
  'escalations.create': true,
  'escalations.resolve': true,
  'claude.use': true,
  'mcp.send': false,
};

export const DEFAULT_CONFIG: OrgConfig = {
  permissions: { admin: ADMIN_DEFAULT, member: MEMBER_DEFAULT },
  claude: { enabled: true, allowedUserIds: [], maxTokensPerUser: 5, tokenTtlDays: 90 },
  mcp: { enabled: true, requireAiAssist: true, allowWrite: true, allowSend: false },
  sla: { warnMinutes: 30, overdueMinutes: 120, workStart: '08:00', workEnd: '21:00', notifyTelegram: true },
  channels: { listenNewGroups: true, listenNewP2P: true, aiAssistNew: false },
  escalation: { notifyZalo: true, notifyTelegram: true, managerConversationId: null },
  telegram: { enabled: false, notifyEscalations: true, dailySummary: true },
};

const KEY = 'org_config';
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; cfg: OrgConfig }>();

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in (base as any))) continue; // ignore unknown keys
    const cur = (base as any)[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
    // nullable string fields (e.g. managerConversationId): allow string ↔ null
    else if ((cur === null || typeof cur === 'string') && (v === null || typeof v === 'string')) out[k] = v;
    else if (Array.isArray(cur) && Array.isArray(v)) out[k] = v;
  }
  return out;
}

export async function getOrgConfig(orgId: string): Promise<OrgConfig> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.cfg;
  const row = await prisma.appSetting.findFirst({ where: { orgId, settingKey: KEY }, select: { valuePlain: true } });
  let stored: unknown = null;
  try {
    stored = row?.valuePlain ? JSON.parse(row.valuePlain) : null;
  } catch {
    stored = null;
  }
  const cfg = deepMerge(structuredClone(DEFAULT_CONFIG), stored);
  cache.set(orgId, { at: Date.now(), cfg });
  return cfg;
}

export async function saveOrgConfig(orgId: string, cfg: OrgConfig): Promise<OrgConfig> {
  const clean = deepMerge(structuredClone(DEFAULT_CONFIG), cfg);
  await prisma.appSetting.upsert({
    where: { orgId_settingKey: { orgId, settingKey: KEY } },
    create: { orgId, settingKey: KEY, valuePlain: JSON.stringify(clean) },
    update: { valuePlain: JSON.stringify(clean) },
  });
  cache.set(orgId, { at: Date.now(), cfg: clean });
  return clean;
}

export async function patchOrgConfig<K extends keyof OrgConfig>(
  orgId: string,
  section: K,
  patch: Partial<OrgConfig[K]>,
): Promise<OrgConfig> {
  const cur = await getOrgConfig(orgId);
  const next = { ...cur, [section]: deepMerge(cur[section], patch) } as OrgConfig;
  return saveOrgConfig(orgId, next);
}

export interface AuthUser {
  id: string;
  role: string;
  orgId: string;
  email?: string;
}

export function permissionsFor(user: AuthUser, cfg: OrgConfig): RolePermissions {
  if (user.role === 'owner') {
    return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) as RolePermissions;
  }
  const base = user.role === 'admin' ? cfg.permissions.admin : cfg.permissions.member;
  const perms = { ...base };
  // Explicit Claude Code grant for individual users
  if (cfg.claude.allowedUserIds.includes(user.id)) perms['claude.use'] = true;
  return perms;
}

export async function hasPermission(user: AuthUser, key: PermissionKey): Promise<boolean> {
  const cfg = await getOrgConfig(user.orgId);
  return permissionsFor(user, cfg)[key];
}

/** Fastify preHandler factory: 403 unless the user holds the permission. */
export function requirePermission(key: PermissionKey) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user;
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await hasPermission(user, key))) {
      return reply.status(403).send({ error: `Không có quyền: ${PERMISSION_LABELS[key]}` });
    }
  };
}

/** Minutes since midnight in Vietnam time for "HH:mm". */
function hm(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

export function isWorkingTime(cfg: OrgConfig, now = new Date()): boolean {
  const vn = new Date(now.getTime() + 7 * 3600_000);
  const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const start = hm(cfg.sla.workStart);
  const end = hm(cfg.sla.workEnd);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
