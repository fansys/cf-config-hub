'use strict';
// 所有不可信的 GitHub 名称/内容都用 textContent 插入，从不 innerHTML

/* ============================================================
 *  工具
 * ============================================================ */

const $ = id => document.getElementById(id);

let toastTimer;
function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3600);
}

function makeEl(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.textContent = text;
  return e;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function encPath(s) { return s.split('/').map(encodeURIComponent).join('/'); }
function fileFullPath(s) { return state.info?.root ? `${state.info.root}/${s}` : s; }

function b64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(binary);
}
function bytesFromB64(s) {
  const raw = atob(s.replace(/\s/g, ''));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

function textBytes() {
  const raw = state.mode === 'visual' && state.parsed
    ? window.VisualEditors.serialize(state.parsed)
    : $('editor').value;
  return new TextEncoder().encode(raw);
}
function getEditorText() {
  return state.mode === 'visual' && state.parsed
    ? window.VisualEditors.serialize(state.parsed)
    : $('editor').value;
}

/* ============================================================
 *  全局 state（所有字段在此声明，避免隐式创建）
 * ============================================================ */

const state = {
  // 鉴权
  token: '', remember: false,
  // 仓库
  info: null,        // /api/info 返回
  files: [],         // /api/files 返回
  commitSha: '',     // 分支最新 commit
  // 当前文件
  current: null,     // { path, sha, size }
  original: '',      // 原始文本（脏标记基线）
  bytes: null,       // 原始二进制
  binary: false,
  dirty: false,
  // UI 状态
  foldersOpen: new Set(),
  // 可视化编辑
  fmt: null,         // 'clash-list' | 'clash-ini' | 'qx-list' | null
  parsed: null,      // VisualEditors.parse() 返回
  mode: 'text',      // 'text' | 'visual' | 'highlight'
  // 语法高亮
  hlLang: '',               // 用户手动选的语言，''= 自动检测
  hlLangDetectEl: null,     // 用来显示"自动 → xxx"的 <span>
};

/* ============================================================
 *  API 封装
 * ============================================================ */

async function request(url, method = 'GET', body) {
  const headers = {};
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      // 管理接口返回 401 → 清 token 跳登录页（公开接口如 /api/info 不带 token 时 401 是正常的）
      if (state.token) { logout(false); }
      throw new Error(data.error || '需要登录');
    }
    throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
  }
  return data;
}

/* ============================================================
 *  登录 / 登出 / 刷新
 * ============================================================ */

async function login(token) {
  state.token = token;
  const info = await request('/api/info');
  state.info = info;
  if (state.remember) sessionStorage.setItem('cfhub-token', token);

  $('loginView').hidden = true;
  $('appView').hidden = false;
  updateRepoHeader(info);

  await refreshFiles();

  // 恢复 hash 指向的文件
  const hashPath = readHashPath();
  if (hashPath) {
    const file = state.files.find(f => f.path === hashPath);
    if (file) openFile(file.path).catch(() => {});
  }
  toast('已连接 GitHub 仓库');
}

function logout(show = true) {
  state.token = '';
  state.current = null;
  state.parsed = null;
  sessionStorage.removeItem('cfhub-token');
  $('appView').hidden = true;
  $('loginView').hidden = false;
  $('tokenInput').value = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (show) toast('已退出管理后台');
}

function updateRepoHeader(info) {
  $('repoName').textContent = `${info.owner}/${info.repo}`;
  $('repoBadge').textContent = `${info.owner}/${info.repo} · ${info.branch}`;
  $('branchLabel').textContent = `分支: ${info.branch}${info.root ? ' · 目录: /' + info.root : ' · 整个仓库'}`;
  const privText = info.private === null ? '（无 PAT，未知是否私有）'
    : info.private ? '私有仓库（Worker 代理带 PAT；其他直连不可用）'
    : '公开仓库（所有链接可分发）';
  $('repoVisibility').textContent = privText;
}

async function refreshFiles() {
  const data = await request('/api/files');
  state.files = data.files;
  state.commitSha = data.commitSha || '';
  $('fileCount').textContent = `${state.files.length} 个文件`;
  renderFiles();
  if (state.current) renderLinks();
}

/* ============================================================
 *  Hash 路由
 * ============================================================ */

function readHashPath() {
  const h = location.hash;
  if (!h.startsWith('#/')) return null;
  try { return h.slice(2).split('/').map(decodeURIComponent).join('/'); }
  catch { return null; }
}

function navigateFromHash() {
  if (!state.token) return;   // 无 token 时 hashchange 不处理（主入口 bootstrap 会做）
  if (!state.current) return;
  const p = readHashPath();
  if (!p) return;
  if (state.current.path === p) return;
  const file = state.files.find(f => f.path === p);
  if (file) openFile(file.path).catch(() => {});
}

/* ============================================================
 *  文件树渲染
 * ============================================================ */

