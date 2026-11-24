<script setup lang="ts">
import { collapse, diffLines, diffStats } from '@shared/diff.js';
import { computed } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import { panels } from '@/features/shell/panels';

const rows = computed(() => panels.diff ? collapse(diffLines(panels.diff.oldText, panels.diff.newText), 3) : []);
const stats = computed(() => panels.diff ? diffStats(diffLines(panels.diff.oldText, panels.diff.newText)) : null);
</script>

<template>
  <Dialog :open="!!panels.diff" :title="panels.diff?.title || '差异'" wide @update:open="open => { if (!open) panels.diff = null }">
    <p v-if="stats && !stats.changed" class="text-sm text-muted">两个版本内容完全一致。</p>
    <p v-else-if="stats" class="mb-2.5 flex items-center gap-2 text-sm">
      <span class="rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">+{{ stats.add }}</span>
      <span class="rounded bg-red-50 px-2 py-0.5 font-medium text-danger">−{{ stats.del }}</span>
      <span class="text-muted">行变化</span>
    </p>
    <div class="max-h-[60dvh] overflow-auto rounded-xl border border-border font-mono text-xs">
      <div
        v-for="(row, idx) in rows"
        :key="idx"
        class="grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)] gap-1.5 border-b border-border/40 px-2 py-0.5 last:border-b-0 sm:grid-cols-[3rem_3rem_1rem_minmax(0,1fr)] sm:gap-2"
        :class="row.type === 'add' ? 'bg-emerald-50/80 text-emerald-950' : row.type === 'del' ? 'bg-red-50/80 text-red-950' : row.type === 'gap' ? 'bg-background/70 py-1 text-muted' : ''"
      >
        <template v-if="row.type === 'gap'">
          <span class="col-span-4">⋯ 省略 {{ row.count }} 行未变化内容</span>
        </template>
        <template v-else>
          <span class="select-none text-right text-muted">{{ row.a ?? '' }}</span>
          <span class="select-none text-right text-muted">{{ row.b ?? '' }}</span>
          <span class="select-none font-bold">{{ row.type === 'add' ? '+' : row.type === 'del' ? '−' : '' }}</span>
          <span class="break-all whitespace-pre-wrap">{{ row.text }}</span>
        </template>
      </div>
    </div>
  </Dialog>
</template>
