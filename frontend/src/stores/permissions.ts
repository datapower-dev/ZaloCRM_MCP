/**
 * permissions store — effective permissions of the signed-in user (GET /config/me).
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '@/api/index';

export type PermissionKey =
  | 'channels.view'
  | 'channels.manage'
  | 'escalations.create'
  | 'escalations.resolve'
  | 'claude.use'
  | 'mcp.send';

export const usePermissionStore = defineStore('permissions', () => {
  const perms = ref<Record<string, boolean>>({});
  const claudeEnabled = ref(false);
  const sla = ref<{ warnMinutes: number; overdueMinutes: number } | null>(null);
  const loaded = ref(false);

  async function load() {
    try {
      const res = await api.get('/config/me');
      perms.value = res.data.permissions || {};
      claudeEnabled.value = !!res.data.claudeEnabled;
      sla.value = res.data.sla ?? null;
      loaded.value = true;
    } catch {
      perms.value = {};
      loaded.value = false;
    }
  }

  function can(key: PermissionKey): boolean {
    return !!perms.value[key];
  }

  function reset() {
    perms.value = {};
    loaded.value = false;
  }

  return { perms, claudeEnabled, sla, loaded, load, can, reset };
});
