/** 文件链接：直接链接 + 带令牌链接（弹窗），以及"链接解析"。 */
import { request } from '../api.js';
import { MODE_LABELS, resolveAccess, ruleSnippets } from '../access.js';
import { state, fileFullPath } from '../state.js';
import { $, encPath, isValidPath, makeEl, toast } from '../util.js';
import { openFile } from './editor.js';
import { openAccessDialog, showAccessEditor } from './access.js';
import { askConfirm, askInput, openModal } from './modal.js';

/** 编辑器里"获取文件链接"按钮的可用状态。 */
export function renderLinks() {
  const btn = $('linksBtn');
  if (btn) btn.disabled = !state.current;
}

/* ============================================================
 *  直接链接
 * ============================================================ */

/** 当前是否在非默认分支上：Worker 链接需要带 ?b=<分支>。 */
const branchParam = () => (state.info.branch !== state.info.defaults?.branch ? `b=${encodeURIComponent(state.info.branch)}` : '');
const withQuery = (url, ...q) => { const all = q.filter(Boolean).join('&'); return all ? `${url}${url.includes('?') ? '&' : '?'}${all}` : url; };

function directLinks() {
  const rel = state.current.path;
  const p = encPath(fileFullPath(rel));
  const owner = encodeURIComponent(state.info.owner);
  const repo = encodeURIComponent(state.info.repo);
  const branch = encodeURIComponent(state.info.branch);
  const rev = state.commitSha;
  const worker = withQuery(location.origin + '/file/' + encPath(rel), branchParam());
  const isPrivate = !!state.info.private;
  const access = resolveAccess(state.info.access?.rules, rel);
  const isDirect = access.direct;
  const sha = state.current.sha;

  const items = [
    { title: 'GitHub 直链', hint: '公开仓库可直接访问', url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`, needs: 'public' },
    { title: 'jsDelivr · 分支 CDN', hint: '带缓存加速，更新有延迟', url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${p}`, needs: 'public' },
    { title: 'jsDelivr · 固定版本', hint: '不可变的固定 commit 版本', url: rev ? `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${rev}/${p}` : '', needs: 'public' },
    {
      title: isPrivate ? 'Worker 直链（免令牌）' : 'Worker 稳定链接',
      hint: isPrivate ? '仅路径命中 DIRECT_PATHS 规则的私有文件可用' : '统一代理，短时缓存',
      url: worker, needs: isPrivate ? 'direct' : 'worker',
    },
    { title: 'Worker 固定版本', hint: 'Worker 固定 commit', url: rev ? withQuery(worker, `v=${rev}`) : '', needs: isPrivate ? 'direct' : 'worker' },
  ];
  return items.map(item => {
    let reason = '';
    if (!sha) reason = '请先保存文件';
    else if (!item.url) reason = '暂未获取 Commit SHA';
    else if (item.needs === 'public' && isPrivate) reason = '私有仓库不可用，请使用下方的令牌链接';
    else if (item.needs !== 'public' && !state.info.publicFiles) reason = '公开文件代理已关闭';
    else if (item.needs === 'direct' && !isDirect) reason = access.mode === 'deny' ? '该文件被 DIRECT_PATHS 规则禁止访问' : '该文件未设为免令牌直链（见下方「访问策略」）';
    return { ...item, reason };
  });
}

function linkCard(title, hint, url, reason = '') {
  const enabled = !reason && !!url;
  const copy = makeEl('button', '', '复制');
  copy.type = 'button';
  copy.disabled = !enabled;
  copy.addEventListener('click', () => copyText(url));
  const open = makeEl('a', '', '打开');
  if (enabled) Object.assign(open, { href: url, target: '_blank', rel: 'noopener noreferrer' });
  else open.style.opacity = '.4';
  const actions = makeEl('div', 'link-actions');
  actions.append(copy, open);
  const top = makeEl('div', 'link-top');
  top.append(makeEl('span', 'link-title', title), actions);
  const card = makeEl('article', 'link-card');
  card.append(top, makeEl('p', 'link-hint', reason || hint), makeEl('div', 'link-url', url || '—'));
  return card;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { toast('浏览器未授权复制，请选中文本手动复制'); }
}

/* ============================================================
 *  访问策略（DIRECT_PATHS）
 * ============================================================ */

