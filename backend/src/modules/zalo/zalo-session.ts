/**
 * zalo-session.ts — (de)serializes Zalo login credentials for the
 * zalo_accounts.session_data column. Credentials are stored encrypted
 * (AES-256-GCM). Legacy plaintext rows are still readable and are
 * transparently re-encrypted at startup.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { encryptJson, decryptJson, isEncryptedBlob } from '../../shared/utils/crypto.js';

export interface ZaloCredentials {
  cookie: any;
  imei: string;
  userAgent: string;
}

export function serializeSession(creds: ZaloCredentials): Prisma.InputJsonValue {
  return encryptJson(creds) as unknown as Prisma.InputJsonValue;
}

/** Returns credentials or null when the column is empty/unreadable. */
export function parseSession(sessionData: unknown): ZaloCredentials | null {
  if (!sessionData || typeof sessionData !== 'object') return null;
  try {
    const value = isEncryptedBlob(sessionData)
      ? decryptJson<ZaloCredentials>(sessionData)
      : (sessionData as ZaloCredentials); // legacy plaintext
    return value && typeof value.imei === 'string' && value.imei ? value : null;
  } catch (err) {
    logger.error('[zalo-session] Cannot decrypt session (ENCRYPTION_KEY changed?):', (err as Error).message);
    return null;
  }
}

export function isLegacyPlaintext(sessionData: unknown): boolean {
  return !!sessionData && typeof sessionData === 'object' && !isEncryptedBlob(sessionData);
}

/** One-shot migration: encrypt any plaintext session rows found at startup. */
export async function migrateLegacySessions(): Promise<void> {
  const rows = await prisma.zaloAccount.findMany({
    where: { sessionData: { not: Prisma.JsonNull } },
    select: { id: true, sessionData: true },
  });
  let migrated = 0;
  for (const row of rows) {
    if (!isLegacyPlaintext(row.sessionData)) continue;
    const creds = parseSession(row.sessionData);
    if (!creds) continue;
    await prisma.zaloAccount.update({
      where: { id: row.id },
      data: { sessionData: serializeSession(creds) },
    });
    migrated++;
  }
  if (migrated) logger.info(`[zalo-session] Encrypted ${migrated} legacy plaintext session(s)`);
}
