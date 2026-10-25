<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">
        <v-icon class="mr-2" color="warning">mdi-alert-decagram-outline</v-icon>
        Ca khó
      </h1>
      <v-chip v-if="openCount" class="ml-3" color="warning" size="small" variant="flat">{{ openCount }} đang chờ</v-chip>
      <v-spacer />
      <v-btn-toggle v-model="status" density="compact" variant="outlined" divided mandatory>
        <v-btn value="open">Đang chờ</v-btn>
        <v-btn value="approved">Đã duyệt</v-btn>
        <v-btn value="rejected">Từ chối</v-btn>
        <v-btn value="resolved">Đã xử lý</v-btn>
        <v-btn value="">Tất cả</v-btn>
      </v-btn-toggle>
    </div>

    <v-alert v-if="!canResolve" type="info" variant="tonal" density="compact" class="mb-3">
      Bạn thấy các ca khó do mình chuyển hoặc thuộc kênh mình phụ trách. Quản lí duyệt trên web hoặc qua Telegram.
    </v-alert>

    <v-card>
      <v-data-table
        :headers="headers"
        :items="items"
        :loading="loading"
        item-value="id"
        no-data-text="Không có ca khó nào"
        :items-per-page="30"
      >
        <template #item.title="{ item }">
          <div class="py-2">
            <div class="font-weight-medium">{{ item.title }}</div>
            <div v-if="item.detail" class="text-caption text-medium-emphasis" style="white-space: pre-wrap; max-width: 520px;">{{ item.detail }}</div>
            <div v-if="item.resolution" class="text-caption mt-1"><v-icon size="12">mdi-reply</v-icon> {{ item.resolution }}</div>
          </div>
        </template>
        <template #item.priority="{ item }">
          <v-chip :color="priorityColor(item.priority)" size="x-small" variant="flat">{{ priorityLabel(item.priority) }}</v-chip>
          <div class="text-caption mt-1">{{ item.category === 'approval' ? 'Cần duyệt' : 'Phức tạp' }}</div>
        </template>
        <template #item.conversation="{ item }">
          <div class="text-body-2">{{ item.conversation?.contact?.fullName || '—' }}</div>
          <div class="text-caption text-medium-emphasis">{{ item.conversation?.zaloAccount?.displayName }}</div>
        </template>
        <template #item.createdBy="{ item }">
          <div class="text-body-2">{{ item.createdBy?.fullName || (item.source === 'mcp' ? 'Claude Code' : '—') }}</div>
          <div class="text-caption text-medium-emphasis">{{ formatTime(item.createdAt) }}</div>
        </template>
        <template #item.delivery="{ item }">
          <v-chip size="x-small" class="mb-1" :color="deliveryColor(item.zaloDelivery)" variant="tonal" :title="item.zaloDelivery || ''">Zalo</v-chip>
          <v-chip size="x-small" :color="deliveryColor(item.telegramDelivery)" variant="tonal" :title="item.telegramDelivery || ''">Telegram</v-chip>
        </template>
        <template #item.status="{ item }">
          <v-chip :color="statusColor(item.status)" size="small" variant="flat">{{ statusLabel(item.status) }}</v-chip>
          <div v-if="item.resolvedByName" class="text-caption mt-1">{{ item.resolvedByName }}</div>
        </template>
        <template #item.actions="{ item }">
          <v-btn v-if="item.conversation" icon size="small" variant="text" title="Mở hội thoại" @click="openChat(item.conversation.id)">
            <v-icon>mdi-message-text-outline</v-icon>
          </v-btn>
          <v-btn icon size="small" variant="text" title="Gửi lại Zalo/Telegram" :loading="resending === item.id" @click="resend(item)">
            <v-icon>mdi-send-clock-outline</v-icon>
          </v-btn>
          <template v-if="canResolve">
            <v-btn v-if="item.status === 'open'" size="small" variant="text" color="success" @click="openAction(item, 'approved')">Duyệt</v-btn>
            <v-btn v-if="item.status === 'open'" size="small" variant="text" color="error" @click="openAction(item, 'rejected')">Từ chối</v-btn>
            <v-btn v-if="item.status !== 'resolved'" size="small" variant="text" color="primary" @click="openAction(item, 'resolved')">Đã xử lý</v-btn>
            <v-btn v-else size="small" variant="text" @click="openAction(item, 'open')">Mở lại</v-btn>
          </template>
        </template>
      </v-data-table>
    </v-card>

    <v-dialog v-model="action.show" max-width="460">
      <v-card>
        <v-card-title>{{ statusLabel(action.status) }}: {{ action.item?.title }}</v-card-title>
        <v-card-text>
          <v-textarea v-model="action.resolution" label="Ghi chú / hướng xử lý" rows="3" counter="2000" maxlength="2000" auto-grow />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="action.show = false">Hủy</v-btn>
          <v-btn color="primary" variant="flat" :loading="action.saving" @click="submitAction">Xác nhận</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="4000">{{ snack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { io, Socket } from 'socket.io-client';
import { api } from '@/api';

const router = useRouter();
const status = ref<string>('open');
const items = ref<any[]>([]);
const loading = ref(false);
const openCount = ref(0);
const canResolve = ref(false);
const resending = ref<string | null>(null);
const snack = ref({ show: false, text: '', color: 'success' });
const action = ref<{ show: boolean; item: any; status: string; resolution: string; saving: boolean }>({
  show: false, item: null, status: 'resolved', resolution: '', saving: false,
});
let socket: Socket | null = null;

const headers = [
  { title: 'Yêu cầu', key: 'title', sortable: false },
  { title: 'Mức độ', key: 'priority', sortable: false, width: 110 },
  { title: 'Khách / Kênh', key: 'conversation', sortable: false, width: 170 },
  { title: 'Người chuyển', key: 'createdBy', sortable: false, width: 160 },
  { title: 'Đã gửi', key: 'delivery', sortable: false, width: 100 },
  { title: 'Trạng thái', key: 'status', sortable: false, width: 130 },
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: 280 },
];

const STATUS: Record<string, [string, string]> = {
  open: ['Đang chờ', 'warning'], approved: ['Đã duyệt', 'success'], rejected: ['Từ chối', 'error'], resolved: ['Đã xử lý', 'primary'],
};
const statusLabel = (s: string) => STATUS[s]?.[0] ?? s;
const statusColor = (s: string) => STATUS[s]?.[1] ?? 'default';
const priorityLabel = (p: string) => ({ normal: 'Thường', high: 'Cao', urgent: 'Khẩn' } as Record<string, string>)[p] ?? p;
const priorityColor = (p: string) => ({ normal: 'grey', high: 'orange', urgent: 'red' } as Record<string, string>)[p] ?? 'grey';
const deliveryColor = (v: string | null) => (!v ? 'grey' : v.startsWith('sent') ? 'success' : v.startsWith('failed') ? 'error' : 'grey');
const formatTime = (v: string) => new Date(v).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

function showSnack(text: string, color = 'success') {
  snack.value = { show: true, text, color };
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get('/escalations', { params: { status: status.value || undefined, limit: 100 } });
    items.value = res.data.items;
    openCount.value = res.data.open;
    canResolve.value = res.data.canResolve;
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Không tải được ca khó', 'error');
  } finally {
    loading.value = false;
  }
}

