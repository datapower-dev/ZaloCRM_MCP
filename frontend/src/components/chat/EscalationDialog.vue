<template>
  <v-dialog :model-value="modelValue" max-width="520" @update:model-value="$emit('update:modelValue', $event)">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon color="warning" class="mr-2">mdi-alert-decagram</v-icon>
        Chuyển Ca khó
      </v-card-title>
      <v-card-text>
        <p class="text-body-2 mb-3 text-medium-emphasis">
          Yêu cầu phức tạp hoặc cần phê duyệt sẽ được gửi kèm 5 tin nhắn gần nhất tới <b>Zalo quản lí</b> và <b>Telegram</b>.
        </p>
        <v-text-field v-model="form.title" label="Tiêu đề *" counter="200" maxlength="200" class="mb-2" autofocus />
        <div class="d-flex" style="gap: 12px;">
          <v-select v-model="form.category" :items="categories" item-title="label" item-value="value" label="Loại" />
          <v-select v-model="form.priority" :items="priorities" item-title="label" item-value="value" label="Mức độ" />
        </div>
        <v-textarea v-model="form.detail" label="Chi tiết / đề xuất" rows="4" counter="4000" maxlength="4000" auto-grow />
        <v-alert v-if="error" type="error" density="compact" class="mt-2">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="$emit('update:modelValue', false)">Hủy</v-btn>
        <v-btn color="warning" variant="flat" :loading="saving" :disabled="!form.title.trim()" @click="submit">Chuyển ca khó</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '@/api';

const props = defineProps<{ modelValue: boolean; conversationId: string; titleHint?: string }>();
const emit = defineEmits<{ 'update:modelValue': [v: boolean]; created: [message: string] }>();

const categories = [
  { label: 'Yêu cầu phức tạp', value: 'complex' },
  { label: 'Cần phê duyệt', value: 'approval' },
];
const priorities = [
  { label: 'Bình thường', value: 'normal' },
  { label: 'Cao', value: 'high' },
  { label: 'Khẩn', value: 'urgent' },
];

const form = ref({ title: '', detail: '', category: 'complex', priority: 'normal' });
const saving = ref(false);
const error = ref('');

watch(() => props.modelValue, (open) => {
  if (open) {
    form.value = { title: '', detail: '', category: 'complex', priority: 'normal' };
    error.value = '';
  }
});

function deliveryText(d: { zalo: string; telegram: string }) {
  const part = (label: string, v: string) =>
    v.startsWith('sent') ? `${label}: đã gửi` : v.startsWith('failed') ? `${label}: lỗi (${v.slice(8)})` : `${label}: bỏ qua (${v.slice(9)})`;
  return `${part('Zalo', d.zalo)} · ${part('Telegram', d.telegram)}`;
}

async function submit() {
  if (!props.conversationId) return;
  saving.value = true;
  error.value = '';
  try {
    const res = await api.post(`/conversations/${props.conversationId}/escalations`, {
      title: form.value.title.trim(),
      detail: form.value.detail.trim() || undefined,
      category: form.value.category,
      priority: form.value.priority,
    });
    emit('created', `Đã chuyển ca khó. ${deliveryText(res.data.delivery)}`);
    emit('update:modelValue', false);
  } catch (err: any) {
    error.value = err?.response?.data?.error || 'Không chuyển được ca khó';
  } finally {
    saving.value = false;
  }
}
</script>