function policySection() {
  const rel = state.current.path;
  const access = resolveAccess(state.info.access?.rules, rel);
  const box = makeEl('div', 'policy-box');
  const status = makeEl('div', 'policy-status');
  status.append(makeEl('strong', '', '访问策略：'), `${MODE_LABELS[access.mode]}${access.rule ? `（规则 ${access.rule.pattern}:${access.rule.mode}）` : ''}`);
  box.classList.toggle('bad', access.mode === 'none' || access.mode === 'deny');
  box.append(status);

  const acc = state.info.access || {};
  const where = acc.source === 'none' ? `分支 ${state.info.branch} 还没有自己的规则（默认分支的规则不适用于它）` : acc.source === 'kv' ? '规则保存在 KV' : acc.kvAvailable ? '规则来自环境变量 DIRECT_PATHS（可在编辑器里改存 KV）' : '规则来自环境变量 DIRECT_PATHS（未绑定 KV，只读）';
  const hint = makeEl('p', 'muted small-text',
    `${where}。配置任何规则后即为白名单；多条规则同时命中时，以最具体的一条为准。`);
  const edit = makeEl('button', 'btn small', state.readonly ? '查看访问设置' : '设置此文件…');
  edit.type = 'button';
  edit.addEventListener('click', () => openAccessDialog(rel, 'file'));
  void showAccessEditor;
  const row = makeEl('div', 'chip-row');
  for (const sn of ruleSnippets(rel)) {
    const b = makeEl('button', 'chip', sn.label);
    b.type = 'button';
    b.title = `复制规则：${sn.text}`;
    b.addEventListener('click', () => copyText(sn.text));
    row.append(b);
  }
  const top = makeEl('div', 'field-inline');
  top.append(hint, edit);
  box.append(top, row);
  return box;
}

/* ============================================================
 *  令牌链接：<10 位 hex><6 位到期分钟>，撤销 = 文件版本 +1
 * ============================================================ */

const DAY = 86400;
const EXPIRY = [
  { label: '1 天', sec: DAY }, { label: '7 天', sec: 7 * DAY }, { label: '30 天', sec: 30 * DAY },
  { label: '180 天', sec: 180 * DAY }, { label: '1 年', sec: 365 * DAY }, { label: '永久', sec: null },
];
const SCOPES = [
  { id: 'file', label: '仅此文件' },
  { id: 'dir', label: '同目录下的全部文件（批量）' },
  { id: 'tree', label: '此目录及子目录的全部文件（批量）' },
];
const MAX_BATCH = 100;

const fmtDate = ms => (ms ? new Date(ms).toLocaleString() : '永久有效');

/** 按范围从当前文件列表里取出要生成链接的文件。 */
function scopeFiles(scope, rel) {
  if (scope === 'file') return [rel];
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const prefix = dir ? `${dir}/` : '';
  return state.files
    .map(f => f.path)
    .filter(p => p.startsWith(prefix) && (scope === 'tree' || !p.slice(prefix.length).includes('/')));
}

/** 按 DIRECT_PATHS 策略拆成"可生成"与"未开放"两组。 */
function splitByPolicy(paths) {
  const rules = state.info.access?.rules;
  const allowed = [], blocked = [];
  for (const p of paths) (resolveAccess(rules, p).token ? allowed : blocked).push(p);
  return { allowed, blocked };
}

const urlsFor = (token, path) => ({
  route: withQuery(`${location.origin}/t/${token}/${encPath(path)}`, branchParam()),
  query: withQuery(`${location.origin}/file/${encPath(path)}`, `token=${token}`, branchParam()),
});

