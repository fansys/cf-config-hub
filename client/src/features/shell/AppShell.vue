<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ChevronsDownUp, ChevronsUpDown, Ellipsis, FolderTree, GitBranch, PanelLeft, RefreshCw, Search, Upload, X } from '@lucide/vue';
import Button from '@/components/ui/Button.vue';
import Menu from '@/components/ui/Menu.vue';
import FileTree from '@/features/files/FileTree.vue';
import EditorPanel from '@/features/editor/EditorPanel.vue';
import { useFileActions } from '@/features/editor/actions';
import { openAccess, openLinks, panels } from '@/features/shell/panels';
import { extractPathFromLink } from '@shared/linkpath.js';
import { isValidPath } from '@shared/text.js';
import { askInput } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { routePath, router } from '@/router';
import { useSession } from '@/stores/session';

const LinksDialog = defineAsyncComponent(() => import('@/features/links/LinksDialog.vue'));
const AccessDialogs = defineAsyncComponent(() => import('@/features/access/AccessDialogs.vue'));
const SearchDialog = defineAsyncComponent(() => import('@/features/search/SearchDialog.vue'));
const HistoryDialogs = defineAsyncComponent(() => import('@/features/history/HistoryDialogs.vue'));
const BackupDialog = defineAsyncComponent(() => import('@/features/backup/BackupDialog.vue'));
const BranchDialog = defineAsyncComponent(() => import('@/features/target/BranchDialog.vue'));
const DiffDialog = defineAsyncComponent(() => import('@/features/history/DiffDialog.vue'));

const session = useSession();
const actions = useFileActions();
const query = ref('');
const debounced = ref('');
const dropping = ref(false);
const upload = ref<HTMLInputElement | null>(null);
const treeRef = ref<{ expandAll: () => void; collapseAll: () => void } | null>(null);
let dragDepth = 0;
let queryTimer = 0;

watch(query, (value) => {
  clearTimeout(queryTimer);
  queryTimer = window.setTimeout(() => { debounced.value = value; }, 150);
});
watch(() => router.currentRoute.value.fullPath, () => { void actions.openFromHash(); });

function onKey(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 's') {
    event.preventDefault();
    if (session.current) void actions.saveFile();
  } else if (key === 'k' || (key === 'f' && event.shiftKey)) {
    event.preventDefault();
    panels.search = true;
  }
}
function onLeave(event: BeforeUnloadEvent) {
  if (session.dirty) { event.preventDefault(); event.returnValue = ''; }
}
function hasFiles(event: DragEvent) {
  return [...(event.dataTransfer?.types || [])].includes('Files');
}
onMounted(() => {
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onLeave);
  if (routePath()) void actions.openFromHash();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', onLeave);
});

async function parseLink() {
  const input = await askInput({ title: '链接解析', message: '粘贴本仓库的 GitHub 文件、Raw、jsDelivr 或 Worker 链接：', placeholder: 'https://…', okText: '定位文件' });
  if (!input) return;
  try {
    const path = extractPathFromLink(input, session.info, location.origin);
    if (!path || !isValidPath(path)) throw new Error('链接不属于当前管理仓库或分支');
    if (!session.files.some(file => file.path === path)) throw new Error('找不到对应文件，请先刷新文件列表');
    await actions.openFile(path);
    panels.nav = false;
  } catch (error) { toast('解析失败：' + (error as Error).message); }
}

const menu = () => [
  { label: '操作记录', onClick: () => { panels.activity = true; } },
  { label: '导出 / 导入', onClick: () => { panels.backup = true; } },
  { label: '链接解析', onClick: parseLink },
  { label: '文件访问规则', onClick: () => { panels.rules = true; } },
  { label: '退出登录', danger: true, onClick: () => session.logout() },
];

async function refresh() {
  try { await session.refreshFiles(); toast('文件列表已刷新'); }
  catch (error) { toast('刷新失败：' + (error as Error).message); }
}

async function goHome() {
  panels.nav = false;
  if (!session.current) return;
  if (await actions.checkUnsaved()) session.clearEditor();
}
</script>

