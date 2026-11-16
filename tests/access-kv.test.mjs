/** 访问规则存放在 KV：读写、优先级、校验、权限、失败即关闭。 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { _resetThrottle } from '../src/auth.js';
import worker from '../src/index.js';
import { _clearAccessCache, loadRules, normalizeRules } from '../src/lib/accessstore.js';
import { _clearVersionCache } from '../src/lib/linkversion.js';
import { linkFailures } from '../src/routes/file.js';

globalThis.crypto ||= webcrypto;
let calls, store, kvFail;
const kv = {
  async get(key, opts) {
    if (kvFail) throw new Error('kv down');
    const v = store.get(key);
    return v === undefined ? null : opts?.type === 'json' ? JSON.parse(v) : v;
  },
  async put(key, value) { store.set(key, value); },
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
globalThis.fetch = async (resource, init = {}) => {
  const url = String(resource);
  calls.push({ url, headers: init.headers || {} });
  if (url.includes('.cfhub-links.json')) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (url.includes('/contents/clash/a.list')) return new Response('DOMAIN,a.com\n', { headers: { 'content-type': 'text/plain' } });
  if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('public', { status: 200 });
  return Response.json({ message: 'Not Found' }, { status: 404 });
};
const env = {
  GITHUB_OWNER: 'example', GITHUB_REPO: 'priv', GITHUB_BRANCH: 'main', ROOT_DIR: '', PUBLIC_FILES: 'true',
  ADMIN_TOKEN: 'admin-secret', READONLY_TOKEN: 'ro-secret', GITHUB_TOKEN: 'ghp', LINK_SECRET: 's', ACCESS_CACHE_TTL: '0', CONFIG_KV: kv,
};
const call = (path, { method = 'GET', auth = 'admin-secret', body, e = env } = {}) =>
  worker.fetch(new Request('https://hub.example.com' + path, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), e, { waitUntil() {} });
const put = (rules, o = {}) => call('/api/access', { method: 'PUT', body: { rules }, ...o });

beforeEach(() => { calls = []; store = new Map(); kvFail = false; _resetThrottle(); _clearVersionCache(); _clearAccessCache(); linkFailures.reset(); });

test('规则校验：模式、路径、目录补 **、去重、数量', () => {
  assert.deepEqual(normalizeRules([{ pattern: ' clash/ ', mode: 'DIRECT' }, { pattern: 'clash/**', mode: 'direct' }, { pattern: '/a.txt', mode: 'token' }]),
    [{ pattern: 'clash/**', mode: 'direct' }, { pattern: 'a.txt', mode: 'token' }]);
  for (const bad of [[{ pattern: '', mode: 'direct' }], [{ pattern: 'a', mode: 'open' }], [{ pattern: '../x', mode: 'deny' }], [{ pattern: 'a,b', mode: 'token' }], [{ pattern: 'a\\b', mode: 'token' }], 'x']) {
    assert.throws(() => normalizeRules(bad), `${JSON.stringify(bad)}`);
  }
  assert.throws(() => normalizeRules(Array.from({ length: 201 }, (_, i) => ({ pattern: 'f' + i, mode: 'token' }))), /200/);
});

test('读取：KV 没有时回退到 DIRECT_PATHS；保存后以 KV 为准（即使保存空列表）', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/:direct' };
  let r = await loadRules(e, { owner: 'example', repo: 'priv', root: '' });
  assert.deepEqual([r.source, r.rules], ['env', [{ pattern: 'clash/**', mode: 'direct' }]]);

  assert.equal((await put([{ pattern: 'docs/', mode: 'token' }], { e })).status, 200);
  _clearAccessCache();
  r = await loadRules(e, { owner: 'example', repo: 'priv', root: '' });
  assert.deepEqual([r.source, r.rules, r.updatedBy], ['kv', [{ pattern: 'docs/**', mode: 'token' }], 'admin']);

  await put([], { e });
  _clearAccessCache();
  r = await loadRules(e, { owner: 'example', repo: 'priv', root: '' });
  assert.deepEqual([r.source, r.rules], ['kv', []], '空列表也覆盖环境变量');
});

test('接口：GET 返回来源与 KV 状态；PUT 仅读写角色；非法输入 400；规则按分支独立', async () => {
  const g = await (await call('/api/access')).json();
  assert.deepEqual([g.source, g.kvAvailable, g.rules], ['env', true, []]);
  assert.equal((await put([{ pattern: 'a', mode: 'token' }], { auth: 'ro-secret' })).status, 403);
  assert.equal((await put([{ pattern: 'a', mode: 'bogus' }])).status, 400);
  const saved = await (await put([{ pattern: 'clash/', mode: 'direct' }, { pattern: 'clash/secret/', mode: 'deny' }])).json();
  assert.deepEqual(saved.rules.map(r => r.pattern), ['clash/**', 'clash/secret/**']);
  assert.equal(saved.source, 'kv');
  assert.equal((await (await call('/api/context', { auth: 'ro-secret' })).json()).access.rules.length, 2, '只读口令也能看到规则');
  // 规则按分支独立保存：其它分支看不到默认分支的规则，可以单独设置
  const onDev = await worker.fetch(new Request('https://hub.example.com/api/access', { headers: { Authorization: 'Bearer admin-secret', 'X-Cfh-Branch': 'dev' } }), env, { waitUntil() {} });
  assert.equal(onDev.status, 200);
  const dev = await onDev.json();
  assert.deepEqual([dev.rules.length, dev.source], [0, 'none']);
});

test('没有绑定 KV：来源为环境变量，保存返回 503', async () => {
  const e = { ...env, CONFIG_KV: undefined, DIRECT_PATHS: 'x/:token' };
  const g = await (await call('/api/access', { e })).json();
  assert.deepEqual([g.source, g.kvAvailable, g.rules], ['env', false, [{ pattern: 'x/**', mode: 'token' }]]);
  assert.equal((await put([], { e })).status, 503);
});

test('规则在 KV 中即时影响访问：直链、令牌签发与访问', async () => {
  await put([{ pattern: 'clash/', mode: 'direct' }, { pattern: 'clash/secret/', mode: 'deny' }]);
  calls = [];
  assert.equal((await call('/file/clash/a.list', { auth: '' })).status, 200);
  assert.ok(calls.some(c => c.url.includes('/contents/clash/a.list') && c.headers.Authorization), 'direct：用 PAT 读取');
  calls = [];
  await call('/file/clash/secret/k.list', { auth: '' });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), 'deny：不用 PAT');

  const issue = paths => call('/api/links', { method: 'POST', body: { paths } });
  assert.equal((await issue(['clash/a.list'])).status, 200);
  assert.equal((await issue(['clash/secret/k.list'])).status, 403);
  assert.equal((await issue(['elsewhere/x'])).status, 403);

  const { links } = await (await issue(['clash/a.list'])).json();
  assert.equal((await call(`/t/${links[0].token}/clash/a.list`, { auth: '' })).status, 200);
  // 改规则收紧后，已发出的令牌立即对该文件失效
  await put([{ pattern: 'docs/', mode: 'token' }]);
  assert.equal((await call(`/t/${links[0].token}/clash/a.list`, { auth: '' })).status, 403);
});

test('KV 读取失败：令牌访问返回 503（失败即关闭），无令牌请求不开放直链', async () => {
  const { links } = await (await call('/api/links', { method: 'POST', body: { paths: ['clash/a.list'] } })).json();
  kvFail = true;
  _clearAccessCache();
  assert.equal((await call(`/t/${links[0].token}/clash/a.list`, { auth: '' })).status, 503);
  calls = [];
  await call('/file/clash/a.list', { auth: '' });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), '读不到规则时不会用 PAT');
});

test('POST /api/access/set：只改这条路径自己的规则；null 恢复继承；其它规则保留', async () => {
  await put([{ pattern: 'clash/', mode: 'direct' }, { pattern: 'docs/', mode: 'token' }]);
  const set = (pattern, mode, o = {}) => call('/api/access/set', { method: 'POST', body: { pattern, mode }, ...o });

  let r = await (await set('clash/abc.list', 'token')).json();
  assert.deepEqual(r.rules, [{ pattern: 'clash/**', mode: 'direct' }, { pattern: 'docs/**', mode: 'token' }, { pattern: 'clash/abc.list', mode: 'token' }]);

  r = await (await set('clash/abc.list', 'deny')).json(); // 同一路径再设置 = 替换而不是叠加
  assert.deepEqual(r.rules.filter(x => x.pattern === 'clash/abc.list'), [{ pattern: 'clash/abc.list', mode: 'deny' }]);

  r = await (await set('docs/', 'direct')).json(); // 目录写法规范为 /**
  assert.deepEqual(r.rules.filter(x => x.pattern === 'docs/**'), [{ pattern: 'docs/**', mode: 'direct' }]);

  r = await (await set('clash/abc.list', null)).json(); // 恢复继承 = 删除这条
  assert.ok(!r.rules.some(x => x.pattern === 'clash/abc.list'));
  assert.equal(r.rules.length, 2);

  assert.equal((await set('x', 'bogus')).status, 400);
  assert.equal((await set('../x', 'token')).status, 400);
  assert.equal((await set('a', 'token', { auth: 'ro-secret' })).status, 403);
  assert.equal((await set('a', 'token', { e: { ...env, CONFIG_KV: undefined } })).status, 503);
});

test('从环境变量迁移：KV 里没有规则时，set 会把环境变量里的规则一并带过去', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/:direct' };
  const r = await (await call('/api/access/set', { method: 'POST', body: { pattern: 'clash/abc.list', mode: 'token' }, e })).json();
  assert.equal(r.source, 'kv');
  assert.deepEqual(r.rules.map(x => `${x.pattern}:${x.mode}`).sort(), ['clash/**:direct', 'clash/abc.list:token']);
});
