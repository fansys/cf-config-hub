<script setup lang="ts">
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import { useSession } from '@/stores/session';

const session = useSession();
const token = ref('');
const remember = ref(session.remember);
const busy = ref(false);
const emit = defineEmits<{ submit: [token: string, remember: boolean] }>();

async function submit() {
  busy.value = true;
  emit('submit', token.value, remember.value);
  busy.value = false;
}
</script>

<template>
  <section id="loginView" class="grid h-full place-items-center bg-gradient-to-b from-background to-slate-200/40 px-4">
    <form class="w-full max-w-sm rounded-3xl border border-border/80 bg-white p-6 shadow-xl sm:p-8" @submit.prevent="submit">
      <div class="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary text-lg font-bold text-white shadow-sm">{ }</div>
      <p class="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">GitHub Config Hub</p>
      <h1 class="mb-5 mt-0.5 text-xl font-semibold text-foreground sm:text-2xl">配置文件管理中心</h1>
      <label class="mb-1.5 block text-sm font-medium text-foreground" for="tokenInput">管理口令</label>
      <input id="tokenInput" v-model="token" type="password" required autocomplete="off" placeholder="请输入管理口令" class="mb-3.5 w-full rounded-xl border border-border px-3.5 py-2.5 text-sm" />
      <label class="mb-5 flex cursor-pointer select-none items-center gap-2 text-sm text-muted"><input id="rememberInput" v-model="remember" type="checkbox" class="size-4 accent-primary" /> 在本浏览器内保持登录</label>
      <Button id="loginButton" class="h-10 w-full rounded-xl" variant="primary" :disabled="busy" type="submit">进入管理中心</Button>
    </form>
  </section>
</template>
