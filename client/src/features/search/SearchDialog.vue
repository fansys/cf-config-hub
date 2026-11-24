<script setup lang="ts">
import { buildMatcher, findInText, replaceInText, searchable } from '@shared/searchlib.js';
import { bytesFromB64 } from '@shared/text.js';
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { fileUrl, request } from '@/lib/api';
import { askConfirm } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { panels } from '@/features/shell/panels';
import { useFileActions } from '@/features/editor/actions';
import { useSession } from '@/stores/session';

const session = useSession();
const actions = useFileActions();
const query = ref('');
const replacement = ref('');
const pathFilter = ref('');
const regex = ref(false);
const caseSensitive = ref(false);
const wholeWord = ref(false);
const summary = ref('');
const progress = ref(0);
const hits = ref<any[]>([]);
const cache = new Map<string, { sha: string; text: string | null }>();
let last: any = null;

async function loadTexts(files: any[]) {
  for (const file of files) {
    const shared = session.getCachedFile(file.path, file.sha);
    if (shared) cache.set(file.path, { sha: file.sha, text: shared.binary ? null : shared.text });
  }
  const pending = files.filter(file => cache.get(file.path)?.sha !== file.sha);
  let done = 0;
  const queue = [...pending];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        const data = await request(fileUrl(file.path));
        const bytes = bytesFromB64(data.content);
        const binary = bytes.includes(0);
        const text = binary ? null : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        cache.set(file.path, { sha: file.sha, text });
        session.setCachedFile(file.path, { sha: data.sha, size: data.size, bytes, text: text || '', binary });
      } catch { cache.set(file.path, { sha: file.sha, text: null }); }
      done += 1;
      progress.value = pending.length ? done / pending.length : 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
}

async function run() {
  let matcher;
  try { matcher = buildMatcher({ query: query.value, regex: regex.value, caseSensitive: caseSensitive.value, wholeWord: wholeWord.value }); }
  catch (error) { return toast((error as Error).message); }
  const filters = pathFilter.value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const files = session.files.filter(file => searchable(file.path, file.size) && (!filters.length || filters.some(item => file.path.toLowerCase().includes(item))));
  summary.value = `正在读取 ${files.length} 个文件…`;
  await loadTexts(files);
  const perFile = [];
  let total = 0;
  for (const file of files) {
    const text = cache.get(file.path)?.text;
    if (text == null) continue;
    const found = findInText(text, matcher);
    if (found.total) { perFile.push({ path: file.path, text, found }); total += found.total; }
  }
  last = { matcher, perFile, regex: regex.value };
  hits.value = perFile.slice(0, 200);
  summary.value = perFile.length ? `在 ${perFile.length} 个文件中找到 ${total} 处匹配` : `没有找到匹配（已搜索 ${files.length} 个文本文件）`;
}

async function replaceAll() {
  if (!last?.perFile.length) return;
  const changes = [];
  let count = 0;
  for (const file of last.perFile) {
    const out = replaceInText(file.text, last.matcher, replacement.value, last.regex);
    if (out.text !== file.text) { changes.push({ path: file.path, content: out.text, count: out.count }); count += out.count; }
  }
  if (!changes.length) return toast('替换后内容没有变化');
  if (session.dirty && changes.some(change => change.path === session.current?.path) && !(await actions.checkUnsaved())) return;
  if (!await askConfirm({ title: '确认全部替换', message: `将在 ${changes.length} 个文件中替换 ${count} 处，并以原子提交写入 GitHub。`, okText: '替换并提交', danger: true, details: changes.slice(0, 12).map(change => `${change.path}（${change.count} 处）`) })) return;
  let batch: any[] = [];
  let bytes = 0;
  let commits = 0;
  const flush = async () => {
    if (!batch.length) return;
    await request('/api/commit', 'POST', { message: `Replace in ${changes.length} file(s)`, changes: batch.map(({ path, content }) => ({ path, content })) });
    commits += 1;
    batch = [];
    bytes = 0;
  };
  for (const change of changes) {
    const size = change.content.length * 3;
    if (batch.length >= 50 || bytes + size > 2.5 * 1024 * 1024) await flush();
    batch.push(change);
    bytes += size;
  }
  await flush();
  cache.clear();
  session.clearFileCache();
  const reopen = session.current && changes.some(change => change.path === session.current?.path) ? session.current.path : null;
  await session.refreshFiles();
  if (reopen) { session.current = null; session.dirty = false; await actions.openFile(reopen); }
  panels.search = false;
  toast(`已替换 ${count} 处（${changes.length} 个文件，${commits} 次提交）`);
}

async function openHit(path: string, line: number) {
  panels.search = false;
  await actions.openFile(path);
  await actions.setMode('highlight');
}
</script>

<template>
  <Dialog :open="panels.search" title="全库搜索 / 替换" wide @update:open="open => panels.search = open">
    <input v-model="query" class="mb-2 w-full rounded border border-border px-2 py-1" placeholder="搜索内容…" @keydown.enter.prevent="run" />
    <input v-model="replacement" class="mb-2 w-full rounded border border-border px-2 py-1" placeholder="替换为…（留空表示替换为空）" />
    <input v-model="pathFilter" class="mb-2 w-full rounded border border-border px-2 py-1" placeholder="只搜索路径包含…（可选，逗号分隔）" />
    <label class="mr-3 text-sm"><input v-model="regex" type="checkbox" /> 正则</label>
    <label class="mr-3 text-sm"><input v-model="caseSensitive" type="checkbox" /> 区分大小写</label>
    <label class="text-sm"><input v-model="wholeWord" type="checkbox" /> 全词</label>
    <div class="my-3 flex gap-2">
      <Button variant="primary" @click="run">搜索</Button>
      <Button v-if="!session.readonly" variant="danger" :disabled="!hits.length" @click="replaceAll">全部替换</Button>
    </div>
    <div v-if="progress && progress < 1" class="mb-2 h-1 bg-background"><i class="block h-full bg-primary" :style="{ width: `${progress * 100}%` }" /></div>
    <p class="mb-2 text-sm">{{ summary }}</p>
    <div class="max-h-[40vh] overflow-auto text-sm">
      <div v-for="file in hits" :key="file.path" class="mb-2">
        <div class="font-medium">{{ file.path }} · {{ file.found.total }} 处</div>
        <button v-for="line in file.found.lines" :key="line.line" class="block w-full truncate px-2 py-0.5 text-left hover:bg-background" type="button" @click="openHit(file.path, line.line)">{{ line.line }}: {{ line.text }}</button>
      </div>
    </div>
  </Dialog>
</template>
