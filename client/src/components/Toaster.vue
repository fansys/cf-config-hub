<script setup lang="ts">
import { toasts } from '@/lib/toast';
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 left-1/2 z-[80] flex w-[min(360px,calc(100%-1.5rem))] -translate-x-1/2 flex-col gap-2 sm:left-auto sm:right-4 sm:translate-x-0">
    <div v-for="item in toasts" :key="item.id" class="pointer-events-auto rounded-xl bg-slate-900/95 px-3.5 py-2.5 text-sm text-white shadow-xl backdrop-blur-xs">
      {{ item.msg }}
    </div>
  </div>
</template>
