/** 文件访问规则编辑器（规则保存在 Workers KV）：免令牌直链 / 仅令牌 / 禁止。 */
import { request } from '../api.js';
import { MODE_LABELS, resolveAccess } from '../access.js';
import { state } from '../state.js';
import { makeEl, toast } from '../util.js';
import { askConfirm, closeModal, openModal } from './modal.js';
import { renderFiles } from './files.js';
import { showLinks } from './links.js';
import { loadContext } from './session.js';

const MODES = [
  { id: 'direct', label: '免令牌直链' },
  { id: 'token', label: '仅令牌访问' },
  { id: 'deny', label: '禁止访问' },
];

const fmt = ms => (ms ? new Date(ms).toLocaleString() : '');

export async function showAccessEditor() {
  const body = makeEl('div', '', '加载中…');
  const other = state.info.branch !== state.info.defaults?.branch;
  openModal(`文件访问规则${other ? ` · 分支 ${state.info.branch}` : ''}`, body, { wide: true });

  let data;
  try { data = await request('/api/access'); }
  catch (e) { body.textContent = '加载失败：' + e.message; return; }

  const editable = data.kvAvailable && !state.readonly;
  const rules = data.rules.map(r => ({ ...r }));
  const list = makeEl('div');

  const preview = makeEl('div', 'muted small-text');
  const updatePreview = () => {
    if (!state.current) { preview.textContent = ''; return; }
    const a = resolveAccess(rules, state.current.path);
    preview.textContent = `按当前（未保存的）规则，「${state.current.path}」：${MODE_LABELS[rules.length ? a.mode : 'open']}`;
  };

  function render() {
    list.replaceChildren();
    if (!rules.length) list.append(makeEl('p', 'muted small-text', '还没有规则：此时令牌可访问任意文件，没有免令牌直链。添加任意一条规则后即变为白名单。'));
    rules.forEach((r, i) => {
      const row = makeEl('div', 'field-inline');
      row.style.marginBottom = '8px';
      const pattern = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', value: r.pattern, placeholder: '文件、目录/ 或通配，如 clash/ 、docs/*.md', disabled: !editable });
      pattern.addEventListener('input', () => { r.pattern = pattern.value; updatePreview(); });
      const mode = makeEl('select', 'sel');
      mode.style.maxWidth = '170px';
      MODES.forEach(m => mode.append(Object.assign(makeEl('option', '', m.label), { value: m.id })));
      mode.value = r.mode;
      mode.disabled = !editable;
      mode.addEventListener('change', () => { r.mode = mode.value; updatePreview(); });
      const del = makeEl('button', 'btn tiny danger', '✕');
      del.type = 'button';
      del.disabled = !editable;
      del.addEventListener('click', () => { rules.splice(i, 1); render(); });
      row.append(pattern, mode, del);
      list.append(row);
    });
    updatePreview();
  }
  render();

  const add = (pattern, mode = 'token') => { rules.push({ pattern, mode }); render(); };
  const addBtn = makeEl('button', 'btn small', '＋ 添加规则');
  addBtn.type = 'button';
  addBtn.disabled = !editable;
  addBtn.addEventListener('click', () => add(''));

  const quick = makeEl('div', 'chip-row');
  if (state.current && editable) {
    const rel = state.current.path;
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    for (const [label, pat] of [['＋ 当前文件', rel], dir ? ['＋ 当前目录', dir] : ['＋ 全部文件', '**']]) {
      const b = makeEl('button', 'chip', label);
      b.type = 'button';
      b.addEventListener('click', () => add(pat));
      quick.append(b);
    }
  }

  const save = makeEl('button', 'btn primary', '保存规则');
  save.disabled = !editable;
  save.addEventListener('click', async () => {
    const cleaned = rules.filter(r => r.pattern.trim());
    if (!cleaned.length && data.rules.length) {
      const ok = await askConfirm({ title: '清空全部规则', message: '清空后令牌可访问任意文件，且不再有任何免令牌直链。确定吗？', okText: '清空并保存', danger: true });
      if (!ok) return;
    }
    save.disabled = true;
    try {
      await request('/api/access', 'PUT', { rules: cleaned });
      await loadContext();
      toast('规则已保存（全球生效最长约 1 分钟）');
      if (state.current) showLinks();
    } catch (e) { toast('保存失败：' + e.message); save.disabled = false; }
  });

  const source = data.source === 'kv'
    ? `规则保存在 KV${data.updatedAt ? `，最后修改：${fmt(data.updatedAt)}（${data.updatedBy}）` : ''}。`
    : data.source === 'none'
      ? `分支 ${state.info.branch} 还没有自己的规则（默认分支的规则不适用于它）；保存后即为该分支单独的白名单。`
      : data.kvAvailable
      ? '规则目前来自环境变量 DIRECT_PATHS；保存后改为以 KV 为准，环境变量不再生效。'
      : '未绑定 KV（CONFIG_KV）：规则来自环境变量 DIRECT_PATHS，只能在 Cloudflare 控制台修改。绑定 KV 后即可在这里编辑。';
  const hint = makeEl('p', 'muted small-text',
    '目录以 / 结尾（含子目录），可用 * ** ? 通配；路径相对管理目录。多条规则同时命中时取最具体的一条（精确文件 > 更深的目录 > 单层通配 > 递归通配），例如目录开放而其中某个文件设为「仅令牌」，则该文件需要令牌；同样具体时 禁止 > 直链 > 令牌。免令牌直链需要 PUBLIC_FILES="true"，等于有意公开该文件。');
  const actions = makeEl('div', 'reauth-actions');
  actions.append(save);

  body.replaceChildren(makeEl('p', 'diff-stat', source), hint, list, preview, quick, makeEl('div', 'spacer'), addBtn, actions);
}

/* ============================================================
 *  直接在文件 / 目录上设置访问方式
 * ============================================================ */

/** 文件树角标：只在"不能直链"时显示——需要令牌访问显示分享图标 🔗，未开放显示 🔒，禁止显示 ⛔；可直链的不显示。 */
export const BADGES = { token: '🔗', open: '🔗', none: '🔒', deny: '⛔' };
export const BADGE_TITLES = {
  token: '需要令牌访问：点「获取文件链接」生成分享链接',
  open: '私有仓库：需要令牌才能分享，点「获取文件链接」生成',
  none: '未开放：没有命中任何规则，令牌也无法访问',
  deny: '禁止访问',
};

const CHOICES = [
  { id: 'inherit', name: '继承上级', desc: '不为它单独设置规则，沿用所在目录或通配规则的结果' },
  { id: 'direct', name: '免令牌直链', desc: '/file/<路径> 直接可读（需 PUBLIC_FILES="true"），同时允许令牌访问；等于有意公开' },
  { id: 'token', name: '仅令牌访问', desc: '必须带有效令牌；没有令牌的请求读不到' },
  { id: 'deny', name: '禁止访问', desc: '直链和令牌都不能访问，也不能为它生成链接' },
];

const tally = (rules, paths) => {
  const t = { direct: 0, token: 0, deny: 0, none: 0, open: 0 };
  for (const p of paths) t[resolveAccess(rules, p).mode]++;
  return t;
};

/** 为单个文件或整个目录设置访问方式（只改这一条规则，其它规则不动）。 */
export function openAccessDialog(path, kind) {
  const isDir = kind === 'dir';
  const pattern = isDir ? `${path}/**` : path;
  const acc = state.info.access || { rules: [], kvAvailable: false };
  const editable = acc.kvAvailable && !state.readonly;
  const files = isDir ? state.files.map(f => f.path).filter(p => p.startsWith(path + '/')) : [path];

  const others = acc.rules.filter(r => r.pattern !== pattern);
  const current = acc.rules.find(r => r.pattern === pattern)?.mode || 'inherit';
  const probe = isDir ? [`${path}/\u0000`] : [path]; // 目录的"继承结果"：看上级规则会怎样对待其中的文件
  const inherited = resolveAccess(others, probe[0]);

  let selected = current;
  const body = makeEl('div');
  const head = makeEl('p', 'diff-stat', `${isDir ? '目录' : '文件'}：${path}${isDir ? `（含子目录，共 ${files.length} 个文件）` : ''}`);
  const preview = makeEl('div', 'policy-box');
  const cards = [];

  const hypothetical = () => (selected === 'inherit' ? others : [...others, { pattern, mode: selected }]);
  const update = () => {
    cards.forEach(c => c.el.classList.toggle('on', c.id === selected));
    const rules = hypothetical();
    if (isDir) {
      const t = tally(rules, files);
      const parts = [['direct', '免令牌直链'], ['token', '仅令牌'], ['deny', '禁止'], ['none', '未开放'], ['open', '无规则（令牌可访问）']]
        .filter(([k]) => t[k]).map(([k, label]) => `${label} ${t[k]}`);
      preview.textContent = `保存后，目录内 ${files.length} 个文件：${parts.join('、') || '—'}。目录里更具体的规则（子目录、单个文件）仍然优先。`;
    } else {
      const a = resolveAccess(rules, path);
      preview.textContent = `保存后：${MODE_LABELS[rules.length ? a.mode : 'open']}${a.rule ? `（规则 ${a.rule.pattern}:${a.rule.mode}）` : ''}`;
    }
  };

  for (const c of CHOICES) {
    const label = makeEl('label', 'radio-card' + (c.id === 'deny' ? ' deny' : ''));
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'access-mode', checked: c.id === current, disabled: !editable });
    radio.addEventListener('change', () => { selected = c.id; update(); });
    const text = makeEl('span');
    const desc = c.id === 'inherit' ? `${c.desc}（当前继承结果：${MODE_LABELS[acc.rules.length ? inherited.mode : 'open']}）` : c.desc;
    text.append(makeEl('strong', '', c.name), makeEl('small', '', desc));
    label.append(radio, text);
    cards.push({ id: c.id, el: label });
    body.append(label);
  }
  update();

  const note = makeEl('p', 'muted small-text',
    !acc.kvAvailable ? '未绑定 KV（CONFIG_KV）：规则来自环境变量 DIRECT_PATHS，只能在 Cloudflare 控制台修改。'
      : state.readonly ? '当前口令为只读，只能查看。'
        : `规则保存在 KV，全球生效最长约 1 分钟。这条规则的写法：${pattern}${state.info.branch !== state.info.defaults?.branch ? `。仅对当前分支 ${state.info.branch} 生效，各分支的规则相互独立。` : ''}`);
  const all = makeEl('button', 'btn ghost', '管理全部规则…');
  all.type = 'button';
  all.addEventListener('click', showAccessEditor);
  const save = makeEl('button', 'btn primary', '保存');
  save.disabled = !editable;
  save.addEventListener('click', async () => {
    if (selected === 'direct' && !(await askConfirm({
      title: '开启免令牌直链', okText: '确认开启', danger: true,
      message: `${isDir ? `目录 ${path} 下（没有更具体规则的）所有文件` : path}将可被任何人通过链接直接读取，请确认内容可以公开。`,
    }))) return;
    save.disabled = true;
    try {
      await request('/api/access/set', 'POST', { pattern, mode: selected === 'inherit' ? null : selected });
      await loadContext();
      renderFiles();
      closeModal();
      toast('访问规则已保存（全球生效最长约 1 分钟）');
    } catch (e) { toast('保存失败：' + e.message); save.disabled = false; }
  });
  const actions = makeEl('div', 'reauth-actions');
  actions.style.justifyContent = 'space-between';
  const right = makeEl('div', 'field-inline');
  right.append(save);
  actions.append(all, right);
  body.append(preview, makeEl('div', 'spacer'), note, actions);
  body.prepend(head);
  openModal('访问设置', body);
}
