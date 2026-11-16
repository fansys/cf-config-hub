/** 后端接口测试：mock GitHub / Cache API，不需要网络。 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { _resetThrottle } from '../src/auth.js';
import worker from '../src/index.js';

globalThis.crypto ||= webcrypto;

const SHA = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const fixed = () => ({ 'configs/a.yaml': { content: Buffer.from('hello: world\n').toString('base64'), sha: SHA } });
let data;
let requests;
let cache;
let upstreamBody;

globalThis.caches = {
  default: {
    match: async req => cache.get(req.url)?.clone(),
    put: async (req, res) => { cache.set(req.url, res.clone()); },
  },
};

globalThis.fetch = async (resource, init = {}) => {
  const url = String(resource);
  requests.push({ url, method: init.method || 'GET', headers: init.headers || {} });
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    if (url.endsWith('/configs/a.yaml')) {
      return new Response(upstreamBody ?? 'hello: world\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Not Found', { status: 404 });
  }
  if (url.endsWith('/repos/example/configs')) return Response.json({ private: false });
  if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: COMMIT } });
  if (url.includes('/git/trees/' + COMMIT)) {
    return Response.json({ truncated: false, tree: [
      { type: 'blob', path: 'configs/a.yaml', size: 13, sha: SHA },
      { type: 'blob', path: 'README.md', size: 10, sha: SHA },
    ] });
  }
  if (url.includes('/commits?')) {
    return Response.json([{ sha: COMMIT, commit: { message: 'Update a.yaml\n\nbody', author: { name: 'Alice', date: '2026-11-15T00:00:00Z' } } }]);
  }
  const m = url.match(/\/repos\/example\/configs\/contents\/(.*?)(?:\?ref=.*)?$/);
  if (m) {
    const p = m[1].split('?')[0];
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      data[p] = { content: body.content, sha: SHA };
      return Response.json({ content: { sha: SHA }, commit: { sha: COMMIT } });
    }
    if (init.method === 'DELETE') { delete data[p]; return Response.json({ commit: { sha: COMMIT } }); }
    if (!data[p]) return Response.json({ message: 'Not Found' }, { status: 404 });
    return Response.json({ type: 'file', encoding: 'base64', size: 13, sha: data[p].sha, content: data[p].content });
  }
  return Response.json({ message: `Unknown: ${url}` }, { status: 404 });
};

const baseEnv = {
  GITHUB_OWNER: 'example', GITHUB_REPO: 'configs', GITHUB_BRANCH: 'main', ROOT_DIR: 'configs',
  ADMIN_TOKEN: 'admin-secret', GITHUB_TOKEN: 'github-secret', PUBLIC_FILES: 'true', CACHE_TTL: '60',
};
const ctx = { waitUntil: p => p.catch(() => {}) };
const call = (path, { method = 'GET', auth = 'admin-secret', body, env = baseEnv } = {}) =>
  worker.fetch(new Request('https://hub.example.com' + path, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, ctx);

beforeEach(() => { data = fixed(); requests = []; cache = new Map(); upstreamBody = undefined; _resetThrottle(); });

test('/api/info 无需口令，且只暴露"是否已配置"而非密钥', async () => {
  const r = await call('/api/info', { auth: 'wrong' });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.owner, 'example');
  assert.equal(info.publicFiles, true);
  assert.deepEqual(info.configured, { githubToken: true, adminToken: true });
  assert.ok(!JSON.stringify(info).includes('github-secret'));
  assert.ok(!JSON.stringify(info).includes('admin-secret'));
});

test('无 GITHUB_TOKEN 时 private 为 null 且不调用 GitHub', async () => {
  const r = await call('/api/info', { env: { ...baseEnv, GITHUB_TOKEN: '' } });
  assert.equal((await r.json()).private, null);
});

test('管理接口需要正确口令', async () => {
  assert.equal((await call('/api/files', { auth: 'wrong' })).status, 401);
  assert.equal((await call('/api/files', { auth: '' })).status, 401);
  assert.equal((await call('/api/file?path=a.yaml', { auth: 'wrong' })).status, 401);
});

test('连续输错口令会被限流', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call('/api/files', { auth: 'bad' + i })).status, 401);
  assert.equal((await call('/api/files', { auth: 'bad' })).status, 429);
  assert.equal((await call('/api/files')).status, 429, '限流期间连正确口令也应被拒');
});

test('列表按 ROOT_DIR 隔离；读写删完整流程', async () => {
  let r = await call('/api/files');
  assert.deepEqual((await r.json()).files.map(f => f.path), ['a.yaml']);

  r = await call('/api/file?path=a.yaml');
  assert.equal((await r.json()).content, data['configs/a.yaml'].content);

  const content = Buffer.from('{"a":1}').toString('base64');
  r = await call('/api/file?path=new.json', { method: 'PUT', body: { content } });
  assert.equal(r.status, 200);
  assert.equal(data['configs/new.json'].content, content);

  r = await call('/api/file?path=new.json', { method: 'DELETE', body: { sha: SHA } });
  assert.equal(r.status, 200);
  assert.equal(data['configs/new.json'], undefined);
});

test('拦截路径穿越与 Actions 工作流', async () => {
  assert.equal((await call('/api/file?path=..%2Fprivate.txt')).status, 400);
  assert.equal((await call('/api/file?path=a//b')).status, 400);
  assert.equal((await call('/api/file?path=x/.GIT/config')).status, 400);
  assert.equal((await call('/api/file?path=.github/workflows/x.yml')).status, 403);
  assert.equal((await call('/file/..%2Fx', { auth: '' })).status, 400);
});

test('写入校验：非法 Base64、非法 SHA、缺少 SHA 的删除', async () => {
  assert.equal((await call('/api/file?path=x.txt', { method: 'PUT', body: { content: '***' } })).status, 413);
  const ok = Buffer.from('x').toString('base64');
  assert.equal((await call('/api/file?path=x.txt', { method: 'PUT', body: { content: ok, sha: 'zz' } })).status, 400);
  assert.equal((await call('/api/file?path=x.txt', { method: 'DELETE', body: {} })).status, 400);
});

test('公开代理：无需口令、命中缓存、固定版本', async () => {
  let r = await call('/file/a.yaml', { auth: '' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'hello: world\n');
  assert.equal(r.headers.get('X-Worker-Cache'), 'MISS');

  r = await call('/file/a.yaml', { auth: '' });
  assert.equal(r.headers.get('X-Worker-Cache'), 'HIT');

  r = await call('/file/a.yaml?v=' + COMMIT, { auth: '' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Cache-Control'), /immutable/);
  assert.ok(requests.some(x => x.url.includes(`/${COMMIT}/configs/a.yaml`)));
  assert.equal((await call('/file/a.yaml?v=nothex', { auth: '' })).status, 400);
});

test('公开代理绝不携带 GitHub 令牌（防止私有内容经 PAT 泄露）', async () => {
  await call('/file/a.yaml', { auth: '' });
  const raw = requests.filter(x => x.url.startsWith('https://raw.githubusercontent.com/'));
  assert.ok(raw.length > 0);
  for (const req of raw) {
    assert.equal(JSON.stringify(req.headers).toLowerCase().includes('authorization'), false);
    assert.equal(JSON.stringify(req.headers).includes('github-secret'), false);
  }
});

test('公开代理：HTML/SVG 降级为 text/plain，且上游过大时拒绝', async () => {
  data['configs/x.html'] = { content: '', sha: SHA };
  upstreamBody = 'x'.repeat(6 * 1024 * 1024);
  const r = await call('/file/a.yaml', { auth: '' });
  assert.equal(r.status, 413);
  const { mimeFor } = await import('../src/lib/mime.js');
  assert.equal(mimeFor('a/b.html'), 'text/plain; charset=utf-8');
  assert.equal(mimeFor('a/b.svg', 'image/svg+xml'), 'text/plain; charset=utf-8');
});

test('PUBLIC_FILES=false 时代理返回 404', async () => {
  const r = await call('/file/a.yaml', { auth: '', env: { ...baseEnv, PUBLIC_FILES: 'false' } });
  assert.equal(r.status, 404);
});

test('未配置仓库时返回 503 而非崩溃', async () => {
  const r = await call('/api/info', { env: { ...baseEnv, GITHUB_OWNER: 'YOUR_GITHUB_OWNER' } });
  assert.equal(r.status, 503);
});

test('/api/history：返回精简的提交列表，路径带 ROOT_DIR', async () => {
  const r = await call('/api/history?path=a.yaml');
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).commits, [{ sha: COMMIT, message: 'Update a.yaml', author: 'Alice', date: '2026-11-15T00:00:00Z' }]);
  const req = requests.find(x => x.url.includes('/commits?'));
  assert.match(req.url, /path=configs%2Fa\.yaml/);
  assert.equal((await call('/api/history?path=a.yaml', { auth: 'wrong' })).status, 401);
  assert.equal((await call('/api/history?path=../x')).status, 400);
});

test('/api/file?ref=：只接受 40 位 commit SHA，并按该版本读取', async () => {
  assert.equal((await call('/api/file?path=a.yaml&ref=main')).status, 400);
  const r = await call('/api/file?path=a.yaml&ref=' + COMMIT);
  assert.equal(r.status, 200);
  assert.ok(requests.some(x => x.url.includes('contents/configs/a.yaml?ref=' + COMMIT)));
});
