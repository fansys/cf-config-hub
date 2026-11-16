/** 左侧文件树。 */
import { request } from '../api.js';
import { state } from '../state.js';
import { $, formatSize, makeEl } from '../util.js';
import { renderLinks } from './links.js';
import { resolveAccess } from '../access.js';
import { BADGES, BADGE_TITLES, openAccessDialog } from './access.js';
import { deleteFolder, newFile, openFile, renamePath } from './editor.js';

export async function refreshFiles() {
  const data = await request('/api/files');
  state.files = data.files;
  state.commitSha = data.commitSha || '';
  $('fileCount').textContent = `${state.files.length} 个文件`;
  renderFiles();
  if (state.current) renderLinks();
}

export function renderFiles() {
  const q = $('searchInput').value.toLowerCase().trim();
  const list = $('fileList');
  list.replaceChildren();
  const filtered = state.files.filter(f => f.path.toLowerCase().includes(q));
  if (!filtered.length) {
    list.append(makeEl('div', 'footnote', q ? '没有匹配的文件' : '仓库目录暂无文件'));
    return;
  }
  if (q) {
    filtered.forEach(f => appendFile(list, f, f.path.split('/').at(-1)));
    return;
  }
  appendTree(list, buildTree(filtered), '');
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    let node = root;
    for (const part of f.path.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push(f);
  }
  return root;
}

function appendTree(parent, node, parentPath) {
  const dirs = [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
  for (const [name, child] of dirs) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    const isOpen = !state.closedFolders.has(path);

    const folder = makeEl('button', 'folder-item');
    folder.type = 'button';
    const icon = makeEl('span', 'icon', isOpen ? '▾' : '▸');
    folder.append(icon, makeEl('span', 'label', name));
    const dirRule = state.info?.access?.rules?.find(r => r.pattern === `${path}/**`);
    // 目录自己的规则：只有不能直链（需令牌 / 禁止）时才显示角标
    if (dirRule && state.info?.private !== false && BADGES[dirRule.mode]) folder.append(badge(dirRule.mode, `目录规则：${BADGE_TITLES[dirRule.mode]}`));

    const row = makeEl('div', 'folder-row');
    row.append(folder, folderAction('＋', '在此目录下新建文件', () => newFile(path)),
      folderAction('⚙', '访问设置（直链 / 仅令牌 / 禁止）', () => openAccessDialog(path, 'dir')),
      folderAction('✎', '重命名/移动目录', () => renamePath(path, 'dir')),
      folderAction('🗑', '删除整个目录', () => deleteFolder(path)));

    const children = makeEl('div', 'folder-children');
    children.hidden = !isOpen;
    folder.addEventListener('click', () => {
      const open = children.hidden;
      children.hidden = !open;
      icon.textContent = open ? '▾' : '▸';
      if (open) state.closedFolders.delete(path); else state.closedFolders.add(path);
    });

    parent.append(row, children);
    appendTree(children, child, path);
  }
  for (const f of node.files) appendFile(parent, f, f.path.split('/').at(-1));
}

function folderAction(text, title, onClick) {
  const b = makeEl('button', 'folder-act', text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function badge(mode, title) {
  const b = makeEl('span', 'access-badge', BADGES[mode] || '');
  b.title = title;
  return b;
}

function appendFile(parent, f, label) {
  const btn = makeEl('button', 'file-item' + (state.current?.path === f.path ? ' active' : ''));
  btn.type = 'button';
  btn.title = f.path;
  btn.append(makeEl('span', 'icon', '▤'), makeEl('span', 'label', label));
  // 公开仓库的文件本来就能直链，不显示角标；私有仓库里，不能直链的才显示 🔒 / ⛔
  if (state.info && state.info.private !== false) {
    const a = resolveAccess(state.info.access?.rules || [], f.path);
    if (BADGES[a.mode]) btn.append(badge(a.mode, `${BADGE_TITLES[a.mode]}${a.rule ? `（规则 ${a.rule.pattern}）` : ''}`));
  }
  btn.append(makeEl('span', 'file-size', f.size ? formatSize(f.size) : ''));
  btn.addEventListener('click', () => openFile(f.path));

  const row = makeEl('div', 'file-row');
  row.append(btn);
  if (state.info) row.append(folderAction('⚙', '访问设置（直链 / 仅令牌 / 禁止）', () => openAccessDialog(f.path, 'file')));
  parent.append(row);
}
