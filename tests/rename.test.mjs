/** 文件/目录重命名：规划逻辑 + 接口流程（mock Git Data API）。 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import worker from '../src/index.js';
import { planRename } from '../src/routes/rename.js';

globalThis.crypto ||= webcrypto;

const blob = (path, sha = 's' + path.length) => ({ type: 'blob', mode: '100644', path, sha });
const TREE = [
  { type: 'tree', path: 'clash', mode: '040000', sha: 't1' },
  blob('clash/a.list', 'sha-a'), blob('clash/sub/b.list', 'sha-b'),
  { type: 'tree', path: 'clash/sub', mode: '040000', sha: 't2' },
  blob('readme.md', 'sha-r'),
  blob('.github/workflows/ci.yml', 'sha-ci'),
];
const status = fn => { try { fn(); return 200; } catch (e) { return e.status; } };

test('文件重命名：新路径指向原 blob，旧路径删除', () => {
  const { entries, moved } = planRename(TREE, 'readme.md', 'docs/readme.md', 'file');
  assert.equal(moved, 1);
  assert.deepEqual(entries, [
    { path: 'docs/readme.md', mode: '100644', type: 'blob', sha: 'sha-r' },
    { path: 'readme.md', mode: '100644', type: 'blob', sha: null },
  ]);
});

test('目录重命名：递归移动全部文件，保留相对结构', () => {
  const { entries, moved } = planRename(TREE, 'clash', 'rules', 'dir');
  assert.equal(moved, 2);
  const added = entries.filter(e => e.sha).map(e => e.path).sort();
  const removed = entries.filter(e => !e.sha).map(e => e.path).sort();
  assert.deepEqual(added, ['rules/a.list', 'rules/sub/b.list']);
  assert.deepEqual(removed, ['clash/a.list', 'clash/sub/b.list']);
});

test('拒绝：目标已存在、目标父级是文件、移入自身、同名、源不存在', () => {
  assert.equal(status(() => planRename(TREE, 'readme.md', 'clash/a.list', 'file')), 409);
  assert.equal(status(() => planRename(TREE, 'clash', 'readme.md', 'dir')), 409);
  assert.equal(status(() => planRename(TREE, 'clash/a.list', 'readme.md/x', 'file')), 409);
  assert.equal(status(() => planRename(TREE, 'clash/a.list', 'clash/sub', 'file')), 409);
  assert.equal(status(() => planRename(TREE, 'clash', 'clash/inner', 'dir')), 400);
  assert.equal(status(() => planRename(TREE, 'readme.md', 'readme.md', 'file')), 400);
  assert.equal(status(() => planRename(TREE, 'nope.txt', 'x.txt', 'file')), 404);
  assert.equal(status(() => planRename(TREE, 'nope', 'x', 'dir')), 404);
  assert.equal(status(() => planRename(TREE, 'readme.md', 'x', 'weird')), 400);
});

test('拒绝触碰 GitHub Actions 工作流', () => {
  assert.equal(status(() => planRename(TREE, '.github', 'gh', 'dir')), 403);
  assert.equal(status(() => planRename(TREE, 'readme.md', '.github/workflows/x.yml', 'file')), 403);
});

test('POST /api/rename：一次提交完成（tree → commit → ref），并受 ROOT_DIR 约束', async () => {
  const calls = [];
  globalThis.fetch = async (resource, init = {}) => {
    const url = String(resource);
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'head1' } });
    if (url.endsWith('/git/commits/head1')) return Response.json({ tree: { sha: 'tree1' } });
    if (url.includes('/git/trees/tree1')) {
      return Response.json({ truncated: false, tree: [
        { type: 'blob', mode: '100644', path: 'configs/old/a.yaml', sha: 'sa' },
        { type: 'blob', mode: '100644', path: 'outside.txt', sha: 'so' },
      ] });
    }
    if (url.endsWith('/git/trees') && method === 'POST') return Response.json({ sha: 'tree2' });
    if (url.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: 'commit2' });
    if (url.endsWith('/git/refs/heads/main') && method === 'PATCH') return Response.json({});
    return Response.json({ message: 'unknown ' + url }, { status: 404 });
  };
  const env = {
    GITHUB_OWNER: 'example', GITHUB_REPO: 'configs', GITHUB_BRANCH: 'main', ROOT_DIR: 'configs',
    ADMIN_TOKEN: 'admin-secret', GITHUB_TOKEN: 'gh', PUBLIC_FILES: 'false',
  };
  const post = body => worker.fetch(new Request('https://hub.example.com/api/rename', {
    method: 'POST',
    headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });

  const r = await post({ from: 'old', to: 'new/dir', kind: 'dir' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual([out.moved, out.commitSha], [1, 'commit2']);

  const treeCall = calls.find(c => c.url.endsWith('/git/trees') && c.method === 'POST');
  assert.equal(treeCall.body.base_tree, 'tree1');
  assert.deepEqual(treeCall.body.tree.map(e => [e.path, e.sha]), [['configs/new/dir/a.yaml', 'sa'], ['configs/old/a.yaml', null]]);
  const commitCall = calls.find(c => c.url.endsWith('/git/commits') && c.method === 'POST');
  assert.deepEqual(commitCall.body.parents, ['head1']);
  assert.equal(calls.find(c => c.method === 'PATCH').body.force, false);

  // ROOT_DIR 之外的文件不可见
  assert.equal((await post({ from: 'outside.txt', to: 'x.txt', kind: 'file' })).status, 404);
  assert.equal((await post({ from: '../outside.txt', to: 'x.txt', kind: 'file' })).status, 400);
});
