/** 多口令/只读、多仓库多分支、原子提交、导出、操作记录。 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { _resetThrottle } from '../src/auth.js';
import worker from '../src/index.js';
import { gitBlobSha, normalizeCommitRequest, planCommit } from '../src/routes/commit.js';
import { validBranchName } from '../src/routes/repos.js';
import { scopedPath } from '../src/lib/paths.js';

globalThis.crypto ||= webcrypto;
const enc = new TextEncoder();
let calls;
let treeEntries;

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
globalThis.fetch = async (resource, init = {}) => {
  const url = String(resource);
  const method = init.method || 'GET';
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  calls.push({ url, method, body });
  if (url.endsWith('/user/repos?per_page=100&sort=pushed')) {
    return Response.json([
      { full_name: 'example/configs', name: 'configs', owner: { login: 'example' }, private: false, default_branch: 'main', permissions: { push: true } },
      { full_name: 'example/other', name: 'other', owner: { login: 'example' }, private: true, default_branch: 'dev', permissions: { push: false } },
      { full_name: 'stranger/x', name: 'x', owner: { login: 'stranger' }, private: false, default_branch: 'main' },
    ]);
  }
  if (/\/repos\/example\/(configs|other)$/.test(url)) return Response.json({ private: false, default_branch: 'main' });
  if (url.includes('/branches?per_page=100')) return Response.json([{ name: 'main', protected: true }, { name: 'dev' }]);
  if (url.includes('/git/ref/heads/')) return Response.json({ object: { sha: 'h'.repeat(40) } });
  if (url.endsWith('/git/refs') && method === 'POST') return Response.json({});
  if (url.includes('/git/commits/') && method === 'GET') return Response.json({ tree: { sha: 'tree1' } });
  if (url.includes('/git/trees/tree1')) return Response.json({ truncated: false, tree: treeEntries });
  if (url.includes('/git/trees/') && method === 'GET') return Response.json({ truncated: false, tree: treeEntries });
  if (url.endsWith('/git/trees') && method === 'POST') return Response.json({ sha: 'tree2' });
  if (url.endsWith('/git/blobs') && method === 'POST') return Response.json({ sha: 'b'.repeat(40) });
  if (url.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: 'c'.repeat(40) });
  if (url.includes('/git/refs/heads/') && method === 'PATCH') return Response.json({});
  if (url.includes('/zipball/')) return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { headers: { 'content-type': 'application/zip' } });
  if (url.includes('/commits?')) {
    return Response.json([
      { sha: 'a'.repeat(40), commit: { message: 'Update a\n\nEdited-by: alice', author: { name: 'Bot', date: '2026-11-15T00:00:00Z' } } },
      { sha: 'b'.repeat(40), commit: { message: 'Plain', author: { name: 'Bob', date: '2026-11-14T00:00:00Z' } } },
    ]);
  }
  if (/\/contents\//.test(url) && method === 'PUT') return Response.json({ content: { sha: 's'.repeat(40) }, commit: { sha: 'c'.repeat(40) } });
  return Response.json({ message: 'unknown ' + url }, { status: 404 });
};

const baseEnv = {
  GITHUB_OWNER: 'example', GITHUB_REPO: 'configs', GITHUB_BRANCH: 'main', ROOT_DIR: '',
  ADMIN_TOKEN: 'admin-secret', READONLY_TOKEN: 'view-secret', USERS: 'alice:rw:alice-tok, bob:ro:bob-tok',
  GITHUB_TOKEN: 'gh', PUBLIC_FILES: 'true',
};
const call = (path, { method = 'GET', auth = 'admin-secret', body, headers = {}, env = baseEnv } = {}) =>
  worker.fetch(new Request('https://hub.example.com' + path, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });

beforeEach(() => { calls = []; treeEntries = []; _resetThrottle(); });

test('角色：只读口令可读不可写；USERS 里的口令各自生效', async () => {
  assert.equal((await call('/api/files', { auth: 'view-secret' })).status, 200);
  const put = { method: 'PUT', body: { content: 'eA==' } };
  assert.equal((await call('/api/file?path=a.txt', { ...put, auth: 'view-secret' })).status, 403);
  assert.equal((await call('/api/file?path=a.txt', { ...put, auth: 'bob-tok' })).status, 403);
  assert.equal((await call('/api/file?path=a.txt', { ...put, auth: 'alice-tok' })).status, 200);
  assert.equal((await call('/api/file?path=a.txt', { ...put, auth: 'nope' })).status, 401);
  const me = await (await call('/api/context', { auth: 'bob-tok' })).json();
  assert.deepEqual(me.me, { name: 'bob', role: 'ro' });
});

test('提交署名：非 admin 用户的提交说明带 Edited-by，admin 保持干净', async () => {
  await call('/api/file?path=a.txt', { method: 'PUT', auth: 'alice-tok', body: { content: 'eA==', message: 'hi' } });
  await call('/api/file?path=b.txt', { method: 'PUT', body: { content: 'eA==', message: 'hi' } });
  const puts = calls.filter(c => c.method === 'PUT');
  assert.equal(puts[0].body.message, 'hi\n\nEdited-by: alice');
  assert.equal(puts[1].body.message, 'hi');
});

test('操作记录：优先显示 Edited-by 署名，其次提交作者', async () => {
  const { commits } = await (await call('/api/activity')).json();
  assert.deepEqual(commits.map(c => c.author), ['alice', 'Bob']);
});

test('只允许切换分支：切换仓库或管理目录一律拒绝', async () => {
  // 仅分支：沿用默认仓库与目录
  const b = await (await call('/api/context', { headers: { 'X-Cfh-Branch': 'dev' } })).json();
  assert.deepEqual([b.repo, b.branch, b.root, b.isDefault], ['configs', 'dev', '', false]);
  const d = await (await call('/api/context')).json();
  assert.deepEqual([d.branch, d.isDefault, d.defaults.branch], ['main', true, 'main']);
  // 带上与默认相同的仓库/目录是允许的（等同没带），不同则 403
  assert.equal((await call('/api/context', { headers: { 'X-Cfh-Repo': 'example/configs', 'X-Cfh-Branch': 'dev' } })).status, 200);
  assert.equal((await call('/api/context', { headers: { 'X-Cfh-Repo': 'example/other', 'X-Cfh-Branch': 'dev' } })).status, 403);
  assert.equal((await call('/api/context', { headers: { 'X-Cfh-Repo': 'stranger/x' } })).status, 403);
  assert.equal((await call('/api/context', { headers: { 'X-Cfh-Root': encodeURIComponent('其它目录') } })).status, 403);
  assert.equal((await call('/api/context', { headers: { 'X-Cfh-Root': '' } })).status, 200, '空目录 = 与默认一致');
  // 所有写操作也不能借请求头写到别的仓库
  assert.equal((await call('/api/file?path=a.txt', { method: 'PUT', body: { content: 'eA==' }, headers: { 'X-Cfh-Repo': 'example/other' } })).status, 403);
});

test('/api/info 公开且忽略切换请求头', async () => {
  const r = await call('/api/info', { auth: '', headers: { 'X-Cfh-Repo': 'example/other', 'X-Cfh-Branch': 'dev' } });
  assert.equal((await r.json()).repo, 'configs');
});

test('分支列表与新建分支；不再提供仓库列表', async () => {
  assert.equal((await call('/api/repos')).status, 404, '没有仓库列表接口');
  const br = await (await call('/api/branches')).json();
  assert.deepEqual(br.branches.map(b => b.name), ['main', 'dev']);
  assert.equal((await call('/api/branches?repo=example/configs')).status, 200);
  assert.equal((await call('/api/branches?repo=example/other')).status, 403);

  assert.equal((await call('/api/branch', { method: 'POST', body: { name: 'feature/x' } })).status, 200);
  assert.deepEqual(calls.find(c => c.url.endsWith('/git/refs')).body.ref, 'refs/heads/feature/x');
  assert.equal((await call('/api/branch', { method: 'POST', body: { name: 'bad..name' } })).status, 400);
  assert.equal((await call('/api/branch', { method: 'POST', auth: 'view-secret', body: { name: 'x' } })).status, 403);
  assert.equal(validBranchName('a/b-c_1.2'), true);
  assert.equal(validBranchName('a b'), false);
  assert.equal(validBranchName('x.lock'), false);
});

test('导出 zip：透传并带下载文件名', async () => {
  const r = await call('/api/export', { auth: 'view-secret' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /configs-main\.zip/);
  assert.equal(new Uint8Array(await r.arrayBuffer())[0], 0x50);
});

const cfgRoot = { root: 'cfg' };
const ops = body => normalizeCommitRequest(cfgRoot, body, scopedPath);

test('原子提交：请求校验', () => {
  assert.throws(() => ops({}), /没有可提交/);
  assert.throws(() => ops({ changes: [{ path: 'a', content: 'x', base64: 'eA==' }] }), /二选一/);
  assert.throws(() => ops({ changes: [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }] }), /重复/);
  assert.throws(() => ops({ changes: [{ path: 'a', content: 'x' }, { path: 'a/b', content: 'y' }] }), /冲突/);
  assert.throws(() => ops({ changes: [{ path: '../x', content: 'x' }] }), /非法/);
  assert.throws(() => ops({ changes: [{ path: '.github/workflows/x.yml', content: 'x' }] }), /工作流/);
  assert.throws(() => ops({ changes: [{ path: 'a', base64: '***' }] }), /Base64/);
  assert.equal(ops({ changes: [{ path: 'a', content: 'x' }], deletes: ['b'] })[0].path, 'cfg/a');
  const many = Array.from({ length: 51 }, (_, i) => ({ path: 'f' + i, content: 'x' }));
  assert.throws(() => ops({ changes: many }), /最多/);
});

test('原子提交：跳过内容未变的文件、检测与目录/文件的冲突', async () => {
  const same = enc.encode('hello\n');
  const sha = await gitBlobSha(same);
  assert.equal(await gitBlobSha(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'); // 空 blob 的已知值
  const tree = [
    { type: 'blob', mode: '100644', path: 'cfg/same.txt', sha },
    { type: 'blob', mode: '100755', path: 'cfg/run.sh', sha: 'z'.repeat(40) },
    { type: 'tree', path: 'cfg/dir', mode: '040000', sha: 't' },
    { type: 'blob', mode: '100644', path: 'cfg/file', sha: 'y'.repeat(40) },
  ];
  const plan = await planCommit(tree, ops({
    changes: [{ path: 'same.txt', content: 'hello\n' }, { path: 'run.sh', content: '#!/bin/sh\n' }, { path: 'new.txt', content: 'n' }],
    deletes: ['file', 'ghost'],
  }));
  assert.deepEqual(plan.stats, { changed: 2, skipped: 2, deleted: 1 });
  assert.equal(plan.entries.find(e => e.op?.rel === 'run.sh').existing.mode, '100755'); // 保留可执行位
  await assert.rejects(planCommit(tree, ops({ changes: [{ path: 'dir', content: 'x' }] })), /已是目录/);
  await assert.rejects(planCommit(tree, ops({ changes: [{ path: 'file/sub.txt', content: 'x' }] })), /已是文件/);
});

test('POST /api/commit：一次提交完成，且受角色限制', async () => {
  treeEntries = [{ type: 'blob', mode: '100644', path: 'old.txt', sha: 'o'.repeat(40) }];
  const r = await call('/api/commit', { method: 'POST', auth: 'alice-tok', body: {
    message: 'bulk', changes: [{ path: 'a.txt', content: 'A' }, { path: 'img.bin', base64: 'AAEC' }], deletes: ['old.txt'],
  } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { commitSha: 'c'.repeat(40), changed: 2, skipped: 0, deleted: 1 });
  const tree = calls.find(c => c.url.endsWith('/git/trees') && c.method === 'POST').body.tree;
  assert.equal(tree.find(e => e.path === 'a.txt').content, 'A');
  assert.equal(tree.find(e => e.path === 'img.bin').sha, 'b'.repeat(40));
  assert.equal(tree.find(e => e.path === 'old.txt').sha, null);
  assert.equal(calls.find(c => c.url.endsWith('/git/commits') && c.method === 'POST').body.message, 'bulk\n\nEdited-by: alice');
  assert.equal((await call('/api/commit', { method: 'POST', auth: 'view-secret', body: { changes: [{ path: 'a', content: 'x' }] } })).status, 403);
});
