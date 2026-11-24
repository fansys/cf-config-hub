<script setup lang="ts">
import { Check, GitBranch } from '@lucide/vue';
import { ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { request } from '@/lib/api';
import { askInput } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { useFileActions } from '@/features/editor/actions';
import { panels } from '@/features/shell/panels';
import { useSession } from '@/stores/session';

const session = useSession();
const actions = useFileActions();
const branches = ref<any[]>([]);
const selected = ref('');
const loading = ref(false);
const busy = ref(false);
const errorMsg = ref('');

function fallbackBranches() {
  const names = [...new Set([session.info?.defaults?.branch, session.info?.branch].filter(Boolean))];
  return names.map(name => ({ name, protected: false }));
}

async function loadBranches() {
  loading.value = true;
  errorMsg.value = '';
  selected.value = session.info?.branch || session.info?.defaults?.branch || '';
  try {
    const data = await request('/api/branches');
    const list = Array.isArray(data.branches) && data.branches.length ? data.branches : fallbackBranches();
    branches.value = list;
    if (!selected.value || !branches.value.some((b: any) => b.name === selected.value)) {
      selected.value = session.info?.branch || branches.value[0]?.name || '';
    }
  } catch (error) {
    errorMsg.value = (error as Error).message;
    branches.value = fallbackBranches();
    toast('加载分支失败：' + errorMsg.value);
  } finally {
    loading.value = false;
  }
}

watch(() => panels.branch, (open) => {
  if (open) void loadBranches();
}, { immediate: true });

async function createBranch() {
  const baseBranch = selected.value || session.info?.branch || 'main';
  const name = await askInput({ title: '新建分支', message: `基于 ${baseBranch} 创建：`, placeholder: 'feature/xxx', okText: '创建' });
  if (!name?.trim()) return;
  try {
    await request('/api/branch', 'POST', { name: name.trim(), from: baseBranch });
    const data = await request('/api/branches');
    branches.value = data.branches || [];
    selected.value = name.trim();
    toast('分支已创建');
  } catch (error) { toast('创建失败：' + (error as Error).message); }
}

async function apply() {
  if (!selected.value || selected.value === session.info?.branch) { panels.branch = false; return; }
  if (!(await actions.checkUnsaved())) return;
  busy.value = true;
  try {
    const branch = selected.value === session.info?.defaults?.branch ? '' : selected.value;
    if (await actions.applyBranch(branch)) {
      panels.branch = false;
      panels.nav = false;
      toast(`已切换到分支 ${selected.value}`);
    }
  } finally {
    busy.value = false;
  }
}

async function resetDefault() {
  if (session.info?.branch === session.info?.defaults?.branch) { panels.branch = false; return; }
  if (!(await actions.checkUnsaved())) return;
  busy.value = true;
  try {
    if (await actions.applyBranch('')) {
      panels.branch = false;
      panels.nav = false;
      toast('已回到默认分支');
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="panels.branch" title="切换分支" @update:open="open => panels.branch = open">
    <div class="mb-3 flex items-center justify-between gap-2">
      <p class="min-w-0 truncate text-sm text-muted">
        {{ session.info?.owner }}/{{ session.info?.repo }}{{ session.info?.root ? ' · 目录 /' + session.info.root : '' }}
      </p>
      <Button v-if="!session.readonly" variant="secondary" size="sm" :disabled="loading || busy" @click="createBranch">＋ 新建分支</Button>
    </div>

    <p v-if="errorMsg" class="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-danger">
      读取远端分支列表异常（{{ errorMsg }}），当前仅展示已知分支。
    </p>
    <div v-if="loading" class="space-y-2 py-2">
      <div class="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
      <div class="h-10 w-full animate-pulse rounded-xl bg-slate-100" />
    </div>

    <div v-else-if="branches.length" class="max-h-60 space-y-1.5 overflow-y-auto pr-0.5">
      <button
        v-for="branch in branches"
        :key="branch.name"
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition"
        :class="selected === branch.name ? 'border-primary bg-primary/8 font-medium text-primary' : 'border-border bg-white text-foreground hover:bg-background/60'"
        @click="selected = branch.name"
      >
        <div class="flex min-w-0 items-center gap-2">
          <GitBranch class="size-4 shrink-0" :class="selected === branch.name ? 'text-primary' : 'text-muted'" />
          <span class="truncate">{{ branch.name }}</span>
          <span v-if="branch.name === session.info?.defaults?.branch" class="shrink-0 rounded bg-background px-1.5 py-0.5 text-[11px] font-normal text-muted">默认</span>
          <span v-if="branch.name === session.info?.branch" class="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-normal text-emerald-700">当前</span>
        </div>
        <Check v-if="selected === branch.name" class="size-4 shrink-0 text-primary" />
      </button>
    </div>

    <p v-else class="rounded-xl bg-background p-3 text-sm text-muted">未能获取到分支列表，请稍后重试。</p>

    <p class="my-3 text-xs leading-relaxed text-muted">仓库与管理目录由部署配置决定。分支选择只保存在本浏览器。其它分支的访问规则和令牌链接相互独立。</p>
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" :disabled="busy || session.info?.branch === session.info?.defaults?.branch" @click="resetDefault">回到默认分支</Button>
      <Button variant="primary" :disabled="loading || busy || !selected" @click="apply">切换</Button>
    </div>
  </Dialog>
</template>
