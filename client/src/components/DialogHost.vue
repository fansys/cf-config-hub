<script setup lang="ts">
import { ref, watch } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import { pendingDialog, settleDialog } from '@/lib/dialogs';

const draft = ref('');
const selected = ref('');

watch(pendingDialog, (dialog) => {
  draft.value = dialog?.defaultValue || '';
  selected.value = dialog?.selected || dialog?.options[0]?.id || '';
});

function submitInput(event?: KeyboardEvent) {
  const dialog = pendingDialog.value;
  if (!dialog) return;
  if (dialog.multiline && event && !(event.ctrlKey || event.metaKey)) return;
  if (event) event.preventDefault();
  settleDialog(draft.value);
}
</script>

<template>
  <Dialog
    v-if="pendingDialog"
    :open="true"
    :title="pendingDialog.title"
    @update:open="open => { if (!open) settleDialog(pendingDialog?.kind === 'confirm' || pendingDialog?.kind === 'input' || pendingDialog?.kind === 'choice' ? null : undefined) }"
  >
    <p v-if="pendingDialog.message" class="mb-3 text-sm leading-6">{{ pendingDialog.message }}</p>
    <ul v-if="pendingDialog.details.length" class="mb-3 max-h-40 overflow-auto rounded-lg bg-background p-2 text-xs">
      <li v-for="line in pendingDialog.details" :key="line">{{ line }}</li>
    </ul>
    <input
      v-if="pendingDialog.kind === 'input' && !pendingDialog.multiline"
      v-model="draft"
      class="mb-3 w-full rounded-lg border border-border px-3 py-2"
      :placeholder="pendingDialog.placeholder"
      @keydown.enter.prevent="settleDialog(draft)"
    />
    <textarea
      v-else-if="pendingDialog.kind === 'input'"
      v-model="draft"
      rows="10"
      class="mb-3 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs"
      :placeholder="pendingDialog.placeholder"
      @keydown.enter="submitInput"
    />
    <div v-else-if="pendingDialog.kind === 'choice'" class="mb-3 space-y-2">
      <label v-for="option in pendingDialog.options" :key="option.id" class="flex cursor-pointer gap-2 rounded-lg border border-border p-2">
        <input v-model="selected" type="radio" :value="option.id" />
        <span><strong>{{ option.name }}</strong><small v-if="option.desc" class="mt-1 block text-muted">{{ option.desc }}</small></span>
      </label>
    </div>
    <div class="flex justify-end gap-2">
      <Button v-if="pendingDialog.kind !== 'alert'" @click="settleDialog(pendingDialog.kind === 'confirm' ? false : null)">{{ pendingDialog.cancelText }}</Button>
      <Button :variant="pendingDialog.danger ? 'danger' : 'primary'" @click="settleDialog(pendingDialog.kind === 'confirm' ? true : pendingDialog.kind === 'choice' ? selected : pendingDialog.kind === 'alert' ? true : draft)">
        {{ pendingDialog.okText }}
      </Button>
    </div>
  </Dialog>
</template>
