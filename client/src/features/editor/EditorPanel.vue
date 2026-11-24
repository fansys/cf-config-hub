<script setup lang="ts">
import { FORMAT_LABELS, parse } from '@shared/formats/index.js';
import { LANG_LABELS, langOf, lint } from '@shared/lint.js';
import { formatSize, toLF } from '@shared/text.js';
import { Archive, Check, Clock, Copy, FileCode2, FileJson, FilePlus2, FileText, FolderTree, GitBranch, GitCompare, History, Link2, Lock, Redo2, Save, Search, Shield, Trash2, Undo2, WrapText, X } from '@lucide/vue';
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Menu from '@/components/ui/Menu.vue';
import { useFileActions } from '@/features/editor/actions';
import { openAccess, openLinks, panels } from '@/features/shell/panels';
import { HIGHLIGHT_LANGUAGES } from '@/features/editor/languages';
import { askConfirm } from '@/lib/dialogs';
import { copyText, toast } from '@/lib/toast';
import { useSession } from '@/stores/session';

const CodeEditor = defineAsyncComponent(() => import('@/features/editor/CodeEditor.vue'));
const VisualPanel = defineAsyncComponent(() => import('@/features/visual/VisualPanel.vue'));
const MarkdownPreview = defineAsyncComponent(() => import('@/features/preview/MarkdownPreview.vue'));

const session = useSession();
const actions = useFileActions();
const editor = ref<{
  gotoLine: (line: number, col?: number) => void;
  toggleSearch: () => void;
  undo: () => void;
  redo: () => void;
} | null>(null);
const detected = ref('');
const byteSize = ref(0);
const lineCount = ref(0);
const copiedPath = ref(false);
const lineWrap = ref(true);
const cursorInfo = ref<{ line: number; col: number; selected: number }>({ line: 1, col: 1, selected: 0 });
let lintSeq = 0;
let lintTimer = 0;

const isMd = () => /\.(md|markdown)$/i.test(session.current?.path || '');
const dataLang = () => (session.current && !session.binary ? langOf(session.current.path) : null);
const isLoading = () => !!session.loadingPath && session.loadingPath === session.current?.path;

const pathSegments = computed(() => {
  const p = session.current?.path || '';
  if (!p) return { dirs: [] as { name: string; path: string }[], file: '' };
  const parts = p.split('/');
  const file = parts.pop() || '';
  const dirs = parts.map((name, idx) => ({ name, path: parts.slice(0, idx + 1).join('/') }));
  return { dirs, file };
});

const recentFiles = computed(() => {
  const fileMap = new Map<string, { path: string; size?: number; sha?: string }>(
    session.files.map((f: any) => [f.path, f]),
  );
  return session.recentPaths
    .map(path => fileMap.get(path))
    .filter((f): f is { path: string; size?: number; sha?: string } => !!f)
    .slice(0, 9);
});

const repoStats = computed(() => {
  let totalBytes = 0;
  let ruleFiles = 0;
  let dataFiles = 0;
  const dirs = new Set<string>();
  for (const file of session.files) {
    totalBytes += file.size || 0;
    if (/\.(list|conf|ini)$/i.test(file.path)) ruleFiles++;
    else if (/\.(json|ya?ml|toml)$|(^|\/)\.env/i.test(file.path)) dataFiles++;
    const idx = file.path.lastIndexOf('/');
    if (idx > 0) dirs.add(file.path.slice(0, idx));
  }
  return {
    totalFiles: session.files.length,
    totalDirs: dirs.size,
    totalBytes,
    ruleFiles,
    dataFiles,
  };
});

function splitFilePath(path: string) {
  const idx = path.lastIndexOf('/');
  return idx > 0
    ? { dir: path.slice(0, idx), name: path.slice(idx + 1) }
    : { dir: '根目录', name: path };
}

function fileCategory(path: string): 'rule' | 'data' | 'code' | 'text' {
  const lower = path.toLowerCase();
  if (/\.(list|conf|ini)$/.test(lower)) return 'rule';
  if (/\.(json|ya?ml|toml)$|(^|\/)\.env/.test(lower)) return 'data';
  if (/\.(js|mjs|ts|py|go|rs|sh|lua)$/.test(lower)) return 'code';
  return 'text';
}

function clearRecentFiles() {
  session.clearRecent();
  toast('已清空最近打开记录');
}