function renderFiles() {
  const q = $('searchInput').value.toLowerCase().trim();
  const list = $('fileList');
  list.replaceChildren();
  const filtered = state.files.filter(f => f.path.toLowerCase().includes(q));
  if (!filtered.length) {
    list.appendChild(makeEl('div', 'footnote', q ? '没有匹配的文件' : '仓库目录暂无文件'));
    return;
  }
  if (q) {
    filtered.forEach(f => appendFile(list, f, f.path.split('/').at(-1)));
    return;
  }
  // 构建树
  const tree = { dirs: new Map(), files: [] };
  for (const f of filtered) {
    const parts = f.path.split('/');
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  appendTree(list, tree, '');
}

function appendTree(parent, node, parentPath) {
  for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))) {
    const path = parentPath ? parentPath + '/' + name : name;
    const folder = makeEl('button', 'folder-item');
    folder.type = 'button';
    const isOpen = !state.foldersOpen.has('CLOSED:' + path);
    folder.append(makeEl('span', 'icon', isOpen ? '▾' : '▸'), makeEl('span', 'label', name));
    parent.append(folder);
    const children = makeEl('div', 'folder-children');
    children.hidden = !isOpen;
    parent.append(children);
    folder.addEventListener('click', () => {
      const nowOpen = children.hidden;
      if (nowOpen) state.foldersOpen.delete('CLOSED:' + path);
      else state.foldersOpen.add('CLOSED:' + path);
      children.hidden = !nowOpen;
      folder.querySelector('.icon').textContent = nowOpen ? '▾' : '▸';
    });
    appendTree(children, child, path);
  }
  for (const f of node.files) appendFile(parent, f, f.path.split('/').at(-1));
}

function appendFile(parent, f, label) {
  const btn = makeEl('button', 'file-item' + (state.current?.path === f.path ? ' active' : ''));
  btn.type = 'button';
  btn.title = f.path;
  btn.append(
    makeEl('span', 'icon', '▤'),
    makeEl('span', 'label', label),
    makeEl('span', 'file-size', f.size ? formatSize(f.size) : ''),
  );
  btn.addEventListener('click', () => openFile(f.path));
  parent.append(btn);
}

function isValidPath(path) {
  return !!path && path.length <= 500 && !path.startsWith('/') && !path.endsWith('/') &&
    !path.includes('\\') && !path.includes('//') && !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split('/').some(s => s === '.' || s === '..') &&
    path !== '.github/workflows' && !path.startsWith('.github/workflows/');
}

/* ============================================================
 *  文件打开 / 新建 / 保存 / 删除 / 上传
 * ============================================================ */

function checkUnsaved() {
  return !state.dirty || confirm('当前文件有未保存的修改，确定放弃吗？');
}

async function openFile(path) {
  if (state.current?.path === path) return;
  if (!checkUnsaved()) return;
  try {
    const data = await request('/api/file?path=' + encodeURIComponent(path));
    const bytes = bytesFromB64(data.content);
    let text = '';
    let binary = bytes.includes(0);
    if (!binary) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { binary = true; }
    }
    state.current = { path, sha: data.sha, size: data.size };
    state.bytes = bytes;
    state.original = text;
    state.binary = binary;
    state.dirty = false;
    state.fmt = null;
    state.parsed = null;
    state.mode = 'text';
    state.hlLang = '';
    $('editor').value = text;

    // 尝试识别格式 → 决定默认进入哪种模式
    if (!binary && window.VisualEditors) {
      try {
        const fmt = window.VisualEditors.detectFormat(path, text);
        if (fmt) {
          state.fmt = fmt;
          state.parsed = window.VisualEditors.parse(fmt, text);
          state.mode = 'visual';
        } else if (window.hljs) {
          state.mode = 'highlight';
        }
      } catch { state.fmt = null; state.parsed = null; }
    }

    await showEditor();
    const target = '#/' + path.split('/').map(encodeURIComponent).join('/');
    if (location.hash !== target) history.replaceState(null, '', target);
  } catch (e) { toast('打开失败：' + e.message); }
}

function newFile() {
  if (!checkUnsaved()) return;
  const path = prompt('输入新文件路径（相对于仓库管理目录）：', 'example.yaml');
  if (path === null) return;
  const trimmed = path.trim();
  if (!isValidPath(trimmed)) return toast('路径无效：禁止空路径、../ 或反斜杠');
  const existing = state.files.find(f => f.path === trimmed);
  if (existing) return openFile(existing.path);

  state.current = { path: trimmed, sha: null, size: 0 };
  state.binary = false;
  state.bytes = new Uint8Array();
  state.original = '';
  state.dirty = true;
  $('editor').value = '';
  showEditor();
  $('editor').focus();
}

async function saveFile() {
  if (!state.current || state.binary) return;
  const bytes = textBytes();
  if (bytes.length > state.info.maxWriteBytes) return toast('文件不能超过 768 KiB');
  const path = state.current.path;
  $('saveBtn').disabled = true;
  try {
    const out = await request('/api/file?path=' + encodeURIComponent(path), 'PUT', {
      content: b64FromBytes(bytes),
      sha: state.current.sha || undefined,
      message: `${state.current.sha ? 'Update' : 'Create'} ${fileFullPath(path)}`,
    });
    state.current.sha = out.sha;
    state.current.size = bytes.length;
    state.bytes = bytes;
    // 保存后用序列化结果作为新的 original 基线
    state.original = getEditorText();
    state.dirty = false;
    if (out.commitSha) state.commitSha = out.commitSha;
    await showEditor();
    await refreshFiles();
    toast('保存成功，已提交到 GitHub');
  } catch (e) { toast('保存失败：' + e.message); }
  finally { $('saveBtn').disabled = state.binary; }
}

async function deleteFile() {
  if (!state.current?.sha) return;
  const { path, sha } = state.current;
  if (!confirm(`确认删除 ${path}？\n该操作会向 GitHub 提交一次删除记录。`)) return;
  $('deleteBtn').disabled = true;
  try {
    await request('/api/file?path=' + encodeURIComponent(path), 'DELETE', {
      sha, message: `Delete ${fileFullPath(path)}`,
    });
    state.current = null;
    state.dirty = false;
    state.fmt = null; state.parsed = null; state.mode = 'text';
    $('editorPanel').hidden = true;
    $('emptyState').hidden = false;
    await refreshFiles();
    toast('已从 GitHub 删除文件');
  } catch (e) { toast('删除失败：' + e.message); $('deleteBtn').disabled = false; }
}

