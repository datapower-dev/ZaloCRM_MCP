<template>
  <div>
    <div class="d-flex align-center mb-2">
      <h1 class="text-h5">
        <v-icon class="mr-2" style="color: #00F2FF;">mdi-forum-outline</v-icon>
        Kênh Tư Vấn
      </h1>
      <v-spacer />
      <v-chip size="small" class="mr-2" variant="flat" color="success">Đang nghe {{ summary.listening }}</v-chip>
      <v-chip size="small" class="mr-2" variant="flat" color="grey-darken-1">Đã tắt {{ summary.muted }}</v-chip>
      <v-chip size="small" class="mr-2" variant="flat" color="purple">AI assist {{ summary.ai }}</v-chip>
      <v-chip size="small" variant="flat" color="warning">Chưa gán {{ summary.unassigned }}</v-chip>
    </div>

    <v-tabs v-model="tab" class="mb-3" color="primary">
      <v-tab value="group">Quản lý Nhóm ({{ summary.groups }})</v-tab>
      <v-tab value="user">Quản lý P2P ({{ summary.p2p }})</v-tab>
    </v-tabs>

    <v-alert type="info" variant="tonal" density="compact" class="mb-3">
      Zalo cá nhân mặc định nghe mọi {{ tab === 'group' ? 'nhóm' : 'hội thoại' }} MỚI (đổi trong Cấu hình → Kênh).
      Tắt <b>Nghe tin nhắn</b> để bỏ qua kênh không cần theo dõi: tin mới không được lưu, không thông báo, không gửi webhook.
      Bật <b>AI assist</b> để Claude Code (qua MCP) được đọc và hỗ trợ kênh này.
    </v-alert>

    <v-expansion-panels class="mb-3" variant="accordion">
      <v-expansion-panel>
        <v-expansion-panel-title>
          <v-icon size="18" class="mr-2" color="info">mdi-information-outline</v-icon>
          Cách hoạt động của các cột
        </v-expansion-panel-title>
        <v-expansion-panel-text class="text-body-2">
          <ul class="ml-4">
            <li><b>Số lượt hỏi</b>: tổng tin nhắn khách gửi vào kênh (đã lưu).</li>
            <li><b>Hoạt động gần nhất</b>: thời điểm tin nhắn mới nhất; màu cam/đỏ khi chưa trả lời quá thời gian cảnh báo/quá hạn trong Cấu hình.</li>
            <li><b>Người hỗ trợ</b>: nhân viên phụ trách; member thấy được kênh mình hỗ trợ kể cả khi chưa được cấp quyền tài khoản Zalo.</li>
            <li><b>Ca khó</b>: chuyển yêu cầu phức tạp / cần duyệt tới Zalo quản lí và Telegram.</li>
          </ul>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <div class="d-flex align-center flex-wrap mb-3" style="gap: 12px;">
      <v-text-field
        v-model="search"
        :placeholder="tab === 'group' ? 'Tìm tên nhóm hoặc ID…' : 'Tìm tên khách, SĐT hoặc ID…'"
        prepend-inner-icon="mdi-magnify"
        density="compact"
        hide-details
        clearable
        style="max-width: 320px;"
      />
      <v-select
        v-model="status"
        :items="statusOptions"
        item-title="label"
        item-value="value"
        density="compact"
        hide-details
        style="max-width: 200px;"
      />
      <v-select
        v-model="accountId"
        :items="accountOptions"
        item-title="label"
        item-value="value"
        density="compact"
        hide-details
        style="max-width: 220px;"
      />
      <span class="text-caption text-medium-emphasis">{{ total }} {{ tab === 'group' ? 'nhóm' : 'hội thoại' }}</span>
      <v-spacer />
      <template v-if="canManage && selected.length">
        <span class="text-caption">Đã chọn {{ selected.length }}</span>
        <v-btn size="small" variant="tonal" color="success" @click="bulk({ listening: true })">Bật nghe</v-btn>
        <v-btn size="small" variant="tonal" @click="bulk({ listening: false })">Tắt nghe</v-btn>
        <v-btn size="small" variant="tonal" color="purple" @click="bulk({ aiAssist: true })">Bật AI</v-btn>
        <v-btn size="small" variant="tonal" @click="bulk({ aiAssist: false })">Tắt AI</v-btn>
      </template>
    </div>

    <v-card>
      <v-data-table-server
        v-model="selected"
        :headers="headers"
        :items="channels"
        :items-length="total"
        :loading="loading"
        :items-per-page="limit"
        :page="page"
        :show-select="canManage"
        item-value="id"
        no-data-text="Chưa có kênh nào"
        @update:options="onOptions"
      >
        <template #item.account="{ item }">
          <div class="d-flex align-center">
            <v-icon size="18" color="info" class="mr-1">mdi-chat-processing</v-icon>
            <span class="text-caption">{{ item.zaloAccount?.displayName || 'Zalo' }}</span>
          </div>
        </template>
        <template #item.name="{ item }">
          <div class="py-1">
            <div class="font-weight-medium">{{ item.contact?.fullName || (item.threadType === 'group' ? 'Nhóm' : 'Khách') }}</div>
            <div class="d-flex align-center text-caption text-medium-emphasis">
              <code>{{ item.externalThreadId }}</code>
              <v-btn icon size="x-small" variant="text" title="Sao chép ID" @click="copy(item.externalThreadId)">
                <v-icon size="14">mdi-content-copy</v-icon>
              </v-btn>
            </div>
          </div>
        </template>
        <template #item.questionCount="{ item }">{{ item.questionCount }}</template>
        <template #item.lastMessageAt="{ item }">
          <span :class="slaClass(item)">{{ formatTime(item.lastMessageAt) }}</span>
          <div v-if="!item.isReplied" class="text-caption" :class="slaClass(item)">chưa trả lời</div>
        </template>
        <template #item.listening="{ item }">
          <v-checkbox-btn
            :model-value="item.listening"
            :disabled="!canManage || busy === item.id"
            color="primary"
            @update:model-value="(v: boolean | null) => update(item, { listening: !!v })"
          />
        </template>
        <template #item.aiAssist="{ item }">
          <v-checkbox-btn
            :model-value="item.aiAssist"
            :disabled="!canManage || busy === item.id"
            color="purple"
            @update:model-value="(v: boolean | null) => update(item, { aiAssist: !!v })"
          />
        </template>
        <template #item.supporter="{ item }">
          <v-select
            :model-value="item.supporterUserId"
            :items="supporterOptions"
            item-title="label"
            item-value="value"
            density="compact"
            hide-details
            variant="outlined"
            :disabled="!canManage || busy === item.id"
            style="min-width: 160px;"
            @update:model-value="(v: string | null) => update(item, { supporterUserId: v || null })"
          />
        </template>
        <template #item.actions="{ item }">
          <v-btn size="small" variant="text" color="primary" @click="openChat(item.id)">Mở chat</v-btn>
          <v-btn v-if="permStore.can('escalations.create')" size="small" variant="text" color="warning" @click="openEscalation(item)">
            Ca khó
          </v-btn>
        </template>
      </v-data-table-server>
    </v-card>

    <EscalationDialog
      v-model="showEscalation"
      :conversation-id="escalationTarget?.id || ''"
      :title-hint="escalationTarget?.contact?.fullName || ''"
      @created="onEscalationCreated"
    />

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="3500">{{ snack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '@/api';
import { usePermissionStore } from '@/stores/permissions';
import EscalationDialog from '@/components/chat/EscalationDialog.vue';

interface Channel {
  id: string;
  threadType: 'group' | 'user';
  externalThreadId: string | null;
  lastMessageAt: string | null;
  isReplied: boolean;
  listening: boolean;
  aiAssist: boolean;
  supporterUserId: string | null;
  questionCount: number;
  contact: { id: string; fullName: string | null } | null;
  zaloAccount: { id: string; displayName: string | null } | null;
}

const router = useRouter();
const permStore = usePermissionStore();
const canManage = computed(() => permStore.can('channels.manage'));

const tab = ref<'group' | 'user'>('group');
const search = ref('');
const status = ref<string>('');
const accountId = ref<string>('');
const channels = ref<Channel[]>([]);
const total = ref(0);
const page = ref(1);
const limit = ref(25);
const loading = ref(false);
const busy = ref<string | null>(null);
const selected = ref<string[]>([]);
const summary = ref({ groups: 0, p2p: 0, listening: 0, muted: 0, ai: 0, unassigned: 0 });
const users = ref<{ id: string; fullName: string }[]>([]);
const accounts = ref<{ id: string; displayName: string | null }[]>([]);
const snack = ref({ show: false, text: '', color: 'success' });
const showEscalation = ref(false);
const escalationTarget = ref<Channel | null>(null);

const statusOptions = [
  { label: 'Mọi trạng thái', value: '' },
  { label: 'Đang nghe', value: 'listening' },
  { label: 'Đã tắt nghe', value: 'muted' },
  { label: 'Bật AI assist', value: 'ai' },
  { label: 'Chưa gán người hỗ trợ', value: 'unassigned' },
];
const accountOptions = computed(() => [
  { label: 'Mọi tài khoản Zalo', value: '' },
  ...accounts.value.map((a) => ({ label: a.displayName || a.id.slice(0, 8), value: a.id })),
]);
const supporterOptions = computed(() => [
  { label: 'Chưa gán', value: null },
  ...users.value.map((u) => ({ label: u.fullName, value: u.id })),
]);

const headers = computed(() => [
  { title: 'Kênh', key: 'account', sortable: false, width: 140 },
  { title: tab.value === 'group' ? 'Nhóm' : 'Khách hàng', key: 'name', sortable: false },
  { title: 'Số lượt hỏi', key: 'questionCount', sortable: false, width: 100 },
  { title: 'Hoạt động gần nhất', key: 'lastMessageAt', sortable: false, width: 150 },
  { title: 'Nghe tin nhắn', key: 'listening', sortable: false, width: 110 },
  { title: 'AI assist', key: 'aiAssist', sortable: false, width: 90 },
  { title: 'Người hỗ trợ', key: 'supporter', sortable: false, width: 190 },
  { title: 'Thao tác', key: 'actions', sortable: false, align: 'end' as const, width: 170 },
]);

function showSnack(text: string, color = 'success') {
  snack.value = { show: true, text, color };
}

function formatTime(v: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString('vi-VN');
}

function slaClass(item: Channel) {
  if (item.isReplied || !item.lastMessageAt || !permStore.sla) return '';
  const mins = (Date.now() - new Date(item.lastMessageAt).getTime()) / 60000;
  if (mins > permStore.sla.overdueMinutes) return 'text-error';
  if (mins > permStore.sla.warnMinutes) return 'text-warning';
  return '';
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get('/channels', {
      params: {
        type: tab.value,
        search: search.value || undefined,
        status: status.value || undefined,
        accountId: accountId.value || undefined,
        page: page.value,
        limit: limit.value,
      },
    });
    channels.value = res.data.channels;
    total.value = res.data.total;
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Không tải được danh sách kênh', 'error');
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    summary.value = (await api.get('/channels/summary')).data;
  } catch { /* ignore */ }
}

function onOptions(opts: { page: number; itemsPerPage: number }) {
  page.value = opts.page;
  limit.value = opts.itemsPerPage > 0 ? opts.itemsPerPage : 200;
  load();
}

async function update(item: Channel, patch: Partial<Pick<Channel, 'listening' | 'aiAssist' | 'supporterUserId'>>) {
  busy.value = item.id;
  try {
    const res = await api.patch(`/channels/${item.id}`, patch);
    Object.assign(item, res.data);
    loadSummary();
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Cập nhật thất bại', 'error');
  } finally {
    busy.value = null;
  }
}

async function bulk(patch: Record<string, unknown>) {
  try {
    const res = await api.post('/channels/bulk', { ids: selected.value, ...patch });
    showSnack(`Đã cập nhật ${res.data.updated} kênh`);
    selected.value = [];
    await Promise.all([load(), loadSummary()]);
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Cập nhật thất bại', 'error');
  }
}

async function copy(text: string | null) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showSnack('Đã sao chép ID');
}

function openChat(id: string) {
  router.push({ path: '/chat', query: { conv: id } });
}

function openEscalation(item: Channel) {
  escalationTarget.value = item;
  showEscalation.value = true;
}

function onEscalationCreated(msg: string) {
  showSnack(msg);
}

let t: ReturnType<typeof setTimeout>;
watch(search, () => {
  clearTimeout(t);
  t = setTimeout(() => { page.value = 1; load(); }, 300);
});
watch([status, accountId], () => { page.value = 1; load(); });
watch(tab, () => { page.value = 1; selected.value = []; load(); });

onMounted(async () => {
  if (!permStore.loaded) await permStore.load();
  loadSummary();
  try {
    const [u, a] = await Promise.all([api.get('/users'), api.get('/zalo-accounts')]);
    users.value = (u.data.users || []).filter((x: any) => x.isActive);
    accounts.value = a.data || [];
  } catch { /* members may not list users; selector stays minimal */ }
});
</script>
