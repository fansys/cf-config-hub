<script setup lang="ts">
import {
  CONVERT_TARGETS, LIST_FORMATS, collectIssues, dedupe, envIssues, isSensitiveKey,
  lineToItem, parse, ruleKey, serialize, sortRuns, validateRuleset,
} from '@shared/formats/index.js';
import { ArrowDown, ArrowUp, Plus, Redo2, Search, Undo2, X } from '@lucide/vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Menu from '@/components/ui/Menu.vue';
import Button from '@/components/ui/Button.vue';
import { askInput } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { useSession } from '@/stores/session';
import { useFileActions } from '@/features/editor/actions';

const session = useSession();
const actions = useFileActions();
const filter = ref('');
const onlyIssues = ref(false);
const revealed = ref<number[]>([]);
const stack = ref<string[]>([]);
const index = ref(0);
const issueMap = ref<Map<number, string>>(new Map());
const listParent = ref<HTMLElement | null>(null);
const customActions = ref<string[]>([]);
let timer = 0;
const IMPORT_HOSTS = new Set(['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'github.com']);
const NO_RESOLVE_TYPES = new Set(['IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'SRC-IP-CIDR', 'GEOIP', 'HOST-IP', 'DOMAIN-IP']);
const NO_CONTENT_TYPES = new Set(['FINAL', 'MATCH']);

const spec = computed(() => LIST_FORMATS[session.fmt || ''] || LIST_FORMATS['clash-list']);
const isIni = computed(() => session.fmt === 'clash-ini');
const isEnv = computed(() => session.fmt === 'env');

/** 汇总预设策略 + 当前文件中出现过的自定义策略组 + 用户本轮新增的策略名 */
const availableActions = computed(() => {
  const set = new Set<string>(spec.value.actions || []);
  for (const act of customActions.value) if (act) set.add(act);
  const items: any[] = session.parsed?.items || [];
  for (const item of items) {
    if (!item) continue;
    if (NO_CONTENT_TYPES.has(item.type) && item.rule) set.add(item.rule);
    if (item.action) set.add(item.action);
  }
  return Array.from(set);
});

function refreshIssues() {
  if (!session.parsed || isIni.value) {
    issueMap.value = new Map();
    return;
  }
  issueMap.value = isEnv.value ? envIssues(session.parsed.items) : collectIssues(session.parsed.items);
  if (!issueMap.value.size) onlyIssues.value = false;
}

const filteredEntries = computed<{ item: any; idx: number }[]>(() => {
  const items: any[] = session.parsed?.items || [];
  if (isIni.value) return [];
  const q = isEnv.value ? filter.value.trim().toLowerCase() : filter.value.trim().toLowerCase();
  const filterIssues = onlyIssues.value && issueMap.value.size > 0;
  if (!q && !filterIssues) return items.map((item, idx) => ({ item, idx }));
  const out: { item: any; idx: number }[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    if (filterIssues && !issueMap.value.has(idx)) continue;
    const item = items[idx];
    const hay = isEnv.value
      ? `${item.key || ''} ${item.value || ''} ${item.text || ''}`.toLowerCase()
      : `${item.type || ''} ${item.rule || ''} ${item.action || ''} ${(item.opts || []).join(' ')}`.toLowerCase();
    if (!q || hay.includes(q)) {
      out.push({ item, idx });
    }
  }
  return out;
});

const rowVirtualizer = useVirtualizer(computed(() => ({
  count: filteredEntries.value.length,
  getScrollElement: () => listParent.value,
  estimateSize: () => 88,
  overscan: 10,
})));

function measureEl(el: unknown) {
  if (el instanceof HTMLElement) rowVirtualizer.value.measureElement(el);
}

function resetHistory() {
  stack.value = [serialize(session.parsed)];
  index.value = 0;
  refreshIssues();
}

watch(() => [session.current?.path, session.loadingPath], () => {
  filter.value = '';
  onlyIssues.value = false;
  revealed.value = [];
  customActions.value = [];
  if (session.parsed && !session.loadingPath) resetHistory();
  if (listParent.value) listParent.value.scrollTop = 0;
}, { immediate: true });

function touch() {
  session.markDirty();
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    refreshIssues();
    pushSnapshot();
  }, 450);
}

function pushSnapshot() {
  if (!session.parsed) return;
  const snap = serialize(session.parsed);
  if (snap === stack.value[index.value]) return;
  const next = stack.value.slice(0, index.value + 1);
  next.push(snap);
  stack.value = next.length > 200 ? next.slice(next.length - 200) : next;
  index.value = stack.value.length - 1;
}

function commit() {
  session.markDirty();
  refreshIssues();
  pushSnapshot();
}

function restore(delta: number) {
  pushSnapshot();
  const next = index.value + delta;
  if (next < 0 || next >= stack.value.length || !session.fmt) return;
  index.value = next;
  session.parsed = parse(session.fmt, stack.value[next]);
  refreshIssues();
  session.markDirty();
}

function onKey(event: KeyboardEvent) {
  if (session.mode !== 'visual' || !session.parsed || !(event.ctrlKey || event.metaKey)) return;
  if ((event.target as HTMLElement | null)?.closest?.('input,textarea,select')) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) { event.preventDefault(); restore(-1); }
  else if ((key === 'z' && event.shiftKey) || key === 'y') { event.preventDefault(); restore(1); }
}

onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));

