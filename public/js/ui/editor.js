/** 编辑器面板：打开 / 新建 / 保存 / 删除 / 上传 / 下载、模式切换、语法高亮。 */
import { fileUrl, request } from '../api.js';
import { CONVERT_TARGETS, convertRuleList, detectFormat, parse, serialize, suggestConvertedPath } from '../formats/index.js';
import { allLanguages, detectLanguage, ensureLanguageLoaded } from '../highlight.js';
import { LANG_LABELS, convertData, convertedName, formatJson, langOf, lint } from '../lint.js';
import { renderMarkdown } from '../markdown.js';
import { scanSecrets } from '../secrets.js';
import { templatesFor } from '../templates.js';
import { fileFullPath, getEditorText, state, textBytes } from '../state.js';
import { $, b64FromBytes, bytesFromB64, detectEol, formatSize, isValidPath, makeEl, toast, toLF } from '../util.js';
import { refreshFiles, renderFiles } from './files.js';
import { renderLinks } from './links.js';
import { askChoice, askConfirm, askInput, showAlert } from './modal.js';
import { renderVisualPanel } from './visual.js';

/* ---------- 脏标记 ---------- */

export function updateTitle() {
  const name = state.current ? state.current.path.split('/').at(-1) : '';
  document.title = `${state.dirty ? '● ' : ''}${name ? name + ' · ' : ''}GitHub Config Hub · 配置管理`;
}

export function markDirty() {
  state.dirty = toLF(getEditorText()) !== state.original;
  $('dirtyLabel').hidden = !state.dirty;
  updateTitle();
  $('sizeLabel').textContent = formatSize(textBytes().length);
  scheduleLint();
}

export const checkUnsaved = async () => !state.dirty || askConfirm({
  title: '有未保存的修改', message: '当前文件有未保存的修改，确定放弃吗？', okText: '放弃修改', danger: true,
});

/* ---------- 语法校验 / 格式化 / 转换 ---------- */

let lintTimer = 0;
let lintSeq = 0;

function scheduleLint(delay = 400) {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(runLint, delay);
}

async function runLint() {
  const label = $('lintLabel');
  const lang = state.current && !state.binary ? langOf(state.current.path) : null;
  $('formatBtn').hidden = $('minifyBtn').hidden = lang !== 'json';
  $('convertDataBtn').hidden = !['json', 'yaml', 'toml'].includes(lang);
  if (!lang) { label.hidden = true; state.lint = null; return; }
  const seq = ++lintSeq;
  const result = await lint(state.current.path, toLF(getEditorText()));
  if (seq !== lintSeq || !result) return; // 已有更新的校验在进行
  state.lint = result;
  label.hidden = false;
  label.className = 'lint-label ' + (result.ok ? 'ok' : 'bad');
  const where = result.line ? `第 ${result.line} 行${result.col ? ` 第 ${result.col} 列` : ''}：` : '';
  label.textContent = result.ok ? `✓ ${LANG_LABELS[lang]} 语法正确` : `✗ ${where}${result.message}`;
  label.title = result.ok ? '' : '点击定位到出错位置';
}

/** 在纯文本模式下选中并滚动到指定行。 */
export async function gotoLine(line, col = 1) {
  if (state.mode !== 'highlight') await setMode('highlight');
  const ta = $('editor');
  const lines = ta.value.split('\n');
  const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
  const start = lines.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(start + Math.min(col - 1, lines[idx].length), start + lines[idx].length);
  ta.scrollTop = Math.max(0, idx - 3) * 21.9; // 与 textarea 的行高一致
}

async function reformatJson(minify) {
  try { await replaceContent(formatJson(getEditorText(), minify)); }
  catch (e) { toast('无法处理：' + e.message); }
}

async function convertDataCurrent() {
  const from = langOf(state.current?.path || '');
  if (!from || !(await checkUnsaved())) return;
  const to = await askChoice({
    title: '转换格式', message: `把 ${LANG_LABELS[from]} 转换为：（会生成新文件，原文件不变；注释无法保留）`,
    options: ['json', 'yaml', 'toml'].filter(l => l !== from).map(l => ({ id: l, name: LANG_LABELS[l] })), okText: '下一步',
  });
  if (!to) return;
  let text;
  try { text = await convertData(from, to, getEditorText()); }
  catch (e) { return toast('转换失败：' + e.message); }
  const path = await askNewPath('转换为 ' + LANG_LABELS[to], '保存到：', convertedName(state.current.path, to));
  if (!path) return;
  await startNewFile(path, text);
  toast('已转换，原文件中的注释不会保留。保存后才会提交');
}