function tokenSection() {
  const box = makeEl('div');
  const rel = state.current.path;
  const field = (name, ...kids) => { const r = makeEl('div', 'field-row'); r.append(makeEl('label', '', name), ...kids); return r; };

  if (state.readonly) box.append(makeEl('p', 'muted small-text', '当前口令为只读，不能生成或撤销令牌链接，只能检查已有链接。'));
  else if (!state.current.sha) box.append(makeEl('p', 'muted small-text', '请先保存文件，再生成令牌链接。'));
  const canIssue = !state.readonly && !!state.current.sha;

  const scopeSel = makeEl('select', 'sel');
  SCOPES.forEach(s => scopeSel.append(Object.assign(makeEl('option', '', s.label), { value: s.id })));
  const preview = makeEl('div', 'muted small-text');
  const updatePreview = () => {
    const { allowed, blocked } = splitByPolicy(scopeFiles(scopeSel.value, rel));
    const n = allowed.length;
    preview.textContent = n > MAX_BATCH ? `共 ${n} 个文件，超过单次上限 ${MAX_BATCH}` : `将为 ${n} 个文件各生成一条链接（令牌只对各自的文件有效）`;
    if (blocked.length) preview.textContent += `；另有 ${blocked.length} 个文件未开放令牌访问，已跳过`;
  };
  scopeSel.addEventListener('change', updatePreview);
  updatePreview();

  let expiry = EXPIRY[1].sec; // 默认 7 天
  const customDays = Object.assign(makeEl('input', 'dialog-field chip-input'), { type: 'number', min: 1, max: 365, placeholder: '天数' });
  const chipBtns = EXPIRY.map(e => {
    const b = makeEl('button', 'chip' + (e.sec === expiry ? ' active' : ''), e.label);
    b.type = 'button';
    b.addEventListener('click', () => { expiry = e.sec; customDays.value = ''; chipBtns.forEach(x => x.classList.toggle('active', x === b)); });
    return b;
  });
  customDays.addEventListener('input', () => {
    const n = Number(customDays.value);
    if (n >= 1 && n <= 365) { expiry = Math.floor(n) * DAY; chipBtns.forEach(x => x.classList.remove('active')); }
  });
  const chips = makeEl('div', 'chip-row');
  chips.append(...chipBtns, customDays, makeEl('span', 'muted small-text', '天（1–365）'));

  const result = makeEl('div');
  const go = makeEl('button', 'btn primary', '生成令牌链接');
  go.disabled = !canIssue;
  go.addEventListener('click', async () => {
    const paths = splitByPolicy(scopeFiles(scopeSel.value, rel)).allowed;
    if (!paths.length || paths.length > MAX_BATCH) return toast(paths.length ? `一次最多 ${MAX_BATCH} 个文件` : '没有可生成的文件');
    go.disabled = true;
    try {
      showResult(result, await request('/api/links', 'POST', { paths, expiresIn: expiry }));
    } catch (e) { toast('生成失败：' + e.message); }
    go.disabled = false;
  });
  box.append(field('生成范围', scopeSel, preview), field('有效期', chips), go, result);

  /* ---- 撤销（更新文件版本） ---- */
  const verText = makeEl('div', 'muted small-text', '读取版本中…');
  const refreshVersion = async () => {
    try {
      const v = await request('/api/links/versions?path=' + encodeURIComponent(rel));
      verText.textContent = `当前文件${v.branch ? `（分支 ${v.branch}）` : ''}的链接版本：v${v.version}（全局偏移 ${v.global}）。撤销会把版本号 +1，旧令牌按新版本重算后即失效；之后重新生成的链接才可用。`;
    } catch (e) { verText.textContent = '读取版本失败：' + e.message; }
  };
  refreshVersion();
  const revoke = async (all) => {
    const ok = await askConfirm({
      title: all ? '撤销全部文件的链接' : '撤销此文件的链接', okText: '撤销', danger: true,
      message: all ? '所有文件已发出的令牌链接都会失效，需要重新生成并分发。' : `「${rel}」已发出的令牌链接都会失效，需要重新生成并分发。`,
    });
    if (!ok) return;
    try {
      await request('/api/links/revoke', 'POST', all ? { all: true } : { path: rel });
      toast('已撤销，旧链接最迟在版本缓存到期后全部失效');
      result.replaceChildren();
      refreshVersion();
    } catch (e) { toast('撤销失败：' + e.message); }
  };
  const revokeOne = makeEl('button', 'btn small danger-solid write-only', '撤销此文件的链接');
  const revokeAll = makeEl('button', 'btn small write-only', '撤销全部文件的链接');
  revokeOne.disabled = revokeAll.disabled = !canIssue;
  revokeOne.addEventListener('click', () => revoke(false));
  revokeAll.addEventListener('click', () => revoke(true));
  const revokeRow = makeEl('div', 'field-inline');
  revokeRow.append(revokeOne, revokeAll);
  box.append(makeEl('hr'), field('撤销', verText, revokeRow));

  /* ---- 检查令牌 ---- */
  const check = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', placeholder: '粘贴令牌或完整链接（检查它对「' + rel + '」是否有效）' });
  const checkBtn = makeEl('button', 'btn small', '检查');
  const checkOut = makeEl('div', 'muted small-text');
  checkBtn.addEventListener('click', async () => {
    let raw = check.value.trim();
    let path = rel;
    const m = raw.match(/\/t\/([0-9a-f]{10}\d{6})\/(.+?)(?:\?.*)?$/);
    if (m) { raw = m[1]; try { path = decodeURIComponent(m[2]); } catch { /* 保持默认 */ } }
    else { const q = raw.match(/[?&]token=([0-9a-f]{10}\d{6})/); if (q) raw = q[1]; }
    if (!raw) return;
    try {
      const r = await request(`/api/links/inspect?path=${encodeURIComponent(path)}&token=${encodeURIComponent(raw)}`);
      const names = { valid: '✓ 有效', expired: '✗ 已过期', revoked: `✗ 已撤销（令牌版本 v${r.version}，当前 v${r.currentVersion}）`, invalid: '✗ 无效（伪造、文件不符，或不是本站签发）', malformed: '✗ 格式不正确（应为 16 位：10 位 hex + 6 位数字）' };
      checkOut.textContent = `${names[r.status]} · ${path}${r.status === 'valid' || r.status === 'expired' ? ' · ' + fmtDate(r.expiresAt) : ''}`;
    } catch (e) { checkOut.textContent = '检查失败：' + e.message; }
  });
  const checkRow = makeEl('div', 'field-inline');
  checkRow.append(check, checkBtn);
  box.append(field('检查令牌', checkRow, checkOut));
  return box;
}

