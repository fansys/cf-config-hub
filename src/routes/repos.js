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
  const [infoResult, listResult] = await Promise.allSettled([
    gh(env, base),
    gh(env, `${base}/branches?per_page=100`),
  ]);
  const defaultBranch = (infoResult.status === 'fulfilled' && infoResult.value?.default_branch) || c.defaultBranch || c.branch;
  let branches = [];
  if (listResult.status === 'fulfilled' && Array.isArray(listResult.value)) {
    branches = listResult.value.map(b => ({ name: b.name, protected: !!b.protected }));
  } else {
    // 兜底：若 /branches 被限流或权限不足，尝试通过 git/matching-refs/heads 获取分支名
    try {
      const refs = await gh(env, `${base}/git/matching-refs/heads/`);
      if (Array.isArray(refs)) {
        branches = refs
          .filter(r => typeof r.ref === 'string' && r.ref.startsWith('refs/heads/'))
          .map(r => ({ name: r.ref.slice('refs/heads/'.length), protected: false }));
      }
    } catch { /* 继续使用已知分支兜底 */ }
  }
  // 确保默认分支与当前生效分支始终在列表中
  for (const known of [defaultBranch, c.branch]) {
    if (known && !branches.some(b => b.name === known)) {
      branches.unshift({ name: known, protected: false });
    }
  }
  return json({ defaultBranch, branches });
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
