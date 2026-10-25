/**
 * channel-access.ts — which conversations ("kênh") a user may see.
 * Owner/admin: every conversation in the org.
 * Member: conversations of Zalo accounts they were granted, or where they are the supporter.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import type { AuthUser } from '../settings/org-config.js';

export async function conversationScope(user: AuthUser): Promise<Record<string, unknown>> {
  if (user.role === 'owner' || user.role === 'admin') return { orgId: user.orgId };
  const access = await prisma.zaloAccountAccess.findMany({
    where: { userId: user.id },
    select: { zaloAccountId: true },
  });
  return {
    orgId: user.orgId,
    OR: [{ zaloAccountId: { in: access.map((a) => a.zaloAccountId) } }, { supporterUserId: user.id }],
  };
}

/** Returns the Zalo permission level the user has on the conversation's account (owner/admin → 'admin'). */
export async function zaloPermissionFor(user: AuthUser, zaloAccountId: string): Promise<'read' | 'chat' | 'admin' | null> {
  if (user.role === 'owner' || user.role === 'admin') return 'admin';
  const a = await prisma.zaloAccountAccess.findFirst({
    where: { userId: user.id, zaloAccountId },
    select: { permission: true },
  });
  return (a?.permission as 'read' | 'chat' | 'admin') ?? null;
}

export async function canSeeConversation(user: AuthUser, conversationId: string) {
  const scope = await conversationScope(user);
  return prisma.conversation.findFirst({
    where: { ...scope, id: conversationId },
    include: {
      contact: { select: { id: true, fullName: true, phone: true } },
      zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
    },
  });
}