async function copyCurrentPath() {
  if (!session.current?.path) return;
  await copyText(session.current.path);
  copiedPath.value = true;
  window.setTimeout(() => { copiedPath.value = false; }, 1600);
}

function filterTreeByDir(dirPath: string) {
  session.closedFolders = session.closedFolders.filter(
    folder => folder !== dirPath && !dirPath.startsWith(folder + '/'),
  );
  panels.nav = true;
}

async function discardChanges() {
  if (!session.current || !session.dirty) return;
  const ok = await askConfirm({
    title: '放弃未保存的修改',
    message: `确定要将「${session.current.path}」恢复为上次保存的内容吗？当前未保存的修改将丢失。`,
    okText: '放弃修改',
    danger: true,
  });
  if (!ok) return;
  session.editorText = session.original;
  session.parsed = session.fmt ? parse(session.fmt, session.original) : null;
  session.dirty = false;
  toast('已恢复为已保存内容');
}

function updateStats() {
  if (!session.current) { byteSize.value = 0; lineCount.value = 0; return; }
  if (session.binary || isLoading()) {
    byteSize.value = session.current.size || 0;
    lineCount.value = 0;
    return;
  }
  const text = session.getEditorText();
  byteSize.value = session.textBytes().length;
  lineCount.value = text ? text.split(/\r?\n/).length : 0;
}

async function runLint() {
  updateStats();
  const lang = dataLang();
  if (!lang || !session.current || isLoading()) {
    session.lintResult = null;
    return;
  }
  const seq = ++lintSeq;
  const result = await lint(session.current.path, toLF(session.getEditorText()));
  if (seq !== lintSeq || !result) return;
  session.lintResult = result;
}

watch(() => [session.current?.path, session.loadingPath], () => {
  cursorInfo.value = { line: 1, col: 1, selected: 0 };
  updateStats();
  clearTimeout(lintTimer);
  lintTimer = window.setTimeout(runLint, 150);
}, { immediate: true });

watch(() => [session.editorText, session.parsed, session.mode], () => {
  clearTimeout(lintTimer);
  lintTimer = window.setTimeout(runLint, 350);
});

async function jumpLint() {
  const result = session.lintResult;
  if (!result || result.ok || !result.line) return;
  await actions.setMode('highlight');
  editor.value?.gotoLine(result.line, result.col || 1);
}

function showCurrentDiff() {
  if (!session.current || session.binary) return;
  if (!session.dirty) {
    toast('当前文件尚未修改');
    return;
  }
  panels.diff = { title: `未保存的修改 · ${session.current.path}`, oldText: session.original, newText: toLF(session.getEditorText()) };
}

const more = () => [
  ...(session.dirty && !session.readonly ? [{ label: '放弃未保存修改', danger: true, onClick: () => { void discardChanges(); } }] : []),
  { label: '提交历史', disabled: !session.current?.sha, onClick: () => { panels.history = true; } },
  { label: '访问设置', disabled: !session.current?.sha, onClick: () => session.current && openAccess(session.current.path, 'file') },
  { label: '下载文件', onClick: actions.downloadCurrent },
  { label: '重命名 / 移动', disabled: !session.current?.sha || session.readonly, onClick: () => session.current && actions.renamePath(session.current.path, 'file') },
  { label: '复制为新文件', disabled: session.binary || session.readonly, onClick: actions.duplicateCurrent },
  { label: '删除文件', danger: true, disabled: !session.current?.sha || session.readonly, onClick: actions.deleteFile },
];
</script>

