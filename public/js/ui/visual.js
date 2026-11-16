/** 可视化编辑面板：规则列表（Clash / QX）与 Clash .ini。 */
import {
  CONVERT_TARGETS, FORMAT_LABELS, LIST_FORMATS,
  collectIssues, dedupe, envIssues, isSensitiveKey, lineToItem, parse, ruleKey, serialize, sortRuns, validateRuleset,
} from '../formats/index.js';
import { state } from '../state.js';
import { makeEl, toast } from '../util.js';
import { attachDrag } from './drag.js';
import { makeMenu } from './menu.js';
import { askInput } from './modal.js';
import { convertCurrent, markDirty } from './editor.js';

const spec = () => LIST_FORMATS[state.fmt] || LIST_FORMATS['clash-list'];

/* ---------- 撤销 / 重做（以序列化文本为快照） ---------- */

const hist = { parsed: null, stack: [], idx: 0, timer: 0 };
const MAX_HISTORY = 200;

function resetHistoryIfNeeded() {
  if (hist.parsed === state.parsed) return;
  clearTimeout(hist.timer);
  Object.assign(hist, { parsed: state.parsed, stack: [serialize(state.parsed)], idx: 0, timer: 0 });
}

function pushSnapshot() {
  clearTimeout(hist.timer);
  hist.timer = 0;
  if (hist.parsed !== state.parsed) return;
  const snap = serialize(state.parsed);
  if (snap === hist.stack[hist.idx]) return;
  hist.stack.splice(hist.idx + 1);
  hist.stack.push(snap);
  if (hist.stack.length > MAX_HISTORY) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
}

/** 输入框里连续敲字合并为一次快照（停顿 0.6 秒后记录）。 */
function touch() {
  markDirty();
  clearTimeout(hist.timer);
  hist.timer = setTimeout(pushSnapshot, 600);
}

function restore(delta) {
  pushSnapshot(); // 先把尚未记录的输入落盘，保证能撤销回来
  const next = hist.idx + delta;
  if (next < 0 || next >= hist.stack.length) return;
  hist.idx = next;
  state.parsed = parse(state.fmt, hist.stack[next]);
  hist.parsed = state.parsed;
  markDirty();
  renderVisualPanel();
}

export const undo = () => restore(-1);
export const redo = () => restore(1);

/** 修改数据后统一调用：记录快照、更新脏标记并重绘。 */
function commit() { markDirty(); pushSnapshot(); renderVisualPanel(); }

function input(className, value, placeholder, onInput) {
  const el = makeEl('input', className);
  el.value = value ?? '';
  if (placeholder) el.placeholder = placeholder;
  el.addEventListener('input', () => { onInput(el.value); touch(); });
  return el;
}

