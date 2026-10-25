<template>
  <div style="max-width: 700px;">
    <h1 class="text-h5 mb-4">
      <v-icon class="mr-2" style="color: #00F2FF;">mdi-api</v-icon>
      API & Webhook
    </h1>

    <v-alert v-if="!authStore.isAdmin" type="warning" variant="tonal" class="mb-4">
      Chỉ Owner / Admin mới được cấu hình API key và Webhook.
    </v-alert>

    <!-- API Key section -->
    <v-card class="mb-4">
      <v-card-title class="text-body-1">API Key</v-card-title>
      <v-card-text>
        <v-alert v-if="freshKey" type="info" variant="tonal" class="mb-3">
          Key mới chỉ hiển thị <strong>một lần</strong>. Hãy sao chép và lưu ở nơi an toàn.
        </v-alert>
        <v-text-field
          :model-value="freshKey || apiKeyHint || '(chưa tạo)'"
          label="API Key"
          readonly
          :append-inner-icon="freshKey ? 'mdi-content-copy' : undefined"
          @click:append-inner="copyKey"
        />
        <v-alert v-if="legacyKey" type="warning" variant="tonal" density="compact" class="mb-3">
          Key hiện tại được tạo bởi phiên bản cũ (lưu dạng rõ). Hãy tạo key mới để lưu dạng băm.
        </v-alert>
        <div class="d-flex gap-2">
          <v-btn
            color="primary"
            variant="outlined"
            prepend-icon="mdi-refresh"
            :loading="generatingKey"
            :disabled="!authStore.isAdmin"
            @click="generateKey"
          >
            Tạo key mới
          </v-btn>
          <v-btn
            color="error"
            variant="text"
            prepend-icon="mdi-key-remove"
            :disabled="!authStore.isAdmin || (!apiKeyHint && !freshKey)"
            @click="revokeKey"
          >
            Thu hồi key
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Webhook section -->
    <v-card class="mb-4">
      <v-card-title class="text-body-1">Webhook</v-card-title>
      <v-card-text>
        <v-text-field
          v-model="webhookUrl"
          label="Webhook URL"
          placeholder="https://your-server.com/webhook"
          hint="Chỉ chấp nhận http(s) tới máy chủ công khai; địa chỉ nội bộ bị chặn để chống SSRF."
          persistent-hint
          class="mb-2"
          :disabled="!authStore.isAdmin"
        />
        <v-text-field
          v-model="webhookSecret"
          label="Secret (HMAC)"
          type="password"
          hint="Để trống để giữ secret hiện tại."
          persistent-hint
          class="mb-3"
          :disabled="!authStore.isAdmin"
        />
        <div class="d-flex gap-2">
          <v-btn color="primary" :loading="saving" :disabled="!authStore.isAdmin" @click="saveWebhook">Lưu</v-btn>
          <v-btn variant="outlined" :loading="testing" :disabled="!authStore.isAdmin" @click="testWebhook">Test Webhook</v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- API Docs -->
    <v-card>
      <v-card-title class="text-body-1">API Documentation</v-card-title>
      <v-card-text>
        <pre style="font-size: 12px; overflow-x: auto; white-space: pre-wrap;">Header: X-API-Key: your-key

GET  /api/public/contacts
POST /api/public/contacts
GET  /api/public/conversations
POST /api/public/messages/send
GET  /api/public/appointments
POST /api/public/appointments

Webhook events:
- message.received
- message.sent
- contact.created
- zalo.connected
- zalo.disconnected</pre>
      </v-card-text>
    </v-card>

    <v-snackbar v-model="snack.show" :color="snack.color" :timeout="4000">
      {{ snack.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '@/api';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();

const apiKeyHint = ref('');
const freshKey = ref('');
const legacyKey = ref(false);
const generatingKey = ref(false);
const webhookUrl = ref('');
const webhookSecret = ref('');
const savedSecretMask = ref('');
const saving = ref(false);
const testing = ref(false);

const snack = ref({ show: false, text: '', color: 'success' });

function showSnack(text: string, color = 'success') {
  snack.value = { show: true, text, color };
}

function errorText(err: any, fallback: string) {
  return err?.response?.data?.error || fallback;
}

async function loadApiKey() {
  try {
    const res = await api.get('/settings/api-key');
    apiKeyHint.value = res.data.key ?? '';
    legacyKey.value = !!res.data.legacy;
  } catch {
    apiKeyHint.value = '';
  }
}

async function loadWebhook() {
  try {
    const res = await api.get('/settings/webhook');
    webhookUrl.value = res.data.url ?? '';
    savedSecretMask.value = res.data.secret ?? '';
    webhookSecret.value = '';
  } catch {
    webhookUrl.value = '';
    savedSecretMask.value = '';
  }
}

async function generateKey() {
  if (!confirm('Tạo key mới sẽ vô hiệu hoá key cũ ngay lập tức. Tiếp tục?')) return;
  generatingKey.value = true;
  try {
    const res = await api.post('/settings/api-key/generate');
    freshKey.value = res.data.key ?? '';
    legacyKey.value = false;
    await loadApiKey();
    showSnack('API key mới đã được tạo — hãy sao chép ngay');
  } catch (err) {
    showSnack(errorText(err, 'Tạo key thất bại'), 'error');
  } finally {
    generatingKey.value = false;
  }
}

async function revokeKey() {
  if (!confirm('Thu hồi API key? Mọi tích hợp đang dùng key này sẽ ngừng hoạt động.')) return;
  try {
    await api.delete('/settings/api-key');
    freshKey.value = '';
    apiKeyHint.value = '';
    legacyKey.value = false;
    showSnack('Đã thu hồi API key');
  } catch (err) {
    showSnack(errorText(err, 'Thu hồi thất bại'), 'error');
  }
}

async function copyKey() {
  if (!freshKey.value) return;
  await navigator.clipboard.writeText(freshKey.value);
  showSnack('Đã sao chép API key');
}

async function saveWebhook() {
  saving.value = true;
  try {
    const payload: { url: string; secret?: string } = { url: webhookUrl.value.trim() };
    // Empty field = keep existing secret
    if (webhookSecret.value) payload.secret = webhookSecret.value;
    await api.put('/settings/webhook', payload);
    await loadWebhook();
    showSnack('Đã lưu cấu hình webhook');
  } catch (err) {
    showSnack(errorText(err, 'Lưu thất bại'), 'error');
  } finally {
    saving.value = false;
  }
}

async function testWebhook() {
  testing.value = true;
  try {
    await api.post('/settings/webhook/test');
    showSnack('Đã gửi sự kiện test tới webhook');
  } catch (err) {
    showSnack(errorText(err, 'Test webhook thất bại'), 'error');
  } finally {
    testing.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadApiKey(), loadWebhook()]);
});
</script>
