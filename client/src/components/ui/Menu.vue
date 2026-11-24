<script setup lang="ts">
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui';

defineProps<{ label: string; items: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void }[] }>();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger :aria-label="label" class="inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-border bg-white px-2.5 text-sm font-medium text-foreground shadow-2xs transition hover:bg-background">
      <slot>{{ label }}</slot>
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="z-50 min-w-44 rounded-xl border border-border bg-white p-1.5 shadow-xl" :side-offset="6" align="end">
        <DropdownMenuItem
          v-for="item in items"
          :key="item.label"
          :disabled="item.disabled"
          :class="['cursor-pointer select-none rounded-lg px-3 py-2 text-sm outline-none transition data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-background', item.danger ? 'text-danger data-[highlighted]:bg-red-50' : 'text-foreground']"
          @select="item.onClick()"
        >
          {{ item.label }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
