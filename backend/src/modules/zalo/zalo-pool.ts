/**
 * ZaloAccountPool — singleton that manages live Zalo SDK instances.
 * Handles QR login, session reconnect, message listener lifecycle,
 * and (encrypted) credential persistence to the database.
 *
 * Every Socket.IO event is scoped to the owning organization's room
 * (`org:<orgId>`) — nothing is broadcast globally.
 *
 * Note: zca-js is imported via createRequire because its TypeScript
 * declarations don't expose named exports in ESM mode.
 */
import { createRequire } from 'module';
import type { Server } from 'socket.io';
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';
import { attachZaloListener, type UserInfoCacheEntry } from './zalo-listener-factory.js';
import { emitWebhook } from '../api/webhook-service.js';
import { parseSession, serializeSession, type ZaloCredentials } from './zalo-session.js';

// zca-js has no reliable ESM type exports — load via CJS interop
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Zalo } = require('zca-js') as {
  Zalo: new (opts: { logging: boolean; checkUpdate: boolean }) => any;
};

// Never phone home to npm for update checks; keep SDK logs off.
const ZALO_OPTS = { logging: false, checkUpdate: false };

interface ZaloInstance {
  zalo: any;
  api: any;
  orgId: string;
  status: 'connected' | 'disconnected' | 'qr_pending' | 'connecting';
  displayName?: string;
  zaloUid?: string;
  lastActivity: Date;
}

export const orgRoom = (orgId: string) => `org:${orgId}`;
export const accountRoom = (accountId: string) => `account:${accountId}`;

class ZaloAccountPool {
  private instances = new Map<string, ZaloInstance>();
  private io: Server | null = null;
  // Shared user-info cache passed into each listener context
  private userInfoCache = new Map<string, UserInfoCacheEntry>();
  // Circuit breaker: track disconnect timestamps per account
  private disconnectHistory = new Map<string, number[]>();

  setIO(io: Server): void {
    this.io = io;
  }

  private emitOrg(orgId: string, event: string, payload: unknown): void {
    this.io?.to(orgRoom(orgId)).emit(event, payload);
  }

  private async resolveOrgId(accountId: string): Promise<string> {
    const rec = await prisma.zaloAccount.findUnique({
      where: { id: accountId },
      select: { orgId: true },
    });
    if (!rec) throw new Error(`Zalo account ${accountId} not found`);
    return rec.orgId;
  }

  // Initiate QR-based login; emits QR events to the account room (org-scoped) via Socket.IO
  async loginQR(accountId: string): Promise<void> {
    const orgId = await this.resolveOrgId(accountId);
    const zalo = new Zalo(ZALO_OPTS);
    this.instances.set(accountId, { zalo, api: null, orgId, status: 'qr_pending', lastActivity: new Date() });

    try {
      const api = await zalo.loginQR({}, (event: any) => {
        switch (event.type) {
          case 0: // QRCodeGenerated
            this.io?.to(accountRoom(accountId)).emit('zalo:qr', { accountId, qrImage: event.data.image });
            break;
          case 1: // QRCodeExpired
            this.io?.to(accountRoom(accountId)).emit('zalo:qr-expired', { accountId });
            event.actions?.retry();
            break;
          case 2: // QRCodeScanned
            this.io?.to(accountRoom(accountId)).emit('zalo:scanned', {
              accountId,
              displayName: event.data.display_name,
              avatar: event.data.avatar,
            });
            break;
          case 4: // GotLoginInfo
            this.saveCredentials(accountId, {
              cookie: event.data.cookie,
              imei: event.data.imei,
              userAgent: event.data.userAgent,
            });
            break;
        }
      });

      await this.onLoggedIn(accountId, api);
    } catch (err) {
      const instance = this.instances.get(accountId);
      if (instance) instance.status = 'disconnected';
      this.emitOrg(orgId, 'zalo:error', { accountId, error: String(err) });
      throw err;
    }
  }

  // Reconnect using previously saved session credentials
  async reconnect(accountId: string, credentials: ZaloCredentials): Promise<void> {
    const orgId = await this.resolveOrgId(accountId);
    const zalo = new Zalo(ZALO_OPTS);
    this.instances.set(accountId, { zalo, api: null, orgId, status: 'connecting', lastActivity: new Date() });

    try {
      const api = await zalo.login({
        cookie: credentials.cookie,
        imei: credentials.imei,
        userAgent: credentials.userAgent,
      });
      await this.onLoggedIn(accountId, api);
    } catch (err) {
      const instance = this.instances.get(accountId);
      if (instance) instance.status = 'disconnected';
      await this.updateAccountDB(accountId, 'qr_pending', null);
      this.emitOrg(orgId, 'zalo:reconnect-failed', { accountId, error: String(err) });
    }
  }

