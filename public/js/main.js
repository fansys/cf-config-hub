/** 入口：登录 / 登出、hash 路由、事件绑定。 */
import { target, tokenStore } from './api.js';
import { state } from './state.js';
import { $, toast } from './util.js';
import {
  bindEditorEvents, deleteFile, downloadCurrent, newFile, openFile, duplicateCurrent, renameCurrent, saveFile, setMode, uploadFiles,
} from './ui/editor.js';
import { refreshFiles, renderFiles } from './ui/files.js';
import { showActivity, showDiffCurrent, showHistory } from './ui/history.js';
import { parseGitHubLink, showLinks } from './ui/links.js';
import { bindModal } from './ui/modal.js';
import { openSwitcher } from './ui/target.js';
import { loadContext } from './ui/session.js';
import { showSearch } from './ui/search.js';
import { openAccessDialog, showAccessEditor } from './ui/access.js';
import { bindMenus } from './ui/menu.js';
import { showBackup } from './ui/zipio.js';
import { bindVisualShortcuts } from './ui/visual.js';

/* ---------- 登录 / 登出 ---------- */

function showApp(visible) {
  const root = document.documentElement;
  $('loginView').hidden = visible;
  $('appView').hidden = !visible;
  root.classList.add('ready');                 // 结束加载占位
  if (!visible) root.classList.remove('has-token'); // 显示登录页时，不再强制隐藏它
}

async function login(token, remember) {
  rememberLogin = remember;
  state.token = token;
  try {
    await loadContext(); // 同时验证口令
    await refreshFiles();
  } catch (e) {
    // 之前保存的分支已不可用（被删除…）：回到默认分支再试一次
    if (e.status && e.status !== 401 && target.get().branch) {
      target.clear();
      await loadContext();
      await refreshFiles();
      toast('之前选择的分支不可用，已回到默认分支');
    } else throw e;
  }
  tokenStore.save(token, remember);
  showApp(true);

  const hashPath = readHashPath();
  if (hashPath && state.files.some(f => f.path === hashPath)) openFile(hashPath);
  toast('已连接 GitHub 仓库');
}

function logout(announce = true) {
  Object.assign(state, { token: '', current: null, parsed: null, dirty: false });
  tokenStore.clear();
  showApp(false);
  $('tokenInput').value = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (announce) toast('已退出管理后台');
}

/* ---------- hash 路由 ---------- */

function readHashPath() {
  if (!location.hash.startsWith('#/')) return null;
  try { return location.hash.slice(2).split('/').map(decodeURIComponent).join('/'); }
  catch { return null; }
}

window.addEventListener('hashchange', () => {
  const path = readHashPath();
  if (!state.token || !path || state.current?.path === path) return;
  if (state.files.some(f => f.path === path)) openFile(path);
});

/* 登录过期：保留页面状态（含未保存的编辑），弹出原地重新登录，成功后继续 */
let rememberLogin = false;

window.addEventListener('cfhub:unauthorized', () => {
  // 仅在已进入管理界面后才原地重登；登录页上的 401 就是口令错误，由登录流程自己提示
  if (!state.token || $('appView').hidden) return;
  const dlg = $('reauth');
  if (!dlg.open) { $('reauthInput').value = ''; dlg.showModal(); $('reauthInput').focus(); }
});

$('reauth').addEventListener('cancel', e => e.preventDefault()); // Esc 不关闭，必须二选一
$('reauthLogout').addEventListener('click', () => { $('reauth').close(); logout(); });
$('reauthForm').addEventListener('submit', async e => {
  e.preventDefault();
  const token = $('reauthInput').value;
  const previous = state.token;
  $('reauthSubmit').disabled = true;
  try {
    state.token = token;
    await refreshFiles(); // 受保护接口：口令错误会抛出 AuthError
    tokenStore.save(token, rememberLogin);
    $('reauth').close();
    toast('已重新登录，可以继续操作');
  } catch (err) {
    state.token = previous;
    toast(err.status === 429 ? err.message : '口令不正确，请重试');
    $('reauthInput').select();
  } finally { $('reauthSubmit').disabled = false; }
});

/* ---------- 事件绑定 ---------- */

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginButton').disabled = true;
  try { await login($('tokenInput').value, $('rememberInput').checked); }
  catch (err) { state.token = ''; toast('登录失败：' + err.message); }
  finally { $('loginButton').disabled = false; }
});

$('logoutBtn').addEventListener('click', () => logout());
$('parseBtn').addEventListener('click', parseGitHubLink);
$('linksBtn').addEventListener('click', showLinks);
$('refreshBtn').addEventListener('click', async () => {
  try { await refreshFiles(); toast('文件列表已刷新'); }
  catch (err) { toast('刷新失败：' + err.message); }
});
$('searchInput').addEventListener('input', renderFiles);

$('newBtn').addEventListener('click', () => newFile());
$('renameBtn').addEventListener('click', renameCurrent);
$('duplicateBtn').addEventListener('click', duplicateCurrent);
$('diffBtn').addEventListener('click', showDiffCurrent);
$('historyBtn').addEventListener('click', showHistory);
$('activityBtn').addEventListener('click', showActivity);
$('switchBtn').addEventListener('click', openSwitcher);
$('searchBtn').addEventListener('click', showSearch);
$('backupBtn').addEventListener('click', showBackup);
bindModal();
bindMenus();
$('accessRulesBtn').addEventListener('click', showAccessEditor);
$('accessBtn').addEventListener('click', () => { if (state.current) openAccessDialog(state.current.path, 'file'); });
bindVisualShortcuts();

/* 拖拽上传：把文件拖进页面任意位置 */
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', e => {
  if (!hasFiles(e) || !state.token || state.readonly) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dropping');
});
document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (state.token && !state.readonly && e.dataTransfer.files.length) await uploadFiles(e.dataTransfer.files);
});
$('uploadBtn').addEventListener('click', () => $('uploadInput').click());
$('uploadInput').addEventListener('change', async () => {
  const files = [...$('uploadInput').files];
  $('uploadInput').value = '';
  if (files.length) await uploadFiles(files);
});

$('saveBtn').addEventListener('click', saveFile);
$('deleteBtn').addEventListener('click', deleteFile);
$('downloadBtn').addEventListener('click', downloadCurrent);
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});
bindEditorEvents();

/* ---------- 启动 ---------- */

const saved = tokenStore.load();
$('rememberInput').checked = saved.remember;
if (saved.token) {
  login(saved.token, saved.remember).catch(() => {
    logout(false);
    toast('登录态已失效，请重新输入口令');
  });
} else {
  showApp(false);
}
