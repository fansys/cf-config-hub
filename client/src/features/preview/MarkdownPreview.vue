<script setup lang="ts">
import { renderMarkdown } from '@shared/markdown.js';
import { onMounted, ref, watch } from 'vue';

const props = defineProps<{ text: string }>();
const host = ref<HTMLElement | null>(null);

function draw() {
  if (!host.value) return;
  host.value.replaceChildren(renderMarkdown(props.text));
}

onMounted(draw);
watch(() => props.text, draw);
</script>

<template>
  <div ref="host" class="prose-preview h-full overflow-auto bg-white p-4 text-sm leading-6" />
</template>