async function uploadFile(file) {
  if (!file || !checkUnsaved()) return;
  if (file.size > state.info.maxWriteBytes) return toast('上传文件不能超过 768 KiB');
  const suggested = state.current ? state.current.path.replace(/[^/]+$/, '') + file.name : file.name;
  const path = prompt('输入仓库上传路径（相对于管理目录）：', suggested);
  if (path === null) return;
  const p = path.trim();
  if (!isValidPath(p)) return toast('上传路径无效');
  const found = state.files.find(f => f.path === p);
  if (found && !confirm(`${p} 已存在，确定覆盖吗？`)) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await request('/api/file?path=' + encodeURIComponent(p), 'PUT', {
      sha: found?.sha || undefined,
      content: b64FromBytes(bytes),
      message: `Upload ${fileFullPath(p)}`,
    });
    await refreshFiles();
    state.current = null; state.dirty = false;
    await openFile(p);
    toast('文件上传成功');
  } catch (e) { toast('上传失败：' + e.message); }
}

function downloadCurrent() {
  if (!state.current) return;
  const bytes = state.binary ? state.bytes : textBytes();
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.current.path.split('/').at(-1);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ============================================================
 *  编辑器面板显示 / 模式切换
 * ============================================================ */

async function showEditor() {
  $('emptyState').hidden = true;
  $('editorPanel').hidden = false;
  $('currentPath').textContent = state.current.path;
  $('shaLabel').textContent = state.current.sha
    ? 'SHA ' + state.current.sha.slice(0, 10)
    : '新文件';
  $('sizeLabel').textContent = formatSize(state.current.size || 0);
  $('editor').hidden = state.binary;
  $('editor').disabled = state.binary;
  $('binaryNotice').hidden = !state.binary;
  $('encodingLabel').textContent = state.binary ? 'Binary' : 'UTF-8';
  $('saveBtn').disabled = state.binary;
  $('deleteBtn').disabled = !state.current.sha;
  $('dirtyLabel').hidden = !state.dirty;
  // 模式按钮显隐
  const visualBtn = document.querySelector('.mode-btn[data-mode="visual"]');
  const hlBtn = document.querySelector('.mode-btn[data-mode="highlight"]');
  visualBtn.hidden = !state.fmt || state.binary;
  hlBtn.hidden = state.binary;

  await applyModeUI();
  renderFiles();
  renderLinks();
}

async function applyModeUI() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });
  const isVisual = state.mode === 'visual' && !!state.fmt;
  const isHl = state.mode === 'highlight' && !!window.hljs;
  $('editor').hidden = isVisual || isHl;
  $('visualPanel').hidden = !isVisual;
  $('highlightViewer').hidden = !isHl;

  if (isVisual) renderVisualPanel();
  if (isHl) { renderHighlightLangSelect(); await renderHighlight(); }
}

async function setMode(mode) {
  if (mode === state.mode) return;

  // 模式切换：双向同步数据
  if (state.mode === 'visual' && state.parsed) {
    $('editor').value = window.VisualEditors.serialize(state.parsed);
  } else if (mode === 'visual' && state.fmt) {
    try {
      state.parsed = window.VisualEditors.parse(state.fmt, $('editor').value);
    } catch (e) { toast('可视化解析失败：' + e.message); return; }
  }
  state.mode = mode;
  state.dirty = getEditorText() !== state.original;
  $('dirtyLabel').hidden = !state.dirty;
  $('sizeLabel').textContent = formatSize(textBytes().length);
  await applyModeUI();
}

/* ---------- 语法高亮 ---------- */

function renderHighlightLangSelect() {
  const bar = $('highlightBar');
  if (!bar) return;
  bar.innerHTML = '';

  const label = makeEl('span', 'hl-lang-label', '语言：');
  bar.appendChild(label);

  const sel = document.createElement('select');
  sel.className = 'hl-lang-select';
  const autoOpt = makeEl('option', '', '自动检测');
  autoOpt.value = '';
  autoOpt.selected = !state.hlLang;
  sel.appendChild(autoOpt);

  const langs = window.VisualEditors?.allHljsLanguages?.() || [];
  for (const l of langs) {
    const opt = makeEl('option', '', l);
    opt.value = l;
    if (state.hlLang === l) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    state.hlLang = sel.value;
    renderHighlight();
  });
  bar.appendChild(sel);

  const det = makeEl('span', 'hl-lang-detect', '');
  bar.appendChild(det);
  state.hlLangDetectEl = det;
}

async function renderHighlight() {
  if (!window.hljs) return;
  const text = $('editor').value;
  const detected = window.VisualEditors?.detectLanguage?.(state.current?.path || '', text) || 'plaintext';
  const lang = state.hlLang || detected;

  if (window.VisualEditors?.ensureLanguageLoaded) {
    await window.VisualEditors.ensureLanguageLoaded(lang);
  }

  const codeEl = $('highlightCode');
  codeEl.className = 'language-' + lang;
  codeEl.textContent = text;
  // highlight.js 的 highlightElement() 会给元素加 data-highlighted="yes" 守卫
  delete codeEl.dataset.highlighted;

  try { window.hljs.highlightElement(codeEl); }
  catch (e) { console.warn('[highlight]', e); }

  if (state.hlLangDetectEl) {
    const actual = state.hlLang ? lang : ('自动 → ' + detected);
    state.hlLangDetectEl.textContent = ' (' + actual + ')';
  }
}