<template>
  <section v-if="session.current" class="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
    <header class="flex flex-col gap-2 border-b border-border bg-white px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-2.5">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1 text-sm leading-snug sm:text-base">
          <button
            type="button"
            class="mr-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-background hover:text-foreground"
            title="关闭当前文件（返回工作台）"
            @click="actions.checkUnsaved().then(ok => { if (ok) session.clearEditor() })"
          >
            <X class="size-3.5" />
          </button>
          <template v-for="dir in pathSegments.dirs" :key="dir.path">
            <button
              type="button"
              class="rounded px-1 py-0.5 text-xs font-normal text-muted transition hover:bg-background hover:text-primary sm:text-sm"
              :title="`在文件树中筛选 ${dir.path}/`"
              @click="filterTreeByDir(dir.path)"
            >
              {{ dir.name }}
            </button>
            <span class="text-xs text-muted/50">/</span>
          </template>
          <h2 class="break-all font-semibold text-foreground">{{ pathSegments.file }}</h2>
          <button
            type="button"
            class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-background hover:text-foreground"
            title="复制文件路径"
            @click="copyCurrentPath"
          >
            <Check v-if="copiedPath" class="size-3.5 text-emerald-600" />
            <Copy v-else class="size-3.5" />
          </button>

          <span v-if="session.fmt" class="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-primary">
            {{ FORMAT_LABELS[session.fmt] || session.fmt }}
          </span>
          <span v-if="isLoading()" class="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            <span class="size-2.5 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            加载中…
          </span>
          <span v-else-if="session.dirty" class="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
            <span>● 未保存</span>
            <button
              v-if="!session.readonly"
              type="button"
              class="ml-0.5 rounded px-1 text-[10px] underline hover:text-amber-950"
              title="放弃未保存的修改"
              @click="discardChanges"
            >
              撤销修改
            </button>
          </span>
        </div>

        <p class="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 pl-6 text-[11px] text-muted sm:text-xs">
          <span>{{ formatSize(byteSize) }}</span>
          <span v-if="lineCount && !session.binary">{{ lineCount }} 行</span>
          <span>{{ session.current.sha ? 'SHA ' + session.current.sha.slice(0, 8) : '新文件（未提交）' }}</span>
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
        <Button
          v-if="!session.readonly"
          variant="primary"
          size="sm"
          class="h-8 flex-1 px-2.5 text-xs sm:h-9 sm:flex-none sm:px-3"
          :disabled="session.binary || isLoading()"
          title="保存到 GitHub (⌘S / Ctrl+S)"
          @click="actions.saveFile"
        >
          <Save class="size-3.5" />
          <span>保存</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          class="h-8 px-2.5 text-xs sm:h-9 sm:px-3"
          :class="session.dirty ? 'border-amber-300 bg-amber-50/70 text-amber-900 hover:bg-amber-100/70' : ''"
          :disabled="session.binary || isLoading() || !session.dirty"
          :title="session.dirty ? '查看未保存修改对比' : '当前文件无未保存修改'"
          @click="showCurrentDiff"
        >
          <GitCompare class="size-3.5" :class="session.dirty ? 'text-amber-700' : 'text-muted'" />
          <span class="sm:hidden">对比</span>
          <span class="max-sm:hidden">对比修改</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          class="h-8 px-2.5 text-xs sm:h-9 sm:px-3"
          :disabled="isLoading()"
          title="获取订阅 / 直链"
          @click="session.current && openLinks(session.current.path, 'file')"
        >
          <Link2 class="size-3.5 text-muted" />
          <span class="sm:hidden">链接</span>
          <span class="max-sm:hidden">获取链接</span>
        </Button>
        <Menu label="更多 ▾" :items="more()" />
      </div>
    </header>

    <div
      v-if="!isLoading() && !session.binary && (session.fmt || isMd() || session.mode === 'highlight' || session.lintResult || dataLang())"
      class="flex flex-wrap items-center gap-1.5 border-b border-border bg-background/60 px-3 py-1.5 sm:gap-2 sm:px-4"
    >
      <div v-if="session.fmt || isMd()" class="inline-flex rounded-lg border border-border bg-background p-0.5">
        <button
          v-if="session.fmt"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition"
          :class="session.mode === 'visual' ? 'bg-white text-foreground shadow-2xs' : 'text-muted hover:text-foreground'"
          @click="actions.setMode('visual')"
        >
          可视化
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition"
          :class="session.mode === 'highlight' ? 'bg-white text-foreground shadow-2xs' : 'text-muted hover:text-foreground'"
          @click="actions.setMode('highlight')"
        >
          原始内容
        </button>
        <button
          v-if="isMd()"
          type="button"
          class="rounded-md px-2.5 py-1 text-xs font-medium transition"
          :class="session.mode === 'preview' ? 'bg-white text-foreground shadow-2xs' : 'text-muted hover:text-foreground'"
          @click="actions.setMode('preview')"
        >
          预览
        </button>
      </div>

      <button
        v-if="session.lintResult"
        type="button"
        class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
        :class="session.lintResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-danger hover:underline'"
        @click="jumpLint"
      >
        {{ session.lintResult.ok ? `✓ ${LANG_LABELS[dataLang() || ''] || dataLang()} 语法正确` : `✗ ${session.lintResult.line ? '第 ' + session.lintResult.line + ' 行：' : ''}${session.lintResult.message}` }}
      </button>

      <div class="ml-auto flex flex-wrap items-center gap-1.5">
        <template v-if="session.mode === 'highlight'">
          <div v-if="!session.readonly" class="inline-flex items-center rounded-lg border border-border bg-white p-0.5">
            <button
              type="button"
              class="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition hover:bg-background hover:text-foreground"
              title="撤销 (⌘Z / Ctrl+Z)"
              @click="editor?.undo()"
            >
              <Undo2 class="size-3.5" />
            </button>
            <button
              type="button"
              class="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition hover:bg-background hover:text-foreground"
              title="重做 (⇧⌘Z / Ctrl+Y)"
              @click="editor?.redo()"
            >
              <Redo2 class="size-3.5" />
            </button>
          </div>

          <button
            type="button"
            class="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-white px-2 text-xs font-medium text-foreground transition hover:bg-background"
            title="页内查找与替换 (⌘F / Ctrl+F)"
            @click="editor?.toggleSearch()"
          >
            <Search class="size-3.5 text-muted" />
            <span class="max-sm:hidden">查找</span>
          </button>

          <button
            type="button"
            class="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium transition"
            :class="lineWrap ? 'border-primary/40 bg-primary/8 text-primary' : 'border-border bg-white text-muted hover:text-foreground'"
            title="切换自动换行"
            @click="lineWrap = !lineWrap"
          >
            <WrapText class="size-3.5" />
            <span class="max-sm:hidden">换行</span>
          </button>

          <label class="flex items-center gap-1 text-xs text-muted">
            <select v-model="session.hlLang" class="h-7 rounded-md border border-border bg-white px-1.5 text-xs text-foreground" title="语法高亮语言">
              <option value="">自动高亮</option>
              <option v-for="name in HIGHLIGHT_LANGUAGES" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
        </template>

        <Button v-if="dataLang() === 'json' && !session.readonly" variant="secondary" size="sm" class="h-7 px-2 text-xs" @click="actions.reformat(false)">格式化</Button>
        <Button v-if="dataLang() === 'json' && !session.readonly" variant="secondary" size="sm" class="h-7 px-2 text-xs" @click="actions.reformat(true)">压缩</Button>
        <Button v-if="['json', 'yaml', 'toml'].includes(dataLang() || '') && !session.readonly" variant="secondary" size="sm" class="h-7 px-2 text-xs" @click="actions.convertDataFile">转换…</Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-if="isLoading()" class="space-y-3 p-4 sm:p-6" aria-live="polite">
        <div class="h-4 w-48 animate-pulse rounded bg-slate-200/70" />
        <div class="h-8 w-full animate-pulse rounded-lg bg-slate-100" />
        <div class="h-8 w-11/12 animate-pulse rounded-lg bg-slate-100" />
        <div class="h-8 w-4/5 animate-pulse rounded-lg bg-slate-100" />
        <div class="h-8 w-full animate-pulse rounded-lg bg-slate-100" />
      </div>
      <p v-else-if="session.binary" class="p-6 text-sm text-muted">二进制内容不能在线编辑，请下载后修改再上传。</p>
      <VisualPanel v-else-if="session.mode === 'visual' && session.fmt" />
      <MarkdownPreview v-else-if="session.mode === 'preview'" :text="session.editorText" />
      <CodeEditor
        v-else
        ref="editor"
        :model-value="session.editorText"
        :path="session.current.path"
        :lang="session.hlLang"
        :readonly="session.readonly"
        :wrap="lineWrap"
        @update:model-value="session.setEditorText"
        @detected="detected = $event"
        @cursor="cursorInfo = $event"
      />
    </div>

    <footer class="flex shrink-0 items-center justify-between border-t border-border bg-[#fbfcfe] px-3 py-1 text-xs text-muted sm:px-4">
      <div class="flex flex-wrap items-center gap-x-2">
        <span>{{ session.binary ? 'Binary' : 'UTF-8' }} · {{ session.eol === '\r\n' ? 'CRLF' : 'LF' }}</span>
        <span v-if="lineCount && !session.binary">· 共 {{ lineCount }} 行</span>
        <span v-if="session.mode === 'highlight' && !session.binary" class="font-mono text-[11px] text-muted/90">
          · 行 {{ cursorInfo.line }}, 列 {{ cursorInfo.col }}<template v-if="cursorInfo.selected"> (已选 {{ cursorInfo.selected }})</template>
        </span>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="session.mode === 'highlight' && !session.hlLang && detected" class="text-[11px] text-muted/80">{{ detected }}</span>
        <span class="hidden text-[11px] text-muted/80 md:inline">⌘S 保存 · ⌘F 查找 · ⌘K 全库搜索</span>
      </div>
    </footer>
  </section>

  <section v-else class="flex-1 overflow-y-auto bg-background/40 p-4 sm:p-6 lg:p-8">
    <div class="mx-auto max-w-5xl space-y-6">
      <!-- 顶部仓库工作台横幅 -->
      <div class="rounded-2xl border border-border/80 bg-white p-4 shadow-xs sm:p-6">
        <div class="flex flex-col justify-between gap-3.5 md:flex-row md:items-center">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold text-foreground sm:text-xl">
                {{ session.info ? `${session.info.owner}/${session.info.repo}` : '配置文件管理中心' }}
              </h2>
              <span
                v-if="session.info?.private !== null && session.info?.private !== undefined"
                class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                :class="session.info.private ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-700'"
              >
                {{ session.info.private ? '🔒 私有仓库' : '🌐 公开仓库' }}
              </span>
              <button
                v-if="session.info?.branch"
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2.5 py-0.5 text-xs font-medium text-foreground transition hover:border-primary/40 hover:text-primary"
                title="点击切换分支"
                @click="panels.branch = true"
              >
                <GitBranch class="size-3 text-primary" />
                <span>{{ session.info.branch }}</span>
              </button>
            </div>
            <p class="mt-1 text-xs text-muted sm:text-sm">
              从左侧选择文件开始编辑，或直接新建配置文件。
            </p>
          </div>

          <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center md:shrink-0">
            <Button variant="secondary" class="col-span-2 h-9 md:hidden" @click="panels.nav = true">
              <FolderTree class="size-4 text-primary" />
              <span>浏览仓库文件</span>
            </Button>
            <Button v-if="!session.readonly" variant="primary" class="h-9" @click="actions.newFile()">
              <FilePlus2 class="size-4" />
              <span>新建配置文件</span>
            </Button>
            <Button variant="secondary" class="h-9" @click="panels.search = true">
              <Search class="size-4 text-muted" />
              <span>全库搜索 / 替换</span>
            </Button>
          </div>
        </div>

        <!-- 仓库统计概览栏 -->
        <div class="mt-5 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 sm:grid-cols-4">
          <div class="rounded-xl bg-background/60 px-3.5 py-2.5">
            <p class="text-xs text-muted">仓库文件总数</p>
            <p class="mt-0.5 text-base font-semibold text-foreground">{{ repoStats.totalFiles }} 个文件 <span class="text-xs font-normal text-muted">({{ repoStats.totalDirs }} 个目录)</span></p>
          </div>
          <div class="rounded-xl bg-background/60 px-3.5 py-2.5">
            <p class="text-xs text-muted">代理与分流规则</p>
            <p class="mt-0.5 text-base font-semibold text-primary">{{ repoStats.ruleFiles }} 个 <span class="text-xs font-normal text-muted">(.list / .conf / .ini)</span></p>
          </div>
          <div class="rounded-xl bg-background/60 px-3.5 py-2.5">
            <p class="text-xs text-muted">通用配置文件</p>
            <p class="mt-0.5 text-base font-semibold text-foreground">{{ repoStats.dataFiles }} 个 <span class="text-xs font-normal text-muted">(YAML / JSON / ENV)</span></p>
          </div>
          <div class="rounded-xl bg-background/60 px-3.5 py-2.5">
            <p class="text-xs text-muted">配置总体积 / 最新提交</p>
            <p class="mt-0.5 text-base font-semibold text-foreground">
              {{ formatSize(repoStats.totalBytes) }}
              <span v-if="session.commitSha" class="font-mono text-xs font-normal text-muted">· {{ session.commitSha.slice(0, 7) }}</span>
            </p>
          </div>
        </div>
      </div>

      <!-- 最近打开的文件（大尺寸完整文件名卡片，不再挤压截断） -->
      <div v-if="recentFiles.length" class="rounded-2xl border border-border/80 bg-white p-5 shadow-xs sm:p-6">
        <div class="mb-3.5 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Clock class="size-4 text-primary" />
            <h3 class="text-sm font-semibold text-foreground sm:text-base">最近打开的文件</h3>
            <span class="rounded-full bg-background px-2 py-0.5 text-xs text-muted">{{ recentFiles.length }}</span>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-muted transition hover:bg-red-50 hover:text-danger"
            title="清空最近打开记录"
            @click="clearRecentFiles"
          >
            <Trash2 class="size-3.5" />
            <span>清空记录</span>
          </button>
        </div>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="file in recentFiles"
            :key="file.path"
            class="group relative flex items-start gap-3 rounded-xl border border-border/80 bg-background/30 p-3.5 transition hover:border-primary/50 hover:bg-primary/4 hover:shadow-2xs"
            @mouseenter="actions.prefetchFile(file.path)"
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-start gap-3 text-left"
              @click="actions.openFile(file.path)"
            >
              <div
                class="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl"
                :class="fileCategory(file.path) === 'rule' ? 'bg-indigo-50 text-primary' : fileCategory(file.path) === 'data' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-muted'"
              >
                <Shield v-if="fileCategory(file.path) === 'rule'" class="size-4" />
                <FileJson v-else-if="fileCategory(file.path) === 'data'" class="size-4" />
                <FileCode2 v-else-if="fileCategory(file.path) === 'code'" class="size-4" />
                <FileText v-else class="size-4" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="break-all text-sm font-semibold leading-snug text-foreground group-hover:text-primary">
                  {{ splitFilePath(file.path).name }}
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                  <span class="truncate">{{ splitFilePath(file.path).dir }}</span>
                  <span>·</span>
                  <span class="shrink-0">{{ formatSize(file.size || 0) }}</span>
                </div>
              </div>
            </button>
            <button
              type="button"
              class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted opacity-0 transition hover:bg-white hover:text-danger group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="从最近记录中移除"
              @click.stop="session.removeRecent(file.path)"
            >
              <X class="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <!-- 快捷工具与操作卡片 -->
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          class="flex items-start gap-3 rounded-2xl border border-border/80 bg-white p-4 text-left shadow-2xs transition hover:border-primary/40 hover:shadow-xs"
          @click="panels.search = true"
        >
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Search class="size-4" />
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-foreground">全库搜索 / 替换</div>
            <p class="mt-0.5 text-xs text-muted">支持正则、大小写与多文件原子替换提交 (⌘K)</p>
          </div>
        </button>

        <button
          type="button"
          class="flex items-start gap-3 rounded-2xl border border-border/80 bg-white p-4 text-left shadow-2xs transition hover:border-primary/40 hover:shadow-xs"
          @click="panels.rules = true"
        >
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600">
            <Lock class="size-4" />
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-foreground">文件访问规则</div>
            <p class="mt-0.5 text-xs text-muted">按目录或通配符管理免令牌直链与令牌白名单</p>
          </div>
        </button>

        <button
          type="button"
          class="flex items-start gap-3 rounded-2xl border border-border/80 bg-white p-4 text-left shadow-2xs transition hover:border-primary/40 hover:shadow-xs"
          @click="panels.activity = true"
        >
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600">
            <History class="size-4" />
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-foreground">仓库操作记录</div>
            <p class="mt-0.5 text-xs text-muted">查看当前分支最近 30 次 Git 提交与协作者署名</p>
          </div>
        </button>

        <button
          type="button"
          class="flex items-start gap-3 rounded-2xl border border-border/80 bg-white p-4 text-left shadow-2xs transition hover:border-primary/40 hover:shadow-xs"
          @click="panels.backup = true"
        >
          <div class="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
            <Archive class="size-4" />
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-foreground">整库导出 / 导入</div>
            <p class="mt-0.5 text-xs text-muted">一键下载分支 ZIP 备份或导入 ZIP 预览差异提交</p>
          </div>
        </button>
      </div>
    </div>
  </section>
</template>
