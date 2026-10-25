/**
 * telegram-store.ts — encrypted storage of the org's Telegram bot token and
 * short-lived link codes used to connect a Telegram chat (/start <code>).
 */
import crypto from 'node:crypto';
import { prisma } from '../../shared/database/prisma-client.js';
import { encryptJson, decryptJson, isEncryptedBlob } from '../../shared/utils/crypto.js';

const TOKEN_KEY = 'telegram_bot_token';
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

export function isValidBotToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function saveBotToken(orgId: string, token: string, botUsername: string): Promise<void> {
  const value = JSON.stringify(encryptJson({ token, botUsername }));
  await prisma.appSetting.upsert({
    where: { orgId_settingKey: { orgId, settingKey: TOKEN_KEY } },
    create: { orgId, settingKey: TOKEN_KEY, valuePlain: value },
    update: { valuePlain: value },
  });
}

export async function deleteBotToken(orgId: string): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { orgId, settingKey: TOKEN_KEY } });
}

export async function loadBotToken(orgId: string): Promise<{ token: string; botUsername: string } | null> {
  const row = await prisma.appSetting.findFirst({ where: { orgId, settingKey: TOKEN_KEY }, select: { valuePlain: true } });
  if (!row?.valuePlain) return null;
  try {
    const blob = JSON.parse(row.valuePlain);
    if (!isEncryptedBlob(blob)) return null;
    return decryptJson<{ token: string; botUsername: string }>(blob);
  } catch {
    return null;
  }
}

export async function listOrgsWithBot(): Promise<string[]> {
  const rows = await prisma.appSetting.findMany({ where: { settingKey: TOKEN_KEY }, select: { orgId: true } });
  return rows.map((r) => r.orgId);
}

// ── Link codes (in memory, 10 minutes, single use) ─────────────────────────
const LINK_TTL_MS = 10 * 60_000;
const linkCodes = new Map<string, { orgId: string; userId: string; exp: number }>();

export function createLinkCode(orgId: string, userId: string): { code: string; expiresAt: string } {
  for (const [c, v] of linkCodes) if (v.exp < Date.now()) linkCodes.delete(c);
  const code = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8).toUpperCase();
  const exp = Date.now() + LINK_TTL_MS;
  linkCodes.set(code, { orgId, userId, exp });
  return { code, expiresAt: new Date(exp).toISOString() };
}

export function consumeLinkCode(orgId: string, code: string): { userId: string } | null {
  const v = linkCodes.get(code.toUpperCase());
  if (!v || v.orgId !== orgId || v.exp < Date.now()) return null;
  linkCodes.delete(code.toUpperCase());
  return { userId: v.userId };
}
