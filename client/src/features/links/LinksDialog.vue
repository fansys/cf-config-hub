<script setup lang="ts">
import { MODE_LABELS, resolveAccess, ruleSnippets } from '@shared/access.js';
import { formatTokenExpiry } from '@shared/tokenexpiry.js';
import { encPath } from '@shared/text.js';
import { computed, ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { request } from '@/lib/api';
import { askConfirm } from '@/lib/dialogs';
import { copyText, toast } from '@/lib/toast';
import { useSession } from '@/stores/session';
import { panels } from '@/features/shell/panels';

const focusPath = () => panels.linkPath || session.current?.path || '';
const focusIsDir = () => panels.linkScope === 'dir';

const session = useSession();
const scope = ref('file');
const expiry = ref<number | null>(7 * 86400);
const customDays = ref('');
const result = ref<any>(null);
const issuedLoading = ref(false);
const versionText = ref('');
const checkValue = ref('');
const checkOut = ref('');
const busy = ref(false);
const DAY = 86400;
const choices = [
  { label: '1 天', sec: DAY }, { label: '7 天', sec: 7 * DAY }, { label: '30 天', sec: 30 * DAY },
  { label: '180 天', sec: 180 * DAY }, { label: '1 年', sec: 365 * DAY }, { label: '永久', sec: null },
];

const branchParam = () => (session.info?.branch !== session.info?.defaults?.branch ? `b=${encodeURIComponent(session.info.branch)}` : '');
function withQuery(url: string, ...query: string[]) {
  const all = query.filter(Boolean).join('&');
  return all ? `${url}${url.includes('?') ? '&' : '?'}${all}` : url;
}
function scopeFiles() {
  const rel = focusPath();
  if (!focusIsDir() && scope.value === 'file') return rel ? [rel] : [];
  const base = focusIsDir() ? rel : (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const prefix = base ? `${base}/` : '';
  const deep = focusIsDir() ? scope.value !== 'dir' : scope.value === 'tree';
  return session.files.map(file => file.path).filter(path => path.startsWith(prefix) && (deep || !path.slice(prefix.length).includes('/')));
}
const split = computed(() => {
  const ready: string[] = [];
  const closed: string[] = [];
  const denied: string[] = [];
  for (const path of scopeFiles()) {
    if (!path) continue;
    const access = resolveAccess(session.info?.access?.rules || [], path);
    if (access.mode === 'deny') denied.push(path);
    else if (access.token) ready.push(path);
    else closed.push(path);
  }
  return { ready, closed, denied };
});
const direct = computed(() => {
  if (!focusPath() || !session.info || focusIsDir()) return [];
  const rel = focusPath();
  const full = encPath(session.fileFullPath(rel));
  const owner = encodeURIComponent(session.info.owner);
  const repo = encodeURIComponent(session.info.repo);
  const branch = encodeURIComponent(session.info.branch);
  const worker = withQuery(`${location.origin}/file/${encPath(rel)}`, branchParam());
  const access = resolveAccess(session.info.access?.rules || [], rel);
  const isPrivate = !!session.info.private;
  const items = [
    { title: 'GitHub 直链', hint: '公开仓库可直接访问', url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${full}`, needs: 'public' },
    { title: 'jsDelivr · 分支 CDN', hint: '带缓存加速，更新有延迟', url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${full}`, needs: 'public' },
    { title: 'jsDelivr · 固定版本', hint: '不可变的固定 commit 版本', url: session.commitSha ? `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${session.commitSha}/${full}` : '', needs: 'public' },
    { title: isPrivate ? 'Worker 直链（免令牌）' : 'Worker 稳定链接', hint: isPrivate ? '仅路径命中免令牌规则的私有文件可用' : '统一代理，短时缓存', url: worker, needs: isPrivate ? 'direct' : 'worker' },
    { title: 'Worker 固定版本', hint: 'Worker 固定 commit', url: session.commitSha ? withQuery(worker, `v=${session.commitSha}`) : '', needs: isPrivate ? 'direct' : 'worker' },
  ];
  return items.flatMap(item => {
    if (!session.files.some(file => file.path === rel) || !item.url) return [];
    if (item.needs === 'public' && isPrivate) return [];
    if (item.needs !== 'public' && !session.info.publicFiles) return [];
    if (item.needs === 'direct' && !access.direct) return [];
    return [item];
  });
});
const access = computed(() => focusPath() ? resolveAccess(session.info?.access?.rules || [], focusIsDir() ? `${focusPath()}/\0` : focusPath()) : null);

async function loadVersion() {
  const rel = focusPath();
  if (!rel || focusIsDir()) return;
  try {
    const version = await request('/api/links/versions?path=' + encodeURIComponent(rel));
    versionText.value = `当前文件${version.branch ? `（分支 ${version.branch}）` : ''}的链接版本：v${version.version}（全局偏移 ${version.global}）。`;
  } catch (error) {
    versionText.value = '读取版本失败：' + (error as Error).message;
  }
}

async function loadIssued() {
  const rel = focusPath();
  if (!rel) return;
  issuedLoading.value = true;
  try {
    const data = await request('/api/links/issued?path=' + encodeURIComponent(rel) + (focusIsDir() ? '&prefix=1' : ''));
    if (data.links?.length) result.value = { links: data.links, saved: true };
  } catch { /* 没有保存过的令牌时留空 */ }
  finally { issuedLoading.value = false; }
}

watch(() => panels.links, (open) => {
  if (!open) return;
  scope.value = focusIsDir() ? 'tree' : 'file';
  result.value = null;
  loadVersion();
  loadIssued();
}, { immediate: true });

function tokenPattern() {
  const rel = focusPath();
  if (focusIsDir()) return rel ? `${rel}/**` : '**';
  if (scope.value === 'file') return rel;
  const slash = rel.lastIndexOf('/');
  return slash < 0 ? '**' : `${rel.slice(0, slash)}/**`;
}

function rememberAccess(saved: { rules?: unknown }) {
  if (!saved?.rules || !session.info) return;
  session.info = { ...session.info, access: { ...(session.info.access || {}), ...saved, rules: saved.rules } };
}

async function createLinks() {
  if (split.value.denied.length && !split.value.ready.length && !split.value.closed.length) {
    return toast('这些文件已被禁止访问，请先在文件树里把规则改成仅令牌');
  }
  let rules = session.info?.access?.rules || [];
  if (split.value.closed.length) {
    try {
      const saved = await request('/api/access/set', 'POST', { pattern: tokenPattern(), mode: 'token' });
      rememberAccess(saved);
      rules = saved.rules || rules;
    } catch (error) {
      toast('设置失败：' + (error as Error).message);
      return;
    }
  }
  const paths = scopeFiles().filter(path => path && resolveAccess(rules, path).token);
  if (!paths.length) return toast('这些文件已被禁止访问，请先在文件树里把规则改成仅令牌');
  if (paths.length > 100) return toast('一次最多 100 个文件');
  busy.value = true;
  try { result.value = await request('/api/links', 'POST', { paths, expiresIn: expiry.value }); }
  catch (error) { toast('生成失败：' + (error as Error).message); }
  busy.value = false;
}

function urlsFor(token: string, path: string) {
  return {
    route: withQuery(`${location.origin}/t/${token}/${encPath(path)}`, branchParam()),
    query: withQuery(`${location.origin}/file/${encPath(path)}`, `token=${token}`, branchParam()),
  };
}

const issued = computed(() => {
  const raw = result.value?.links || [];
  const sameFile = raw.length > 0 && raw.every((link: { path: string }) => link.path === raw[0].path);
  const links = sameFile ? raw.slice(0, 1) : raw;
  if (!sameFile) {
    return {
      groups: [] as { key: string; expires: string; cards: { title: string; hint: string; url: string }[] }[],
      rows: links.map((link: { token: string; path: string }) => ({ path: link.path, url: urlsFor(link.token, link.path).route, expires: formatTokenExpiry(link.token) })),
    };
  }
  return {
    groups: links.map((link: { token: string; path: string }) => {
      const urls = urlsFor(link.token, link.path);
      const expires = formatTokenExpiry(link.token);
      return {
        key: link.token,
        expires,
        cards: [
          { title: '路径式链接', hint: `令牌在路径中，适合订阅客户端 · ${expires}`, url: urls.route },
          { title: '查询参数链接', hint: `令牌放在 ?token= 里 · ${expires}`, url: urls.query },
          { title: '令牌', hint: expires, url: link.token },
        ],
      };
    }),
    rows: [] as { path: string; url: string; expires: string }[],
  };
});

async function revoke(all: boolean) {
  const rel = focusPath();
  if (!rel) return;
  if (!await askConfirm({
    title: all ? '撤销全部文件的链接' : '撤销此文件的链接',
    okText: '撤销',
    danger: true,
    message: all ? '所有文件已发出的令牌链接都会失效，需要重新生成并分发。' : `「${rel}」已发出的令牌链接都会失效，需要重新生成并分发。`,
  })) return;
  try {
    await request('/api/links/revoke', 'POST', all ? { all: true } : { path: rel });
    toast('已撤销，旧链接最迟在版本缓存到期后全部失效');
    result.value = null;
    loadVersion();
  } catch (error) { toast('撤销失败：' + (error as Error).message); }
}

async function inspect() {
  let raw = checkValue.value.trim();
  let path = focusPath();
  const matched = raw.match(/\/t\/([0-9a-f]{10}\d{6})\/(.+?)(?:\?.*)?$/);
  if (matched) {
    raw = matched[1];
    try { path = decodeURIComponent(matched[2]); } catch { /* 保持当前文件 */ }
  } else {
    const query = raw.match(/[?&]token=([0-9a-f]{10}\d{6})/);
    if (query) raw = query[1];
  }
  if (!raw) return;
  try {
    const report = await request(`/api/links/inspect?path=${encodeURIComponent(path)}&token=${encodeURIComponent(raw)}`);
    const names: Record<string, string> = {
      valid: '✓ 有效', expired: '✗ 已过期', revoked: `✗ 已撤销（令牌版本 v${report.version}，当前 v${report.currentVersion}）`,
      invalid: '✗ 无效（伪造、文件不符，或不是本站签发）', malformed: '✗ 格式不正确（应为 16 位：10 位 hex + 6 位数字）',
    };
    checkOut.value = `${names[report.status] || report.status} · ${path}`;
  } catch (error) { checkOut.value = '检查失败：' + (error as Error).message; }
}
</script>

<template>
  <Dialog :open="panels.links" :title="`文件链接 · ${focusPath()}`" wide @update:open="open => panels.links = open">
    <p v-if="session.info?.private" class="mb-3 rounded-lg bg-amber-50 p-2 text-sm">私有仓库：GitHub Raw 和 jsDelivr 无法访问。请使用令牌链接。</p>
    <p v-if="access" class="mb-3 text-sm">访问策略：{{ MODE_LABELS[access.mode] }}<span v-if="access.rule">（规则 {{ access.rule.pattern }}:{{ access.rule.mode }}）</span></p>
    <div class="mb-3 flex flex-wrap gap-2">
      <button v-for="item in ruleSnippets(focusPath())" :key="item.text" class="rounded-full bg-background px-2 py-1 text-xs" type="button" @click="copyText(item.text)">{{ item.label }}</button>
      <Button size="sm" @click="panels.rules = true">管理访问规则…</Button>
    </div>
    <div v-if="direct.length" class="grid gap-2 md:grid-cols-2">
      <article v-for="item in direct" :key="item.title" class="rounded-xl border border-border p-3">
        <div class="flex items-start justify-between gap-3">
          <div>
            <strong class="text-sm">{{ item.title }}</strong>
            <p class="text-xs text-muted">{{ item.hint }}</p>
          </div>
          <Button size="sm" class="shrink-0" @click="copyText(item.url)">复制</Button>
        </div>
        <p class="mt-2 break-all rounded-lg bg-background p-2 font-mono text-xs leading-5">{{ item.url }}</p>
      </article>
    </div>
    <h3 class="mb-2 mt-4 font-semibold">令牌链接</h3>
    <div v-if="result?.links?.length" class="mb-4 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm font-medium">{{ result.saved ? '已保存的令牌' : '已生成' }} {{ result.links.length }} 条</p>
        <Button v-if="issued.rows.length" size="sm" @click="copyText(issued.rows.map((row: { url: string }) => row.url).join('\n'))">复制全部链接</Button>
      </div>
      <section v-for="group in issued.groups" :key="group.key" class="space-y-2">
        <p class="text-xs font-medium text-muted">{{ group.expires }}</p>
        <article v-for="card in group.cards" :key="group.key + card.title" class="rounded-xl border border-border p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <strong class="text-sm">{{ card.title }}</strong>
              <p class="text-xs text-muted">{{ card.hint }}</p>
            </div>
            <Button size="sm" class="shrink-0" @click="copyText(card.url)">复制</Button>
          </div>
          <p class="mt-2 break-all rounded-lg bg-background p-2 font-mono text-xs leading-5">{{ card.url }}</p>
        </article>
      </section>
      <div v-if="issued.rows.length" class="max-h-64 space-y-2 overflow-auto">
        <article v-for="row in issued.rows" :key="row.path" class="rounded-xl border border-border p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0"><strong class="block truncate text-sm">{{ row.path }}</strong><span class="text-xs text-muted">{{ row.expires }}</span></div>
            <Button size="sm" class="shrink-0" @click="copyText(row.url)">复制</Button>
          </div>
          <p class="mt-2 break-all rounded-lg bg-background p-2 font-mono text-xs leading-5">{{ row.url }}</p>
        </article>
      </div>
    </div>
    <p v-else-if="issuedLoading" class="mb-3 text-sm text-muted">正在读取已保存的令牌…</p>
    <p v-else class="mb-3 text-sm text-muted">还没有已保存的令牌。</p>
    <p v-if="session.readonly" class="text-sm text-muted">当前口令为只读，不能生成或撤销令牌链接，只能检查已有链接。</p>
    <p v-else-if="!scopeFiles().length" class="text-sm text-muted">请先保存文件，再生成令牌链接。</p>
    <label class="mb-2 block text-sm">生成范围
      <select v-model="scope" class="mt-1 w-full rounded-lg border border-border px-2 py-1">
        <option value="file">仅此文件</option>
        <option value="dir">同目录下的全部文件（批量）</option>
        <option value="tree">此目录及子目录的全部文件（批量）</option>
      </select>
    </label>
    <p class="mb-2 text-xs text-muted">将为 {{ split.ready.length + split.closed.length }} 个文件生成链接<span v-if="split.closed.length">，其中 {{ split.closed.length }} 个会先设为仅令牌</span><span v-if="split.denied.length">；{{ split.denied.length }} 个已禁止，会跳过</span></p>
    <div class="mb-3 flex flex-wrap items-center gap-1.5">
      <button v-for="choice in choices" :key="choice.label" type="button" class="rounded-full px-3 py-1 text-xs font-medium transition" :class="expiry === choice.sec && !customDays ? 'bg-primary text-white shadow-2xs' : 'bg-background text-foreground hover:bg-slate-200/70'" @click="expiry = choice.sec; customDays = ''">{{ choice.label }}</button>
      <input v-model="customDays" type="number" min="1" max="365" class="h-7 w-24 rounded-lg border border-border px-2.5 text-xs" placeholder="自定义天" @input="expiry = Math.min(365, Math.max(1, Number(customDays) || 1)) * DAY" />
    </div>
    <Button variant="primary" :disabled="session.readonly || !scopeFiles().length || busy" @click="createLinks">{{ result?.links?.length ? '重新生成' : '生成令牌链接' }}</Button>
    <p class="mt-4 text-xs text-muted">{{ versionText }}</p>
    <div v-if="!session.readonly" class="mt-2 flex flex-wrap gap-2">
      <Button size="sm" variant="danger" @click="revoke(false)">撤销此文件的链接</Button>
      <Button size="sm" variant="danger" @click="revoke(true)">撤销全部文件的链接</Button>
    </div>
    <div class="mt-4 flex flex-wrap gap-2 sm:flex-nowrap">
      <input v-model="checkValue" class="min-w-0 flex-1 rounded-lg border border-border px-3 py-1.5 text-sm" placeholder="粘贴令牌或完整链接进行检查…" />
      <Button variant="secondary" size="sm" class="h-9 px-3" @click="inspect">检查</Button>
    </div>
    <p class="mt-1.5 text-xs text-muted">{{ checkOut }}</p>
  </Dialog>
</template>