function select(className, options, current, onChange, { allowUnknown = true, labelOf = v => v } = {}) {
  const el = makeEl('select', className);
  for (const o of options) {
    const opt = makeEl('option', '', labelOf(o));
    opt.value = o;
    el.append(opt);
  }
  if (allowUnknown && current && !options.includes(current)) {
    const opt = makeEl('option', '', current);
    opt.value = current;
    opt.hidden = true;
    el.append(opt);
  }
  el.value = current ?? '';
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function deleteButton(onClick) {
  const b = makeEl('button', 'btn tiny danger', '✕');
  b.title = '删除';
  b.addEventListener('click', onClick);
  return b;
}

/* ============================================================
 *  面板骨架
 * ============================================================ */

/** 面板内的临时 UI 状态（搜索词等），切换文件时重置。 */
const ui = { filter: '', file: '', badge: null };

export function renderVisualPanel() {
  const panel = document.getElementById('visualPanel');
  panel.replaceChildren();
  if (ui.file !== state.current?.path) { ui.file = state.current?.path; ui.filter = ''; }
  const isIni = state.fmt === 'clash-ini';
  const isEnv = state.fmt === 'env';
  resetHistoryIfNeeded();

  const addBar = makeEl('div', 'vp-addbar');
  addBar.append(button('btn primary small', isEnv ? '＋ 添加变量' : '＋ 添加规则', addRule));
  if (isIni) {
    addBar.append(
      button('btn secondary small', '＋ 添加 ruleset', () => addIniEntry({ kind: 'ruleset', label: '🆎 广告过滤', url: '', embedded: null })),
      button('btn secondary small', '＋ 添加 proxy_group', () => addIniEntry({ kind: 'proxy_group', name: '新分组', strategy: 'select', members: [] })),
    );
  }
  // 低频操作折叠进"更多"
  const more = [{ label: '📋 批量粘贴', onClick: batchPaste }];
  if (!isIni && !isEnv) {
    more.push(
      { label: '⇣ 导入链接', onClick: importFromUrl },
      { label: '去重', onClick: dedupeRules },
      { label: '安全排序', onClick: sortRules, title: '只在同类型、同动作的连续规则内排序，不改变匹配优先级' },
      ...Object.entries(CONVERT_TARGETS).filter(([fmt]) => fmt !== state.fmt)
        .map(([fmt, t]) => ({ label: `→ 转为 ${t.label} 规则`, onClick: () => convertCurrent(fmt) })),
    );
  }
  addBar.append(makeMenu('更多', more));

  // 标题与操作按钮放进编辑器顶部那一行（和模式切换同一行），而不是面板内部
  const top = makeEl('div', 'vp-topbar');
  top.append(makeEl('span', 'vp-title', FORMAT_LABELS[state.fmt] || state.fmt), addBar);
  document.getElementById('visualBar').replaceChildren(top);

  if (!isIni && !isEnv) panel.append(filterBar());
  if (isIni) renderIni(panel);
  else if (isEnv) renderEnv(panel);
  else renderRuleList(panel);
}

function filterBar() {
  const bar = makeEl('div', 'vp-filterbar');
  const box = makeEl('input', 'vp-filter');
  box.type = 'search';
  box.placeholder = '搜索规则（类型 / 内容 / 动作）…';
  box.value = ui.filter;
  box.addEventListener('input', () => { ui.filter = box.value; applyFilter(); });
  ui.badge = makeEl('span', 'vp-badge');
  bar.append(box, ui.badge);
  return bar;
}

function applyFilter() {
  const q = ui.filter.trim().toLowerCase();
  document.querySelectorAll('#visualPanel .rule-row').forEach(row => {
    const it = state.parsed.items[Number(row.dataset.idx)];
    const hay = `${it.type} ${it.rule} ${it.action} ${(it.opts || []).join(' ')}`.toLowerCase();
    row.hidden = !!q && !hay.includes(q);
  });
}

function button(cls, text, onClick) {
  const b = makeEl('button', cls, text);
  b.addEventListener('click', onClick);
  return b;
}

/* ============================================================
 *  规则列表（Clash .list / QX .list）
 * ============================================================ */

function renderRuleList(panel) {
  const items = state.parsed.items;
  const list = makeEl('div', 'rule-list');
  const rows = [];

  // 重新计算校验/重复提示，只更新样式，不重建 DOM（避免输入时失去焦点）
  const refreshIssues = () => {
    const issues = collectIssues(items);
    rows.forEach((row, i) => {
      const msg = issues.get(i) || '';
      row.classList.toggle('invalid', !!msg);
      row.title = msg;
    });
    if (ui.badge) {
      ui.badge.textContent = issues.size ? `⚠ ${issues.size} 条需要检查` : `共 ${items.length} 行`;
      ui.badge.classList.toggle('warn', issues.size > 0);
    }
  };
  const changed = () => { touch(); refreshIssues(); };

  items.forEach((it, idx) => { const r = ruleRow(it, idx, changed); rows.push(r); list.append(r); });
  panel.append(list);
  refreshIssues();
  applyFilter();
  attachDrag(list, (from, to) => {
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    commit();
  });
}

function ruleRow(it, idx, changed) {
  const { types, actions } = spec();
  const row = makeEl('div', 'rule-row');
  row.dataset.idx = idx;
  const refresh = () => row.classList.toggle('disabled', !it.enabled || !it.type);
  refresh();

  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.className = 'rule-enabled';
  enabled.checked = it.enabled !== false;
  enabled.title = '勾选=启用规则，取消=注释掉';
  enabled.addEventListener('change', () => { it.enabled = enabled.checked; refresh(); changed(); });

  const type = select('rule-type', types, it.type, v => { it.type = v; refresh(); changed(); },
    { labelOf: t => t || '-' });

  const rule = input('rule-input', it.rule, spec().placeholder, v => { it.rule = v; changed(); });

  const actionOptions = ['', ...actions];
  const action = select('rule-action', actionOptions, it.action, v => { it.action = v; changed(); },
    { labelOf: a => a || '(无)' });

  const box = makeEl('div', 'rule-actions');
  box.append(
    button('btn tiny', '↑', () => moveItem(idx, -1)),
    button('btn tiny', '↓', () => moveItem(idx, 1)),
    deleteButton(() => { state.parsed.items.splice(idx, 1); commit(); }),
  );
  box.children[0].title = '上移';
  box.children[1].title = '下移';

  row.append(enabled, makeEl('span', 'rule-drag', '⋮⋮'), type, rule, action, box);
  return row;
}

function moveItem(idx, dir) {
  const arr = state.parsed.items;
  const j = idx + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  commit();
}

function addRule() {
  if (state.fmt === 'clash-ini') return;
  if (state.fmt === 'env') {
    state.parsed.items.push({ kind: 'kv', exported: false, key: 'NEW_VARIABLE', value: '' });
    return commit();
  }
  const types = spec().types;
  const type = types.find(Boolean) || 'DOMAIN-SUFFIX';
  state.parsed.items.push({ kind: 'rule', enabled: true, type, rule: '', action: '', opts: [], isBracketRule: false });
  commit();
}

function dedupeRules() {
  const { items, removed } = dedupe(state.parsed.items);
  if (!removed) return toast('没有发现重复规则');
  state.parsed.items = items;
  toast(`已删除 ${removed} 条重复规则`);
  commit();
}

function sortRules() {
  const { items, changedRuns } = sortRuns(state.parsed.items);
  if (!changedRuns) return toast('没有需要调整的规则段');
  state.parsed.items = items;
  toast(`已整理 ${changedRuns} 段规则（仅同类型、同动作的连续规则，不影响匹配优先级）`);
  commit();
}

const IMPORT_HOSTS = new Set(['raw.githubusercontent.com', 'cdn.jsdelivr.net', 'github.com']);

/** 从链接导入规则：仅限 GitHub / jsDelivr / 本站 Worker 链接；已存在的规则自动跳过。 */
async function importFromUrl() {
  const input = await askInput({ title: '导入链接', message: '粘贴要导入的 .list 链接（GitHub Raw / blob、jsDelivr 或本站 /file/ 链接）：', placeholder: 'https://…', okText: '导入' });
  if (!input?.trim()) return;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' || !(IMPORT_HOSTS.has(u.hostname) || u.origin === location.origin)) {
      throw new Error('只支持 GitHub / jsDelivr / 本站链接');
    }
    let url = u.href;
    const blob = u.hostname === 'github.com' && u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (blob) url = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`;

    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 1024 * 1024) throw new Error('文件超过 1 MiB');

    const existing = new Set(state.parsed.items.filter(i => i.type).map(ruleKey));
    let added = 0, skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = lineToItem(line, state.fmt);
      if (item.type) {
        const key = ruleKey(item);
        if (existing.has(key)) { skipped++; continue; }
        existing.add(key);
      }
      state.parsed.items.push(item);
      added++;
    }
    toast(`已导入 ${added} 行，跳过 ${skipped} 条已存在的规则`);
    commit();
  } catch (e) { toast('导入失败：' + e.message); }
}

async function batchPaste() {
  if (state.fmt === 'clash-ini') return toast('批量粘贴暂不支持 .ini 格式');
  const text = await askInput({ title: '批量粘贴', message: '粘贴多行规则（每行一条，支持注释 #）。Ctrl/Cmd+Enter 提交。', multiline: true, okText: '添加' });
  if (text === null || !text.trim()) return;
  const lines = text.split(/\r?\n/);
  if (state.fmt === 'env') state.parsed.items.push(...parse('env', text).items.map(i => { const c = { ...i }; delete c.raw; return c; }));
  else for (const line of lines) state.parsed.items.push(lineToItem(line, state.fmt));
  toast(`已添加 ${lines.length} 条`);
  commit();
}

/* ============================================================
 *  Clash .ini
 * ============================================================ */

function addIniEntry(entry) {
  const sections = state.parsed.sections;
  const target = sections.find(s => s.section === 'custom') || sections.find(s => s.section !== null) || sections[0];
  if (!target) return toast('文件中没有可添加的 section');
  target.entries.push(entry);
  commit();
}

function renderIni(panel) {
  for (const sec of state.parsed.sections) {
    const box = makeEl('div', 'ini-section');
    const head = makeEl('div', 'ini-section-head');
    head.append(makeEl('span', 'ini-section-title', sec.section === null ? '(文件开头)' : `[${sec.section}]`));
    const body = makeEl('div', 'ini-section-body');
    sec.entries.forEach((e, i) => body.append(iniRow(e, () => { sec.entries.splice(i, 1); commit(); })));
    box.append(head, body);
    panel.append(box);
  }
}

function iniRow(e, onDelete) {
  const row = makeEl('div', 'ini-row kind-' + (e.kind || 'other'));
  const del = deleteButton(onDelete);

  switch (e.kind) {
    case 'blank':
      row.append(makeEl('div', 'rule-empty', '— 空行 —'), del);
      break;
    case 'comment': {
      const t = e.text.trim();
      const sigil = t.startsWith('//') ? '//' : t.startsWith(';') ? ';' : '#';
      row.append(makeEl('span', 'rule-type-badge comment', sigil), input('rule-comment-input', e.text, '', v => { e.text = v; }), del);
      break;
    }
    case 'kv':
      row.append(
        input('ini-kv-key', e.key, '', v => { e.key = v; }),
        makeEl('span', 'ini-eq', '='),
        input('ini-kv-val', e.value, '', v => { e.value = v; }),
        del,
      );
      break;
    case 'ruleset': {
      row.append(rulesetCard(e, row), del);
      const msg = validateRuleset(e);
      row.classList.toggle('invalid', !!msg);
      row.title = msg;
      break;
    }
    case 'proxy_group':
      row.append(proxyGroupCard(e), del);
      break;
    default:
      row.append(makeEl('div', 'rule-empty', e.raw || JSON.stringify(e)), del);
  }
  return row;
}

function rulesetCard(e, rowEl) {
  const recheck = () => { const m = validateRuleset(e); rowEl.classList.toggle('invalid', !!m); rowEl.title = m; };
  const card = makeEl('div', 'ini-ruleset-card');
  const head = makeEl('div', 'ini-ruleset-head');
  const kind = select('ini-ruleset-type', ['外部 URL', '内嵌规则'], e.embedded ? '内嵌规则' : '外部 URL', v => {
    if (v === '外部 URL') { e.url = e.url || ''; e.embedded = null; }
    else { e.url = ''; e.embedded = e.embedded || { type: 'GEOIP', rule: '' }; }
    commit();
  }, { allowUnknown: false });
  head.append(makeEl('span', 'ini-kw', 'ruleset='), input('ini-label', e.label, '标签', v => { e.label = v; recheck(); }), kind);

  const body = makeEl('div', 'ini-ruleset-body');
  if (!e.embedded) {
    body.append(input('ini-url', e.url, 'https://raw.githubusercontent.com/.../xxx.list', v => { e.url = v; recheck(); }));
  } else {
    body.append(
      makeEl('span', 'ini-bracket', '['),
      select('ini-embed-type', ['GEOSITE', 'GEOIP', 'FINAL', 'DOMAIN', 'DOMAIN-KEYWORD'], e.embedded.type,
        v => { e.embedded.type = v; touch(); }),
      makeEl('span', 'ini-bracket', ', '),
      input('ini-embed-rule', e.embedded.rule, 'CN / facebook.com', v => { e.embedded.rule = v; }),
      makeEl('span', 'ini-bracket', ']'),
    );
  }
  card.append(head, body);
  return card;
}

const GROUP_STRATEGIES = ['select', 'url-test', 'fallback', 'domain-test', 'load-balance'];
const TEST_FIELDS = [
  ['filters', '过滤', '.* 或 (香港)'],
  ['interval', '间隔(s)', '300'],
  ['failure', '失败阈值', '5'],
  ['success', '成功阈值', '100'],
];

function proxyGroupCard(e) {
  const box = makeEl('div', 'ini-pgroup');
  const head = makeEl('div', 'ini-pg-head');
  const strategy = select('ini-pg-strategy', GROUP_STRATEGIES, e.strategy, v => {
    e.strategy = v;
    if (v === 'select') e.members ||= [];
    else { e.filters ||= '.*'; e.url ||= ''; }
    commit();
  });
  head.append(
    makeEl('span', 'ini-kw', 'custom_proxy_group='),
    input('ini-pg-name', e.name, '节点选择', v => { e.name = v; }),
    strategy,
  );
  box.append(head, e.strategy === 'select' ? memberList(e) : urlTestFields(e));
  return box;
}

function memberList(e) {
  const box = makeEl('div', 'ini-pg-members');
  e.members ||= [];
  e.members.forEach((m, i) => {
    const line = makeEl('div', 'ini-pg-member');
    const glob = document.createElement('input');
    glob.type = 'checkbox';
    glob.className = 'ini-pg-star';
    glob.checked = !!m.glob;
    glob.addEventListener('change', () => { m.glob = glob.checked; touch(); });
    const globLabel = makeEl('label', '', '.* 通配');
    globLabel.prepend(glob);

    const swap = d => () => {
      const j = i + d;
      if (j < 0 || j >= e.members.length) return;
      [e.members[i], e.members[j]] = [e.members[j], e.members[i]];
      commit();
    };
    line.append(
      Object.assign(input('ini-pg-prefix', m.prefix, '[]', v => { m.prefix = v; }), { maxLength: 2 }),
      input('ini-pg-name2', m.name, '节点名 / DIRECT / REJECT / 子组', v => { m.name = v; }),
      globLabel,
      button('btn tiny', '↑', swap(-1)),
      button('btn tiny', '↓', swap(1)),
      deleteButton(() => { e.members.splice(i, 1); commit(); }),
    );
    box.append(line);
  });
  box.append(button('btn tiny', '＋ 节点', () => { e.members.push({ name: '', prefix: '[]', glob: false }); commit(); }));
  return box;
}

function urlTestFields(e) {
  const box = makeEl('div', 'ini-pg-urltest');
  for (const [key, label, placeholder] of TEST_FIELDS) {
    const lab = makeEl('label', 'ini-pg-field');
    lab.append(makeEl('span', '', label), input('ini-pg-' + key, e[key], placeholder, v => { e[key] = v; }));
    box.append(lab);
  }
  const url = makeEl('label', 'ini-pg-field ini-pg-url-field');
  url.append(makeEl('span', '', '测速 URL'), input('ini-pg-url', e.url, 'http://www.gstatic.com/generate_204', v => { e.url = v; }));
  box.append(url);
  return box;
}

/** 可视化模式下的全局撤销/重做快捷键；焦点在输入框内时交给浏览器原生撤销。 */
export function bindVisualShortcuts() {
  document.addEventListener('keydown', e => {
    if (state.mode !== 'visual' || !state.parsed || !(e.ctrlKey || e.metaKey)) return;
    if (e.target.closest?.('input,textarea,select')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
  });
}

/* ============================================================
 *  .env：敏感值默认遮罩，可逐项显示
 * ============================================================ */

const revealed = new WeakSet();

function renderEnv(panel) {
  const items = state.parsed.items;
  if (state.info?.private !== true) {
    panel.append(makeEl('div', 'env-warn', '⚠ 当前仓库不是私有的：.env 里的真实密钥一旦提交就会进入公开的 Git 历史。建议只提交变量名与占位值（如 .env.example）。'));
  }
  const rows = [];
  const refresh = () => {
    const issues = envIssues(items);
    rows.forEach(({ row, idx }) => {
      const msg = issues.get(idx) || '';
      row.classList.toggle('invalid', !!msg);
      row.title = msg;
    });
  };
  const changed = () => { touch(); refresh(); };

  const box = makeEl('div', 'ini-section-body');
  items.forEach((it, idx) => {
    const row = makeEl('div', 'ini-row kind-' + it.kind);
    const del = deleteButton(() => { items.splice(idx, 1); commit(); });
    if (it.kind === 'blank') { row.append(makeEl('div', 'rule-empty', '— 空行 —'), del); }
    else if (it.kind === 'comment') {
      row.append(makeEl('span', 'rule-type-badge comment', '#'), input('rule-comment-input', it.text, '', v => { it.text = v; changed(); }), del);
    } else if (it.kind === 'kv') {
      const value = input('ini-kv-val env-secret', it.value, '', v => { it.value = v; changed(); });
      const syncType = () => { value.type = isSensitiveKey(it.key) && !revealed.has(it) ? 'password' : 'text'; };
      syncType();
      const key = input('ini-kv-key', it.key, 'KEY', v => { it.key = v; syncType(); changed(); });
      const eye = button('btn tiny', '👁', () => { if (revealed.has(it)) revealed.delete(it); else revealed.add(it); syncType(); });
      eye.title = '显示 / 隐藏值';
      row.append(key, makeEl('span', 'ini-eq', '='), value, eye, del);
    } else {
      row.append(makeEl('div', 'rule-empty', it.raw || ''), del);
    }
    rows.push({ row, idx });
    box.append(row);
  });
  panel.append(box);
  refresh();
}
