<script setup lang="ts">
import { bytesFromB64, toLF } from '@shared/text.js';
import { ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { fileUrl, request } from '@/lib/api';
import { askConfirm } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { decodeBytes, useFileActions } from '@/features/editor/actions';
import { panels } from '@/features/shell/panels';
import { useSession } from '@/stores/session';

const session = useSession();
const actions = useFileActions();
const history = ref<any[]>([]);
const activity = ref<any[]>([]);
const error = ref('');

watch(() => panels.history, async (open) => {
  if (!open || !session.current) return;
  error.value = '';
  try { history.value = (await request('/api/history?path=' + encodeURIComponent(session.current.path))).commits || []; }
  catch (err) { error.value = (err as Error).message; }
}, { immediate: true });
watch(() => panels.activity, async (open) => {
  if (!open) return;
  try { activity.value = (await request('/api/activity')).commits || []; }
  catch (err) { error.value = (err as Error).message; }
}, { immediate: true });

async function versionText(sha: string) {
  const data = await request(`${fileUrl(session.current!.path)}&ref=${sha}`);
  const decoded = decodeBytes(bytesFromB64(data.content));
  if (decoded.binary) throw new Error('该版本是二进制文件，无法对比');
  return toLF(decoded.text);
}

async function diff(sha: string) {
  try {
    panels.diff = { title: `${sha.slice(0, 7)} → 当前编辑内容`, oldText: await versionText(sha), newText: toLF(session.getEditorText()) };
  } catch (err) { toast((err as Error).message); }
}

async function load(sha: string) {
  try {
    const text = await versionText(sha);
    if (session.dirty && !await askConfirm({ title: '覆盖未保存的修改', message: '编辑器里有未保存的修改，载入旧版本会覆盖它们，继续吗？', okText: '继续载入', danger: true })) return;
    panels.history = false;
    await actions.replaceContent(text);
    toast('已载入旧版本，保存后才会提交');
  } catch (err) { toast((err as Error).message); }
}
</script>

<template>
  <Dialog :open="panels.history" :title="`提交历史 · ${session.current?.path || ''}`" wide @update:open="open => panels.history = open">
    <p v-if="error" class="text-sm text-danger">{{ error }}</p>
    <p v-else-if="!history.length" class="text-sm text-muted">没有找到提交记录。</p>
    <div v-for="commit in history" :key="commit.sha" class="mb-2 flex flex-col justify-between gap-2 border-b border-border py-2.5 last:border-b-0 sm:flex-row sm:items-center">
      <div class="min-w-0">
        <div class="break-words text-sm font-medium text-foreground">{{ commit.message || '(无提交信息)' }}</div>
        <div class="mt-0.5 text-xs text-muted">{{ commit.sha.slice(0, 7) }} · {{ commit.author }} · {{ commit.date ? new Date(commit.date).toLocaleString() : '' }}</div>
      </div>
      <div class="flex shrink-0 gap-1.5">
        <Button variant="secondary" size="sm" @click="diff(commit.sha)">对比当前</Button>
        <Button variant="secondary" size="sm" @click="load(commit.sha)">载入此版本</Button>
      </div>
    </div>
  </Dialog>
  <Dialog :open="panels.activity" :title="`操作记录 · ${session.info?.branch || ''}`" wide @update:open="open => panels.activity = open">
    <p v-if="!activity.length" class="text-sm text-muted">没有找到操作记录。</p>
    <div v-for="commit in activity" :key="commit.sha" class="mb-2 flex items-start justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <div class="min-w-0">
        <div class="break-words text-sm font-medium text-foreground">{{ commit.message || '(无提交信息)' }}</div>
        <div class="mt-0.5 text-xs text-muted">{{ commit.author }} · {{ commit.date ? new Date(commit.date).toLocaleString() : '' }}</div>
      </div>
      <a class="shrink-0 rounded-md bg-background px-2 py-1 font-mono text-xs font-medium text-primary hover:underline" :href="`https://github.com/${encodeURIComponent(session.info.owner)}/${encodeURIComponent(session.info.repo)}/commit/${commit.sha}`" target="_blank" rel="noopener noreferrer">{{ commit.sha.slice(0, 7) }}</a>
    </div>
  </Dialog>
</template>