/* ---------- 保存前的敏感信息检查 ---------- */

/** 返回本次修改"新引入"的疑似密钥（已存在于原文的不重复提示）。 */
function newSecretFindings(text) {
  const before = new Set(scanSecrets(state.original).map(f => `${f.rule}|${f.preview}`));
  return scanSecrets(text).filter(f => !before.has(`${f.rule}|${f.preview}`));
}

/* ---------- 打开 / 新建 ---------- */

export function decodeBytes(bytes) {
  if (bytes.includes(0)) return { binary: true, text: '' };
  try { return { binary: false, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return { binary: true, text: '' }; }
}

/** 根据文件内容决定默认编辑模式：能可视化的默认可视化，其余都是（可编辑的）语法高亮视图。 */
function pickMode(path, text) {
  state.fmt = null;
  state.parsed = null;
  state.mode = 'highlight';
  try {
    const fmt = detectFormat(path, text);
    if (fmt) {
      state.parsed = parse(fmt, text);
      state.fmt = fmt;
      state.mode = 'visual';
      return;
    }
  } catch { state.fmt = null; state.parsed = null; }
}

/** 用给定文本替换编辑器内容（保持当前文件与 SHA 不变，标记为未保存）。 */
export async function replaceContent(text) {
  $('editor').value = text;
  if (state.fmt) {
    try { state.parsed = parse(state.fmt, $('editor').value); }
    catch { state.fmt = null; state.parsed = null; state.mode = 'highlight'; }
  }
  markDirty();
  await showEditor();
}

export async function openFile(path) {
  if (state.current?.path === path) return;
  if (!(await checkUnsaved())) {
    // 取消切换：把地址栏 hash 还原为当前文件，避免地址与内容不一致
    if (state.current) history.replaceState(null, '', '#/' + state.current.path.split('/').map(encodeURIComponent).join('/'));
    return;
  }
  try {
    const data = await request(fileUrl(path));
    const bytes = bytesFromB64(data.content);
    const { binary, text } = decodeBytes(bytes);

    Object.assign(state, {
      current: { path, sha: data.sha, size: data.size },
      bytes, original: toLF(text), eol: detectEol(text), binary, dirty: false, hlLang: '',
    });
    $('editor').value = text;
    if (binary) { state.fmt = null; state.parsed = null; state.mode = 'highlight'; }
    else pickMode(path, text);

    await showEditor();
    const target = '#/' + path.split('/').map(encodeURIComponent).join('/');
    if (location.hash !== target) history.replaceState(null, '', target);
  } catch (e) { toast('打开失败：' + e.message); }
}

/** 重命名/移动文件或目录（一次 Git 提交完成）。成功后若当前文件受影响，会自动打开新路径。 */
export async function renamePath(from, kind) {
  if (!(await checkUnsaved())) return;
  const label = kind === 'dir' ? '目录' : '文件';
  const input = await askInput({
    title: `重命名 / 移动${label}`, message: `输入新的${label}路径（相对于仓库管理目录，可包含 / 以移动位置）：`, defaultValue: from,
  });
  if (input === null) return;
  const to = input.trim().replace(/\/+$/, '');
  if (to === from) return;
  if (!isValidPath(to)) return toast('路径无效：禁止空路径、../ 或反斜杠');

  try {
    const wasOpen = state.current?.path;
    await request('/api/rename', 'POST', {
      from, to, kind,
      message: `Rename ${fileFullPath(from)} → ${fileFullPath(to)}`,
    });
    state.dirty = false;
    let next = null;
    if (wasOpen === from) next = to;
    else if (kind === 'dir' && wasOpen?.startsWith(from + '/')) next = to + wasOpen.slice(from.length);
    if (next) { state.current = null; }
    await refreshFiles();
    if (next) await openFile(next);
    toast('重命名成功，已提交到 GitHub');
  } catch (e) { toast('重命名失败：' + e.message); }
}

export const renameCurrent = () => state.current?.sha && renamePath(state.current.path, 'file');

/** 在编辑器中创建一个尚未提交的新文件（可带初始内容）。 */
function startNewFile(path, text = '') {
  Object.assign(state, {
    current: { path, sha: null, size: 0 },
    binary: false, bytes: new Uint8Array(), original: '', eol: '\n', dirty: true, hlLang: '',
  });
  $('editor').value = text;
  if (text) pickMode(path, text); else { state.fmt = null; state.parsed = null; state.mode = 'highlight'; }
  markDirty();
  return showEditor();
}

/** 询问并校验新路径；通过返回路径，否则返回 null。已存在则直接打开。 */
async function askNewPath(title, message, def) {
  const input = await askInput({ title, message, defaultValue: def });
  if (input === null) return null;
  const path = input.trim();
  if (!isValidPath(path)) { toast('路径无效：禁止空路径、../ 或反斜杠'); return null; }
  const existing = state.files.find(f => f.path === path);
  if (existing) { openFile(existing.path); return null; }
  const conflict = pathConflict(path);
  if (conflict) { toast('路径冲突：' + conflict); return null; }
  return path;
}

export async function newFile(dir = '') {
  if (!(await checkUnsaved())) return;
  const path = await askNewPath('新建文件', '输入新文件路径（相对于仓库管理目录）：', dir ? `${dir}/` : 'example.yaml');
  if (!path) return;
  let content = '';
  const tpls = templatesFor(path);
  if (tpls.length) {
    const id = await askChoice({
      title: '选择模板', message: `为 ${path} 选择一个起始模板：`, okText: '创建',
      options: [{ id: '', name: '空白文件' }, ...tpls.map(t => ({ id: t.id, name: t.name, desc: t.desc }))],
      selected: tpls[0].id,
    });
    if (id === null) return;
    content = tpls.find(t => t.id === id)?.content || '';
  }
  await startNewFile(path, content);
  if (!content) $('editor').focus();
}

/** 复制当前文件（含未保存的修改）为新文件。 */
export async function duplicateCurrent() {
  if (!state.current || state.binary || !(await checkUnsaved())) return;
  const text = getEditorText();
  const dot = state.current.path.lastIndexOf('.');
  const def = dot > state.current.path.lastIndexOf('/')
    ? `${state.current.path.slice(0, dot)}-copy${state.current.path.slice(dot)}`
    : state.current.path + '-copy';
  const path = await askNewPath('复制文件', '复制为（新文件路径）：', def);
  if (!path) return;
  await startNewFile(path, text);
  toast('已创建副本，保存后才会提交');
}

/** Clash / QuantumultX / Shadowrocket 规则互转：生成一个新文件（未提交），不改动原文件。 */
export async function convertCurrent(to) {
  if (!state.current || !CONVERT_TARGETS[state.fmt] || !CONVERT_TARGETS[to] || state.fmt === to) return;
  const target = CONVERT_TARGETS[to].label;
  const { text, converted, skipped, customPolicies } = convertRuleList(parse(state.fmt, getEditorText()), to);
  if (!(await checkUnsaved())) return;
  const path = await askNewPath(`转换为 ${target} 规则`, `转换为 ${target} 规则，保存到：`, suggestConvertedPath(state.current.path, state.fmt, to));
  if (!path) return;
  await startNewFile(path, text);
  const notes = [];
  if (skipped.length) notes.push(`${skipped.length} 条不支持，已保留为注释（${[...new Set(skipped)].slice(0, 5).join('、')}）`);
  if (customPolicies.length) notes.push(`自定义策略组（${customPolicies.slice(0, 3).join('、')}${customPolicies.length > 3 ? ' 等' : ''}）原样保留，请确认目标客户端里存在同名策略`);
  toast(`已转换 ${converted} 条${notes.length ? '；' + notes.join('；') : ''}。保存后才会提交`);
}

/* ---------- 保存 / 删除 / 上传 / 下载 ---------- */

export async function saveFile() {
  if (!state.current || state.binary || state.readonly) return;
  const bytes = textBytes();
  if (bytes.length > state.info.maxWriteBytes) return toast('文件不能超过 768 KiB');

  const { path, sha } = state.current;
  const found = newSecretFindings(new TextDecoder().decode(bytes));
  if (found.length) {
    const publicRepo = state.info.private !== true;
    const ok = await askConfirm({
      title: publicRepo ? '检测到疑似密钥（公开仓库）' : '检测到疑似密钥',
      message: publicRepo
        ? '这个仓库不是私有的：一旦提交，密钥会出现在公开的 Git 历史里，即使之后删除也可能已被抓取。建议改用占位符，并立即轮换已泄露的密钥。'
        : '本次修改新增了疑似密钥的内容，请确认这是你有意提交的。',
      details: found.slice(0, 10).map(f => `第 ${f.line} 行 · ${f.name} · ${f.preview}`),
      okText: '仍然保存', cancelText: '返回修改', danger: publicRepo,
    });
    if (!ok) return;
  }
  $('saveBtn').disabled = true;
  try {
    const out = await request(fileUrl(path), 'PUT', {
      content: b64FromBytes(bytes),
      sha: sha || undefined,
      message: `${sha ? 'Update' : 'Create'} ${fileFullPath(path)}`,
    });
    Object.assign(state.current, { sha: out.sha, size: bytes.length });
    state.bytes = bytes;
    state.original = toLF(getEditorText());
    state.dirty = false;
    if (out.commitSha) state.commitSha = out.commitSha;
    await showEditor();
    await refreshFiles();
    toast('保存成功，已提交到 GitHub');
  } catch (e) {
    toast('保存失败：' + e.message);
    // 409/422：远端文件已被他人修改，提供重新加载的出口
    if (sha && (e.status === 409 || e.status === 422) && await askConfirm({
      title: '远端文件已变化',
      message: '无法保存：远端文件已被修改。是否放弃本地修改并重新加载远端版本？选择"保留当前内容"可先复制备份，再手动重新加载。',
      okText: '放弃本地并重新加载', cancelText: '保留当前内容', danger: true,
    })) {
      await refreshFiles();
      state.current = null; state.dirty = false;
      await openFile(path);
    }
  } finally { $('saveBtn').disabled = state.binary; }
}

export const resetEditor = () => clearEditor();

function clearEditor() {
  Object.assign(state, { current: null, dirty: false, fmt: null, parsed: null, mode: 'highlight' });
  $('editorPanel').hidden = true;
  $('emptyState').hidden = false;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  updateTitle();
}

/** 删除整个目录（一次提交）。 */
export async function deleteFolder(dir) {
  const count = state.files.filter(f => f.path.startsWith(dir + '/')).length;
  if (!count) return toast('目录为空或不存在');
  const affectsCurrent = state.current?.path.startsWith(dir + '/');
  if (affectsCurrent && !(await checkUnsaved())) return;
  if (!await askConfirm({ title: '删除目录', message: `确认删除目录 ${dir}？其中 ${count} 个文件会在一次提交中被删除。`, okText: '删除', danger: true })) return;
  try {
    await request('/api/dir', 'DELETE', { path: dir, message: `Delete ${fileFullPath(dir)}/` });
    if (affectsCurrent) clearEditor();
    await refreshFiles();
    toast(`已删除目录（${count} 个文件）`);
  } catch (e) { toast('删除目录失败：' + e.message); }
}

/** 新路径是否与现有目录/文件冲突；冲突时返回原因。 */
function pathConflict(path) {
  if (state.files.some(f => f.path.startsWith(path + '/'))) return `${path} 已是目录`;
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (state.files.some(f => f.path === parent)) return `${parent} 已是文件，不能作为目录`;
  }
  return '';
}

