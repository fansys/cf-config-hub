<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import DialogHost from '@/components/DialogHost.vue';
import Toaster from '@/components/Toaster.vue';
import LoginView from '@/features/auth/LoginView.vue';
import { setUnauthorizedHandler } from '@/lib/api';
import { toast } from '@/lib/toast';
import { tokenStore } from '@/lib/storage';
import { target } from '@/lib/storage';
import { panels } from '@/features/shell/panels';
import { useSession } from '@/stores/session';
import { RouterView } from 'vue-router';

const session = useSession();
const reauthToken = ref('');
const reauthBusy = ref(false);

function ready() {
  document.documentElement.classList.add('ready');
}

async function login(token: string, remember: boolean) {
  session.applyToken(token, remember);
  try {
    await Promise.all([session.loadContext(), session.refreshFiles()]);
  } catch (error: any) {
    if (error.status && error.status !== 401 && target.get().branch) {
      target.clear();
      await Promise.all([session.loadContext(), session.refreshFiles()]);
      toast('之前选择的分支不可用，已回到默认分支');
    } else throw error;
  }
  tokenStore.save(token, remember);
  document.documentElement.classList.toggle('has-token', remember);
  session.authed = true;
  ready();
  toast('已连接 GitHub 仓库');
}

async function submit(token: string, remember: boolean) {
  try { await login(token, remember); }
  catch (error) {
    session.applyToken('', false);
    toast('登录失败：' + (error as Error).message);
    ready();
  }
}

async function reauth() {
  const previous = session.token;
  reauthBusy.value = true;
  session.applyToken(reauthToken.value, session.remember);
  try {
    await session.refreshFiles();
    tokenStore.save(reauthToken.value, session.remember);
    panels.reauth = false;
    toast('已重新登录，可以继续操作');
  } catch (error: any) {
    session.applyToken(previous, session.remember);
    toast(error.status === 429 ? error.message : '口令不正确，请重试');
  } finally { reauthBusy.value = false; }
}

onMounted(async () => {
  setUnauthorizedHandler(() => {
    if (session.authed) panels.reauth = true;
  });
  const saved = tokenStore.load();
  if (!saved.token) { ready(); return; }
  try { await login(saved.token, saved.remember); }
  catch {
    session.logout();
    toast('登录态已失效，请重新输入口令');
    ready();
  }
});
</script>

<template>
  <LoginView v-if="!session.authed" @submit="submit" />
  <RouterView v-else />
  <DialogHost />
  <Toaster />
  <Dialog :open="panels.reauth" title="登录已失效" :dismissable="false" @update:open="() => {}">
    <p class="mb-3 text-sm text-muted">管理口令已失效或被更换。你的编辑内容仍保留在页面中，重新输入口令即可继续，无需刷新。</p>
    <form @submit.prevent="reauth">
      <input v-model="reauthToken" type="password" required placeholder="管理口令" class="mb-3 w-full rounded-lg border border-border px-3 py-2" />
      <div class="flex justify-end gap-2">
        <Button type="button" @click="panels.reauth = false; session.logout()">退出登录</Button>
        <Button variant="primary" :disabled="reauthBusy" type="submit">继续</Button>
      </div>
    </form>
  </Dialog>
</template>
