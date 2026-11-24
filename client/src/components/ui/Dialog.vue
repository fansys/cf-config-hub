<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { cn } from '@/lib/utils';

const open = defineModel<boolean>('open', { default: false });
withDefaults(defineProps<{ title: string; wide?: boolean; dismissable?: boolean }>(), { dismissable: true });

function block(event: Event, dismissable: boolean) {
  if (!dismissable) event.preventDefault();
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px]" />
      <DialogContent
        :class="cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-white shadow-2xl sm:inset-x-auto sm:top-[8vh] sm:bottom-auto sm:left-1/2 sm:max-h-[84dvh] sm:w-[min(560px,calc(100%-2rem))] sm:-translate-x-1/2 sm:rounded-2xl',
          wide && 'sm:w-[min(880px,calc(100%-2rem))]',
        )"
        @escape-key-down="block($event, dismissable)"
        @pointer-down-outside="block($event, dismissable)"
      >
        <div class="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-200 sm:hidden" />
        <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <DialogTitle class="min-w-0 truncate text-base font-semibold text-foreground">{{ title }}</DialogTitle>
          <DialogClose v-if="dismissable" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-background hover:text-foreground">✕</DialogClose>
        </div>
        <DialogDescription class="sr-only">{{ title }}</DialogDescription>
        <div class="safe-pb min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <slot />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
