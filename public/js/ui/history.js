/** 文件提交历史：对比 / 载入旧版本。 */
import { fileUrl, request } from '../api.js';
import { state, getEditorText } from '../state.js';
import { bytesFromB64, makeEl, toLF, toast } from '../util.js';
import { decodeBytes, replaceContent } from './editor.js';
import { showDiff } from './diffview.js';
import { askConfirm, closeModal, openModal } from './modal.js';

async function fetchVersion(path, sha) {
  const data = await request(`${fileUrl(path)}&ref=${sha}`);
  const { binary, text } = decodeBytes(bytesFromB64(data.content));
  if (binary) throw new Error('该版本是二进制文件，无法对比');
  return toLF(text);
}

export function showDiffCurrent() {
  if (!state.current || state.binary) return;
  showDiff(`未保存的修改 · ${state.current.path}`, state.original, toLF(getEditorText()));
}

export async function showHistory() {
  if (!state.current?.sha) return toast('新文件还没有历史记录');
  const { path } = state.current;
  const list = makeEl('div', '', '加载中…');
  openModal(`提交历史 · ${path}`, list);
  try {
    const { commits } = await request('/api/history?path=' + encodeURIComponent(path));
    if (!commits.length) { list.textContent = '没有找到提交记录。'; return; }
    list.replaceChildren(...commits.map(c => historyRow(path, c)));
  } catch (e) { list.textContent = '加载失败：' + e.message; }
}

function historyRow(path, c) {
  const row = makeEl('div', 'hist-item');
  const main = makeEl('div', 'hist-main');
  const when = c.date ? new Date(c.date).toLocaleString() : '';
  main.append(makeEl('div', 'hist-msg', c.message || '(无提交信息)'),
    makeEl('div', 'hist-meta', `${c.sha.slice(0, 7)} · ${c.author} · ${when}`));

  const diff = makeEl('button', 'btn small', '对比当前');
  diff.addEventListener('click', async () => {
    try { showDiff(`${c.sha.slice(0, 7)} → 当前编辑内容`, await fetchVersion(path, c.sha), toLF(getEditorText())); }
    catch (e) { toast(e.message); }
  });
  const load = makeEl('button', 'btn small', '载入此版本');
  load.title = '把该版本内容放进编辑器（作为未保存的修改），确认无误后再点保存';
  load.addEventListener('click', async () => {
    try {
      const text = await fetchVersion(path, c.sha);
      if (state.dirty && !await askConfirm({ title: '覆盖未保存的修改', message: '编辑器里有未保存的修改，载入旧版本会覆盖它们，继续吗？', okText: '继续载入', danger: true })) return;
      closeModal();
      await replaceContent(text);
      toast('已载入旧版本，保存后才会提交');
    } catch (e) { toast(e.message); }
  });
  const actions = makeEl('div', 'hist-actions');
  actions.append(diff, load);
  row.append(main, actions);
  return row;
}

/** 操作记录：当前分支（及管理目录）最近的提交，含 Edited-by 署名。 */
export async function showActivity() {
  const list = makeEl('div', '', '加载中…');
  openModal(`操作记录 · ${state.info.branch}`, list, { wide: true });
  try {
    const { commits } = await request('/api/activity');
    if (!commits.length) { list.textContent = '没有找到提交记录。'; return; }
    list.replaceChildren(...commits.map(c => {
      const row = makeEl('div', 'hist-item');
      const main = makeEl('div', 'hist-main');
      main.append(makeEl('div', 'hist-msg', c.message || '(无提交信息)'),
        makeEl('div', 'hist-meta', `${c.author} · ${c.date ? new Date(c.date).toLocaleString() : ''}`));
      const link = makeEl('a', 'btn small', c.sha.slice(0, 7));
      link.href = `https://github.com/${encodeURIComponent(state.info.owner)}/${encodeURIComponent(state.info.repo)}/commit/${c.sha}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = '在 GitHub 查看这次提交';
      row.append(main, link);
      return row;
    }));
  } catch (e) { list.textContent = '加载失败：' + e.message; }
}
