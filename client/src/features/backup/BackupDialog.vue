<script setup lang="ts">
import { gitBlobSha } from '@shared/gitsha.js';
import { planImport, readZip } from '@shared/zip.js';
import { b64FromBytes, isValidPath } from '@shared/text.js';
import { ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { downloadBlob, request } from '@/lib/api';
import { askConfirm } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { panels } from '@/features/shell/panels';
import { useSession } from '@/stores/session';

const session = useSession();
const rows = ref<any[]>([]);
const summary = ref('');
const stripTop = ref(true);
const prefix = ref('');
let zipFiles: any[] | null = null;

watch(() => panels.backup, (open) => {
  if (!open) return;
  rows.value = [];
  summary.value = '';
  zipFiles = null;
}, { immediate: true });

async function doExport() {
  try {
    const file = await downloadBlob('/api/export');
    const url = URL.createObjectURL(file.blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已开始下载');
  } catch (error) { toast('导出失败：' + (error as Error).message); }
}

async function analyze() {
  if (!zipFiles) return;
  const plan = planImport(zipFiles, { stripTop: stripTop.value, prefix: prefix.value });
  const known = new Map(session.files.map(file => [file.path, file.sha]));
  const next = [];
  for (const item of plan.items) {
    const row: any = { path: item.path, size: item.bytes.length, bytes: item.bytes };
    if (!isValidPath(item.path)) row.skip = '路径不合法或属于 Actions 工作流';
    else if (item.bytes.length > 1024 * 1024) row.skip = '超过 1 MiB';
    else {
      row.sha = await gitBlobSha(item.bytes);
      row.status = !known.has(item.path) ? '新增' : known.get(item.path) === row.sha ? '未变化' : '覆盖';
      try { row.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(item.bytes); }
      catch { row.binary = true; }
    }
    next.push(row);
  }
  rows.value = next;
  const ok = next.filter(row => !row.skip);
  const count = (status: string) => ok.filter(row => row.status === status).length;
  summary.value = `新增 ${count('新增')}、覆盖 ${count('覆盖')}、未变化 ${count('未变化')}、跳过 ${next.length - ok.length}`;
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try { zipFiles = await readZip(await file.arrayBuffer()); await analyze(); }
  catch (error) { toast('读取失败：' + (error as Error).message); }
}

async function commitImport() {
  const todo = rows.value.filter(row => !row.skip && row.status !== '未变化');
  if (!todo.length) return;
  if (!await askConfirm({ title: '确认导入', okText: '导入并提交', danger: true, message: `将向 GitHub 提交 ${todo.length} 个文件。` })) return;
  const batches: any[][] = [];
  let current: any[] = [];
  let bytes = 0;
  for (const row of todo) {
    if (current.length >= 50 || bytes + row.bytes.length > 2.5 * 1024 * 1024) { batches.push(current); current = []; bytes = 0; }
    current.push(row);
    bytes += row.bytes.length;
  }
  if (current.length) batches.push(current);
  for (const [index, batch] of batches.entries()) {
    await request('/api/commit', 'POST', {
      message: batches.length > 1 ? `Import ${todo.length} file(s) from zip (${index + 1}/${batches.length})` : `Import ${todo.length} file(s) from zip`,
      changes: batch.map(row => (row.binary ? { path: row.path, base64: b64FromBytes(row.bytes) } : { path: row.path, content: row.text })),
    });
  }
  await session.refreshFiles();
  session.clearFileCache();
  panels.backup = false;
  toast(`导入完成：${todo.length} 个文件，${batches.length} 次提交`);
}
</script>

<template>
  <Dialog :open="panels.backup" title="导出 / 导入" wide @update:open="open => panels.backup = open">
    <p class="mb-2 text-sm text-muted">导出 {{ session.info?.owner }}/{{ session.info?.repo }} 的 {{ session.info?.branch }} 分支（整个仓库，不受管理目录限制）。</p>
    <Button variant="secondary" @click="doExport">导出当前分支为 zip</Button>
    <template v-if="!session.readonly">
      <h3 class="mb-2 mt-4 font-semibold">导入 zip</h3>
      <input type="file" accept=".zip,application/zip" @change="onFile" />
      <label class="mt-2 block text-sm"><input v-model="stripTop" type="checkbox" @change="analyze" /> 去掉 zip 的顶层目录</label>
      <input v-model="prefix" class="mt-2 w-full rounded border border-border px-2 py-1" placeholder="导入到目录（留空=根目录）" @change="analyze" />
      <p class="my-2 text-sm">{{ summary }}</p>
      <div class="max-h-64 overflow-auto text-xs">
        <div v-for="row in rows.slice(0, 300)" :key="row.path">{{ row.path }} · {{ row.skip ? '跳过：' + row.skip : row.status }}</div>
      </div>
      <Button class="mt-3" variant="primary" @click="commitImport">导入变更</Button>
    </template>
  </Dialog>
</template>
