<script setup lang="ts">
import { cn } from '@/lib/utils';

const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
}>(), { variant: 'ghost', size: 'md' });
</script>

<template>
  <button
    :class="cn(
      'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-transparent font-medium transition active:scale-[0.99] disabled:opacity-50',
      size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3 text-sm',
      variant === 'primary' && 'bg-primary text-white shadow-xs hover:brightness-95',
      variant === 'secondary' && 'border-border bg-white text-foreground shadow-2xs hover:bg-background',
      variant === 'ghost' && 'text-foreground hover:bg-white',
      variant === 'danger' && 'border-red-200 bg-red-50/60 text-danger hover:bg-red-100/70',
    )"
  >
    <slot />
  </button>
</template>
