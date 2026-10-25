<template>
  <div style="max-width: 1100px;">
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" style="color: #D97757;">mdi-robot-outline</v-icon>
      Claude Code
    </h1>

    <v-tabs v-model="tab" class="mb-4">
      <v-tab value="me">Kết nối của tôi</v-tab>
      <v-tab value="logs">Nhật ký sử dụng</v-tab>
      <v-tab v-if="authStore.isAdmin" value="admin">Quản lí token</v-tab>
    </v-tabs>

    <v-window v-model="tab">
      <!-- ── My connection ───────────────────────────────────────────── -->
      <v-window-item value="me">
        <v-alert v-if="me && !me.allowed" type="warning" variant="tonal" class="mb-4">
          <div v-for="r in me.reasons" :key="r">{{ r }}</div>
          <div class="text-caption mt-1">Owner cấp quyền tại Cấu hình → Claude Code / Phân quyền.</div>
        </v-alert>

        <v-card class="mb-4">
          <v-card-title class="text-body-1">Claude Code kết nối ZaloCRM qua MCP</v-card-title>
          <v-card-text class="text-body-2">
            <p class="mb-2">
              Claude Code đọc hội thoại, tìm khách hàng, cập nhật pipeline, chuyển/xử lý ca khó và (nếu được phép) gửi tin Zalo
              thông qua máy chủ MCP của ZaloCRM. Mỗi nhân viên dùng token riêng; mọi lần gọi được ghi nhật ký.
            </p>
            <v-row dense class="mb-2">
              <v-col cols="12" md="6">
                <div class="text-caption text-medium-emphasis">Endpoint MCP</div>
                <code>{{ me?.endpoint }}</code>
              </v-col>
              <v-col cols="12" md="6">
                <div class="text-caption text-medium-emphasis">Quyền token được phép tạo</div>
                <v-chip v-for="s in scopeList" :key="s.key" size="small" class="mr-1" :color="me?.scopes?.[s.key] ? 'success' : undefined" :variant="me?.scopes?.[s.key] ? 'tonal' : 'outlined'">
                  <v-icon start size="14">{{ me?.scopes?.[s.key] ? 'mdi-check' : 'mdi-close' }}</v-icon>{{ s.label }}
                </v-chip>
              </v-col>
            </v-row>
            <v-alert v-if="me?.requireAiAssist" type="info" variant="tonal" density="compact">
              Claude chỉ thấy các kênh bật <b>AI assist</b> trong Kênh Tư Vấn (hiện có {{ me?.aiAssistChannels ?? 0 }} kênh).
            </v-alert>
          </v-card-text>
        </v-card>

        <v-card class="mb-4">
          <v-card-title class="d-flex align-center text-body-1">
            Token của tôi
            <v-spacer />
            <v-btn color="primary" size="small" prepend-icon="mdi-key-plus" :disabled="!me?.allowed" @click="openCreate">Tạo token</v-btn>
          </v-card-title>
          <v-data-table :headers="tokenHeaders" :items="myTokens" no-data-text="Chưa có token" density="compact" hide-default-footer>
            <template #item.scopes="{ item }">
              <v-chip v-for="s in item.scopes" :key="s" size="x-small" class="mr-1">{{ s }}</v-chip>
            </template>
            <template #item.expiresAt="{ item }">
              <span :class="item.expired ? 'text-error' : ''">{{ item.expiresAt ? fmt(item.expiresAt) : 'Không hết hạn' }}</span>
            </template>
            <template #item.lastUsedAt="{ item }">{{ item.lastUsedAt ? fmt(item.lastUsedAt) : '—' }}</template>
            <template #item.actions="{ item }">
              <v-btn size="small" variant="text" color="error" @click="revoke(item.id)">Thu hồi</v-btn>
            </template>
          </v-data-table>
        </v-card>

        <v-card>
          <v-card-title class="text-body-1">Hướng dẫn kết nối</v-card-title>
          <v-card-text class="text-body-2">
            <ol class="ml-4">
              <li>Bấm <b>Tạo token</b>, chọn quyền, sao chép lệnh hiển thị (token chỉ hiện một lần).</li>
              <li>Mở terminal trên máy có Claude Code, dán lệnh:
                <pre class="cmd">claude mcp add --transport http zalocrm {{ me?.endpoint }} --header "Authorization: Bearer zcc_…"</pre>
              </li>
              <li>Kiểm tra: <code>claude mcp list</code> → <code>zalocrm</code> ở trạng thái connected.</li>
              <li>Hỏi Claude, ví dụ: “Tóm tắt các hội thoại chưa trả lời hôm nay” hoặc “Chuyển ca khó cho khách Nguyễn A, cần duyệt giảm giá 15%”.</li>
            </ol>
            <p class="mt-2 text-caption text-medium-emphasis">
              Máy chủ MCP chỉ nghe trên máy này ({{ me?.endpoint }}). Không chia sẻ token; thu hồi ngay nếu nghi lộ.
            </p>
          </v-card-text>
        </v-card>
      </v-window-item>

      <!-- ── Logs ───────────────────────────────────────────────────── -->
      <v-window-item value="logs">
        <div class="d-flex align-center mb-2">
          <v-switch v-if="authStore.isAdmin" v-model="allLogs" label="Toàn tổ chức" hide-details density="compact" color="primary" />
          <v-spacer />
          <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="loadLogs">Tải lại</v-btn>
        </div>
        <v-card>
          <v-data-table :headers="logHeaders" :items="logs" no-data-text="Chưa có lần gọi nào" density="compact" :items-per-page="50">
            <template #item.createdAt="{ item }">{{ fmt(item.createdAt) }}</template>
            <template #item.ok="{ item }">
              <v-icon :color="item.ok ? 'success' : 'error'" size="18">{{ item.ok ? 'mdi-check-circle' : 'mdi-alert-circle' }}</v-icon>
              <span v-if="item.error" class="text-caption ml-1">{{ item.error }}</span>
            </template>
            <template #item.token="{ item }">{{ item.token?.name }} <span class="text-caption text-medium-emphasis">{{ item.token?.hint }}</span></template>
          </v-data-table>
        </v-card>
      </v-window-item>

      <!-- ── Admin: all tokens ─────────────────────────────────────── -->
      <v-window-item v-if="authStore.isAdmin" value="admin">
        <v-alert type="info" variant="tonal" density="compact" class="mb-3">
          Bật/tắt Claude Code, giới hạn số token, hạn dùng và cấp quyền từng người tại <router-link to="/config">Cấu hình → Claude Code</router-link>.
        </v-alert>
        <v-card>
          <v-data-table :headers="adminHeaders" :items="allTokens" no-data-text="Chưa có token" density="compact">
            <template #item.user="{ item }">{{ item.user.fullName }} <span class="text-caption text-medium-emphasis">({{ item.user.role }})</span></template>
            <template #item.scopes="{ item }"><v-chip v-for="s in item.scopes" :key="s" size="x-small" class="mr-1">{{ s }}</v-chip></template>
            <template #item.state="{ item }">
              <v-chip size="x-small" :color="item.revokedAt ? 'error' : isExpired(item) ? 'warning' : 'success'" variant="tonal">
                {{ item.revokedAt ? 'Đã thu hồi' : isExpired(item) ? 'Hết hạn' : 'Hoạt động' }}
              </v-chip>
            </template>
            <template #item.lastUsedAt="{ item }">{{ item.lastUsedAt ? fmt(item.lastUsedAt) : '—' }}</template>
            <template #item.actions="{ item }">
              <v-btn v-if="!item.revokedAt" size="small" variant="text" color="error" @click="revoke(item.id)">Thu hồi</v-btn>
            </template>
          </v-data-table>
        </v-card>
      </v-window-item>
    </v-window>

    <!-- Create token dialog -->
    <v-dialog v-model="create.show" max-width="560" :persistent="!!create.result">
      <v-card>
        <v-card-title>{{ create.result ? 'Token đã tạo' : 'Tạo token MCP' }}</v-card-title>
        <v-card-text v-if="!create.result">
          <v-text-field v-model="create.name" label="Tên token *" placeholder="VD: Laptop văn phòng" maxlength="60" class="mb-2" />
          <div class="text-caption mb-1">Quyền</div>
          <v-checkbox v-model="create.scopes" value="read" label="read — đọc hội thoại, khách hàng, ca khó" disabled hide-details density="compact" />
          <v-checkbox v-model="create.scopes" value="write" :disabled="!me?.scopes?.write" label="write — cập nhật khách hàng, chuyển/xử lý ca khó" hide-details density="compact" />
          <v-checkbox v-model="create.scopes" value="send" :disabled="!me?.scopes?.send" label="send — gửi tin nhắn Zalo" hide-details density="compact" />
          <v-select v-model="create.days" :items="dayOptions" item-title="label" item-value="value" label="Hạn dùng" class="mt-3" />
          <v-alert v-if="create.error" type="error" density="compact">{{ create.error }}</v-alert>
        </v-card-text>
        <v-card-text v-else>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3">
            Sao chép ngay — token sẽ <b>không hiển thị lại</b>.
          </v-alert>
          <div class="text-caption">Lệnh kết nối Claude Code</div>
          <pre class="cmd">{{ create.result.command }}</pre>
          <v-btn size="small" prepend-icon="mdi-content-copy" class="mt-2" @click="copy(create.result.command)">Sao chép lệnh</v-btn>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <template v-if="!create.result">
            <v-btn @click="create.show = false">Hủy</v-btn>
            <v-btn color="primary" variant="flat" :loading="create.saving" :disabled="!create.name.trim()" @click="submitCreate">Tạo</v-btn>
          </template>
          <v-btn v-else color="primary" variant="flat" @click="closeCreate">Đã sao chép, đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="3000">{{ snack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const tab = ref('me');
const me = ref<any>(null);
const logs = ref<any[]>([]);
const allLogs = ref(false);
const allTokens = ref<any[]>([]);
const snack = ref({ show: false, text: '', color: 'success' });
const create = ref<{ show: boolean; name: string; scopes: string[]; days: number; saving: boolean; error: string; result: any }>({
  show: false, name: '', scopes: ['read'], days: 30, saving: false, error: '', result: null,
});

const scopeList = [
  { key: 'read', label: 'Đọc' },
  { key: 'write', label: 'Ghi' },
  { key: 'send', label: 'Gửi tin Zalo' },
];
const tokenHeaders = [
  { title: 'Tên', key: 'name' },
  { title: 'Token', key: 'hint' },
  { title: 'Quyền', key: 'scopes', sortable: false },
  { title: 'Hết hạn', key: 'expiresAt' },
  { title: 'Dùng lần cuối', key: 'lastUsedAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];
const logHeaders = [
  { title: 'Thời gian', key: 'createdAt', width: 170 },
  { title: 'Tool', key: 'tool' },
  { title: 'Kết quả', key: 'ok' },
  { title: 'Người dùng', key: 'userName' },
  { title: 'Token', key: 'token', sortable: false },
  { title: 'ms', key: 'durationMs', width: 70 },
];
const adminHeaders = [
  { title: 'Người dùng', key: 'user', sortable: false },
  { title: 'Tên token', key: 'name' },
  { title: 'Token', key: 'hint' },
  { title: 'Quyền', key: 'scopes', sortable: false },
  { title: 'Trạng thái', key: 'state', sortable: false },
  { title: 'Dùng lần cuối', key: 'lastUsedAt' },
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
];

const myTokens = computed<any[]>(() => me.value?.tokens ?? []);

const dayOptions = computed(() => {
  const max = me.value?.tokenTtlDays ?? 90;
  const opts = [7, 30, 90, 180, 365].filter((d) => max === 0 || d <= max).map((d) => ({ label: `${d} ngày`, value: d }));
  if (max === 0) opts.push({ label: 'Không hết hạn', value: 0 });
  return opts;
});

const fmt = (v: string) => new Date(v).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const isExpired = (t: any) => !!t.expiresAt && new Date(t.expiresAt) < new Date();

function showSnack(text: string, color = 'success') {
  snack.value = { show: true, text, color };
}

async function loadMe() {
  me.value = (await api.get('/claude-code/me')).data;
}
async function loadLogs() {
  logs.value = (await api.get('/claude-code/logs', { params: { limit: 200, all: allLogs.value ? 1 : undefined } })).data.logs;
}
async function loadAll() {
  if (authStore.isAdmin) allTokens.value = (await api.get('/claude-code/tokens')).data.tokens;
}

function openCreate() {
  const d = dayOptions.value.find((o) => o.value === 30) ?? dayOptions.value[0];
  create.value = { show: true, name: '', scopes: ['read'], days: d?.value ?? 30, saving: false, error: '', result: null };
}

async function submitCreate() {
  create.value.saving = true;
  create.value.error = '';
  try {
    create.value.result = (await api.post('/claude-code/tokens', {
      name: create.value.name.trim(), scopes: create.value.scopes, expiresInDays: create.value.days,
    })).data;
    await Promise.all([loadMe(), loadAll()]);
  } catch (err: any) {
    create.value.error = err?.response?.data?.error || 'Tạo token thất bại';
  } finally {
    create.value.saving = false;
  }
}

function closeCreate() {
  create.value.show = false;
  create.value.result = null;
}

async function revoke(id: string) {
  if (!confirm('Thu hồi token này? Claude Code dùng token này sẽ mất kết nối ngay.')) return;
  try {
    await api.delete(`/claude-code/tokens/${id}`);
    showSnack('Đã thu hồi token');
    await Promise.all([loadMe(), loadAll()]);
  } catch (err: any) {
    showSnack(err?.response?.data?.error || 'Thu hồi thất bại', 'error');
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  showSnack('Đã sao chép');
}

watch(tab, (t) => {
  if (t === 'logs') loadLogs();
  if (t === 'admin') loadAll();
});
watch(allLogs, loadLogs);
onMounted(loadMe);
</script>

<style scoped>
.cmd {
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: rgba(127, 127, 127, 0.12);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 4px;
}
</style>