function openChat(id: string) {
  router.push({ path: '/chat', query: { conv: id } });
}

function openAction(item: any, s: string) {
  action.value = { show: true, item, status: s, resolution: item.resolution || '', saving: false };
}

async function submitAction() {
  action.value.saving = true;
  try {
    await api.patch(`/escalations/${action.value.item.id}`, { status: action.value.status, resolution: action.value.resolution || null });
    action.value.show = false;
    showSnack('Đã cập nhật ca khó');
    load();
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Cập nhật thất bại', 'error');
  } finally {
    action.value.saving = false;
  }
}

async function resend(item: any) {
  resending.value = item.id;
  try {
    const r = (await api.post(`/escalations/${item.id}/resend`)).data;
    showSnack(`Zalo: ${r.zalo} · Telegram: ${r.telegram}`, r.zalo.startsWith('sent') || r.telegram.startsWith('sent') ? 'success' : 'warning');
    load();
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Gửi lại thất bại', 'error');
  } finally {
    resending.value = null;
  }
}

watch(status, load);
onMounted(() => {
  load();
  socket = io({ transports: ['websocket', 'polling'], auth: { token: localStorage.getItem('token') || '' } });
  socket.on('escalation:new', load);
  socket.on('escalation:updated', load);
});
onUnmounted(() => socket?.disconnect());
</script>