/* ============================================================
 *  文件链接面板
 * ============================================================ */

function fileLinks() {
  const rootPath = fileFullPath(state.current.path);
  const p = encPath(rootPath);
  const owner = encodeURIComponent(state.info.owner);
  const repo = encodeURIComponent(state.info.repo);
  const branch = encodeURIComponent(state.info.branch);
  const rev = state.commitSha;
  const worker = location.origin + '/file/' + encPath(state.current.path);
  return [
    { title: 'GitHub Raw · 直连',   hint: 'GitHub 原始文件地址（公开仓库可用）',      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}` },
    { title: 'jsDelivr · 分支 CDN', hint: 'jsDelivr CDN 分支版本',                    url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${p}` },
    { title: 'jsDelivr · 固定 Commit', hint: '不可变的固定 commit 版本',                url: rev ? `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${rev}/${p}` : '' },
    { title: 'Cloudflare Worker · 稳定链接', hint: 'Worker 统一代理（私有仓库唯一可用路径）', url: worker, worker: true },
    { title: 'Cloudflare Worker · 固定 Commit', hint: 'Worker 固定版本',                 url: rev ? `${worker}?v=${rev}` : '', worker: true },
  ];
}

function renderLinks() {
  if (!state.current || !state.info) return;
  const warning = $('publicWarning');
  const list = $('linkList');
  list.replaceChildren();

  const sha = state.current.sha;
  const isPrivate = !!state.info.private;
  const publicFiles = !!state.info.publicFiles;

  // 顶部提示
  if (!sha) {
    warning.textContent = '当前是未保存的新文件：请先保存到 GitHub，再使用文件访问链接。';
    warning.hidden = false;
  } else if (isPrivate) {
    warning.textContent = '私有仓库：GitHub Raw / jsDelivr 直连不可用；Worker 代理带 PAT 读取，请妥善保管 Worker 域名。';
    warning.hidden = false;
  } else if (!publicFiles) {
    warning.textContent = 'PUBLIC_FILES 已关闭：Worker 代理不可用；GitHub Raw / jsDelivr 仍可访问（公开仓库）。';
    warning.hidden = false;
  } else {
    warning.hidden = true;
  }

  for (const item of fileLinks()) {
    const card = makeEl('article', 'link-card');
    const top = makeEl('div', 'link-top');
    top.append(makeEl('span', 'link-title', item.title));
    const actions = makeEl('div', 'link-actions');

    let enabled = !!item.url && !!sha;
    if (item.worker) enabled = enabled && publicFiles;
    else enabled = enabled && !isPrivate;

    const copy = makeEl('button', '', '复制');
    copy.disabled = !enabled;
    copy.addEventListener('click', () => copyText(item.url));

    const open = makeEl('a', '', '打开');
    open.href = enabled ? item.url : '#';
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    if (!enabled) { open.removeAttribute('href'); open.style.opacity = '.4'; }

    actions.append(copy, open);
    top.append(actions);
    card.append(
      top,
      makeEl('p', 'link-hint', item.hint),
      makeEl('div', 'link-url', item.url || '暂未获取 Commit SHA'),
    );
    list.append(card);
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('链接已复制到剪贴板'); }
  catch { toast('浏览器未授权复制，请选中文本手动复制'); }
}