export async function deleteFile() {
  if (!state.current?.sha) return;
  const { path, sha } = state.current;
  if (!await askConfirm({ title: '删除文件', message: `确认删除 ${path}？该操作会向 GitHub 提交一次删除记录。`, okText: '删除', danger: true })) return;
  $('deleteBtn').disabled = true;
  try {
    await request(fileUrl(path), 'DELETE', { sha, message: `Delete ${fileFullPath(path)}` });
    clearEditor();
    await refreshFiles();
    toast('已从 GitHub 删除文件');
  } catch (e) { toast('删除失败：' + e.message); $('deleteBtn').disabled = false; }
}

/** 上传一个或多个文件。单文件可自定义完整路径；多文件统一指定目录，逐个提交。 */
export async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length || !(await checkUnsaved())) return;
  const max = state.info.maxWriteBytes;
  const tooBig = files.filter(f => f.size > max);
  const ok = files.filter(f => f.size <= max);
  if (tooBig.length) toast(`已跳过 ${tooBig.length} 个超过 768 KiB 的文件：${tooBig.map(f => f.name).join('、')}`);
  if (!ok.length) return;

  const curDir = state.current ? state.current.path.replace(/[^/]+$/, '') : '';
  let targets;
  if (ok.length === 1) {
    const input = await askInput({ title: '上传文件', message: '输入仓库上传路径（相对于管理目录）：', defaultValue: curDir + ok[0].name, okText: '上传' });
    if (input === null) return;
    targets = [input.trim()];
  } else {
    const input = await askInput({
      title: `上传 ${ok.length} 个文件`, message: '输入目标目录（相对于管理目录，留空=根目录）：',
      defaultValue: curDir.replace(/\/$/, ''), okText: '上传',
    });
    if (input === null) return;
    const dir = input.trim().replace(/^\/+|\/+$/g, '');
    targets = ok.map(f => (dir ? `${dir}/${f.name}` : f.name));
  }

  const bad = targets.find(p => !isValidPath(p));
  if (bad !== undefined) return toast(`上传路径无效：${bad || '(空)'}`);
  if (new Set(targets).size !== targets.length) return toast('存在重名文件，请调整后重试');
  const conflict = targets.map(pathConflict).find(Boolean);
  if (conflict) return toast('路径冲突：' + conflict);

  const existing = targets.filter(p => state.files.some(f => f.path === p));
  if (existing.length && !await askConfirm({
    title: '覆盖已有文件', message: `以下 ${existing.length} 个文件已存在，将被覆盖：`,
    details: existing.length > 8 ? [...existing.slice(0, 8), `…另有 ${existing.length - 8} 个`] : existing,
    okText: '覆盖并上传', danger: true,
  })) return;

  let done = 0;
  const failed = [];
  for (const [i, file] of ok.entries()) {
    const path = targets[i];
    if (ok.length > 1) toast(`上传中 ${i + 1}/${ok.length}：${path}`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const put = sha => request(fileUrl(path), 'PUT', {
        sha: sha || undefined, content: b64FromBytes(bytes), message: `Upload ${fileFullPath(path)}`,
      });
      const sha = state.files.find(f => f.path === path)?.sha;
      try { await put(sha); }
      catch (e) {
        // sha 过期（文件刚被改过）：刷新列表后重试一次
        if (e.status !== 409 && e.status !== 422) throw e;
        await refreshFiles();
        await put(state.files.find(f => f.path === path)?.sha);
      }
      done++;
    } catch (e) { failed.push(`${path}（${e.message}）`); }
  }

  await refreshFiles();
  if (done === 1 && ok.length === 1) {
    state.current = null; state.dirty = false;
    await openFile(targets[0]);
  }
  if (failed.length) {
    showAlert('上传完成（部分失败）', `成功 ${done} 个，失败 ${failed.length} 个：`, failed);
  } else toast(`上传成功：${done} 个文件`);
}

