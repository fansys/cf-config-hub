<script setup lang="ts">
import { useVirtualizer } from '@tanstack/vue-virtual';
import { accessBadge, resolveAccess } from '@shared/access.js';
import { formatSize } from '@shared/text.js';
import { Eye, FileCode2, FileJson, FileText, Folder, FolderOpen, Lock, Pencil, Plus, Share2, Shield, Trash2 } from '@lucide/vue';
import { computed, ref } from 'vue';
import { allDirectories, visibleRows } from '@/lib/tree';
import { useSession } from '@/stores/session';

const props = defineProps<{ query: string }>();
const emit = defineEmits<{
  open: [path: string];
  prefetch: [path: string];
  create: [dir: string];
  access: [path: string, kind: 'file' | 'dir'];
  links: [path: string, scope: 'file' | 'dir'];
  rename: [path: string, kind: 'file' | 'dir'];
  removeDir: [path: string];
}>();

const session = useSession();
const parent = ref<HTMLElement | null>(null);
const rows = computed(() => visibleRows(session.files, session.closedFolders, props.query));
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const virtualizer = useVirtualizer(computed(() => ({
  count: rows.value.length,
  getScrollElement: () => parent.value,
  estimateSize: () => (isTouch ? 42 : 36),
  overscan: 12,
})));

const badgeTitle = { eye: '可以直接访问', share: '查看或生成令牌', lock: '不能访问' };

const badgeMap = computed(() => {
  const map = new Map<string, { kind: 'eye' | 'share' | 'lock'; title: string }>();
  if (!session.info) return map;
  const isPublic = session.info.private === false;
  const rules = session.info.access?.rules || [];
  for (const row of rows.value) {
    const key = `${row.kind}:${row.path}`;
    if (map.has(key)) continue;
    if (isPublic) {
      map.set(key, { kind: 'eye', title: badgeTitle.eye });
    } else {
      const access = resolveAccess(rules, row.kind === 'dir' ? `${row.path}/\0` : row.path);
      const kind = accessBadge(access);
      map.set(key, { kind, title: badgeTitle[kind] });
    }
  }
  return map;
});

function badgeFor(path: string, dir = false) {
  return badgeMap.value.get(`${dir ? 'dir' : 'file'}:${path}`) || null;
}

function fileIconKind(name: string): 'rule' | 'data' | 'code' | 'text' {
  const lower = name.toLowerCase();
  if (/\.(list|conf|ini)$/.test(lower)) return 'rule';
  if (/\.(json|ya?ml|toml)$|^\.env/.test(lower)) return 'data';
  if (/\.(js|mjs|ts|py|go|rs|sh|lua)$/.test(lower)) return 'code';
  return 'text';
}

function onBadge(path: string, dir: boolean) {
  const mark = badgeFor(path, dir);
  if (mark?.kind === 'share') emit('links', path, dir ? 'dir' : 'file');
  else emit('access', path, dir ? 'dir' : 'file');
}

function toggle(path: string) {
  const next = new Set(session.closedFolders);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  session.closedFolders = [...next];
}

function expandAll() {
  session.closedFolders = [];
}

function collapseAll() {
  session.closedFolders = allDirectories(session.files);
}

defineExpose({ expandAll, collapseAll });
</script>

