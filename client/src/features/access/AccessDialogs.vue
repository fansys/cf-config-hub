<script setup lang="ts">
import { MODE_LABELS, resolveAccess } from '@shared/access.js';
import { computed, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { request } from '@/lib/api';
import { askConfirm } from '@/lib/dialogs';
import { toast } from '@/lib/toast';
import { useSession } from '@/stores/session';
import { panels } from '@/features/shell/panels';

const session = useSession();
const rules = ref<any[]>([]);
const meta = ref<any>(null);
const selected = ref('inherit');
const choices = [
  { id: 'inherit', name: '继承上级' },
  { id: 'direct', name: '免令牌直链' },
  { id: 'token', name: '仅令牌访问' },
  { id: 'deny', name: '禁止访问' },
];

async function loadRules() {
  meta.value = await request('/api/access');
  rules.value = (meta.value.rules || []).map((rule: any) => ({ ...rule }));
}

function samePattern(rulePattern: string, path: string, dir: boolean) {
  const norm = rulePattern.endsWith('/') ? `${rulePattern}**` : rulePattern;
  return dir ? norm === `${path}/**` : norm === path;
}

function syncSelected() {
  if (!panels.access) return;
  const path = panels.accessPath;
  const dir = panels.accessKind === 'dir';
  const rules = session.info?.access?.rules || [];
  const own = rules.find((rule: { pattern: string; mode: string }) => samePattern(rule.pattern, path, dir));
  if (own) {
    selected.value = own.mode;
    return;
  }
  const access = resolveAccess(rules, dir ? `${path}/\0` : path);
  selected.value = access.mode === 'direct' || access.mode === 'token' || access.mode === 'deny' ? access.mode : 'inherit';
}

const currentAccess = computed(() => {
  if (!panels.accessPath) return null;
  const path = panels.accessKind === 'dir' ? `${panels.accessPath}/\0` : panels.accessPath;
  return resolveAccess(session.info?.access?.rules || [], path);
});

watch(() => panels.rules, (open) => { if (open) loadRules().catch(error => toast(error.message)); }, { immediate: true });
watch(() => [panels.access, panels.accessPath, panels.accessKind, session.info?.access?.rules], syncSelected, { immediate: true });

const editable = () => !!meta.value?.kvAvailable && !session.readonly;

async function saveRules() {
  const cleaned = rules.value.filter(rule => rule.pattern.trim());
  if (!cleaned.length && meta.value?.rules?.length && !await askConfirm({ title: '清空全部规则', message: '清空后令牌可访问任意文件，且不再有任何免令牌直链。确定吗？', okText: '清空并保存', danger: true })) return;
  await request('/api/access', 'PUT', { rules: cleaned });
  await session.loadContext();
  toast('规则已保存（全球生效最长约 1 分钟）');
  panels.rules = false;
}

async function saveOne() {
  if (selected.value === 'direct' && !await askConfirm({ title: '开启免令牌直链', okText: '确认开启', danger: true, message: '这些内容将可被任何人通过链接直接读取，请确认可以公开。' })) return;
  const pattern = panels.accessKind === 'dir' ? `${panels.accessPath}/**` : panels.accessPath;
  try {
    await request('/api/access/set', 'POST', { pattern, mode: selected.value === 'inherit' ? null : selected.value });
    await session.loadContext();
    toast(panels.accessKind === 'dir' ? '目录规则已保存，其中的文件会按这条规则生成令牌' : '访问规则已保存（全球生效最长约 1 分钟）');
    panels.access = false;
  } catch (error) {
    toast('保存失败：' + (error as Error).message);
  }
}

function preview() {
  const pattern = panels.accessKind === 'dir' ? `${panels.accessPath}/**` : panels.accessPath;
  const others = (session.info?.access?.rules || []).filter((rule: any) => rule.pattern !== pattern);
  const next = selected.value === 'inherit' ? others : [...others, { pattern, mode: selected.value }];
  if (panels.accessKind === 'dir') {
    const files = session.files.map(file => file.path).filter(path => path.startsWith(panels.accessPath + '/'));
    return `保存后影响目录内 ${files.length} 个文件。更具体的规则仍然优先。当前文件示例：${files[0] ? MODE_LABELS[resolveAccess(next, files[0]).mode] : '目录为空'}`;
  }
  const access = resolveAccess(next, panels.accessPath);
  return `保存后：${MODE_LABELS[next.length ? access.mode : 'open']}`;
}
</script>

<template>
  <Dialog :open="panels.access" title="访问设置" @update:open="open => panels.access = open">
    <p class="mb-1 text-sm">{{ panels.accessKind === 'dir' ? '目录' : '文件' }}：{{ panels.accessPath }}</p>
    <p v-if="currentAccess" class="mb-3 text-xs text-muted">当前生效：{{ MODE_LABELS[currentAccess.mode] }}<span v-if="currentAccess.rule">（规则 {{ currentAccess.rule.pattern }}:{{ currentAccess.rule.mode }}）</span></p>
    <label v-for="choice in choices" :key="choice.id" class="mb-2 flex gap-2 rounded-lg border border-border p-2">
      <input v-model="selected" type="radio" name="access-mode" :value="choice.id" :disabled="session.readonly || session.info?.access?.kvAvailable === false" />
      <span>{{ choice.name }}</span>
    </label>
    <p class="mb-3 text-xs text-muted">{{ preview() }}</p>
    <div class="flex justify-between gap-2">
      <Button @click="panels.rules = true">管理全部规则…</Button>
      <Button variant="primary" :disabled="session.readonly || session.info?.access?.kvAvailable === false" @click="saveOne">保存</Button>
    </div>
  </Dialog>
  <Dialog :open="panels.rules" title="文件访问规则" wide @update:open="open => panels.rules = open">
    <p v-if="!rules.length" class="mb-3 rounded-lg bg-background p-3 text-sm text-muted">还没有规则：此时令牌可访问任意文件，没有免令牌直链。</p>
    <div v-for="(rule, index) in rules" :key="index" class="mb-2 flex flex-wrap items-center gap-1.5 sm:flex-nowrap sm:gap-2">
      <input v-model="rule.pattern" class="min-w-0 flex-1 rounded-lg border border-border px-2.5 py-1.5 font-mono text-xs sm:text-sm" :disabled="!editable()" placeholder="clash/ 或 docs/*.md" />
      <select v-model="rule.mode" class="h-8.5 rounded-lg border border-border bg-white px-2 text-xs sm:text-sm" :disabled="!editable()">
        <option value="direct">免令牌直链</option>
        <option value="token">仅令牌访问</option>
        <option value="deny">禁止访问</option>
      </select>
      <Button size="sm" variant="danger" class="h-8.5 px-2.5" :disabled="!editable()" @click="rules = rules.filter((_, item) => item !== index)">✕</Button>
    </div>
    <div class="mt-4 flex flex-wrap justify-between gap-2">
      <Button variant="secondary" :disabled="!editable()" @click="rules = [...rules, { pattern: '', mode: 'token' }]">＋ 添加规则</Button>
      <Button variant="primary" :disabled="!editable()" @click="saveRules">保存规则</Button>
    </div>
  </Dialog>
</template>
