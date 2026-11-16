/** 切换分支（仓库与管理目录固定为部署配置，不允许切换）。 */
import { request, target } from '../api.js';
import { state } from '../state.js';
import { makeEl, toast } from '../util.js';
import { checkUnsaved, resetEditor } from './editor.js';
import { refreshFiles } from './files.js';
import { askInput, closeModal, openModal } from './modal.js';
import { loadContext } from './session.js';

/** 重新加载上下文与文件树；失败时回滚到之前的分支。 */
async function applyBranch(branch) {
  const previous = target.get();
  target.set({ branch });
  try {
    resetEditor();
    await loadContext();
    await refreshFiles();
    return true;
  } catch (e) {
    target.set(previous);
    try { await loadContext(); await refreshFiles(); } catch { /* 保持当前 */ }
    toast('切换失败：' + e.message);
    return false;
  }
}

export async function openSwitcher() {
  if (!(await checkUnsaved())) return;
  const info = state.info;
  const body = makeEl('div', '', '加载中…');
  openModal('切换分支', body);

  let data;
  try { data = await request('/api/branches'); }
  catch (e) { body.textContent = '加载分支失败：' + e.message; return; }

  const select = makeEl('select', 'sel');
  const fill = (branches, current) => {
    select.replaceChildren(...branches.map(b => Object.assign(
      makeEl('option', '', `${b.name}${b.name === info.defaults.branch ? '（默认）' : ''}${b.protected ? ' 🔒' : ''}`), { value: b.name })));
    if (branches.some(b => b.name === current)) select.value = current;
  };
  fill(data.branches, info.branch);

  const newBranch = makeEl('button', 'btn small', '＋ 新建分支');
  newBranch.type = 'button';
  newBranch.disabled = state.readonly;
  newBranch.title = state.readonly ? '只读口令不能新建分支' : '基于所选分支创建新分支';
  newBranch.addEventListener('click', async () => {
    const name = await askInput({ title: '新建分支', message: `基于 ${select.value} 创建：`, placeholder: 'feature/xxx', okText: '创建' });
    if (!name?.trim()) return;
    try {
      await request('/api/branch', 'POST', { name: name.trim(), from: select.value });
      toast('分支已创建');
      const again = await request('/api/branches');
      fill(again.branches, name.trim());
    } catch (e) { toast('创建失败：' + e.message); }
  });

  const apply = makeEl('button', 'btn primary', '切换');
  const back = makeEl('button', 'btn ghost', '回到默认分支');
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    const branch = select.value;
    if (branch === info.branch) { closeModal(); apply.disabled = false; return; }
    // 选中默认分支等同于清除本地选择
    if (await applyBranch(branch === info.defaults.branch ? '' : branch)) {
      closeModal();
      toast(`已切换到分支 ${branch}`);
    }
    apply.disabled = false;
  });
  back.addEventListener('click', async () => {
    if (await applyBranch('')) { closeModal(); toast('已回到默认分支'); }
  });

  const row = makeEl('div', 'field-inline');
  row.append(select, newBranch);
  const field = makeEl('div', 'field-row');
  field.append(makeEl('label', '', `${info.owner}/${info.repo}${info.root ? ' · 目录 /' + info.root : ''}（固定）`), row);
  const hint = makeEl('p', 'muted small-text',
    '仓库与管理目录由部署配置决定，不能在页面里切换。分支选择只保存在本浏览器。其它分支也可以设置访问规则、生成公开链接（链接带 ?b=分支），各分支的规则与链接版本相互独立。');
  const actions = makeEl('div', 'reauth-actions');
  actions.append(back, apply);
  body.replaceChildren(field, hint, actions);
}
