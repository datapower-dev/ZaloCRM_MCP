<template>
  <div style="max-width: 1000px;">
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" style="color: #00F2FF;">mdi-tune-variant</v-icon>
      Cấu hình
    </h1>

    <v-progress-linear v-if="!cfg" indeterminate color="primary" />

    <template v-if="cfg">
      <v-tabs v-model="tab" class="mb-4" show-arrows>
        <v-tab value="mcp">MCP</v-tab>
        <v-tab value="claude">Claude Code</v-tab>
        <v-tab value="permissions">Phân quyền</v-tab>
        <v-tab value="telegram">Telegram bot</v-tab>
        <v-tab value="sla">Thời gian phản hồi</v-tab>
        <v-tab value="channels">Kênh &amp; Ca khó</v-tab>
      </v-tabs>

      <v-window v-model="tab">
        <!-- ── MCP ──────────────────────────────────────────────── -->
        <v-window-item value="mcp">
          <v-card>
            <v-card-text>
              <p class="text-body-2 mb-3">
                Máy chủ MCP cho phép Claude Code làm việc với dữ liệu CRM. Endpoint: <code>{{ data.mcpEndpoint }}</code>
              </p>
              <v-switch v-model="cfg.mcp.enabled" color="primary" label="Bật máy chủ MCP" hide-details />
              <v-switch v-model="cfg.mcp.requireAiAssist" color="primary" hide-details
                label="Chỉ cho Claude thấy kênh bật AI assist (khuyến nghị)" />
              <v-switch v-model="cfg.mcp.allowWrite" color="primary" hide-details
                label="Cho phép ghi: cập nhật khách hàng, chuyển/xử lý ca khó" />
              <v-switch v-model="cfg.mcp.allowSend" color="warning" hide-details
                label="Cho phép gửi tin nhắn Zalo qua Claude Code (cần thêm quyền mcp.send)" />
              <v-alert v-if="cfg.mcp.allowSend" type="warning" variant="tonal" density="compact" class="mt-2">
                Claude có thể gửi tin thay nhân viên. Giới hạn chống khoá Zalo (200 tin/ngày, 5 tin/30s) vẫn áp dụng.
              </v-alert>
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :loading="saving === 'mcp'" @click="save('mcp')">Lưu</v-btn></v-card-actions>
          </v-card>
        </v-window-item>

        <!-- ── Claude Code ─────────────────────────────────────── -->
        <v-window-item value="claude">
          <v-card>
            <v-card-text>
              <v-alert v-if="!authStore.isOwner" type="info" variant="tonal" density="compact" class="mb-3">Chỉ owner được thay đổi mục này.</v-alert>
              <v-switch v-model="cfg.claude.enabled" color="primary" label="Bật Claude Code cho tổ chức" hide-details :disabled="!authStore.isOwner" />
              <v-row class="mt-2">
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="cfg.claude.maxTokensPerUser" type="number" min="1" max="50" label="Số token tối đa mỗi người" :disabled="!authStore.isOwner" />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="cfg.claude.tokenTtlDays" type="number" min="0" max="365" label="Hạn tối đa của token (ngày, 0 = không giới hạn)" :disabled="!authStore.isOwner" />
                </v-col>
              </v-row>
              <v-autocomplete
                v-model="cfg.claude.allowedUserIds"
                :items="userOptions"
                item-title="label"
                item-value="value"
                label="Cấp quyền Claude Code cho từng người (ngoài quyền theo vai trò)"
                multiple chips closable-chips
                :disabled="!authStore.isOwner"
              />
              <p class="text-caption text-medium-emphasis">Quyền theo vai trò đặt ở tab Phân quyền (dòng “Dùng Claude Code”). Owner luôn có quyền.</p>
            </v-card-text>
            <v-card-actions>
              <v-btn variant="text" to="/claude-code">Quản lí token</v-btn>
              <v-spacer />
              <v-btn color="primary" variant="flat" :disabled="!authStore.isOwner" :loading="saving === 'claude'" @click="save('claude')">Lưu</v-btn>
            </v-card-actions>
          </v-card>
        </v-window-item>

        <!-- ── Permissions ─────────────────────────────────────── -->
        <v-window-item value="permissions">
          <v-card>
            <v-card-text>
              <v-alert v-if="!authStore.isOwner" type="info" variant="tonal" density="compact" class="mb-3">Chỉ owner được thay đổi phân quyền.</v-alert>
              <v-table density="compact">
                <thead>
                  <tr><th>Quyền</th><th class="text-center">Owner</th><th class="text-center">Admin</th><th class="text-center">Member</th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in data.permissionKeys" :key="p.key">
                    <td>{{ p.label }} <div class="text-caption text-medium-emphasis">{{ p.key }}</div></td>
                    <td class="text-center"><v-icon color="success" size="18">mdi-check</v-icon></td>
                    <td class="text-center"><v-checkbox-btn v-model="cfg.permissions.admin[p.key]" class="d-inline-flex" :disabled="!authStore.isOwner" /></td>
                    <td class="text-center"><v-checkbox-btn v-model="cfg.permissions.member[p.key]" class="d-inline-flex" :disabled="!authStore.isOwner" /></td>
                  </tr>
                </tbody>
              </v-table>
              <p class="text-caption text-medium-emphasis mt-2">
                Quyền truy cập từng tài khoản Zalo (đọc / chat / quản trị) vẫn đặt ở Tài khoản Zalo → Phân quyền truy cập.
              </p>
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :disabled="!authStore.isOwner" :loading="saving === 'permissions'" @click="save('permissions')">Lưu</v-btn></v-card-actions>
          </v-card>
        </v-window-item>

        <!-- ── Telegram ────────────────────────────────────────── -->
        <v-window-item value="telegram">
          <v-card class="mb-4">
            <v-card-title class="text-body-1">Bot</v-card-title>
            <v-card-text>
              <div v-if="data.telegram.hasToken" class="d-flex align-center mb-3" style="gap: 8px;">
                <v-chip color="success" variant="tonal">@{{ data.telegram.botUsername }}</v-chip>
                <v-chip :color="data.telegram.running ? 'success' : 'grey'" size="small" variant="flat">{{ data.telegram.running ? 'Đang chạy' : 'Đang dừng' }}</v-chip>
                <v-spacer />
                <v-btn size="small" variant="text" color="error" @click="removeToken">Gỡ bot</v-btn>
              </div>
              <div v-else class="text-body-2 mb-2">
                Tạo bot với <b>@BotFather</b> trên Telegram (lệnh <code>/newbot</code>), rồi dán bot token. Token được mã hoá trong DB.
              </div>
              <div class="d-flex" style="gap: 8px;">
                <v-text-field v-model="botToken" :label="data.telegram.hasToken ? 'Thay bot token' : 'Bot token'" type="password" placeholder="123456789:AA…" hide-details density="compact" />
                <v-btn color="primary" :loading="savingToken" :disabled="!botToken.trim()" @click="saveToken">Lưu token</v-btn>
              </div>
              <v-divider class="my-4" />
              <v-switch v-model="cfg.telegram.enabled" color="primary" label="Bật bot" hide-details :disabled="!data.telegram.hasToken" />
              <v-switch v-model="cfg.telegram.notifyEscalations" color="primary" label="Gửi ca khó (kèm nút Duyệt / Từ chối / Đã xử lý)" hide-details />
              <v-switch v-model="cfg.telegram.dailySummary" color="primary" label="Gửi tổng quan lúc 08:00 hằng ngày" hide-details />
              <p class="text-caption text-medium-emphasis mt-2">
                Lệnh bot: /tongquan (dashboard), /cakho (ca khó đang chờ), /quahan (hội thoại quá hạn), /help. Cảnh báo quá hạn bật ở tab Thời gian phản hồi.
              </p>
            </v-card-text>
            <v-card-actions>
              <v-btn variant="text" :disabled="!data.telegram.hasToken" :loading="testing" @click="testTelegram">Gửi tin thử</v-btn>
              <v-spacer />
              <v-btn color="primary" variant="flat" :loading="saving === 'telegram'" @click="save('telegram')">Lưu</v-btn>
            </v-card-actions>
          </v-card>

          <v-card>
            <v-card-title class="d-flex align-center text-body-1">
              Chat đã liên kết
              <v-spacer />
              <v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-link-variant" :disabled="!data.telegram.hasToken" @click="getLinkCode">Liên kết chat mới</v-btn>
            </v-card-title>
            <v-card-text>
              <v-alert v-if="link" type="info" variant="tonal" class="mb-3">
                Mở <a :href="link.deepLink" target="_blank" rel="noopener">{{ link.deepLink }}</a> (chat riêng),
                hoặc thêm bot vào nhóm rồi gửi <code>/start {{ link.code }}</code>. Mã hết hạn lúc {{ fmt(link.expiresAt) }}.
              </v-alert>
              <v-table density="compact">
                <thead><tr><th>Chat</th><th>Chat ID</th><th>Được duyệt ca khó</th><th>Liên kết lúc</th><th></th></tr></thead>
                <tbody>
                  <tr v-for="c in data.telegram.chats" :key="c.id">
                    <td>{{ c.title }}</td>
                    <td><code>{{ c.chatId }}</code></td>
                    <td><v-checkbox-btn :model-value="c.canAct" @update:model-value="(v: boolean | null) => setCanAct(c, !!v)" /></td>
                    <td>{{ fmt(c.createdAt) }}</td>
                    <td class="text-right"><v-btn size="small" variant="text" color="error" @click="unlink(c.id)">Huỷ liên kết</v-btn></td>
                  </tr>
                  <tr v-if="!data.telegram.chats.length"><td colspan="5" class="text-medium-emphasis">Chưa có chat nào. Chỉ chat đã liên kết mới dùng được lệnh bot.</td></tr>
                </tbody>
              </v-table>
            </v-card-text>
          </v-card>
        </v-window-item>

        <!-- ── SLA ─────────────────────────────────────────────── -->
        <v-window-item value="sla">
          <v-card>
            <v-card-text>
              <v-row>
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="cfg.sla.warnMinutes" type="number" min="1" label="Cảnh báo chưa trả lời sau (phút)" hint="Chuông thông báo + màu cam trong Kênh Tư Vấn" persistent-hint />
                </v-col>
                <v-col cols="12" md="6">
                  <v-text-field v-model.number="cfg.sla.overdueMinutes" type="number" min="1" label="Quá hạn phản hồi sau (phút)" hint="Màu đỏ, đếm trong Dashboard, báo Telegram" persistent-hint />
                </v-col>
                <v-col cols="6" md="3"><v-text-field v-model="cfg.sla.workStart" label="Giờ làm từ" placeholder="08:00" /></v-col>
                <v-col cols="6" md="3"><v-text-field v-model="cfg.sla.workEnd" label="đến" placeholder="21:00" /></v-col>
                <v-col cols="12" md="6" class="d-flex align-center">
                  <v-switch v-model="cfg.sla.notifyTelegram" color="primary" label="Báo Telegram khi có hội thoại quá hạn (trong giờ làm)" hide-details />
                </v-col>
              </v-row>
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :loading="saving === 'sla'" @click="save('sla')">Lưu</v-btn></v-card-actions>
          </v-card>
        </v-window-item>

        <!-- ── Channels & escalation ───────────────────────────── -->
        <v-window-item value="channels">
          <v-card class="mb-4">
            <v-card-title class="text-body-1">Kênh mới</v-card-title>
            <v-card-text>
              <v-switch v-model="cfg.channels.listenNewGroups" color="primary" label="Tự nghe nhóm Zalo MỚI" hide-details />
              <v-switch v-model="cfg.channels.listenNewP2P" color="primary" label="Tự nghe hội thoại P2P MỚI" hide-details />
              <v-switch v-model="cfg.channels.aiAssistNew" color="purple" label="Tự bật AI assist cho kênh mới" hide-details />
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :loading="saving === 'channels'" @click="save('channels')">Lưu</v-btn></v-card-actions>
          </v-card>

          <v-card>
            <v-card-title class="text-body-1">Ca khó</v-card-title>
            <v-card-text>
              <v-alert :type="data.managerAccount ? 'success' : 'warning'" variant="tonal" density="compact" class="mb-3">
                <template v-if="data.managerAccount">Zalo quản lí: <b>{{ data.managerAccount.displayName || data.managerAccount.id }}</b></template>
                <template v-else>Chưa chọn Zalo quản lí — vào <router-link to="/zalo-accounts">Tài khoản Zalo</router-link> và bấm ★ trên tài khoản quản lí.</template>
              </v-alert>
              <v-switch v-model="cfg.escalation.notifyZalo" color="primary" label="Gửi ca khó qua Zalo quản lí" hide-details />
              <v-switch v-model="cfg.escalation.notifyTelegram" color="primary" label="Gửi ca khó qua Telegram" hide-details />
              <v-autocomplete
                v-model="cfg.escalation.managerConversationId"
                :items="threadOptions"
                item-title="title"
                item-value="id"
                label="Nơi nhận ca khó trên Zalo quản lí"
                hint="Để trống: Zalo của hội thoại nhắn trực tiếp tới Zalo quản lí. Chọn một nhóm (VD nhóm Quản lí) để Zalo quản lí đăng vào nhóm."
                persistent-hint
                clearable
                :disabled="!data.managerAccount"
                class="mt-3"
              />
            </v-card-text>
            <v-card-actions><v-spacer /><v-btn color="primary" variant="flat" :loading="saving === 'escalation'" @click="save('escalation')">Lưu</v-btn></v-card-actions>
          </v-card>
        </v-window-item>
      </v-window>
    </template>

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="3500">{{ snack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permissions';

const authStore = useAuthStore();
const permStore = usePermissionStore();
const tab = ref('mcp');
const data = ref<any>(null);
const cfg = ref<any>(null);
const users = ref<any[]>([]);
const threads = ref<{ id: string; title: string }[]>([]);
const saving = ref<string | null>(null);
const savingToken = ref(false);
const testing = ref(false);
const botToken = ref('');
const link = ref<{ code: string; deepLink: string; expiresAt: string } | null>(null);
const snack = ref({ show: false, text: '', color: 'success' });

const userOptions = computed(() => users.value.filter((u) => u.isActive && u.role !== 'owner').map((u) => ({ label: `${u.fullName} (${u.role})`, value: u.id })));
const threadOptions = computed(() => threads.value);
const fmt = (v: string) => new Date(v).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

function showSnack(text: string, color = 'success') {
  snack.value = { show: true, text, color };
}
function err(e: any, fallback: string) {
  showSnack(e?.response?.data?.error || fallback, 'error');
}

async function load() {
  const res = await api.get('/config');
  data.value = res.data;
  cfg.value = structuredClone(res.data.config);
  if (res.data.managerAccount) {
    threads.value = (await api.get('/config/manager-threads')).data.threads;
  }
}

async function save(section: string) {
  saving.value = section;
  try {
    const res = await api.put(`/config/${section}`, cfg.value[section]);
    cfg.value = structuredClone(res.data.config);
    data.value.config = res.data.config;
    showSnack('Đã lưu cấu hình');
    permStore.load();
    if (section === 'telegram') await load();
  } catch (e) {
    err(e, 'Lưu thất bại');
  } finally {
    saving.value = null;
  }
}

async function saveToken() {
  savingToken.value = true;
  try {
    const r = (await api.put('/config/telegram/token', { token: botToken.value.trim() })).data;
    botToken.value = '';
    showSnack(`Đã kết nối bot @${r.botUsername}`);
    await load();
  } catch (e) {
    err(e, 'Không lưu được token');
  } finally {
    savingToken.value = false;
  }
}

async function removeToken() {
  if (!confirm('Gỡ bot Telegram? Bot sẽ ngừng nhận lệnh và gửi thông báo.')) return;
  try {
    await api.delete('/config/telegram/token');
    showSnack('Đã gỡ bot');
    await load();
  } catch (e) {
    err(e, 'Gỡ bot thất bại');
  }
}

async function getLinkCode() {
  try {
    link.value = (await api.post('/config/telegram/link-code')).data;
  } catch (e) {
    err(e, 'Không tạo được mã liên kết');
  }
}

async function testTelegram() {
  testing.value = true;
  try {
    const r = (await api.post('/config/telegram/test')).data;
    if (r.skipped) showSnack(r.skipped, 'warning');
    else showSnack(`Đã gửi tới ${r.sent} chat${r.failed ? `, lỗi ${r.failed}` : ''}`, r.failed ? 'warning' : 'success');
  } catch (e) {
    err(e, 'Gửi thử thất bại');
  } finally {
    testing.value = false;
  }
}

async function setCanAct(c: any, v: boolean) {
  try {
    await api.patch(`/config/telegram/chats/${c.id}`, { canAct: v });
    c.canAct = v;
  } catch (e) {
    err(e, 'Cập nhật thất bại');
  }
}

async function unlink(id: string) {
  if (!confirm('Huỷ liên kết chat này?')) return;
  try {
    await api.delete(`/config/telegram/chats/${id}`);
    await load();
  } catch (e) {
    err(e, 'Huỷ liên kết thất bại');
  }
}

onMounted(async () => {
  try {
    await load();
    users.value = (await api.get('/users')).data.users;
  } catch (e) {
    err(e, 'Không tải được cấu hình');
  }
});
</script>