function createNewItem(baseItem?: any) {
  if (isEnv.value) {
    return { kind: 'kv', exported: false, key: 'NEW_VARIABLE', value: '' };
  }
  const type = baseItem?.type || spec.value.types.find(Boolean) || 'DOMAIN-SUFFIX';
  const action = baseItem?.action ?? '';
  return { kind: 'rule', enabled: true, type, rule: '', action, opts: [], isBracketRule: false };
}

function addRule(afterIndex?: number) {
  const items: any[] = session.parsed.items;
  const base = typeof afterIndex === 'number' ? items[afterIndex] : undefined;
  const newItem = createNewItem(base);
  if (typeof afterIndex === 'number' && afterIndex >= 0 && afterIndex < items.length) {
    items.splice(afterIndex + 1, 0, newItem);
    commit();
  } else {
    items.push(newItem);
    commit();
    void nextTick(() => {
      if (filteredEntries.value.length) rowVirtualizer.value.scrollToIndex(filteredEntries.value.length - 1);
    });
  }
}

function onRuleTypeChange(item: any, nextType: string) {
  const prevNoContent = NO_CONTENT_TYPES.has(item.type);
  const nextNoContent = NO_CONTENT_TYPES.has(nextType);
  item.type = nextType;
  if (!prevNoContent && nextNoContent) {
    // 切换到 FINAL/MATCH 时，把原本的策略挪到 rule 位置（序列化为 FINAL,Proxy）
    item.rule = item.action || item.rule || spec.value.actions[0] || 'Proxy';
    item.action = '';
    item.opts = [];
  } else if (prevNoContent && !nextNoContent) {
    // 从 FINAL/MATCH 切回普通规则时，把策略放回 action
    if (!item.action && item.rule) item.action = item.rule;
    item.rule = '';
  }
  touch();
}

async function onActionSelect(item: any, selectEl: HTMLSelectElement, isFinalRule = false) {
  const val = selectEl.value;
  if (val === '__custom__') {
    const current = isFinalRule ? (item.rule || item.action || '') : (item.action || '');
    const custom = await askInput({
      title: '自定义策略 / 策略组',
      message: '输入目标策略或策略组名称（如 Proxy、DIRECT、📲 电报消息、🤖 OpenAI）：',
      defaultValue: current,
      placeholder: '策略组名称',
      okText: '确定',
    });
    if (custom && custom.trim()) {
      const trimmed = custom.trim();
      if (!customActions.value.includes(trimmed)) customActions.value.push(trimmed);
      if (isFinalRule) {
        item.rule = trimmed;
        item.action = '';
      } else {
        item.action = trimmed;
      }
      commit();
    } else {
      selectEl.value = current;
    }
    return;
  }
  if (isFinalRule) {
    item.rule = val;
    item.action = '';
  } else {
    item.action = val;
  }
  touch();
}

function supportsNoResolve(item: any) {
  return NO_RESOLVE_TYPES.has(item.type) || (item.opts && item.opts.includes('no-resolve'));
}

function hasNoResolve(item: any) {
  return Array.isArray(item.opts) && item.opts.includes('no-resolve');
}

function toggleNoResolve(item: any) {
  if (!Array.isArray(item.opts)) item.opts = [];
  if (item.opts.includes('no-resolve')) {
    item.opts = item.opts.filter((o: string) => o !== 'no-resolve');
  } else {
    item.opts = [...item.opts, 'no-resolve'];
  }
  commit();
}

function toggleRulesetMode(entry: any) {
  if (entry.embedded) {
    entry.embedded = null;
    entry.url ||= 'https://raw.githubusercontent.com/';
  } else {
    entry.embedded = { type: 'GEOIP', rule: 'CN' };
  }
  commit();
}

function onIniStrategyChange(entry: any, nextStrategy: string) {
  entry.strategy = nextStrategy;
  if (nextStrategy === 'select') {
    entry.members ||= [];
  } else {
    entry.filters ||= '.*';
    entry.url ||= 'http://www.gstatic.com/generate_204';
    entry.interval ||= '300';
  }
  commit();
}

