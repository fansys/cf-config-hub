/** 会话上下文：当前仓库/分支/目录、角色，并同步到页面。 */
import { request } from '../api.js';
import { state } from '../state.js';
import { $ } from '../util.js';

export function updateRepoHeader(info) {
  $('repoName').textContent = `${info.owner}/${info.repo}`;
  $('repoBadge').textContent = `${info.owner}/${info.repo} · ${info.branch}`;
  $('branchLabel').textContent = `分支: ${info.branch}${info.root ? ' · 目录: /' + info.root : ''}`;
  $('repoVisibility').textContent = info.private === null ? ''
    : info.private ? '私有仓库（公开链接不可用）' : '公开仓库';

  const badge = $('roleBadge');
  badge.hidden = !info.me;
  if (info.me) {
    badge.textContent = `${info.me.name} · ${info.me.role === 'rw' ? '可编辑' : '只读'}`;
    badge.classList.toggle('ro', info.me.role !== 'rw');
  }
}

/** 拉取 /api/context（同时验证口令），更新全局状态与页面。 */
export async function loadContext() {
  const info = await request('/api/context');
  state.info = info;
  state.readonly = info.me?.role !== 'rw';
  document.body.classList.toggle('readonly', state.readonly);
  updateRepoHeader(info);
  return info;
}
