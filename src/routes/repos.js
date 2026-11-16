/** 分支列表与新建分支（仓库固定，不支持切换仓库）。 */
import { gh, readJsonBody } from '../github.js';
import { enc, encPath, HttpError, json } from '../lib/http.js';

const BRANCH_RE = /^[A-Za-z0-9._\-/]{1,100}$/;

export function validBranchName(name) {
  return typeof name === 'string' && BRANCH_RE.test(name) && !name.includes('..') && !name.includes('//') &&
    !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock') && !name.endsWith('.') && !name.startsWith('-');
}

/** GET /api/branches：当前仓库的分支。 */
export async function listBranches(env, c, url) {
  const repoParam = url.searchParams.get('repo');
  if (repoParam && repoParam.toLowerCase() !== `${c.owner}/${c.repo}`.toLowerCase()) {
    throw new HttpError(403, '不允许查看其它仓库，只能切换分支');
  }
  const base = `/repos/${enc(c.owner)}/${enc(c.repo)}`;
  const [info, list] = await Promise.all([gh(env, base), gh(env, `${base}/branches?per_page=100`)]);
  return json({
    defaultBranch: info.default_branch,
    branches: (Array.isArray(list) ? list : []).map(b => ({ name: b.name, protected: !!b.protected })),
  });
}

/** POST /api/branch { name, from? }：基于某分支创建新分支。 */
export async function createBranch(env, c, req, base) {
  const body = await readJsonBody(req);
  if (!validBranchName(body.name)) throw new HttpError(400, '分支名不合法（仅字母、数字、. _ - /）');
  const from = body.from || c.branch;
  const ref = await gh(env, `${base}/git/ref/heads/${encPath(from)}`);
  await gh(env, `${base}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${body.name}`, sha: ref.object?.sha } });
  return json({ name: body.name, from, sha: ref.object?.sha });
}