function parseGitHubLink() {
  const input = prompt('粘贴本仓库的 GitHub 文件、Raw、jsDelivr 或 Worker 链接：');
  if (!input) return;
  try {
    const u = new URL(input.trim());
    const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const { owner, repo, branch, root } = state.info;
    const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
    let path = '';
    if (eq(u.hostname, 'github.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === 'blob' && seg[3] === branch) {
      path = seg.slice(4).join('/');
    } else if (eq(u.hostname, 'raw.githubusercontent.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === branch) {
      path = seg.slice(3).join('/');
    } else if (eq(u.hostname, 'cdn.jsdelivr.net') && seg[0] === 'gh' && eq(seg[1], owner) && seg[2]?.startsWith(repo + '@')) {
      const ref = seg[2].slice(repo.length + 1);
      if (ref === branch) path = seg.slice(3).join('/');
    } else if (u.origin === location.origin && seg[0] === 'file') {
      path = root ? root + '/' + seg.slice(1).join('/') : seg.slice(1).join('/');
    }
    if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
    if (!path || !isValidPath(path)) throw new Error('链接不属于当前管理仓库或分支');
    const file = state.files.find(f => f.path === path);
    if (!file) throw new Error('找不到对应文件，请先刷新文件列表');
    openFile(file.path);
  } catch (e) { toast('解析失败：' + e.message); }
}

/* ============================================================
 *  可视化面板渲染（委托 visual-editors.js 解析器）
 * ============================================================ */

function renderVisualPanel() {
  const panel = $('visualPanel');
  panel.replaceChildren();
  const fmt = state.fmt;
  const topBar = makeEl('div', 'vp-topbar');
  topBar.append(makeEl('span', 'vp-title', formatFmtLabel(fmt)));

  const addBar = makeEl('div', 'vp-addbar');
  const addRuleBtn = makeEl('button', 'btn primary small', '＋ 添加规则');
  addRuleBtn.onclick = () => listAddRule();
  addBar.append(addRuleBtn);

  if (fmt === 'clash-ini') {
    const addRulesetBtn = makeEl('button', 'btn secondary small', '＋ 添加 ruleset');
    addRulesetBtn.onclick = () => iniAddRuleset();
    const addPGBtn = makeEl('button', 'btn secondary small', '＋ 添加 proxy_group');
    addPGBtn.onclick = () => iniAddProxyGroup();
    addBar.append(addRulesetBtn, addPGBtn);
  }
  const batchBtn = makeEl('button', 'btn ghost small', '📋 批量粘贴');
  batchBtn.onclick = () => batchPaste();
  addBar.append(batchBtn);
  topBar.append(addBar);
  panel.append(topBar);

  if (fmt === 'clash-ini') renderClashIni(panel);
  else renderRuleList(panel);
}

function formatFmtLabel(fmt) {
  return {
    'clash-list': 'Clash 规则列表',
    'clash-ini': 'Clash 订阅增强 (.ini)',
    'qx-list': 'QuantumultX 规则列表',
  }[fmt] || fmt;
}

function markDirty() {
  state.dirty = getEditorText() !== state.original;
  $('dirtyLabel').hidden = !state.dirty;
  $('sizeLabel').textContent = formatSize(textBytes().length);
}

/* ---------- Clash .list / QX .list ---------- */

function renderRuleList(panel) {
  const items = state.parsed.items;
  const list = makeEl('div', 'rule-list');
  items.forEach((it, idx) => list.append(renderRuleRow(it, idx)));
  panel.append(list);
  attachDragListeners(list);
}

function renderRuleRow(it, idx) {
  const row = makeEl('div', 'rule-row');
  row.dataset.idx = idx;
  if (!it.enabled || !it.type) row.classList.add('disabled');

  const enabledChk = document.createElement('input');
  enabledChk.type = 'checkbox';
  enabledChk.className = 'rule-enabled';
  enabledChk.checked = it.enabled !== false;
  enabledChk.title = '勾选=启用规则，取消=注释掉';
  enabledChk.addEventListener('change', () => {
    it.enabled = enabledChk.checked;
    row.classList.toggle('disabled', !enabledChk.checked || !it.type);
    markDirty();
  });

  const drag = makeEl('span', 'rule-drag', '⋮⋮');

  const TYPES = state.fmt === 'qx-list' ? window.VisualEditors.QX_RULE_TYPES : window.VisualEditors.CLASH_RULE_TYPES;
  const ACTIONS = state.fmt === 'qx-list' ? window.VisualEditors.QX_ACTIONS : window.VisualEditors.CLASH_ACTIONS;

  const typeSel = makeEl('select', 'rule-type');
  for (const t of TYPES) {
    const o = makeEl('option', '', t === '' ? '-' : t);
    if (t === it.type) o.selected = true;
    typeSel.append(o);
  }
  if (it.type && !TYPES.includes(it.type)) {
    const o = makeEl('option', '', it.type);
    o.selected = true; o.hidden = true; typeSel.append(o);
  }
  typeSel.onchange = () => {
    it.type = typeSel.value === '-' ? '' : typeSel.value;
    row.classList.toggle('disabled', !it.enabled || !it.type);
    markDirty();
  };

  const ruleInput = makeEl('input', 'rule-input');
  ruleInput.placeholder = state.fmt === 'qx-list' ? '域名 / IP' : '域名 / IP / CIDR';
  ruleInput.value = it.rule || '';
  ruleInput.oninput = () => { it.rule = ruleInput.value; markDirty(); };

  const actSel = makeEl('select', 'rule-action');
  actSel.append(makeEl('option', '', '(无)'));
  for (const a of ACTIONS) {
    const o = makeEl('option', '', a);
    if (a === it.action) o.selected = true;
    actSel.append(o);
  }
  if (it.action && !ACTIONS.includes(it.action)) {
    const o = makeEl('option', '', it.action);
    o.selected = true; o.hidden = true; actSel.append(o);
  }
  actSel.onchange = () => { it.action = actSel.value; markDirty(); };

  row.append(enabledChk, drag, typeSel, ruleInput, actSel, makeRowActions(idx));
  return row;
}

function makeRowActions(idx) {
  const box = makeEl('div', 'rule-actions');
  const up = makeEl('button', 'btn tiny', '↑');
  up.title = '上移';
  up.onclick = () => moveItem(idx, -1);
  const down = makeEl('button', 'btn tiny', '↓');
  down.title = '下移';
  down.onclick = () => moveItem(idx, 1);
  const del = makeEl('button', 'btn tiny danger', '✕');
  del.title = '删除';
  del.onclick = () => {
    state.parsed.items.splice(idx, 1);
    markDirty();
    renderVisualPanel();
  };
  box.append(up, down, del);
  return box;
}

function moveItem(idx, dir) {
  const arr = state.parsed.items;
  const j = idx + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  markDirty();
  renderVisualPanel();
}

/* ---------- Pointer Events 拖拽 ---------- */

function attachDragListeners(list) {
  let drag = null;

  list.addEventListener('pointerdown', e => {
    // 避开 input/select/button/textarea 上的交互
    if (e.target.closest('input,select,button,textarea')) return;
    const row = e.target.closest('.rule-row');
    if (!row) return;

    const rect = row.getBoundingClientRect();
    drag = {
      row,
      fromIdx: Number(row.dataset.idx),
      startY: e.clientY,
      startTop: rect.top,
      ghost: row.cloneNode(true),
      active: false,
      targetIdx: Number(row.dataset.idx),
      insertBefore: true,
    };

    // ghost：跟随鼠标的半透明副本，脱离 DOM 流
    const ghost = drag.ghost;
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('rule-row');   // 关键：让 ghost 不被 .rule-row 选择器命中
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', pointerEvents: 'none', zIndex: '9999',
    });
    document.body.append(ghost);
    row.classList.add('dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    e.preventDefault();
  });

  function onMove(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.active && Math.abs(dy) > 5) drag.active = true;
    if (!drag.active) return;

    drag.ghost.style.top = (drag.startTop + dy) + 'px';
    list.querySelectorAll('.rule-row.drop-before,.rule-row.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));

    const target = document.elementFromPoint(e.clientX + 10, e.clientY);
    const targetRow = target ? target.closest('.rule-row') : null;
    if (targetRow && targetRow !== drag.row) {
      const mid = targetRow.getBoundingClientRect().top + targetRow.getBoundingClientRect().height / 2;
      const before = e.clientY < mid;
      targetRow.classList.add(before ? 'drop-before' : 'drop-after');
      drag.targetIdx = Number(targetRow.dataset.idx);
      drag.insertBefore = before;
    }
  }

  function onUp() {
    if (!drag) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);

    drag.ghost.remove();
    drag.row.classList.remove('dragging');
    list.querySelectorAll('.rule-row.drop-before,.rule-row.drop-after')
      .forEach(el => el.classList.remove('drop-before', 'drop-after'));

    if (drag.active && drag.targetIdx !== drag.fromIdx) {
      let to = drag.insertBefore ? drag.targetIdx : drag.targetIdx + 1;
      if (drag.fromIdx < to) to -= 1;

      const arr = state.parsed.items;
      const [m] = arr.splice(drag.fromIdx, 1);
      arr.splice(to, 0, m);
      markDirty();
      renderVisualPanel();
    }
    drag = null;
  }
}