export function downloadCurrent() {
  if (!state.current) return;
  const bytes = state.binary ? state.bytes : textBytes();
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = state.current.path.split('/').at(-1);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- 面板显示 / 模式切换 ---------- */

export async function showEditor() {
  const { current, binary, fmt } = state;
  $('emptyState').hidden = true;
  $('editorPanel').hidden = false;
  $('currentPath').textContent = current.path;
  $('shaLabel').textContent = current.sha ? 'SHA ' + current.sha.slice(0, 10) : '新文件';
  $('sizeLabel').textContent = formatSize(current.size || 0);
  $('editor').disabled = binary;
  $('binaryNotice').hidden = !binary;
  $('encodingLabel').textContent = binary ? 'Binary' : 'UTF-8';
  $('saveBtn').disabled = binary;
  $('deleteBtn').disabled = !current.sha;
  $('renameBtn').disabled = !current.sha;
  $('historyBtn').disabled = !current.sha;
  $('accessBtn').disabled = !current.sha;
  $('accessBtn').title = '设置此文件的访问方式';
  $('diffBtn').disabled = binary;
  $('dirtyLabel').hidden = !state.dirty;
  updateTitle();
  $('duplicateBtn').disabled = binary;
  // 只有存在多个视图（可视化 / 预览）时才显示标签页；此时"语法高亮"改称"原始内容"
  const isMd = /\.(md|markdown)$/i.test(current.path);
  document.querySelector('.editor-modes').hidden = binary || !(fmt || isMd);
  document.querySelector('.mode-btn[data-mode="visual"]').hidden = !fmt || binary;
  document.querySelector('.mode-btn[data-mode="highlight"]').hidden = binary;
  document.querySelector('.mode-btn[data-mode="preview"]').hidden = binary || !isMd;
  $('editor').readOnly = state.readonly;
  runLint();

  await applyModeUI();
  renderFiles();
  renderLinks();
}

async function applyModeUI() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });
  const isVisual = state.mode === 'visual' && !!state.fmt;
  const isPreview = state.mode === 'preview';
  const isRaw = !isVisual && !isPreview && !state.binary;
  if (!isVisual && !isPreview) state.mode = 'highlight';
  $('rawEditor').hidden = !isRaw;
  $('previewPanel').hidden = !isPreview;
  if (isPreview) $('previewPanel').replaceChildren(renderMarkdown($('editor').value));
  $('visualPanel').hidden = !isVisual;

  if (!isVisual) $('visualBar').replaceChildren();
  if (isVisual) renderVisualPanel();
  if (isRaw) { renderLangSelect(); await renderHighlight(); }
}

