/** 全库搜索 / 替换：客户端拉取文本文件（带缓存），替换通过原子提交一次性写回。 */
import { fileUrl, request } from '../api.js';
import { buildMatcher, findInText, replaceInText, searchable } from '../searchlib.js';
import { state } from '../state.js';
import { bytesFromB64, makeEl, toast } from '../util.js';
import { checkUnsaved, gotoLine, openFile } from './editor.js';
import { refreshFiles } from './files.js';
import { askConfirm, closeModal, openModal } from './modal.js';

const cache = { key: '', map: new Map() };
const CONCURRENCY = 4;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const cacheKey = () => `${state.info.owner}/${state.info.repo}@${state.info.branch}/${state.info.root}`;

/** 取得所有可搜索文件的文本（sha 未变则复用缓存）。 */
async function loadTexts(files, onProgress) {
  if (cache.key !== cacheKey()) { cache.key = cacheKey(); cache.map.clear(); }
  const todo = files.filter(f => cache.map.get(f.path)?.sha !== f.sha);
  let done = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let f; (f = queue.shift());) {
      try {
        const data = await request(fileUrl(f.path));
        const bytes = bytesFromB64(data.content);
        cache.map.set(f.path, { sha: f.sha, text: bytes.includes(0) ? null : decoder.decode(bytes) });
      } catch { cache.map.set(f.path, { sha: f.sha, text: null }); }
      onProgress(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
}

function highlightLine(text, matcher) {
  const frag = document.createDocumentFragment();
  let last = 0;
  matcher.lastIndex = 0;
  for (let m; (m = matcher.exec(text));) {
    if (m[0] === '') { matcher.lastIndex++; continue; }
    frag.append(document.createTextNode(text.slice(last, m.index)), Object.assign(document.createElement('mark'), { textContent: m[0] }));
    last = m.index + m[0].length;
  }
  frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

export function showSearch() {
  const q = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', placeholder: '搜索内容…' });
  const r = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', placeholder: '替换为…（留空表示替换为空）' });
  const pathFilter = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', placeholder: '只搜索路径包含…（可选，逗号分隔）' });
  const opt = (label) => {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    const lab = makeEl('label', 'chk');
    lab.append(box, label);
    return { box, lab };
  };
  const regex = opt('正则'), cs = opt('区分大小写'), word = opt('全词');
  const go = makeEl('button', 'btn primary', '搜索');
  const replaceBtn = makeEl('button', 'btn danger-solid write-only', '全部替换');
  replaceBtn.disabled = true;
  const progress = makeEl('div', 'progress');
  const bar = document.createElement('i');
  progress.append(bar);
  progress.hidden = true;
  const summary = makeEl('div', 'diff-stat');
  const results = makeEl('div');

  let last = null; // { matcher, perFile:[{path, text, found}] }

  async function run() {
    let matcher;
    try { matcher = buildMatcher({ query: q.value, regex: regex.box.checked, caseSensitive: cs.box.checked, wholeWord: word.box.checked }); }
    catch (e) { return toast(e.message); }
    const filters = pathFilter.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const files = state.files.filter(f => searchable(f.path, f.size) && (!filters.length || filters.some(s => f.path.toLowerCase().includes(s))));
    go.disabled = true; replaceBtn.disabled = true;
    progress.hidden = false; bar.style.width = '0';
    summary.textContent = `正在读取 ${files.length} 个文件…`;
    await loadTexts(files, (d, t) => { bar.style.width = `${t ? (d / t) * 100 : 100}%`; });
    progress.hidden = true;

    const perFile = [];
    let total = 0;
    for (const f of files) {
      const text = cache.map.get(f.path)?.text;
      if (text == null) continue;
      const found = findInText(text, matcher);
      if (found.total) { perFile.push({ path: f.path, text, found }); total += found.total; }
    }
    last = { matcher, perFile, regex: regex.box.checked };
    summary.textContent = perFile.length
      ? `在 ${perFile.length} 个文件中找到 ${total} 处匹配（已搜索 ${files.length} 个文本文件）`
      : `没有找到匹配（已搜索 ${files.length} 个文本文件）`;
    results.replaceChildren(...perFile.slice(0, 200).map(({ path, found }) => {
      const box = makeEl('div', 'res-file');
      const head = makeEl('div', 'res-head', path);
      head.append(makeEl('span', 'count', `${found.total} 处`));
      box.append(head);
      for (const l of found.lines) {
        const row = makeEl('div', 'res-line');
        const tx = makeEl('span', 'tx');
        tx.append(highlightLine(l.text, matcher));
        row.append(makeEl('span', 'ln', String(l.line)), tx);
        row.addEventListener('click', async () => { closeModal(); await openFile(path); await gotoLine(l.line); });
        box.append(row);
      }
      return box;
    }));
    go.disabled = false;
    replaceBtn.disabled = !perFile.length || state.readonly;
  }

  async function replaceAll() {
    if (!last?.perFile.length) return;
    const replacement = r.value;
    const changes = [];
    let count = 0;
    for (const f of last.perFile) {
      const out = replaceInText(f.text, last.matcher, replacement, last.regex);
      if (out.text !== f.text) { changes.push({ path: f.path, content: out.text, count: out.count }); count += out.count; }
    }
    if (!changes.length) return toast('替换后内容没有变化');
    const dirtyHit = state.dirty && changes.some(c => c.path === state.current?.path);
    if (dirtyHit && !(await checkUnsaved())) return;
    const ok = await askConfirm({
      title: '确认全部替换',
      message: `将在 ${changes.length} 个文件中替换 ${count} 处，并以原子提交写入 GitHub（可在 Git 历史中回退）。`,
      details: changes.slice(0, 12).map(c => `${c.path}（${c.count} 处）`).concat(changes.length > 12 ? [`…另有 ${changes.length - 12} 个文件`] : []),
      okText: '替换并提交', danger: true,
    });
    if (!ok) return;

    replaceBtn.disabled = true;
    try {
      const message = `Replace "${q.value.slice(0, 40)}" → "${replacement.slice(0, 40)}" in ${changes.length} file(s)`;
      let batch = [], bytes = 0, commits = 0;
      const flush = async () => {
        if (!batch.length) return;
        await request('/api/commit', 'POST', { message, changes: batch.map(({ path, content }) => ({ path, content })) });
        commits++; batch = []; bytes = 0;
      };
      for (const c of changes) {
        const size = c.content.length * 3; // 粗略估算 UTF-8 字节数的上界
        if (batch.length >= 50 || bytes + size > 2.5 * 1024 * 1024) await flush();
        batch.push(c); bytes += size;
      }
      await flush();
      cache.map.clear();
      const reopen = state.current && changes.some(c => c.path === state.current.path) ? state.current.path : null;
      await refreshFiles();
      if (reopen) { state.current = null; state.dirty = false; await openFile(reopen); }
      closeModal();
      toast(`已替换 ${count} 处（${changes.length} 个文件，${commits} 次提交）`);
    } catch (e) { toast('替换失败：' + e.message); replaceBtn.disabled = false; }
  }

  go.addEventListener('click', run);
  replaceBtn.addEventListener('click', replaceAll);
  q.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

  const body = makeEl('div');
  const opts = makeEl('div', 'field-inline');
  opts.append(regex.lab, cs.lab, word.lab);
  const actions = makeEl('div', 'field-inline');
  actions.append(go, replaceBtn);
  body.append(q, makeEl('div', 'spacer'), r, makeEl('div', 'spacer'), pathFilter, makeEl('div', 'spacer'), opts, makeEl('div', 'spacer'), actions, progress, summary, results);
  openModal('全库搜索 / 替换', body, { wide: true });
  q.focus();
}