/* ---------- Clash .ini ---------- */

function renderClashIni(panel) {
  for (const [si, sec] of state.parsed.sections.entries()) {
    const secBox = makeEl('div', 'ini-section');
    const head = makeEl('div', 'ini-section-head');
    head.append(makeEl('span', 'ini-section-title', `[${sec.section}]`));
    secBox.append(head);

    const body = makeEl('div', 'ini-section-body');
    for (const [ei, e] of sec.entries.entries()) {
      body.append(renderIniEntry(e, si, ei));
    }
    secBox.append(body);
    panel.append(secBox);
  }
}

function renderIniEntry(e, si, ei) {
  const row = makeEl('div', 'ini-row');
  row.classList.add('kind-' + (e.kind || 'other'));
  row.dataset.section = si;
  row.dataset.entry = ei;

  const delBtn = makeEl('button', 'btn tiny danger', '✕');
  delBtn.title = '删除';
  delBtn.onclick = () => {
    state.parsed.sections[si].entries.splice(ei, 1);
    markDirty();
    renderVisualPanel();
  };

  if (e.kind === 'blank') {
    row.append(makeEl('div', 'rule-empty', '— 空行 —'), delBtn);
    return row;
  }

  if (e.kind === 'comment') {
    const inp = makeEl('input', 'rule-comment-input');
    inp.value = e.text;
    inp.oninput = () => { e.text = inp.value; markDirty(); };
    const sigil = (e.text.startsWith('//') ? '//' : (e.text.startsWith(';') ? ';' : '#'));
    row.append(makeEl('span', 'rule-type-badge comment', sigil), inp, delBtn);
    return row;
  }

  if (e.kind === 'kv') {
    const kInp = makeEl('input', 'ini-kv-key');
    kInp.value = e.key;
    kInp.oninput = () => { e.key = kInp.value; markDirty(); };
    const vInp = makeEl('input', 'ini-kv-val');
    vInp.value = e.value;
    vInp.oninput = () => { e.value = vInp.value; markDirty(); };
    row.append(kInp, makeEl('span', 'ini-eq', '='), vInp, delBtn);
    return row;
  }

  if (e.kind === 'ruleset') {
    const card = makeEl('div', 'ini-ruleset-card');
    const head = makeEl('div', 'ini-ruleset-head');
    const kw = makeEl('span', 'ini-kw', 'ruleset=');
    const labelInp = makeEl('input', 'ini-label');
    labelInp.value = e.label;
    labelInp.placeholder = '标签';
    labelInp.oninput = () => { e.label = labelInp.value; markDirty(); };

    const typeSel = makeEl('select', 'ini-ruleset-type');
    const urlOpt = makeEl('option', '', '外部 URL');
    const embedOpt = makeEl('option', '', '内嵌规则');
    if (!e.embedded) urlOpt.selected = true; else embedOpt.selected = true;
    typeSel.append(urlOpt, embedOpt);
    typeSel.onchange = () => {
      if (typeSel.value === '外部 URL') { e.url = e.url || ''; e.embedded = null; }
      else { e.url = ''; e.embedded = e.embedded || { type: 'GEOIP', rule: '' }; }
      markDirty(); renderVisualPanel();
    };
    head.append(kw, labelInp, typeSel);
    card.append(head);

    const body = makeEl('div', 'ini-ruleset-body');
    if (!e.embedded) {
      const urlInp = makeEl('input', 'ini-url');
      urlInp.value = e.url;
      urlInp.placeholder = 'https://raw.githubusercontent.com/.../xxx.list';
      urlInp.oninput = () => { e.url = urlInp.value; markDirty(); };
      body.append(urlInp);
    } else {
      body.append(makeEl('span', 'ini-bracket', '['));
      const tSel = makeEl('select', 'ini-embed-type');
      for (const t of ['GEOSITE', 'GEOIP', 'FINAL', 'DOMAIN', 'DOMAIN-KEYWORD']) {
        const o = makeEl('option', '', t);
        if (t === e.embedded.type) o.selected = true;
        tSel.append(o);
      }
      tSel.onchange = () => { e.embedded.type = tSel.value; markDirty(); };
      const rInp = makeEl('input', 'ini-embed-rule');
      rInp.value = e.embedded.rule;
      rInp.placeholder = 'CN / facebook.com';
      rInp.oninput = () => { e.embedded.rule = rInp.value; markDirty(); };
      body.append(tSel, makeEl('span', 'ini-bracket', ', '), rInp, makeEl('span', 'ini-bracket', ']'));
    }
    card.append(body);
    row.append(card, delBtn);
    return row;
  }

  if (e.kind === 'proxy_group') {
    const box = makeEl('div', 'ini-pgroup');
    const head = makeEl('div', 'ini-pg-head');
    head.append(makeEl('span', 'ini-kw', 'custom_proxy_group='));
    const nameInp = makeEl('input', 'ini-pg-name');
    nameInp.value = e.name;
    nameInp.placeholder = '节点选择';
    nameInp.oninput = () => { e.name = nameInp.value; markDirty(); };
    const stratSel = makeEl('select', 'ini-pg-strategy');
    for (const s of ['select', 'url-test', 'fallback', 'domain-test', 'load-balance']) {
      const o = makeEl('option', '', s);
      if (s === e.strategy) o.selected = true;
      stratSel.append(o);
    }
    stratSel.onchange = () => {
      e.strategy = stratSel.value;
      if (e.strategy === 'select' && !e.members) e.members = [];
      if (e.strategy !== 'select') { e.filters = e.filters || '.*'; e.url = e.url || ''; }
      markDirty(); renderVisualPanel();
    };
    head.append(nameInp, stratSel);
    box.append(head);

    if (e.strategy === 'select') {
      const memBox = makeEl('div', 'ini-pg-members');
      for (const [mi, m] of (e.members || []).entries()) {
        const line = makeEl('div', 'ini-pg-member');
        const prefixInp = makeEl('input', 'ini-pg-prefix');
        prefixInp.value = m.prefix || '';
        prefixInp.placeholder = '[]';
        prefixInp.maxLength = 2;
        prefixInp.oninput = () => { m.prefix = prefixInp.value; markDirty(); };

        const name = makeEl('input', 'ini-pg-name2');
        name.value = m.name || '';
        name.placeholder = '节点名 / DIRECT / REJECT / 子组';
        name.oninput = () => { m.name = name.value; markDirty(); };

        const starChk = document.createElement('input');
        starChk.type = 'checkbox';
        starChk.className = 'ini-pg-star';
        starChk.checked = !!m.glob;
        starChk.onchange = () => { m.glob = starChk.checked; markDirty(); };
        const starLbl = makeEl('label', '', '.* 通配');
        starLbl.prepend(starChk);

        const up = makeEl('button', 'btn tiny', '↑');
        up.onclick = () => {
          if (mi > 0) { [e.members[mi - 1], e.members[mi]] = [e.members[mi], e.members[mi - 1]]; markDirty(); renderVisualPanel(); }
        };
        const down = makeEl('button', 'btn tiny', '↓');
        down.onclick = () => {
          if (mi < e.members.length - 1) { [e.members[mi + 1], e.members[mi]] = [e.members[mi], e.members[mi + 1]]; markDirty(); renderVisualPanel(); }
        };
        const md = makeEl('button', 'btn tiny danger', '✕');
        md.onclick = () => { e.members.splice(mi, 1); markDirty(); renderVisualPanel(); };

        line.append(prefixInp, name, starLbl, up, down, md);
        memBox.append(line);
      }
      const addMem = makeEl('button', 'btn tiny', '＋ 节点');
      addMem.onclick = () => { e.members.push({ name: '', prefix: '[]', glob: false }); markDirty(); renderVisualPanel(); };
      memBox.append(addMem);
      box.append(memBox);
    } else {
      const optBox = makeEl('div', 'ini-pg-urltest');
      const fields = [
        ['filters', e.filters || '', '.* 或 (香港)'],
        ['超时(s)', e.interval || '', '300'],
        ['失败阈值', e.failure || '', '5'],
        ['成功阈值', e.success || '', '100'],
      ];
      for (const [lbl, val, ph] of fields) {
        const lab = makeEl('label', 'ini-pg-field');
        lab.append(makeEl('span', '', lbl));
        const inp = makeEl('input', 'ini-pg-' + lbl.replace(/\(.*\)/g, '').replace(/\(s\)/, '').toLowerCase());
        inp.value = val; inp.placeholder = ph;
        inp.oninput = () => {
          if (lbl === 'filters') e.filters = inp.value;
          else if (lbl === '超时(s)') e.interval = inp.value;
          else if (lbl === '失败阈值') e.failure = inp.value;
          else if (lbl === '成功阈值') e.success = inp.value;
          markDirty();
        };
        lab.append(inp); optBox.append(lab);
      }
      const uLab = makeEl('label', 'ini-pg-field ini-pg-url-field');
      uLab.append(makeEl('span', '', '测速 URL'));
      const uInp = makeEl('input', 'ini-pg-url');
      uInp.value = e.url || '';
      uInp.placeholder = 'http://www.gstatic.com/generate_204';
      uInp.oninput = () => { e.url = uInp.value; markDirty(); };
      uLab.append(uInp); optBox.append(uLab);
      box.append(optBox);
    }

    row.append(box, delBtn);
    return row;
  }

  // fallback：未知类型，原样展示
  row.append(makeEl('div', 'rule-empty', e.raw || JSON.stringify(e)), delBtn);
  return row;
}