export async function setMode(mode) {
  if (mode === state.mode) return;
  if (state.mode === 'visual' && state.parsed) {
    $('editor').value = serialize(state.parsed);
  } else if (mode === 'visual' && state.fmt) {
    try { state.parsed = parse(state.fmt, $('editor').value); }
    catch (e) { return toast('可视化解析失败：' + e.message); }
  }
  state.mode = mode;
  markDirty();
  await applyModeUI();
}

/* ---------- 语法高亮 ---------- */

function renderLangSelect() {
  const bar = $('highlightBar');
  bar.replaceChildren(makeEl('span', 'hl-lang-label', '语言：'));

  const sel = document.createElement('select');
  sel.className = 'hl-lang-select';
  const auto = makeEl('option', '', '自动检测');
  auto.value = '';
  sel.append(auto);
  for (const lang of allLanguages()) {
    const opt = makeEl('option', '', lang);
    opt.value = lang;
    sel.append(opt);
  }
  sel.value = state.hlLang;
  sel.addEventListener('change', () => { state.hlLang = sel.value; renderHighlight(); });

  state.hlDetectEl = makeEl('span', 'hl-lang-detect');
  bar.append(sel, state.hlDetectEl);
}

const HIGHLIGHT_LIMIT = 300_000; // 超过这个字符数不再逐键高亮，避免输入卡顿
let hlSeq = 0;
let hlFrame = 0;