function addIni(entry: any) {
  const sections = session.parsed.sections;
  const target = sections.find((section: any) => section.section === 'custom') || sections.find((section: any) => section.section !== null) || sections[0];
  if (!target) return toast('文件中没有可添加的 section');
  target.entries.push(entry);
  commit();
}

function move(list: any[], from: number, dir: number) {
  const to = from + dir;
  if (to < 0 || to >= list.length) return;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  list.splice(0, list.length, ...next);
  commit();
}

async function batchPaste() {
  if (isIni.value) return toast('批量粘贴暂不支持 .ini 格式');
  const text = await askInput({ title: '批量粘贴', message: '粘贴多行规则（每行一条，支持注释 #）。Ctrl/Cmd+Enter 提交。', multiline: true, okText: '添加' });
  if (text === null || !text.trim()) return;
  if (isEnv.value) session.parsed.items.push(...(parse('env', text).items || []).map((item: any) => { const copy = { ...item }; delete copy.raw; return copy; }));
  else for (const line of text.split(/\r?\n/)) session.parsed.items.push(lineToItem(line, session.fmt));
  toast(`已添加 ${text.split(/\r?\n/).length} 条`);
  commit();
}

function dedupeRules() {
  const result = dedupe(session.parsed.items);
  if (!result.removed) return toast('没有发现重复规则');
  session.parsed.items = result.items;
  toast(`已删除 ${result.removed} 条重复规则`);
  commit();
}

function sortRules() {
  const result = sortRuns(session.parsed.items);
  if (!result.changedRuns) return toast('没有需要调整的规则段');
  session.parsed.items = result.items;
  toast(`已整理 ${result.changedRuns} 段规则（仅同类型、同动作的连续规则，不影响匹配优先级）`);
  commit();
}

async function importFromUrl() {
  const input = await askInput({ title: '导入链接', message: '粘贴要导入的 .list 链接（GitHub Raw / blob、jsDelivr 或本站 /file/ 链接）：', placeholder: 'https://…', okText: '导入' });
  if (!input?.trim()) return;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || !(IMPORT_HOSTS.has(url.hostname) || url.origin === location.origin)) throw new Error('只支持 GitHub / jsDelivr / 本站链接');
    let href = url.href;
    const blob = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (blob) href = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;
    const res = await fetch(href, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 1024 * 1024) throw new Error('文件超过 1 MiB');
    const existing = new Set(session.parsed.items.filter((item: any) => item.type).map(ruleKey));
    let added = 0;
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = lineToItem(line, session.fmt);
      if (item.type) {
        const key = ruleKey(item);
        if (existing.has(key)) { skipped++; continue; }
        existing.add(key);
      }
      session.parsed.items.push(item);
      added++;
    }
    toast(`已导入 ${added} 行，跳过 ${skipped} 条已存在的规则`);
    commit();
  } catch (error) {
    toast('导入失败：' + (error as Error).message);
  }
}

const moreItems = () => {
  const items: { label: string; onClick: () => void }[] = [{ label: '批量粘贴', onClick: () => { void batchPaste(); } }];
  if (!isIni.value && !isEnv.value) {
    items.push(
      { label: '导入远程链接', onClick: () => { void importFromUrl(); } },
      { label: '一键去重', onClick: dedupeRules },
      { label: '安全排序', onClick: sortRules },
      ...Object.entries(CONVERT_TARGETS).filter(([fmt]) => fmt !== session.fmt).map(([fmt, item]) => ({
        label: `转为 ${item.label} 规则`,
        onClick: () => { void actions.convertCurrent(fmt); },
      })),
    );
  }
  return items;
};

function toggleReveal(idx: number) {
  revealed.value = revealed.value.includes(idx) ? revealed.value.filter(item => item !== idx) : [...revealed.value, idx];
}
</script>