function showResult(host, r) {
  const summary = makeEl('p', 'diff-stat', `✓ 已生成 ${r.links.length} 条 · ${fmtDate(r.expiresAt)}`);
  if (r.links.length === 1) {
    const { token, path } = r.links[0];
    const u = urlsFor(token, path);
    host.replaceChildren(summary,
      linkCard('路径式链接（推荐）', '令牌在路径中，适合订阅类客户端', u.route),
      linkCard('查询参数式链接', '令牌在 ?token= 参数里', u.query),
      linkCard('令牌', `16 位：${token.slice(0, 10)}（签名）+ ${token.slice(10)}（到期分钟，000000 = 永久）`, token));
    return;
  }
  // 批量：每行「文件路径<TAB>链接」，便于整体复制
  const lines = r.links.map(l => `${urlsFor(l.token, l.path).route}`);
  const area = Object.assign(makeEl('textarea', 'dialog-field dialog-textarea'), { readOnly: true, rows: 8, value: lines.join('\n') });
  const copyAll = makeEl('button', 'btn small', '复制全部链接');
  copyAll.addEventListener('click', () => copyText(lines.join('\n')));
  const copyCsv = makeEl('button', 'btn small', '复制「文件 + 链接」对照表');
  copyCsv.addEventListener('click', () => copyText(r.links.map(l => `${l.path}\t${urlsFor(l.token, l.path).route}`).join('\n')));
  const row = makeEl('div', 'field-inline');
  row.append(copyAll, copyCsv);
  host.replaceChildren(summary, area, row);
}

/* ============================================================
 *  入口：点击按钮弹窗
 * ============================================================ */

export function showLinks() {
  if (!state.current || !state.info) return;
  const body = makeEl('div');
  const isPrivate = !!state.info.private;

  if (isPrivate) {
    body.append(makeEl('div', 'notice', '私有仓库：GitHub Raw 和 jsDelivr 无法访问。请使用下方的「令牌链接」分享；也可以在 DIRECT_PATHS 中配置少量允许免令牌访问的路径。'));
  }
  body.append(policySection(), makeEl('h4', '', '直接链接'));
  const list = makeEl('div', 'link-list');
  for (const it of directLinks()) list.append(linkCard(it.title, it.hint, it.url, it.reason));
  body.append(list, makeEl('hr'), makeEl('h4', '', '令牌链接'),
    makeEl('p', 'muted small-text', '令牌 = 10 位签名 + 6 位到期分钟，签名由「文件名 + 文件版本 + 到期分钟」计算，无需数据库；撤销时提升文件版本即可。私有仓库的文件也能通过它分享。'),
    tokenSection());
  openModal(`文件链接 · ${state.current.path}${branchParam() ? ` · 分支 ${state.info.branch}` : ''}`, body, { wide: true });
}

export function extractPathFromLink(input, info, origin) {
  const u = new URL(input.trim());
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const { owner, repo, branch, root } = info;
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  let path = '';
  if (eq(u.hostname, 'github.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === 'blob' && seg[3] === branch) {
    path = seg.slice(4).join('/');
  } else if (eq(u.hostname, 'raw.githubusercontent.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === branch) {
    path = seg.slice(3).join('/');
  } else if (eq(u.hostname, 'cdn.jsdelivr.net') && seg[0] === 'gh' && eq(seg[1], owner) && seg[2]?.startsWith(repo + '@')) {
    if (seg[2].slice(repo.length + 1) === branch) path = seg.slice(3).join('/');
  } else if (u.origin === origin && (seg[0] === 'file' || seg[0] === 't')) {
    // Worker 链接（含 /t/<令牌>/ 形式）已省略 ROOT_DIR，无需再裁剪
    return seg.slice(seg[0] === 't' ? 2 : 1).join('/');
  }
  if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
  return path;
}

export async function parseGitHubLink() {
  const input = await askInput({ title: '链接解析', message: '粘贴本仓库的 GitHub 文件、Raw、jsDelivr 或 Worker 链接：', placeholder: 'https://…', okText: '定位文件' });
  if (!input) return;
  try {
    const path = extractPathFromLink(input, state.info, location.origin);
    if (!path || !isValidPath(path)) throw new Error('链接不属于当前管理仓库或分支');
    const file = state.files.find(f => f.path === path);
    if (!file) throw new Error('找不到对应文件，请先刷新文件列表');
    openFile(file.path);
  } catch (e) { toast('解析失败：' + e.message); }
}