<template>
  <div
    class="flex h-full flex-col overflow-hidden bg-background"
    @dragenter="hasFiles($event) && session.token && !session.readonly && (dragDepth++, dropping = true)"
    @dragleave="hasFiles($event) && (dragDepth = Math.max(0, dragDepth - 1), dropping = dragDepth > 0)"
    @dragover.prevent
    @drop.prevent="dropping = false; dragDepth = 0; !session.readonly && actions.uploadFiles([...( $event.dataTransfer?.files || [])])"
  >
    <div v-if="dropping" class="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-white/85 text-lg font-medium text-primary backdrop-blur-xs">松开鼠标，上传文件到仓库</div>

    <header class="flex h-13 shrink-0 items-center justify-between gap-2 border-b border-border bg-white px-2.5 sm:h-14 sm:px-4">
      <div class="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <button
          class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background/60 text-foreground transition hover:bg-background md:hidden"
          type="button"
          aria-label="打开文件树"
          title="打开文件树"
          @click="panels.nav = !panels.nav"
        >
          <PanelLeft class="size-4 text-primary" />
        </button>
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 rounded-xl py-1 pr-1 text-left transition hover:opacity-85 sm:gap-2.5 sm:pr-2"
          title="返回首页"
          @click="goHome"
        >
          <div class="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary text-xs font-bold text-white shadow-xs sm:h-9 sm:w-9 sm:text-sm">{ }</div>
          <div class="min-w-0">
            <strong class="block truncate text-sm font-semibold leading-tight sm:text-base">GitHub Config Hub</strong>
            <small class="hidden truncate text-xs text-muted sm:block">配置文件管理中心</small>
          </div>
        </button>
      </div>

      <div class="flex shrink-0 items-center gap-1 sm:gap-2">
        <button
          v-if="session.info"
          type="button"
          class="hidden items-center gap-1.5 rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs text-muted transition hover:border-primary/40 hover:text-foreground lg:inline-flex"
          title="点击切换分支"
          @click="panels.branch = true"
        >
          <GitBranch class="size-3.5 text-primary" />
          <span class="max-w-44 truncate font-medium text-foreground">{{ session.info.owner }}/{{ session.info.repo }}</span>
          <span>·</span>
          <span class="max-w-28 truncate">{{ session.info.branch }}</span>
        </button>
        <span
          v-if="session.info?.me"
          class="hidden rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium sm:inline-block"
          :class="session.info.me.role === 'rw' ? 'text-emerald-700' : 'text-amber-700'"
        >
          {{ session.info.me.name }} · {{ session.info.me.role === 'rw' ? '可编辑' : '只读' }}
        </span>
        <Button variant="secondary" size="sm" class="h-9 w-9 p-0 sm:w-auto sm:px-3" title="全库搜索 / 替换 (⌘K / Ctrl+K)" @click="panels.search = true">
          <Search class="size-4 text-muted sm:size-3.5" />
          <span class="max-sm:hidden">搜索/替换</span>
          <kbd class="ml-1 hidden rounded border border-border bg-background px-1 py-0.5 font-sans text-[10px] text-muted lg:inline-block">⌘K</kbd>
        </Button>
        <Button variant="secondary" size="sm" class="h-9 w-9 p-0 sm:w-auto sm:px-3" title="刷新文件列表" @click="refresh">
          <RefreshCw class="size-4 text-muted sm:size-3.5" />
          <span class="max-sm:hidden">刷新</span>
        </Button>
        <Menu label="更多 ▾" :items="menu()">
          <Ellipsis class="size-4 text-muted sm:hidden" />
          <span class="max-sm:hidden">更多 ▾</span>
        </Menu>
      </div>
    </header>

    <div class="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        v-if="panels.nav"
        class="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-[1px] md:hidden"
        @click="panels.nav = false"
      />
      <aside
        class="flex w-76 shrink-0 flex-col border-r border-border bg-[#fbfcfe] transition-transform duration-200 lg:w-80"
        :class="panels.nav ? 'fixed inset-y-0 left-0 z-40 w-[min(320px,86vw)] shadow-2xl' : 'max-md:hidden'"
      >
        <div class="flex items-start justify-between gap-2 border-b border-border/70 px-3.5 py-3">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <p class="text-[10px] font-bold tracking-[0.14em] text-muted uppercase">Repository</p>
              <span v-if="session.info?.private !== null && session.info?.private !== undefined" class="rounded bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted">
                {{ session.info.private ? '私有' : '公开' }}
              </span>
            </div>
            <h2 class="mt-0.5 truncate text-sm font-semibold text-foreground">{{ session.info?.owner }}/{{ session.info?.repo }}</h2>
            <p class="mt-0.5 truncate text-xs text-muted">分支: {{ session.info?.branch }}{{ session.info?.root ? ' · /' + session.info.root : '' }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Button variant="secondary" size="sm" @click="panels.branch = true">
              <GitBranch class="size-3.5 text-primary" />
              <span>分支</span>
            </Button>
            <button
              v-if="panels.nav"
              type="button"
              class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-background hover:text-foreground md:hidden"
              aria-label="关闭侧栏"
              @click="panels.nav = false"
            >
              <X class="size-4" />
            </button>
          </div>
        </div>

        <div v-if="!session.readonly" class="grid grid-cols-2 gap-2 px-3 pt-2.5">
          <Button variant="primary" size="sm" class="h-8.5 w-full" @click="actions.newFile(); panels.nav = false">＋ 新建文件</Button>
          <Button variant="secondary" size="sm" class="h-8.5 w-full" @click="upload?.click()">
            <Upload class="size-3.5" />
            <span>上传</span>
          </Button>
          <input ref="upload" type="file" multiple hidden @change="actions.uploadFiles([...( ($event.target as HTMLInputElement).files || [])]); ($event.target as HTMLInputElement).value = ''; panels.nav = false" />
        </div>

        <div class="relative mx-3 mt-2.5">
          <input
            v-model="query"
            class="w-full rounded-lg border border-border bg-white py-1.5 pr-7 pl-2.5 text-sm placeholder:text-muted/80"
            placeholder="搜索文件或目录..."
          />
          <button
            v-if="query"
            type="button"
            class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-xs text-muted hover:text-foreground"
            @click="query = ''"
          >
            ✕
          </button>
        </div>

        <div class="flex items-center justify-between px-3.5 py-2 text-xs text-muted">
          <span class="font-medium">仓库文件（{{ session.files.length }}）</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-slate-200/60 hover:text-foreground"
              title="展开全部目录"
              @click="treeRef?.expandAll()"
            >
              <ChevronsUpDown class="size-3" />
              <span>展开</span>
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-slate-200/60 hover:text-foreground"
              title="折叠全部目录"
              @click="treeRef?.collapseAll()"
            >
              <ChevronsDownUp class="size-3" />
              <span>折叠</span>
            </button>
          </div>
        </div>

        <FileTree
          ref="treeRef"
          :query="debounced"
          @open="path => { actions.openFile(path); panels.nav = false }"
          @prefetch="actions.prefetchFile"
          @create="dir => { actions.newFile(dir); panels.nav = false }"
          @access="openAccess"
          @links="openLinks"
          @rename="(path, kind) => actions.renamePath(path, kind)"
          @remove-dir="actions.deleteFolder"
        />

        <div class=" flex items-center justify-between border-t border-border/70 px-3.5 py-2 text-xs text-muted">
          <span>{{ session.info?.private === null ? '' : session.info?.private ? '🔒 私有仓库（直链需令牌）' : '🌐 公开仓库' }}</span>
          <span v-if="session.info?.me" class="sm:hidden">{{ session.info.me.name }} ({{ session.info.me.role === 'rw' ? '读写' : '只读' }})</span>
        </div>
      </aside>
      <EditorPanel />
    </div>

    <LinksDialog v-if="panels.links" />
    <AccessDialogs v-if="panels.access || panels.rules" />
    <SearchDialog v-if="panels.search" />
    <HistoryDialogs v-if="panels.history || panels.activity" />
    <BackupDialog v-if="panels.backup" />
    <BranchDialog v-if="panels.branch" />
    <DiffDialog v-if="panels.diff" />
  </div>
</template>