<template>
  <div v-if="session.parsed" class="flex h-full min-h-0 flex-col bg-background/30">
    <!-- 合并后的紧凑单层工具栏（PC 单行、移动端紧凑排布，省去重复标题与双层横栏） -->
    <div class="flex flex-wrap items-center gap-2 border-b border-border bg-white px-3 py-2 sm:px-4">
      <div v-if="!isIni" class="relative min-w-44 flex-1 sm:max-w-xs">
        <Search class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
        <input
          v-model="filter"
          class="h-8 w-full rounded-lg border border-border bg-background/40 pr-7 pl-8 text-xs sm:text-sm"
          :placeholder="isEnv ? '搜索变量名或值…' : '搜索规则（类型 / 内容 / 策略）…'"
        />
        <button
          v-if="filter"
          type="button"
          class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-xs text-muted hover:text-foreground"
          @click="filter = ''"
        >
          ✕
        </button>
      </div>

      <div class="flex items-center gap-1.5">
        <button
          v-if="issueMap.size"
          type="button"
          class="rounded-full px-2.5 py-0.5 text-xs font-medium transition"
          :class="onlyIssues ? 'bg-danger text-white shadow-2xs' : 'bg-red-50 text-danger hover:bg-red-100'"
          title="点击只看需要检查的条目"
          @click="onlyIssues = !onlyIssues"
        >
          ⚠ {{ issueMap.size }} 条需检查{{ onlyIssues ? '（仅看问题）' : '' }}
        </button>
        <span v-else-if="!isIni" class="rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted">
          {{ filter ? `${filteredEntries.length} / ${(session.parsed.items || []).length || 0}` : `共 ${(session.parsed.items || []).length || 0} 条` }}
        </span>
      </div>

      <div class="ml-auto flex items-center gap-1.5">
        <div v-if="!session.readonly" class="inline-flex items-center rounded-lg border border-border bg-white p-0.5">
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-background hover:text-foreground disabled:opacity-35"
            :disabled="index <= 0"
            title="撤销 (⌘Z / Ctrl+Z)"
            @click="restore(-1)"
          >
            <Undo2 class="size-3.5" />
          </button>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-background hover:text-foreground disabled:opacity-35"
            :disabled="index >= stack.length - 1"
            title="重做 (⇧⌘Z / Ctrl+Y)"
            @click="restore(1)"
          >
            <Redo2 class="size-3.5" />
          </button>
        </div>
        <Button v-if="!isIni" size="sm" variant="primary" class="h-8 px-2.5 text-xs" :disabled="session.readonly" @click="addRule()">
          {{ isEnv ? '＋ 添加变量' : '＋ 添加规则' }}
        </Button>
        <Button v-if="isIni" size="sm" variant="primary" class="h-8 px-2.5 text-xs" :disabled="session.readonly" @click="addIni({ kind: 'ruleset', label: '🆎 广告过滤', url: '', embedded: null })">＋ ruleset</Button>
        <Button v-if="isIni" size="sm" variant="secondary" class="h-8 px-2.5 text-xs" :disabled="session.readonly" @click="addIni({ kind: 'proxy_group', name: '新分组', strategy: 'select', members: [] })">＋ 分组</Button>
        <Menu label="工具 ▾" :items="moreItems()" />
      </div>
    </div>

    <div v-if="isEnv && session.info?.private !== true" class="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:px-4">
      当前仓库不是私有的：.env 里的真实密钥一旦提交就会进入公开的 Git 历史。
    </div>

    <div ref="listParent" class="min-h-0 flex-1 overflow-auto p-2.5 sm:p-4">
      <template v-if="!isIni">
        <p v-if="!filteredEntries.length" class="py-8 text-center text-sm text-muted">{{ filter ? '没有匹配的条目' : '暂无条目，点击上方按钮添加' }}</p>
        <div v-else class="relative w-full" :style="{ height: `${rowVirtualizer.getTotalSize()}px` }">
          <div
            v-for="vRow in rowVirtualizer.getVirtualItems()"
            :key="filteredEntries[vRow.index].idx"
            :ref="measureEl"
            :data-index="vRow.index"
            class="absolute top-0 left-0 w-full pb-2 sm:pb-1.5"
            :style="{ transform: `translateY(${vRow.start}px)` }"
          >
            <div
              class="rounded-xl border bg-white px-2.5 py-2 shadow-2xs transition sm:px-3 sm:py-1.5"
              :class="[
                issueMap.has(filteredEntries[vRow.index].idx) ? 'border-red-300 bg-red-50/30' : 'border-border/80 hover:border-border',
                !isEnv && filteredEntries[vRow.index].item.enabled === false && 'opacity-55 bg-slate-50/60',
              ]"
              :title="issueMap.get(filteredEntries[vRow.index].idx) || ''"
            >
              <div class="flex flex-wrap items-center gap-1.5 sm:flex-nowrap sm:gap-2">
                <!-- 序号与启用复选框（移动端第 1 行左侧，PC 端最左侧） -->
                <div class="order-1 flex shrink-0 items-center gap-1.5">
                  <span class="min-w-6 select-none text-right font-mono text-[11px] font-medium text-muted/75">#{{ filteredEntries[vRow.index].idx + 1 }}</span>
                  <input
                    v-if="!isEnv"
                    type="checkbox"
                    class="size-4 shrink-0 rounded accent-primary"
                    :checked="filteredEntries[vRow.index].item.enabled !== false"
                    :disabled="session.readonly"
                    @change="filteredEntries[vRow.index].item.enabled = ($event.target as HTMLInputElement).checked; touch()"
                  />
                </div>

                <!-- 空行 -->
                <template v-if="filteredEntries[vRow.index].item.kind === 'blank'">
                  <span class="order-1 flex-1 px-2 py-1 text-xs italic text-muted">（空行）</span>
                </template>

                <!-- 纯注释行 -->
                <template v-else-if="filteredEntries[vRow.index].item.kind === 'comment' || (!isEnv && !filteredEntries[vRow.index].item.type && filteredEntries[vRow.index].item.kind !== 'rule')">
                  <input
                    class="order-3 h-9 min-w-0 flex-1 rounded-lg border border-border bg-background/50 px-2.5 text-sm text-muted sm:order-2 sm:h-8"
                    :value="filteredEntries[vRow.index].item.text || filteredEntries[vRow.index].item.rule || ''"
                    :disabled="session.readonly"
                    placeholder="注释或原样文本…"
                    @input="filteredEntries[vRow.index].item.text = ($event.target as HTMLInputElement).value; filteredEntries[vRow.index].item.rule = filteredEntries[vRow.index].item.text; touch()"
                  />
                  <div class="order-2 h-0 basis-full sm:hidden" />
                </template>

                <!-- .env 环境变量键值对 -->
                <template v-else-if="isEnv && filteredEntries[vRow.index].item.kind === 'kv'">
                  <input
                    class="order-1 h-9 min-w-0 flex-1 rounded-lg border border-border bg-background/30 px-2.5 font-mono text-xs font-medium sm:h-8 sm:w-44 sm:flex-none"
                    :value="filteredEntries[vRow.index].item.key"
                    :disabled="session.readonly"
                    placeholder="KEY"
                    @input="filteredEntries[vRow.index].item.key = ($event.target as HTMLInputElement).value; touch()"
                  />
                  <div class="order-2 h-0 basis-full sm:hidden" />
                  <span class="hidden text-muted sm:order-2 sm:inline">=</span>
                  <div class="order-3 flex min-w-0 flex-1 items-center gap-1 sm:order-2">
                    <input
                      class="h-9 min-w-0 flex-1 rounded-lg border border-border px-2.5 font-mono text-xs sm:h-8"
                      :type="isSensitiveKey(filteredEntries[vRow.index].item.key) && !revealed.includes(filteredEntries[vRow.index].idx) ? 'password' : 'text'"
                      :value="filteredEntries[vRow.index].item.value"
                      :disabled="session.readonly"
                      placeholder="VALUE"
                      @input="filteredEntries[vRow.index].item.value = ($event.target as HTMLInputElement).value; touch()"
                    />
                    <button
                      v-if="isSensitiveKey(filteredEntries[vRow.index].item.key)"
                      class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-background hover:text-foreground sm:h-7 sm:w-7"
                      type="button"
                      title="显示/隐藏敏感值"
                      @click="toggleReveal(filteredEntries[vRow.index].idx)"
                    >
                      👁
                    </button>
                  </div>
                </template>

                <!-- 标准分流规则行：移动端规整双行（第 1 行：类型 + 操作按钮；第 2 行：内容输入 + 策略），PC 端单行 -->
                <template v-else>
                  <!-- 规则类型选择（移动端在第 1 行自适应撑满中间，PC 端固定宽度） -->
                  <select
                    class="order-1 h-8 min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-2 text-xs font-medium text-foreground transition focus:bg-white sm:w-40 sm:flex-none"
                    :value="filteredEntries[vRow.index].item.type"
                    :disabled="session.readonly"
                    @change="onRuleTypeChange(filteredEntries[vRow.index].item, ($event.target as HTMLSelectElement).value)"
                  >
                    <option v-for="type in spec.types" :key="type" :value="type">{{ type || '- (注释/自由文本)' }}</option>
                    <option v-if="filteredEntries[vRow.index].item.type && !spec.types.includes(filteredEntries[vRow.index].item.type)" :value="filteredEntries[vRow.index].item.type">{{ filteredEntries[vRow.index].item.type }}</option>
                  </select>

                  <!-- 移动端强制换行分隔符（使第 1 行严格为「序号+勾选+类型+行操作」，第 2 行严格为「域名输入+策略」，彻底消除悬空断行） -->
                  <div class="order-2 h-0 basis-full sm:hidden" />

                  <!-- FINAL / MATCH 兜底规则：只有策略列，不再展示多余的域名输入框 -->
                  <template v-if="NO_CONTENT_TYPES.has(filteredEntries[vRow.index].item.type)">
                    <span class="order-3 text-xs text-muted sm:order-2">兜底策略 →</span>
                    <select
                      class="order-3 h-9 min-w-32 flex-1 rounded-lg border border-border bg-white px-2.5 text-xs font-medium sm:order-2 sm:h-8 sm:max-w-52"
                      :value="filteredEntries[vRow.index].item.rule || filteredEntries[vRow.index].item.action"
                      :disabled="session.readonly"
                      @change="onActionSelect(filteredEntries[vRow.index].item, $event.target as HTMLSelectElement, true)"
                    >
                      <option value="">(选择兜底策略)</option>
                      <option v-for="action in availableActions" :key="action" :value="action">{{ action }}</option>
                      <option value="__custom__">＋ 自定义策略组…</option>
                    </select>
                  </template>

                  <template v-else>
                    <!-- 规则匹配内容输入（移动端第 2 行左侧撑满，PC 端中间撑满） -->
                    <input
                      class="order-3 h-9 min-w-0 flex-1 rounded-lg border border-border bg-white px-2.5 font-mono text-xs text-foreground placeholder:text-muted/60 sm:order-2 sm:h-8"
                      :value="filteredEntries[vRow.index].item.rule"
                      :placeholder="filteredEntries[vRow.index].item.type ? spec.placeholder : '注释或自由文本…'"
                      :disabled="session.readonly"
                      @input="filteredEntries[vRow.index].item.rule = ($event.target as HTMLInputElement).value; touch()"
                    />

                    <!-- IP / GEOIP / ASN 等规则的 no-resolve 快捷开关 -->
                    <button
                      v-if="supportsNoResolve(filteredEntries[vRow.index].item)"
                      type="button"
                      class="order-3 inline-flex h-9 shrink-0 items-center rounded-lg border px-2 font-mono text-[11px] font-medium transition sm:order-3 sm:h-8 sm:rounded-md sm:px-1.5"
                      :class="hasNoResolve(filteredEntries[vRow.index].item) ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-background/50 text-muted hover:text-foreground'"
                      :disabled="session.readonly"
                      title="切换 no-resolve（匹配时不触发 DNS 解析）"
                      @click="toggleNoResolve(filteredEntries[vRow.index].item)"
                    >
                      no-resolve
                    </button>

                    <!-- 策略选择（仅当选择了具体规则类型时显示；移动端位于第 2 行右侧，与输入框同行对齐） -->
                    <select
                      v-if="filteredEntries[vRow.index].item.type"
                      class="order-3 h-9 w-28 shrink-0 rounded-lg border border-border bg-background/30 px-2 text-xs text-foreground transition focus:bg-white sm:order-4 sm:h-8 sm:w-36"
                      :value="filteredEntries[vRow.index].item.action"
                      :disabled="session.readonly"
                      @change="onActionSelect(filteredEntries[vRow.index].item, $event.target as HTMLSelectElement, false)"
                    >
                      <option value="">(无策略)</option>
                      <option v-for="action in availableActions" :key="action" :value="action">{{ action }}</option>
                      <option value="__custom__">＋ 自定义策略组…</option>
                    </select>
                  </template>
                </template>

                <!-- 行操作按钮组（移动端固定在第 1 行右上角，PC 端固定在最右侧，统一使用矢量图标） -->
                <div v-if="!session.readonly" class="order-1 ml-auto flex shrink-0 items-center gap-0.5 rounded-lg bg-background/50 p-0.5 sm:order-5 sm:ml-0 sm:bg-transparent sm:p-0">
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-white hover:text-primary sm:hover:bg-background"
                    title="在此行下方插入新行"
                    @click="addRule(filteredEntries[vRow.index].idx)"
                  >
                    <Plus class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-white hover:text-foreground sm:hover:bg-background"
                    title="上移"
                    @click="move(session.parsed.items, filteredEntries[vRow.index].idx, -1)"
                  >
                    <ArrowUp class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-white hover:text-foreground sm:hover:bg-background"
                    title="下移"
                    @click="move(session.parsed.items, filteredEntries[vRow.index].idx, 1)"
                  >
                    <ArrowDown class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    class="inline-flex h-7 w-7 items-center justify-center rounded-md text-danger/80 transition hover:bg-red-50 hover:text-danger"
                    title="删除此行"
                    @click="session.parsed.items.splice(filteredEntries[vRow.index].idx, 1); commit()"
                  >
                    <X class="size-3.5" />
                  </button>
                </div>
              </div>
              <p v-if="issueMap.get(filteredEntries[vRow.index].idx)" class="mt-1.5 pl-6 text-xs text-danger">⚠ {{ issueMap.get(filteredEntries[vRow.index].idx) }}</p>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <section v-for="(section, sIdx) in session.parsed.sections" :key="sIdx" class="mb-3 overflow-hidden rounded-xl border border-border bg-white shadow-2xs">
          <header class="border-b border-border bg-background/70 px-3 py-1.5 text-xs font-semibold text-foreground">{{ section.section === null ? '(文件开头)' : '[' + section.section + ']' }}</header>
          <div
            v-for="(entry, idx) in section.entries"
            :key="idx"
            class="flex flex-wrap items-center gap-1.5 border-t border-border/60 p-2.5 text-sm first:border-t-0"
            :class="entry.kind === 'ruleset' && validateRuleset(entry) ? 'bg-red-50/30' : ''"
            :title="entry.kind === 'ruleset' ? (validateRuleset(entry) || '') : ''"
          >
            <template v-if="entry.kind === 'ruleset'">
              <input class="h-8 w-full rounded-lg border border-border px-2.5 text-xs sm:w-40" :value="entry.label" :disabled="session.readonly" placeholder="目标策略组名称" @input="entry.label = ($event.target as HTMLInputElement).value; touch()" />
              <button
                type="button"
                class="h-8 shrink-0 rounded-lg border border-border bg-background/60 px-2 text-xs font-medium text-muted transition hover:bg-background hover:text-foreground"
                :disabled="session.readonly"
                title="切换远程 URL 规则集 / 内置 [] 规则"
                @click="toggleRulesetMode(entry)"
              >
                {{ entry.embedded ? '[] 内置规则' : '远程 URL' }}
              </button>
              <input v-if="!entry.embedded" class="h-8 min-w-0 flex-1 rounded-lg border border-border px-2.5 font-mono text-xs" :value="entry.url" placeholder="https://raw.githubusercontent.com/…" :disabled="session.readonly" @input="entry.url = ($event.target as HTMLInputElement).value; touch()" />
              <template v-else>
                <input class="h-8 w-28 rounded-lg border border-border px-2.5 font-mono text-xs" :value="entry.embedded.type" placeholder="GEOIP / FINAL" :disabled="session.readonly" @input="entry.embedded.type = ($event.target as HTMLInputElement).value; touch()" />
                <input v-if="entry.embedded.type !== 'FINAL'" class="h-8 min-w-0 flex-1 rounded-lg border border-border px-2.5 font-mono text-xs" :value="entry.embedded.rule" placeholder="参数（如 CN）" :disabled="session.readonly" @input="entry.embedded.rule = ($event.target as HTMLInputElement).value; touch()" />
              </template>
            </template>

            <template v-else-if="entry.kind === 'proxy_group'">
              <input class="h-8 min-w-0 flex-1 rounded-lg border border-border px-2.5 text-xs font-medium sm:w-44 sm:flex-none" :value="entry.name" :disabled="session.readonly" placeholder="策略组名" @input="entry.name = ($event.target as HTMLInputElement).value; touch()" />
              <select class="h-8 rounded-lg border border-border bg-white px-2 text-xs" :value="entry.strategy" :disabled="session.readonly" @change="onIniStrategyChange(entry, ($event.target as HTMLSelectElement).value)">
                <option v-for="strategy in ['select', 'url-test', 'fallback', 'domain-test', 'load-balance']" :key="strategy">{{ strategy }}</option>
              </select>
              <div v-if="!session.readonly" class="ml-auto flex shrink-0 items-center gap-0.5">
                <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-background hover:text-foreground" title="上移" @click="move(section.entries, Number(idx), -1)">↑</button>
                <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-background hover:text-foreground" title="下移" @click="move(section.entries, Number(idx), 1)">↓</button>
                <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-danger hover:bg-red-50" title="删除策略组" @click="section.entries.splice(idx, 1); commit()">✕</button>
              </div>

              <!-- select 策略组：节点与子策略成员列表 -->
              <div v-if="entry.strategy === 'select'" class="mt-1 flex w-full flex-col gap-1.5 rounded-lg bg-background/50 p-2">
                <div v-for="(member, memberIndex) in entry.members || []" :key="memberIndex" class="flex items-center gap-1.5">
                  <input class="h-7 w-14 rounded-md border border-border bg-white px-1.5 font-mono text-xs" :value="member.prefix" :disabled="session.readonly" placeholder="[]" title="前缀（[] 表示引用策略组/内置策略）" @input="member.prefix = ($event.target as HTMLInputElement).value; touch()" />
                  <input class="h-7 min-w-0 flex-1 rounded-md border border-border bg-white px-2.5 text-xs" :value="member.name" placeholder="节点正则或策略组名" :disabled="session.readonly" @input="member.name = ($event.target as HTMLInputElement).value; touch()" />
                  <button v-if="!session.readonly" type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-white hover:text-danger" @click="entry.members.splice(memberIndex, 1); commit()">✕</button>
                </div>
                <button v-if="!session.readonly" type="button" class="self-start rounded-md bg-white px-2 py-1 text-xs font-medium text-primary shadow-2xs hover:bg-primary/5" @click="entry.members ||= []; entry.members.push({ name: '', prefix: '[]', glob: false }); commit()">＋ 添加成员</button>
              </div>

              <!-- url-test / fallback / load-balance / domain-test 参数可视化表单 -->
              <div v-else class="mt-1 grid w-full grid-cols-1 gap-2 rounded-lg bg-background/50 p-2.5 sm:grid-cols-12">
                <label class="flex flex-col gap-1 sm:col-span-4">
                  <span class="text-[11px] font-medium text-muted">节点过滤正则 (filters)</span>
                  <input
                    class="h-7 rounded-md border border-border bg-white px-2 font-mono text-xs"
                    :value="entry.filters || ''"
                    :disabled="session.readonly"
                    placeholder=".* 或 (港|HK|Hong Kong)"
                    @input="entry.filters = ($event.target as HTMLInputElement).value; touch()"
                  />
                </label>
                <label class="flex flex-col gap-1 sm:col-span-5">
                  <span class="text-[11px] font-medium text-muted">测速 URL</span>
                  <input
                    class="h-7 rounded-md border border-border bg-white px-2 font-mono text-xs"
                    :value="entry.url || ''"
                    :disabled="session.readonly"
                    placeholder="http://www.gstatic.com/generate_204"
                    @input="entry.url = ($event.target as HTMLInputElement).value; touch()"
                  />
                </label>
                <div class="grid grid-cols-3 gap-1.5 sm:col-span-3">
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted">间隔(秒)</span>
                    <input
                      class="h-7 rounded-md border border-border bg-white px-1.5 font-mono text-xs"
                      :value="entry.interval || ''"
                      :disabled="session.readonly"
                      placeholder="300"
                      @input="entry.interval = ($event.target as HTMLInputElement).value; touch()"
                    />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted">超时</span>
                    <input
                      class="h-7 rounded-md border border-border bg-white px-1.5 font-mono text-xs"
                      :value="entry.failure || ''"
                      :disabled="session.readonly"
                      placeholder="可选"
                      @input="entry.failure = ($event.target as HTMLInputElement).value; touch()"
                    />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] font-medium text-muted">容差(ms)</span>
                    <input
                      class="h-7 rounded-md border border-border bg-white px-1.5 font-mono text-xs"
                      :value="entry.success || ''"
                      :disabled="session.readonly"
                      placeholder="50"
                      @input="entry.success = ($event.target as HTMLInputElement).value; touch()"
                    />
                  </label>
                </div>
              </div>
            </template>

            <template v-else-if="entry.kind === 'kv'">
              <input class="h-8 w-36 rounded-lg border border-border px-2.5 font-mono text-xs" :value="entry.key" :disabled="session.readonly" @input="entry.key = ($event.target as HTMLInputElement).value; touch()" />
              <input class="h-8 min-w-0 flex-1 rounded-lg border border-border px-2.5 font-mono text-xs" :value="entry.value" :disabled="session.readonly" @input="entry.value = ($event.target as HTMLInputElement).value; touch()" />
            </template>
            <template v-else-if="entry.kind === 'comment'">
              <input class="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background/40 px-2.5 text-xs text-muted" :value="entry.text" :disabled="session.readonly" @input="entry.text = ($event.target as HTMLInputElement).value; touch()" />
            </template>
            <span v-else class="min-w-0 flex-1 truncate text-xs text-muted">{{ entry.raw || entry.kind }}</span>

            <div v-if="!session.readonly && entry.kind !== 'proxy_group'" class="ml-auto flex shrink-0 items-center gap-0.5">
              <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-background hover:text-foreground" title="上移" @click="move(section.entries, Number(idx), -1)">↑</button>
              <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-muted hover:bg-background hover:text-foreground" title="下移" @click="move(section.entries, Number(idx), 1)">↓</button>
              <button type="button" class="inline-flex h-7 w-7 items-center justify-center rounded-md text-xs text-danger hover:bg-red-50" title="删除此项" @click="section.entries.splice(idx, 1); commit()">✕</button>
            </div>
            <p v-if="entry.kind === 'ruleset' && validateRuleset(entry)" class="w-full text-xs text-danger">⚠ {{ validateRuleset(entry) }}</p>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>