/* ---------- 添加按钮 ---------- */

function listAddRule() {
  const TYPES = state.fmt === 'qx-list' ? window.VisualEditors.QX_RULE_TYPES : window.VisualEditors.CLASH_RULE_TYPES;
  const defaultType = TYPES.find(t => t) || (state.fmt === 'qx-list' ? 'HOST-SUFFIX' : 'DOMAIN-SUFFIX');
  state.parsed.items.push({
    kind: 'rule', type: defaultType, rule: '', action: '', enabled: true,
  });
  markDirty(); renderVisualPanel();
}

function iniAddRuleset() {
  const sec = state.parsed.sections.find(s => s.section === 'custom') || state.parsed.sections[0];
  if (!sec) return;
  sec.entries.push({ kind: 'ruleset', label: '🆎 广告过滤', url: '', embedded: null });
  markDirty(); renderVisualPanel();
}

function iniAddProxyGroup() {
  const sec = state.parsed.sections.find(s => s.section === 'custom') || state.parsed.sections[0];
  if (!sec) return;
  sec.entries.push({ kind: 'proxy_group', name: '新分组', strategy: 'select', members: [] });
  markDirty(); renderVisualPanel();
}

// 批量粘贴：先定义 isCommentOrBlank（函数声明提升，放在任何地方都安全）
function isCommentOrBlank(line) {
  const t = line.trim();
  if (!t) return { kind: 'blank', text: '' };
  if (t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) return { kind: 'comment', text: t };
  return null;
}

