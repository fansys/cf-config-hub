import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: () => import('@/features/shell/AppShell.vue') }],
});

export function routePath() {
  const match = router.currentRoute.value.params.pathMatch;
  if (!match || (Array.isArray(match) && match.length === 0)) return null;
  const parts = Array.isArray(match) ? match : [match];
  try {
    return parts.map(part => decodeURIComponent(part)).join('/');
  } catch {
    return null;
  }
}

export function replacePath(path: string | null) {
  const target = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '/';
  if (router.currentRoute.value.fullPath === target) return;
  void router.replace(target);
}