<template>
  <div ref="parent" class="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
    <p v-if="!rows.length" class="px-3 py-8 text-center text-xs text-muted">{{ query ? '没有匹配的文件或目录' : '仓库目录暂无文件' }}</p>
    <div v-else class="relative w-full" :style="{ height: `${virtualizer.getTotalSize()}px` }">
      <template v-for="item in virtualizer.getVirtualItems()" :key="String(item.key)">
        <div
          v-if="rows[item.index]"
          class="group absolute top-0 left-0 flex w-full items-center gap-0.5 rounded-lg pr-1 text-sm transition-colors hover:bg-slate-200/55"
          :class="rows[item.index].kind === 'file' && session.current?.path === rows[item.index].path && 'bg-primary/10 text-primary shadow-2xs ring-1 ring-primary/20 hover:bg-primary/14'"
          :style="{ height: `${item.size}px`, transform: `translateY(${item.start}px)` }"
        >
          <template v-if="rows[item.index].kind === 'dir'">
            <button
              type="button"
              class="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate rounded-lg px-2 text-left font-medium text-foreground/90"
              :style="{ paddingLeft: `${8 + rows[item.index].depth * 14}px` }"
              @click="query ? emit('access', rows[item.index].path, 'dir') : toggle(rows[item.index].path)"
            >
              <span class="w-3 shrink-0 text-xs text-muted">{{ query ? '▸' : ((rows[item.index] as any).open ? '▾' : '▸') }}</span>
              <FolderOpen v-if="!query && (rows[item.index] as any).open" class="size-4 shrink-0 text-amber-500/90" />
              <Folder v-else class="size-4 shrink-0 text-amber-500/80" />
              <span class="truncate">{{ rows[item.index].name }}</span>
            </button>
            <button
              v-if="badgeFor(rows[item.index].path, true)"
              type="button"
              class="shrink-0 rounded-md p-1.5 text-muted transition hover:bg-white hover:text-foreground"
              :class="badgeFor(rows[item.index].path, true)?.kind === 'eye' && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'"
              :title="badgeFor(rows[item.index].path, true)?.title"
              @click="onBadge(rows[item.index].path, true)"
            >
              <Eye v-if="badgeFor(rows[item.index].path, true)?.kind === 'eye'" class="size-3.5" />
              <Share2 v-else-if="badgeFor(rows[item.index].path, true)?.kind === 'share'" class="size-3.5 text-primary" />
              <Lock v-else class="size-3.5" />
            </button>
            <button
              v-if="!session.readonly"
              type="button"
              class="shrink-0 rounded-md p-1.5 text-muted opacity-0 transition hover:bg-white hover:text-foreground group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="在此目录下新建文件"
              @click="emit('create', rows[item.index].path)"
            >
              <Plus class="size-3.5" />
            </button>
            <button
              v-if="!session.readonly"
              type="button"
              class="shrink-0 rounded-md p-1.5 text-muted opacity-0 transition hover:bg-white hover:text-foreground group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="重命名/移动目录"
              @click="emit('rename', rows[item.index].path, 'dir')"
            >
              <Pencil class="size-3.5" />
            </button>
            <button
              v-if="!session.readonly"
              type="button"
              class="shrink-0 rounded-md p-1.5 text-muted opacity-0 transition hover:bg-white hover:text-danger group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              title="删除整个目录"
              @click="emit('removeDir', rows[item.index].path)"
            >
              <Trash2 class="size-3.5" />
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="flex h-full min-w-0 flex-1 items-center gap-1.5 truncate rounded-lg px-2 text-left"
              :class="session.current?.path === rows[item.index].path ? 'font-semibold text-primary' : 'text-foreground'"
              :style="{ paddingLeft: `${12 + rows[item.index].depth * 14}px` }"
              @mouseenter="emit('prefetch', rows[item.index].path)"
              @touchstart.passive="emit('prefetch', rows[item.index].path)"
              @click="emit('open', rows[item.index].path)"
            >
              <span v-if="session.loadingPath === rows[item.index].path" class="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
              <Shield v-else-if="fileIconKind(rows[item.index].name) === 'rule'" class="size-3.5 shrink-0" :class="session.current?.path === rows[item.index].path ? 'text-primary' : 'text-indigo-500/80'" />
              <FileJson v-else-if="fileIconKind(rows[item.index].name) === 'data'" class="size-3.5 shrink-0" :class="session.current?.path === rows[item.index].path ? 'text-primary' : 'text-emerald-600/80'" />
              <FileCode2 v-else-if="fileIconKind(rows[item.index].name) === 'code'" class="size-3.5 shrink-0" :class="session.current?.path === rows[item.index].path ? 'text-primary' : 'text-sky-600/80'" />
              <FileText v-else class="size-3.5 shrink-0" :class="session.current?.path === rows[item.index].path ? 'text-primary' : 'text-muted/80'" />
              <span class="truncate">{{ rows[item.index].name }}</span>
              <span class="ml-auto shrink-0 pl-1 text-[11px] font-normal text-muted">{{ formatSize(((rows[item.index] as any).file?.size) || 0) }}</span>
            </button>
            <button
              v-if="badgeFor(rows[item.index].path)"
              type="button"
              class="shrink-0 rounded-md p-1.5 text-muted transition hover:bg-white hover:text-foreground"
              :class="badgeFor(rows[item.index].path)?.kind === 'eye' && 'opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100'"
              :title="badgeFor(rows[item.index].path)?.title"
              @click="onBadge(rows[item.index].path, false)"
            >
              <Eye v-if="badgeFor(rows[item.index].path)?.kind === 'eye'" class="size-3.5" />
              <Share2 v-else-if="badgeFor(rows[item.index].path)?.kind === 'share'" class="size-3.5 text-primary" />
              <Lock v-else class="size-3.5" />
            </button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
