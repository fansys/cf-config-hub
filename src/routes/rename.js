/**
 * POST /api/rename  { from, to, kind: 'file' | 'dir', message? }
 *
 * Contents API 不支持移动，这里用 Git Data API 在**一次提交**里完成重命名：
 * 新路径指向原 blob（不传输文件内容），旧路径置为删除，因此目录重命名也是原子的。
 */
import { commitMessage, gh, readJsonBody } from '../github.js';
import { encPath, HttpError, json } from '../lib/http.js';
import { isWorkflowPath, scopedPath } from '../lib/paths.js';

/**
 * 纯函数：根据仓库树计算要提交的变更。路径均为仓库内完整路径。
 * @returns {{ entries: object[], moved: number }}
 */
export function planRename(tree, from, to, kind) {
  if (kind !== 'file' && kind !== 'dir') throw new HttpError(400, 'kind 必须是 file 或 dir');
  if (from === to) throw new HttpError(400, '新旧路径相同');
  if (kind === 'dir' && to.startsWith(from + '/')) throw new HttpError(400, '不能把目录移动到它自己的子目录中');

  const blobs = tree.filter(e => e.type === 'blob');
  const sources = kind === 'file'
    ? blobs.filter(e => e.path === from)
    : blobs.filter(e => e.path.startsWith(from + '/'));
  if (!sources.length) throw new HttpError(404, kind === 'file' ? '源文件不存在' : '源目录不存在或为空');
  if (kind === 'dir' && tree.some(e => e.type === 'commit' && e.path.startsWith(from + '/'))) {
    throw new HttpError(400, '目录包含 Git 子模块，不支持重命名');
  }

  if (sources.some(s => isWorkflowPath(s.path)) || isWorkflowPath(to)) {
    throw new HttpError(403, '禁止通过本工具修改 GitHub Actions 工作流');
  }

  const moving = new Set(sources.map(s => s.path));
  const others = tree.filter(e => !moving.has(e.path) && !e.path.startsWith(kind === 'dir' ? from + '/' : '\0'));

  // 目标冲突：同名文件、同名目录、或目标的某一级父路径已是文件
  const parts = to.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (others.some(e => e.type === 'blob' && e.path === parent)) {
      throw new HttpError(409, `目标路径上的 ${parent} 已是文件`);
    }
  }
  if (others.some(e => e.path === to || e.path.startsWith(to + '/'))) {
    throw new HttpError(409, '目标路径已存在，请换一个名称');
  }

  const entries = [];
  for (const s of sources) {
    const target = kind === 'file' ? to : to + s.path.slice(from.length);
    entries.push({ path: target, mode: s.mode, type: 'blob', sha: s.sha });
    entries.push({ path: s.path, mode: s.mode, type: 'blob', sha: null }); // 删除旧路径
  }
  return { entries, moved: sources.length };
}

/** 读取分支头与完整文件树。 */
export async function loadHead(env, c, base) {
  const ref = await gh(env, `${base}/git/ref/heads/${encPath(c.branch)}`);
  const headSha = ref.object?.sha;
  const head = await gh(env, `${base}/git/commits/${headSha}`);
  const listing = await gh(env, `${base}/git/trees/${head.tree.sha}?recursive=1`);
  if (listing.truncated) throw new HttpError(409, '仓库文件过多，无法安全操作');
  return { headSha, treeSha: head.tree.sha, tree: listing.tree || [] };
}

/** 把一组树变更提交为一次 commit 并推进分支（非强制：分支期间被他人推进会失败）。 */
export async function commitChanges(env, c, base, { headSha, treeSha }, entries, message) {
  const newTree = await gh(env, `${base}/git/trees`, { method: 'POST', body: { base_tree: treeSha, tree: entries } });
  const commit = await gh(env, `${base}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [headSha] },
  });
  await gh(env, `${base}/git/refs/heads/${encPath(c.branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  return commit.sha;
}

export async function renamePath(env, c, req, base, user) {
  const body = await readJsonBody(req);
  const from = scopedPath(c, body.from);
  const to = scopedPath(c, body.to);
  const head = await loadHead(env, c, base);
  const { entries, moved } = planRename(head.tree, from, to, body.kind);
  const commitSha = await commitChanges(env, c, base, head, entries, commitMessage(body, `Rename ${from} → ${to}`, user));
  return json({ renamed: true, moved, commitSha, from: body.from, to: body.to });
}

/** 纯函数：删除目录下所有文件。 */
export function planDeleteDir(tree, dir) {
  if (isWorkflowPath(dir)) throw new HttpError(403, '禁止通过本工具修改 GitHub Actions 工作流');
  const files = tree.filter(e => e.type === 'blob' && e.path.startsWith(dir + '/'));
  if (!files.length) throw new HttpError(404, '目录不存在或为空');
  if (files.some(f => isWorkflowPath(f.path))) throw new HttpError(403, '目录包含 GitHub Actions 工作流，禁止删除');
  return { entries: files.map(f => ({ path: f.path, mode: f.mode, type: 'blob', sha: null })), deleted: files.length };
}

/** DELETE /api/dir  { path, message? } —— 一次提交删除整个目录。 */
export async function deleteDir(env, c, req, base, user) {
  const body = await readJsonBody(req);
  const dir = scopedPath(c, body.path);
  const head = await loadHead(env, c, base);
  const { entries, deleted } = planDeleteDir(head.tree, dir);
  const commitSha = await commitChanges(env, c, base, head, entries, commitMessage(body, `Delete ${dir}/`, user));
  return json({ deleted, commitSha });
}
