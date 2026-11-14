import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.js';

globalThis.crypto ||= webcrypto;
const sha = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const data = {
  'configs/a.yaml': { content: Buffer.from('hello: world\n').toString('base64'), sha },
};
const cached = new Map();
globalThis.caches = { default: {
  match: async req => cached.get(req.url)?.clone(),
  put: async (req, res) => { cached.set(req.url, res.clone()); },
} };
const requests = [];
globalThis.fetch = async (resource, init = {}) => {
  const url = String(resource);
  requests.push({ url, method: init.method || 'GET' });
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    if (url.endsWith('/configs/a.yaml')) return new Response('hello: world\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not Found', { status: 404 });
  }
  if (url.endsWith('/repos/example/configs')) return Response.json({ private: false });
  if (url.includes('/git/trees/main')) return Response.json({ truncated: false, tree: [{ type: 'blob', path: 'configs/a.yaml', size: 13, sha }, { type: 'blob', path: 'README.md', size: 10, sha }] });
  if (url.includes('/commits/main')) return Response.json({ sha: commit });
  const match = url.match(/\/repos\/example\/configs\/contents\/(.*?)(?:\?ref=.*)?$/);
  if (match) {
    const p = match[1].split('?')[0];
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      data[p] = { content: body.content, sha };
      return Response.json({ content: { sha }, commit: { sha: commit } });
    }
    if (init.method === 'DELETE') {
      delete data[p];
      return Response.json({ commit: { sha: commit } });
    }
    if (!data[p]) return Response.json({ message: 'Not Found' }, { status: 404 });
    return Response.json({ type: 'file', encoding: 'base64', size: 13, sha: data[p].sha, content: data[p].content });
  }
  return Response.json({ message: `Unknown: ${url}` }, { status: 404 });
};
const env = { GITHUB_OWNER: 'example', GITHUB_REPO: 'configs', GITHUB_BRANCH: 'main', ROOT_DIR: 'configs', ADMIN_TOKEN: 'admin-secret', GITHUB_TOKEN: 'github-secret', PUBLIC_FILES: 'true', CACHE_TTL: '60' };
const ctx = { waitUntil: p => p.catch(() => {}) };
const call = (path, method = 'GET', auth = 'admin-secret', body) => worker.fetch(new Request('https://hub.example.com' + path, {
  method, headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}), env, ctx);

// /api/info 允许无 token / 任意 token 访问（公开仓库首页展示）
let r = await call('/api/info', 'GET', 'wrong');
assert.equal(r.status, 200);
let info = await r.json();
assert.equal(info.owner, 'example');
assert.equal(info.publicFiles, true);

// 无 GITHUB_TOKEN 时 private 字段为 null
const noEnv = { ...env, GITHUB_TOKEN: '' };
r = await worker.fetch(new Request('https://hub.example.com/api/info'), noEnv, ctx);
info = await r.json();
assert.equal(info.private, null);

// /api/files /api/file 仍然需要 admin 鉴权
r = await call('/api/files', 'GET', 'wrong');
assert.equal(r.status, 401);
r = await call('/api/file?path=a.yaml', 'GET', 'wrong');
assert.equal(r.status, 401);
r = await call('/api/files');
assert.deepEqual((await r.json()).files.map(f => f.path), ['a.yaml']);
r = await call('/api/file?path=a.yaml');
assert.equal((await r.json()).content, data['configs/a.yaml'].content);
r = await call('/api/file?path=new.json', 'PUT', undefined, { content: Buffer.from('{"a":1}').toString('base64') });
assert.equal(r.status, 200);
assert.equal(data['configs/new.json'].content, Buffer.from('{"a":1}').toString('base64'));
r = await call('/api/file?path=new.json', 'DELETE', undefined, { sha });
assert.equal(r.status, 200);
assert.equal(data['configs/new.json'], undefined);
r = await call('/api/file?path=..%2Fprivate.txt');
assert.equal(r.status, 400);
r = await call('/file/a.yaml', 'GET', 'not-admin');
assert.equal(r.status, 200);
assert.equal(await r.text(), 'hello: world\n');
r = await call('/file/a.yaml', 'GET', 'not-admin');
assert.equal(r.headers.get('X-Worker-Cache'), 'HIT');
r = await call('/file/a.yaml?v=' + commit, 'GET', 'not-admin');
assert.equal(r.status, 200);
assert.ok(requests.some(x => x.url.includes('/' + commit + '/configs/a.yaml')));
env.PUBLIC_FILES = 'false';
r = await call('/file/a.yaml', 'GET', 'not-admin');
assert.equal(r.status, 404);
console.log('PASS: auth, repository info, scoped listing, reading, uploading, deleting, traversal block, public proxy/cache, privacy toggle');