  // Shared post-login steps for QR login and session reconnect
  private async onLoggedIn(accountId: string, api: any): Promise<void> {
    const instance = this.instances.get(accountId)!;
    instance.api = api;
    instance.status = 'connected';
    instance.lastActivity = new Date();

    const ownId = await api.getOwnId();
    instance.zaloUid = ownId;

    // Fetch own profile info for avatar
    try {
      const userInfo = await api.getUserInfo(ownId);
      const profiles = userInfo?.changed_profiles || {};
      const profile = profiles[ownId] || profiles[`${ownId}_0`];
      if (profile?.avatar) {
        await prisma.zaloAccount.update({
          where: { id: accountId },
          data: {
            avatarUrl: profile.avatar,
            displayName:
              profile.zaloName || profile.zalo_name || profile.displayName || instance.displayName,
          },
        });
      }
    } catch {}

    this.attachListener(accountId, api, instance.orgId);
    await this.updateAccountDB(accountId, 'connected', ownId);
    this.emitOrg(instance.orgId, 'zalo:connected', { accountId, zaloUid: ownId });
    emitWebhook(instance.orgId, 'zalo.connected', { accountId }).catch(() => {});
  }

  // Delegate listener setup to zalo-listener-factory
  private attachListener(accountId: string, api: any, orgId: string): void {
    attachZaloListener({
      accountId,
      orgId,
      api,
      io: this.io,
      userInfoCache: this.userInfoCache,
      onDisconnected: (id) => {
        const inst = this.instances.get(id);
        if (inst) inst.status = 'disconnected';
        this.updateAccountDB(id, 'disconnected', null);
        emitWebhook(orgId, 'zalo.disconnected', { accountId: id }).catch(() => {});

        // Circuit breaker: track disconnect count per account
        const now = Date.now();
        const key = `dc_${id}`;
        const history = (this.disconnectHistory.get(key) || []).filter((t) => now - t < 5 * 60_000);
        history.push(now);
        this.disconnectHistory.set(key, history);

        if (history.length >= 5) {
          // >5 disconnects in 5 min → stop reconnecting, require QR re-login
          logger.error(
            `[zalo:${id}] Circuit breaker: ${history.length} disconnects in 5 min — stopping auto-reconnect. QR re-login required.`,
          );
          this.updateAccountDB(id, 'qr_pending', null);
          this.emitOrg(orgId, 'zalo:reconnect-failed', {
            accountId: id,
            error: 'Session không ổn định, cần đăng nhập QR lại',
          });
          this.disconnectHistory.delete(key);
          return; // DON'T reconnect
        }

        // Normal auto-reconnect after 30 seconds
        setTimeout(() => this.autoReconnect(id), 30_000);
      },
    });
  }

  // Persist session credentials to DB (encrypted at rest)
  private saveCredentials(accountId: string, credentials: ZaloCredentials): void {
    prisma.zaloAccount
      .update({ where: { id: accountId }, data: { sessionData: serializeSession(credentials) } })
      .catch((err) => logger.error(`[zalo:${accountId}] saveCredentials error:`, err));
  }

  // Sync account status and zaloUid to DB
  private async updateAccountDB(accountId: string, status: string, zaloUid: string | null): Promise<void> {
    try {
      await prisma.zaloAccount.update({
        where: { id: accountId },
        data: {
          status,
          ...(zaloUid !== null ? { zaloUid } : {}),
          ...(status === 'connected' ? { lastConnectedAt: new Date() } : {}),
        },
      });
    } catch (err) {
      logger.error(`[zalo:${accountId}] updateAccountDB error:`, err);
    }
  }

  // Auto-reconnect using saved session from DB
  private async autoReconnect(accountId: string): Promise<void> {
    const inst = this.instances.get(accountId);
    // Skip if already reconnected or manually disconnected
    if (inst?.status === 'connected') return;

    try {
      const account = await prisma.zaloAccount.findUnique({
        where: { id: accountId },
        select: { orgId: true, sessionData: true },
      });
      const session = parseSession(account?.sessionData);
      if (session) {
        logger.info(`[zalo:${accountId}] Auto-reconnecting...`);
        await this.reconnect(accountId, session);
      } else {
        logger.warn(`[zalo:${accountId}] No saved session, cannot auto-reconnect`);
        if (account) this.emitOrg(account.orgId, 'zalo:reconnect-failed', { accountId, error: 'No saved session' });
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Auto-reconnect failed:`, err);
      // Retry again in 2 minutes
      setTimeout(() => this.autoReconnect(accountId), 120_000);
    }
  }

  // Stop listener and remove from pool
  disconnect(accountId: string): void {
    const instance = this.instances.get(accountId);
    if (instance?.api?.listener) {
      try {
        instance.api.listener.stop();
      } catch (err) {
        logger.warn(`[zalo:${accountId}] Error stopping listener:`, err);
      }
    }
    this.instances.delete(accountId);
  }

  getStatus(accountId: string): string {
    return this.instances.get(accountId)?.status ?? 'disconnected';
  }

  getAllStatuses(): Record<string, string> {
    const statuses: Record<string, string> = {};
    for (const [id, inst] of this.instances) statuses[id] = inst.status;
    return statuses;
  }

  // Return raw API instance for direct SDK calls (e.g. public API send message)
  getApi(accountId: string): any | null {
    const inst = this.instances.get(accountId);
    return inst?.status === 'connected' ? inst.api : null;
  }

  getInstance(accountId: string): ZaloInstance | undefined {
    return this.instances.get(accountId);
  }
}

export const zaloPool = new ZaloAccountPool();