function batchPaste() {
  const input = prompt('粘贴多行规则（每行一条，支持注释 #）：');
  if (input === null || !input.trim()) return;
  if (state.fmt === 'clash-ini') {
    toast('批量粘贴暂不支持 .ini 格式');
    return;
  }
  const isQX = state.fmt === 'qx-list';
  const existing = state.parsed.items.length;
  for (const rawLine of input.split(/\r?\n/)) {
    const cb = isCommentOrBlank(rawLine);
    if (cb) { state.parsed.items.push({ ...cb, enabled: cb.kind !== 'blank' }); continue; }

    const parts = rawLine.split(',').map(s => s.trim());
    if (isQX) {
      state.parsed.items.push({ kind: 'rule', type: parts[0] || '', rule: parts[1] || '', action: parts[2] || '', enabled: true });
    } else {
      const isBracket = parts[0]?.startsWith('[]');
      state.parsed.items.push({
        kind: 'rule',
        type: isBracket ? parts[0].slice(2) : parts[0] || '',
        rule: parts[1] || '',
        action: parts[2] || '',
        enabled: true,
      });
    }
  }
  markDirty();
  toast(`已添加 ${state.parsed.items.length - existing} 条`);
  renderVisualPanel();
}

/* ============================================================
 *  事件绑定
 * ============================================================ */

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  state.remember = $('rememberInput').checked;
  const token = $('tokenInput').value;
  $('loginButton').disabled = true;
  try { await login(token); }
  catch (e) { toast('登录失败：' + e.message); state.token = ''; }
  finally { $('loginButton').disabled = false; }
});

$('logoutBtn').addEventListener('click', () => logout());
$('parseBtn').addEventListener('click', parseGitHubLink);
$('refreshBtn').addEventListener('click', async () => {
  try { await refreshFiles(); toast('文件列表已刷新'); }
  catch (e) { toast('刷新失败：' + e.message); }
});
$('searchInput').addEventListener('input', renderFiles);

$('newBtn').addEventListener('click', newFile);
$('uploadBtn').addEventListener('click', () => $('uploadInput').click());
$('uploadInput').addEventListener('change', async () => {
  const file = $('uploadInput').files[0];
  $('uploadInput').value = '';
  if (file) await uploadFile(file);
});

$('editor').addEventListener('input', () => {
  state.dirty = $('editor').value !== state.original;
  $('dirtyLabel').hidden = !state.dirty;
  $('sizeLabel').textContent = formatSize(textBytes().length);
});
$('editor').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = e.target;
    e.target.setRangeText('  ', a, b, 'end');
    e.target.dispatchEvent(new Event('input'));
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveFile();
  }
});

$('saveBtn').addEventListener('click', saveFile);
$('deleteBtn').addEventListener('click', deleteFile);
$('downloadBtn').addEventListener('click', downloadCurrent);

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

/* ============================================================
 *  Hash 路由 & 启动 bootstrap
 * ============================================================ */

window.addEventListener('hashchange', () => {
  if (!state.token) return;
  navigateFromHash();
});

// ---- 启动：先显示主界面，再决定要不要跳登录 ----
const savedToken = sessionStorage.getItem('cfhub-token');
if (savedToken) {
  state.remember = true;
  state.token = savedToken;
  $('rememberInput').checked = true;
  $('loginView').hidden = true;
  $('appView').hidden = false;
  login(savedToken).catch(e => {
    sessionStorage.removeItem('cfhub-token');
    state.token = '';
    toast('登录态已失效，请重新输入口令');
    logout(false);
  });
} else {
  $('loginView').hidden = true;
  $('appView').hidden = false;
  // /api/info 允许无 token
  request('/api/info').then(info => {
    state.info = info;
    updateRepoHeader(info);
    return refreshFiles();
  }).then(() => {
    // refreshFiles 也需要 admin token，401 时 request() 会调用 logout(false)
    // 成功的话（无 token 场景下 refreshFiles 被 401 拒了 → 已跳登录页）
    // 所以无 token 场景走到这里时，state.files 是空的，state.current 也是 null
  }).catch(() => { /* request 内部已处理 401 */ });
}