/** 把 textarea 的内容渲染到下层高亮层（textarea 本身文字透明，只显示光标与选区）。 */
async function renderHighlight() {
  const wrap = $('codeWrap');
  const text = $('editor').value;
  const code = $('highlightCode');
  if (!window.hljs || text.length > HIGHLIGHT_LIMIT) {
    wrap.classList.add('plain');
    if (state.hlDetectEl) state.hlDetectEl.textContent = window.hljs ? ' (文件较大，已关闭高亮)' : '';
    return;
  }
  wrap.classList.remove('plain');

  const seq = ++hlSeq;
  const detected = detectLanguage(state.current?.path || '', text);
  const lang = state.hlLang || detected;
  await ensureLanguageLoaded(lang);
  if (seq !== hlSeq) return; // 已有更新的渲染请求

  code.className = 'language-' + lang;
  code.textContent = text + (text === '' || text.endsWith('\n') ? ' ' : ''); // 末尾空行也要占高度，保证与 textarea 对齐
  delete code.dataset.highlighted;
  try { window.hljs.highlightElement(code); }
  catch (e) { console.warn('[highlight]', e); }
  syncScroll();

  if (state.hlDetectEl) state.hlDetectEl.textContent = ` (${state.hlLang ? lang : '自动 → ' + detected})`;
}

/** 输入时合并到下一帧再渲染。 */
function scheduleHighlight() {
  if (hlFrame) return;
  hlFrame = requestAnimationFrame(() => { hlFrame = 0; if (state.mode === 'highlight') renderHighlight(); });
}

function syncScroll() {
  const ta = $('editor');
  const pre = $('highlightCode').parentElement;
  pre.scrollTop = ta.scrollTop;
  pre.scrollLeft = ta.scrollLeft;
}

/* ---------- 文本框事件 ---------- */

export function bindEditorEvents() {
  const editor = $('editor');
  editor.addEventListener('input', scheduleHighlight);
  editor.addEventListener('scroll', syncScroll);
  $('formatBtn').addEventListener('click', () => reformatJson(false));
  $('minifyBtn').addEventListener('click', () => reformatJson(true));
  $('convertDataBtn').addEventListener('click', convertDataCurrent);
  $('lintLabel').addEventListener('click', () => { if (state.lint && !state.lint.ok && state.lint.line) gotoLine(state.lint.line, state.lint.col || 1); });
  editor.addEventListener('input', markDirty);
  editor.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !state.readonly) {
      e.preventDefault();
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input'));
    }
  });
  // Ctrl/Cmd+S 在任何编辑模式下都可保存（可视化、高亮模式里没有焦点在文本框）
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (state.current && !$('editorPanel').hidden) saveFile();
    }
  });
  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}
