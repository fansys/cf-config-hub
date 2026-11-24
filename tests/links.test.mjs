/** 私有仓库：令牌链接（规则生成）与免令牌直链。 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { beforeEach, test } from 'node:test';
import { _resetThrottle } from '../src/auth.js';
import worker from '../src/index.js';
import { globToRegExp, matchAny, normalizePatterns } from '../src/lib/glob.js';
import { _clearVersionCache } from '../src/lib/linkversion.js';
import { EPOCH_MS, inspectToken, linkHex, makeToken, minutesToMs, parseToken, toExpiryMinutes, verifyToken } from '../src/lib/linktoken.js';
import { formatTokenExpiry, tokenExpiry } from '../shared/tokenexpiry.js';
import { linkFailures } from '../src/routes/file.js';

globalThis.crypto ||= webcrypto;
let calls, cache, registry;
globalThis.caches = {
  default: {
    match: async req => cache.get(req.url)?.clone(),
    put: async (req, res) => { cache.set(req.url, res.clone()); },
  },
};
globalThis.fetch = async (resource, init = {}) => {
  const url = String(resource);
  calls.push({ url, headers: init.headers || {}, method: init.method || 'GET' });
  if (url.includes('/contents/.cfhub-links.json')) {
    if ((init.method || 'GET') === 'PUT') {
      const b = JSON.parse(init.body);
      if (registry && b.sha !== registry.sha) return Response.json({ message: 'sha mismatch' }, { status: 409 });
      registry = { sha: 'r' + Math.random().toString(16).slice(2, 10).padEnd(39, '0'), text: Buffer.from(b.content, 'base64').toString('utf8') };
      calls.push({ url: 'REGISTRY_PUT', body: b });
      return Response.json({ content: { sha: registry.sha } });
    }
    if (!registry) return Response.json({ message: 'Not Found' }, { status: 404 });
    return Response.json({ sha: registry.sha, content: Buffer.from(registry.text).toString('base64') });
  }
  if (url.includes('/git/ref/heads/')) return Response.json({ object: { sha: 'p'.repeat(40) } });
  if (url.startsWith('https://api.github.com/repos/example/priv/contents/')) {
    if (url.includes('contents/clash/a.list')) return new Response('DOMAIN,a.com\n', { headers: { 'content-type': 'text/plain', etag: '"e1"' } });
    if (url.includes('contents/dir')) return Response.json([{ name: 'x' }]);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }
  if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('public body', { status: 200 });
  return Response.json({ message: 'unknown ' + url }, { status: 404 });
};

const env = {
  GITHUB_OWNER: 'example', GITHUB_REPO: 'priv', GITHUB_BRANCH: 'main', ROOT_DIR: '',
  ADMIN_TOKEN: 'admin-secret', GITHUB_TOKEN: 'ghp-secret', PUBLIC_FILES: 'true', LINK_SECRET: 'link-secret-1', ACCESS_CACHE_TTL: '0',
};
const call = (path, { method = 'GET', auth, body, headers = {}, e = env } = {}) =>
  worker.fetch(new Request('https://hub.example.com' + path, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), e, { waitUntil() {} });
const mint = async (body, e = env) => (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body, e })).json());

beforeEach(() => { calls = []; cache = new Map(); registry = null; _resetThrottle(); _clearVersionCache(); linkFailures.reset(); });

const cfg = { owner: 'example', repo: 'priv', root: '' };

test('通配规则（仅用于 DIRECT_PATHS）：* 单层、** 多层、? 单字符，整体锚定', () => {
  const t = (p, s) => globToRegExp(p).test(s);
  assert.ok(t('clash/*.list', 'clash/a.list'));
  assert.ok(!t('clash/*.list', 'clash/sub/a.list'));
  assert.ok(t('clash/**', 'clash/sub/deep/a.list'));
  assert.ok(t('**/*.yaml', 'a.yaml') && t('**/*.yaml', 'x/y/a.yaml'));
  assert.ok(t('a?.txt', 'ab.txt') && !t('a?.txt', 'abc.txt'));
  assert.ok(!t('a.txt', 'a_txt'), '点号按字面量');
  assert.ok(matchAny(['x', 'clash/*'], 'clash/b'));
  assert.deepEqual(normalizePatterns([' a/* ']), ['a/*']);
  for (const bad of [[], [''], ['../x'], ['/abs'], ['a\\b'], ['a/./b'], Array(21).fill('a')]) assert.throws(() => normalizePatterns(bad));
});

test('令牌格式：10 位 hex + 6 位分钟数，共 16 个字符', async () => {
  const t = await makeToken(env, cfg, 'clash/a.list', { expiresAtMs: EPOCH_MS + 90 * 60000, version: 3 });
  assert.match(t, /^[0-9a-f]{10}\d{6}$/);
  assert.equal(t.length, 16);
  assert.equal(t.slice(-6), '000090');
  assert.deepEqual(parseToken(t), { hex: t.slice(0, 10), minutes: 90 });
  const forever = await makeToken(env, cfg, 'a', { version: 1 });
  assert.equal(forever.slice(-6), '000000', '永久 = 000000');
  assert.equal(tokenExpiry(t).expiresAt, minutesToMs(90));
  assert.equal(tokenExpiry(forever).permanent, true);
  assert.match(formatTokenExpiry(t, EPOCH_MS), /^到期 /);
  assert.equal(formatTokenExpiry(forever), '永久有效');
  for (const bad of ['', 'x', '1234567890', `${'a'.repeat(10)}12345`, `${'a'.repeat(10)}1234567`, `${'g'.repeat(10)}000001`, `${'A'.repeat(10)}000001`]) assert.equal(parseToken(bad), null, bad);
  assert.equal(toExpiryMinutes(EPOCH_MS + 60000 * 5 + 1), 6, '向上取整，不会比期望的到期时间更早');
  assert.equal(minutesToMs(1), EPOCH_MS + 60000);
  await assert.rejects(makeToken(env, cfg, 'a', { expiresAtMs: EPOCH_MS + 1_000_000 * 60000, version: 1 }), /694/);
  // 一年（525600 分钟）在 6 位范围内
  assert.equal((await makeToken(env, cfg, 'a', { expiresAtMs: EPOCH_MS + 525600 * 60000, version: 1 })).slice(-6), '525600');
});

test('签名由 文件名 + 文件版本 + 6 位分钟数 决定（版本不在令牌里）', async () => {
  const base = await linkHex(env, cfg, 'clash/a.list', 1, 100);
  assert.match(base, /^[0-9a-f]{10}$/);
  assert.notEqual(base, await linkHex(env, cfg, 'clash/b.list', 1, 100), '文件名');
  assert.notEqual(base, await linkHex(env, cfg, 'clash/a.list', 2, 100), '文件版本');
  assert.notEqual(base, await linkHex(env, cfg, 'clash/a.list', 1, 101), '分钟数');
  assert.notEqual(base, await linkHex({ ...env, LINK_SECRET: 'x' }, cfg, 'clash/a.list', 1, 100), '密钥');
  assert.notEqual(base, await linkHex(env, { ...cfg, repo: 'other' }, 'clash/a.list', 1, 100), '仓库');
});

test('令牌校验：换文件/篡改/版本不符都无效；过期；永久', async () => {
  const exp = EPOCH_MS + 1000 * 60000;
  const t = await makeToken(env, cfg, 'clash/a.list', { expiresAtMs: exp, version: 2 });
  const now = EPOCH_MS + 10 * 60000;
  const verify = (token, path = 'clash/a.list', version = 2, n = now) => verifyToken(env, cfg, token, path, version, { now: n });
  assert.equal((await verify(t)).ok, true);
  assert.equal((await verify(t, 'clash/b.list')).reason, 'invalid', '换文件');
  assert.equal((await verify(t, 'clash/a.list', 3)).reason, 'invalid', '版本提升 = 撤销');
  assert.equal((await verify(t.slice(0, 10) + '001001')).reason, 'invalid', '篡改到期分钟');
  assert.equal((await verify('0'.repeat(10) + t.slice(10))).reason, 'invalid', '篡改 hex');
  assert.equal((await verifyToken({ ...env, LINK_SECRET: 'x' }, cfg, t, 'clash/a.list', 2, { now })).reason, 'invalid');
  assert.equal((await verify(t, 'clash/a.list', 2, exp + 1)).reason, 'expired');
  assert.equal((await verify('garbage')).reason, 'malformed');
  const perm = await makeToken(env, cfg, 'a', { version: 1 });
  assert.equal((await verifyToken(env, cfg, perm, 'a', 1, { now: EPOCH_MS + 1e12 })).ok, true, '永久有效');
});

test('inspectToken：区分 有效 / 已撤销（旧版本）/ 无效', async () => {
  const t = await makeToken(env, cfg, 'a.txt', { version: 2 });
  assert.equal((await inspectToken(env, cfg, t, 'a.txt', 2)).status, 'valid');
  const revoked = await inspectToken(env, cfg, t, 'a.txt', 5);
  assert.deepEqual([revoked.status, revoked.version], ['revoked', 2]);
  assert.equal((await inspectToken(env, cfg, t, 'other.txt', 2)).status, 'invalid');
  assert.equal((await inspectToken(env, cfg, 'nope', 'a.txt', 2)).status, 'malformed');
  const old = await makeToken(env, cfg, 'a.txt', { expiresAtMs: EPOCH_MS + 60000, version: 1 });
  assert.equal((await inspectToken(env, cfg, old, 'a.txt', 1)).status, 'expired');
});

test('签发接口：批量、有效期校验、只读口令不能签发', async () => {
  const post = (body, o = {}) => call('/api/links', { method: 'POST', auth: 'admin-secret', body, ...o });
  assert.equal((await post({ paths: [] })).status, 400);
  assert.equal((await post({ paths: ['a'], expiresIn: 5 })).status, 400);
  assert.equal((await post({ paths: ['a'], expiresIn: 999999999 })).status, 400);
  assert.equal((await post({ paths: ['../x'] })).status, 400);
  assert.equal((await post({ paths: ['.cfhub-links.json'] })).status, 403, '版本表是保留文件');
  assert.equal((await call('/api/links', { method: 'POST', body: { paths: ['a'] } })).status, 401);
  assert.equal((await post({ paths: ['a'] }, { e: { ...env, READONLY_TOKEN: 'ro' }, auth: 'ro' })).status, 403);

  const day = await (await post({ paths: ['clash/a.list', 'clash/b.list'], expiresIn: 86400 })).json();
  assert.equal(day.links.length, 2);
  assert.ok(Math.abs(day.expiresAt - (Date.now() + 86400e3)) < 120e3);
  const perm = await (await post({ paths: ['clash/a.list'] })).json();
  assert.equal(perm.expiresAt, null);
  assert.equal(perm.links[0].token.slice(-6), '000000');
  assert.equal(perm.links[0].token.length, 16);
});

test('令牌链接：私有文件可读（路径式/查询式）；令牌只对自己的文件有效', async () => {
  const { links } = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'], expiresIn: 3600 } })).json();
  const token = links[0].token;
  let r = await call(`/t/${token}/clash/a.list`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'DOMAIN,a.com\n');
  assert.match(r.headers.get('cache-control'), /^private/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(calls.find(c => c.url.includes('/contents/clash/a.list')).headers.Authorization, 'Bearer ghp-secret');

  r = await call(`/file/clash/a.list?token=${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-worker-cache'), 'HIT');
  assert.match(r.headers.get('cache-control'), /^private/);

  assert.equal((await call(`/t/${token}/clash/other.list`)).status, 401, '换文件：签名不匹配');
  const flipped = token.slice(0, -1) + String((Number(token.at(-1)) + 1) % 10); // 一定与原令牌不同（原写法在末位恰为 0 时会碰巧不变）
  assert.equal((await call(`/t/${flipped}/clash/a.list`)).status, 401);
  assert.equal((await call(`/t/short/clash/a.list`)).status, 401);
  assert.equal((await call(`/t/${token}/..%2Fx`)).status, 400);
  assert.equal((await call(`/t/${token}/.cfhub-links.json`)).status, 401);
});

test('撤销 = 文件版本 +1：只废掉该文件的旧链接，新链接立即可用', async () => {
  const mint = async paths => (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths } })).json()).links;
  const [a, b] = await mint(['clash/a.list', 'clash/b.list']);
  assert.equal(a.version, 1);
  assert.equal((await call(`/t/${a.token}/clash/a.list`)).status, 200);

  const rev = await call('/api/links/revoke', { method: 'POST', auth: 'admin-secret', body: { path: 'clash/a.list' } });
  assert.equal(rev.status, 200);
  assert.equal((await rev.json()).version, 2);
  const put = calls.find(c => c.url === 'REGISTRY_PUT');
  assert.equal(JSON.parse(Buffer.from(put.body.content, 'base64').toString()).files['clash/a.list'], 2);

  _clearVersionCache();
  cache.clear();
  assert.equal((await call(`/t/${a.token}/clash/a.list`)).status, 401, '旧链接失效');
  assert.notEqual((await call(`/t/${b.token}/clash/b.list`)).status, 401, '其它文件的链接不受影响（通过校验，上游模拟里没有这个文件所以是 404）');
  const [a2] = await mint(['clash/a.list']);
  assert.equal(a2.version, 2);
  assert.equal((await call(`/t/${a2.token}/clash/a.list`)).status, 200, '重新生成的链接可用');
  const vers = await (await call('/api/links/versions', { auth: 'admin-secret' })).json();
  assert.deepEqual([vers.global, vers.files, vers.branch], [0, { 'clash/a.list': 2 }, '']);
  assert.equal((await call('/api/links/revoke', { method: 'POST', auth: 'ro', e: { ...env, READONLY_TOKEN: 'ro' }, body: { all: true } })).status, 403);
});

test('撤销全部：global +1，所有文件的旧链接都失效', async () => {
  const mint = async paths => (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths } })).json()).links;
  const [a, b] = await mint(['clash/a.list', 'x/y.txt']);
  await call('/api/links/revoke', { method: 'POST', auth: 'admin-secret', body: { all: true } });
  _clearVersionCache(); cache.clear();
  assert.equal((await call(`/t/${a.token}/clash/a.list`)).status, 401);
  assert.equal((await call(`/t/${b.token}/x/y.txt`)).status, 401);
  const [a2] = await mint(['clash/a.list']);
  assert.equal(a2.version, 2);
  assert.equal((await call(`/t/${a2.token}/clash/a.list`)).status, 200);
});

test('版本表读取失败时拒绝访问（失败即关闭），已过期令牌被拒', async () => {
  const [a] = (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'], expiresIn: 60 } })).json()).links;
  assert.equal((await call(`/t/${a.token}/clash/a.list`)).status, 200);
  // 构造一个已过期的令牌
  const old = await makeToken(env, { owner: 'example', repo: 'priv', root: '' }, 'clash/a.list', { expiresAtMs: EPOCH_MS + 60000, version: 1 });
  assert.equal((await call(`/t/${old}/clash/a.list`)).status, 401);
  // 版本表所在的接口报错（非 404）→ 503
  _clearVersionCache(); cache.clear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('.cfhub-links.json') ? Response.json({ message: 'boom' }, { status: 500 }) : realFetch(u, i));
  assert.equal((await call(`/t/${a.token}/clash/a.list`)).status, 503);
  globalThis.fetch = realFetch;
});

test('检查令牌接口：有效 / 已撤销', async () => {
  const [a] = (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'] } })).json()).links;
  const inspect = async () => (await call(`/api/links/inspect?path=clash/a.list&token=${a.token}`, { auth: 'admin-secret' })).json();
  const ok = await inspect();
  assert.deepEqual([ok.valid, ok.status, ok.version, ok.permanent], [true, 'valid', 1, true]);
  await call('/api/links/revoke', { method: 'POST', auth: 'admin-secret', body: { path: 'clash/a.list' } });
  const after = await inspect();
  assert.deepEqual([after.valid, after.status, after.currentVersion, after.version], [false, 'revoked', 2, 1]);
});

test('猜测令牌会被限流（同一来源 30 次无效尝试后 429）；过期不计入', async () => {
  const hdr = { 'CF-Connecting-IP': '198.51.100.7' };
  for (let i = 0; i < 30; i++) assert.equal((await call(`/t/${String(i).padStart(10, '0')}000000/clash/a.list`, { headers: hdr })).status, 401);
  assert.equal((await call('/t/0000000000000000/clash/a.list', { headers: hdr })).status, 429);
  // 其它来源不受影响
  assert.equal((await call('/t/0000000000000000/clash/a.list', { headers: { 'CF-Connecting-IP': '198.51.100.8' } })).status, 401);
});

test('版本表文件不出现在文件列表里，也不能被直接读写', async () => {
  registry = { sha: 'r'.repeat(40), text: '{}' };
  assert.equal((await call('/api/file?path=.cfhub-links.json', { auth: 'admin-secret' })).status, 403);
  assert.equal((await call('/api/file?path=.cfhub-links.json', { method: 'PUT', auth: 'admin-secret', body: { content: 'e30=' } })).status, 403);
});

test('令牌链接不依赖 PUBLIC_FILES；无令牌的私有文件不可读且不使用 PAT', async () => {
  const off = { ...env, PUBLIC_FILES: 'false' };
  const { links } = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'] }, e: off })).json();
  assert.equal((await call(`/t/${links[0].token}/clash/a.list`, { e: off })).status, 200);
  assert.equal((await call('/file/clash/a.list', { e: off })).status, 404);
  calls = [];
  const r = await call('/file/clash/a.list');
  assert.equal(r.status, 200);
  assert.ok(calls.every(c => !JSON.stringify(c.headers).includes('ghp-secret')));
});

test('DIRECT_PATHS：命中规则的私有文件免令牌直链，其余仍不可读', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/*.list' };
  const r = await call('/file/clash/a.list', { e });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'DOMAIN,a.com\n');
  calls = [];
  await call('/file/secret/x.yaml', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), '规则外的路径不会用 PAT 读取');
  const ctx = await (await call('/api/context', { auth: 'admin-secret', e })).json();
  assert.deepEqual(ctx.access.rules, [{ pattern: 'clash/*.list', mode: 'direct' }]);
});

test('前端与服务端的通配语义一致；令牌链接可被"链接解析"识别', async () => {
  const client = await import('../shared/glob.js');
  const cases = [['clash/*.list', 'clash/a.list'], ['clash/*.list', 'clash/x/a.list'], ['**', 'a/b/c'], ['a/**/b', 'a/b'], ['a/**/b', 'a/x/y/b'], ['a?c', 'abc'], ['a.b', 'axb']];
  for (const [p, s] of cases) assert.equal(client.globToRegExp(p).test(s), globToRegExp(p).test(s), `${p} vs ${s}`);
  const { extractPathFromLink } = await import('../shared/linkpath.js');
  const info = { owner: 'a', repo: 'b', branch: 'main', root: 'configs' };
  assert.equal(extractPathFromLink('https://hub.example.com/t/ab12cd34ef000000/clash/a.list', info, 'https://hub.example.com'), 'clash/a.list');
  assert.equal(extractPathFromLink('https://hub.example.com/file/clash/a.list?token=x', info, 'https://hub.example.com'), 'clash/a.list');
});

test('访问策略解析：文件 / 目录 / 通配 + 模式，优先级 deny > direct > token', async () => {
  const { parseAccessRules, resolveAccess } = await import('../src/lib/access.js');
  const rules = parseAccessRules('clash/a.list:direct, clash/, docs/readme.md:token, clash/secret/:deny, /lead/*.txt, bad/../x, :token, weird:oops');
  assert.deepEqual(rules.map(r => [r.pattern, r.mode]), [
    ['clash/a.list', 'direct'], ['clash/**', 'direct'], ['docs/readme.md', 'token'], ['clash/secret/**', 'deny'], ['lead/*.txt', 'direct'], ['weird:oops', 'direct'],
  ], '目录以 / 结尾；省略模式 = direct；非法条目被忽略（"weird:oops" 里的 oops 不是模式，整体当作文件名）');
  const r = p => resolveAccess(rules, p);
  assert.equal(r('clash/a.list').mode, 'direct');
  assert.equal(r('clash/sub/x.list').mode, 'direct');
  assert.equal(r('clash/secret/k.list').mode, 'deny', 'deny 压过目录上的 direct');
  assert.equal(r('docs/readme.md').mode, 'token');
  assert.deepEqual([r('docs/readme.md').direct, r('docs/readme.md').token], [false, true]);
  assert.equal(r('other/x').mode, 'none');
  assert.deepEqual([r('other/x').direct, r('other/x').token], [false, false]);
  const open = resolveAccess([], 'anything');
  assert.deepEqual([open.mode, open.token, open.direct], ['open', true, false], '没有规则时：令牌可访问任意文件，没有直链');
  assert.equal(resolveAccess(parseAccessRules('**:token'), 'a/b/c').token, true);
});

test('策略生效：token 模式需令牌；未开放的文件不能签发也不能凭令牌读取；deny 优先', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/a.list:token, clash/open/:direct, clash/open/private.list:deny' };
  const mint = async paths => call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths }, e });

  // token 模式：无令牌不可读，有令牌可读
  calls = [];
  await call('/file/clash/a.list', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), 'token 模式：无令牌请求不会用 PAT 读取');
  const ok = await mint(['clash/a.list']);
  assert.equal(ok.status, 200);
  const token = (await ok.json()).links[0].token;
  assert.equal((await call(`/t/${token}/clash/a.list`, { e })).status, 200);

  // 未命中任何规则：不能签发
  const blocked = await mint(['other/x.yaml']);
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /other\/x\.yaml:token/);
  // deny：不能签发
  assert.equal((await mint(['clash/open/private.list'])).status, 403);
  // 批量里只要有一个未开放就整体拒绝（界面会先过滤）
  assert.equal((await mint(['clash/a.list', 'other/x.yaml'])).status, 403);

  // 规则变更后，已发出的令牌对未开放文件立即失效（即使签名有效）
  const strict = { ...env, DIRECT_PATHS: 'docs/:token' };
  assert.equal((await call(`/t/${token}/clash/a.list`, { e: strict })).status, 403);

  // direct 模式：目录下免令牌；deny 的例外不可读
  calls = [];
  await call('/file/clash/open/a.list', { e });
  assert.ok(calls.some(c => c.url.includes('api.github.com') && c.headers.Authorization), 'direct 目录下的文件用 PAT 读取（免令牌）');
  calls = [];
  await call('/file/clash/open/private.list', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), 'deny 的文件不会用 PAT 读取');
});

test('没有任何规则时保持宽松：令牌可访问任意文件；加 **:token 等价于全部开放令牌访问', async () => {
  const { links } = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'] } })).json();
  assert.equal((await call(`/t/${links[0].token}/clash/a.list`)).status, 200);
  const e = { ...env, DIRECT_PATHS: '**:token' };
  const l2 = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'] }, e })).json();
  assert.equal((await call(`/t/${l2.links[0].token}/clash/a.list`, { e })).status, 200);
  calls = [];
  await call('/file/clash/a.list', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), '**:token 不产生免令牌直链');
});

test('前端访问策略判定与服务端一致', async () => {
  const server = await import('../src/lib/access.js');
  const client = await import('../shared/access.js');
  const rules = server.parseAccessRules('a/:direct, a/x.txt:deny, b/*.list:token, c.txt');
  const wire = rules.map(({ pattern, mode }) => ({ pattern, mode })); // /api/context 返回的形状
  for (const p of ['a/1', 'a/x.txt', 'a/d/2', 'b/k.list', 'b/s/k.list', 'c.txt', 'z']) {
    const a = server.resolveAccess(rules, p), b = client.resolveAccess(wire, p);
    assert.deepEqual([b.mode, b.direct, b.token], [a.mode, a.direct, a.token], p);
  }
  assert.equal(client.resolveAccess([], 'x').mode, 'open');
  assert.equal(client.accessBadge(client.resolveAccess([], 'x')), 'lock');
  assert.equal(client.accessBadge(client.resolveAccess(wire, 'c.txt')), 'eye');
  assert.equal(client.accessBadge(client.resolveAccess(wire, 'b/k.list')), 'share');
  assert.equal(client.accessBadge(client.resolveAccess(wire, 'a/x.txt')), 'lock');
  assert.equal(client.accessBadge(client.resolveAccess(wire, 'z')), 'lock');
  assert.equal(client.resolveAccess([{ pattern: 'docs/', mode: 'token' }], 'docs/a/b.list').token, true, '目录规则 dir/ 覆盖其中的文件');
  assert.equal(server.resolveAccess([{ pattern: 'docs/', mode: 'token' }], 'docs/a/b.list').token, true);
  assert.deepEqual(client.ruleSnippets('clash/a.list').map(x => x.text), ['clash/a.list:direct', 'clash/a.list:token', 'clash/:direct', 'clash/:token']);
  assert.equal(client.ruleSnippets('root.txt')[2].text, '**:direct');
});

test('最小粒度：命中多条规则时取最具体的一条', async () => {
  const { parseAccessRules, resolveAccess, specificity } = await import('../src/lib/access.js');
  const mode = (spec, path) => resolveAccess(parseAccessRules(spec), path).mode;

  // 题设：目录开放，其中某个文件需要令牌
  assert.equal(mode('clash/:direct, clash/abc.list:token', 'clash/abc.list'), 'token');
  assert.equal(mode('clash/:direct, clash/abc.list:token', 'clash/other.list'), 'direct');
  // 顺序无关
  assert.equal(mode('clash/abc.list:token, clash/:direct', 'clash/abc.list'), 'token');
  // 反过来：目录仅令牌，其中一个文件开放直链
  assert.equal(mode('docs/:token, docs/public.md:direct', 'docs/public.md'), 'direct');
  assert.equal(mode('docs/:token, docs/public.md:direct', 'docs/private.md'), 'token');
  // 子目录更具体：父目录 deny 下可以开放子目录；父目录 direct 下可以关闭子目录
  assert.equal(mode('a/:deny, a/pub/:direct', 'a/pub/x'), 'direct');
  assert.equal(mode('a/:deny, a/pub/:direct', 'a/other'), 'deny');
  assert.equal(mode('a/:direct, a/secret/:deny', 'a/secret/k'), 'deny');
  // 文件级例外：deny 目录中的单个文件可以重新开放
  assert.equal(mode('a/:deny, a/ok.txt:token', 'a/ok.txt'), 'token');
  // 单层通配比递归通配具体；更深的目录比通配具体
  assert.equal(mode('c/:direct, c/*.list:token', 'c/x.list'), 'token');
  assert.equal(mode('c/:direct, c/*.list:token', 'c/sub/x.list'), 'direct');
  assert.equal(mode('c/*.list:token, c/sub/:direct', 'c/sub/x.list'), 'direct');
  // 同样具体：deny > direct > token
  assert.equal(mode('x.txt:token, x.txt:direct', 'x.txt'), 'direct');
  assert.equal(mode('x.txt:direct, x.txt:deny', 'x.txt'), 'deny');
  // 没有命中任何规则：未开放
  assert.equal(mode('a/:direct', 'b/x'), 'none');
  // 具体程度的排序
  const order = ['**', 'a/**', 'a/*.list', 'a/b/**', 'a/b/c.list'].map(specificity);
  for (let i = 1; i < order.length; i++) assert.ok(JSON.stringify(order[i]) > JSON.stringify(order[i - 1]) || order[i].join() !== order[i - 1].join());
});

test('最小粒度在访问链路里生效：目录直链 + 文件需令牌', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/:direct, clash/abc.list:token' };
  calls = [];
  await call('/file/clash/abc.list', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), 'abc.list 需要令牌：无令牌请求不会用 PAT');
  calls = [];
  await call('/file/clash/a.list', { e });
  assert.ok(calls.some(c => c.url.includes('/contents/clash/a.list') && c.headers.Authorization), '目录内其它文件仍是直链');
  const { links } = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/abc.list'] }, e })).json();
  assert.equal((await call(`/t/${links[0].token}/clash/abc.list`, { e })).status, 404 /* 通过校验，模拟的上游没有该文件 */);
});

/* ---------------- 其它分支的公开链接 ---------------- */

const asDev = { 'X-Cfh-Branch': 'dev' };
const DEV_RULES = 'clash/:direct, clash/abc.list:token';

test('其它分支可以生成令牌链接：签名绑定分支，需要带 ?b=，各分支互不通用', async () => {
  const issue = async (paths, headers = {}, e = env) =>
    (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths }, headers, e })).json());
  const main = (await issue(['clash/a.list'])).links[0];
  const dev = await issue(['clash/a.list'], asDev);
  assert.equal(dev.branch, 'dev');
  assert.notEqual(main.token, dev.links[0].token, '分支参与签名');

  // dev 的令牌必须带 b=dev：不带则按默认分支验签，对不上
  assert.equal((await call(`/t/${dev.links[0].token}/clash/a.list?b=dev`)).status, 200);
  assert.equal((await call(`/t/${dev.links[0].token}/clash/a.list`)).status, 401);
  // 默认分支令牌带 b=dev 也不行；默认分支令牌不带 b 仍然可用（已发出的链接不受影响）
  assert.equal((await call(`/t/${main.token}/clash/a.list?b=dev`)).status, 401);
  assert.equal((await call(`/t/${main.token}/clash/a.list`)).status, 200);
  // 读取的是对应分支的内容
  const devRead = calls.filter(c => c.url.includes('/contents/clash/a.list')).map(c => c.url);
  assert.ok(devRead.some(u => u.includes('ref=dev')), '读取 dev 分支');
  assert.ok(devRead.some(u => u.includes('ref=main')), '读取默认分支');
  // 非法分支名
  assert.equal((await call(`/t/${main.token}/clash/a.list?b=bad..name`)).status, 400);
});

test('其它分支的访问规则独立保存：默认分支的规则不会让其它分支的文件被公开', async () => {
  const e = { ...env, DIRECT_PATHS: 'clash/:direct' }; // 仅作用于默认分支
  calls = [];
  await call('/file/clash/a.list?b=dev', { e });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), 'dev 没有自己的规则：不开放直链，不用 PAT');
  calls = [];
  await call('/file/clash/a.list', { e });
  assert.ok(calls.some(c => c.url.includes('api.github.com') && c.headers.Authorization), '默认分支仍按规则直链');
  // 没有规则 = 宽松（令牌可访问），但仍需管理员主动签发
  const dev = await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['x/y.txt'] }, headers: asDev, e })).json();
  assert.equal(dev.links.length, 1);
});

test('其它分支的版本与撤销：只影响该分支；版本表始终写在默认分支', async () => {
  const issue = async headers => (await (await call('/api/links', { method: 'POST', auth: 'admin-secret', body: { paths: ['clash/a.list'] }, headers })).json()).links[0];
  const main1 = await issue({});
  const dev1 = await issue(asDev);
  assert.deepEqual([main1.version, dev1.version], [1, 1]);

  const rev = await call('/api/links/revoke', { method: 'POST', auth: 'admin-secret', body: { path: 'clash/a.list' }, headers: asDev });
  assert.equal((await rev.json()).version, 2);
  const put = calls.find(c => c.url === 'REGISTRY_PUT');
  const saved = JSON.parse(Buffer.from(put.body.content, 'base64').toString());
  assert.deepEqual(saved.branches, { dev: { files: { 'clash/a.list': 2 } } });
  assert.deepEqual(saved.files, {}, '默认分支的版本不变');
  assert.equal(put.body.branch, 'main', '元数据提交到默认分支，不污染其它分支');

  _clearVersionCache(); cache.clear();
  assert.equal((await call(`/t/${dev1.token}/clash/a.list?b=dev`)).status, 401, 'dev 旧链接失效');
  assert.equal((await call(`/t/${main1.token}/clash/a.list`)).status, 200, '默认分支的链接不受影响');
  const dev2 = await issue(asDev);
  assert.equal(dev2.version, 2);
  assert.equal((await call(`/t/${dev2.token}/clash/a.list?b=dev`)).status, 200);

  const info = await (await call('/api/links/inspect?path=clash/a.list&token=' + dev1.token, { auth: 'admin-secret', headers: asDev })).json();
  assert.deepEqual([info.status, info.version, info.currentVersion], ['revoked', 1, 2]);
});

test('其它分支在界面上设置规则后，直链与令牌按该分支的规则生效', async () => {
  const set = (pattern, mode) => call('/api/access/set', { method: 'POST', auth: 'admin-secret', body: { pattern, mode }, headers: asDev, e: kvEnv });
  const kvStore = new Map();
  const kv = { get: async k => (kvStore.has(k) ? JSON.parse(kvStore.get(k)) : null), put: async (k, v) => { kvStore.set(k, v); } };
  const kvEnv = { ...env, CONFIG_KV: kv };
  assert.equal((await set('clash/', 'direct')).status, 200);
  assert.ok([...kvStore.keys()].every(k => k.endsWith('@dev')), '其它分支的规则键带 @分支');
  const sum = await (await call('/api/access', { auth: 'admin-secret', headers: asDev, e: kvEnv })).json();
  assert.deepEqual(sum.rules, [{ pattern: 'clash/**', mode: 'direct' }]);
  const onMain = await (await call('/api/access', { auth: 'admin-secret', e: kvEnv })).json();
  assert.deepEqual([onMain.rules, onMain.source], [[], 'kv'.length ? onMain.source : ''], '默认分支不受影响');

  calls = [];
  const r = await call('/file/clash/a.list?b=dev', { e: kvEnv });
  assert.equal(r.status, 200);
  assert.ok(calls.some(c => c.url.includes('ref=dev') && c.headers.Authorization), 'dev 上的目录直链：用 PAT 读取 dev 分支');
  calls = [];
  await call('/file/clash/a.list', { e: kvEnv });
  assert.ok(calls.every(c => !c.url.includes('api.github.com')), '默认分支没有这条规则');
});

test('已生成的令牌写入 KV，再次打开可以回显；撤销后不再返回', async () => {
  const kvStore = new Map();
  const kv = {
    get: async (k, opts) => {
      if (!kvStore.has(k)) return null;
      const raw = kvStore.get(k);
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (k, v) => { kvStore.set(k, v); },
    delete: async k => { kvStore.delete(k); },
  };
  const e = { ...env, CONFIG_KV: kv };
  const made = await mint({ paths: ['clash/a.list'], expiresIn: 86400 }, e);
  assert.equal(made.links.length, 1);
  const again = await (await call('/api/links/issued?path=' + encodeURIComponent('clash/a.list'), { auth: 'admin-secret', e })).json();
  assert.equal(again.links[0].token, made.links[0].token);
  const second = await mint({ paths: ['clash/a.list'], expiresIn: 86400 }, e);
  assert.notEqual(second.links[0].token, made.links[0].token);
  const listed = await (await call('/api/links/issued?path=' + encodeURIComponent('clash/a.list'), { auth: 'admin-secret', e })).json();
  assert.deepEqual(listed.links.map(row => row.token), [second.links[0].token]);
  assert.equal((await call(`/t/${made.links[0].token}/clash/a.list`, { e })).status, 401);
  assert.equal((await call(`/t/${second.links[0].token}/clash/a.list`, { e })).status, 200);
  await call('/api/links/revoke', { method: 'POST', auth: 'admin-secret', body: { path: 'clash/a.list' }, e });
  const after = await (await call('/api/links/issued?path=' + encodeURIComponent('clash/a.list'), { auth: 'admin-secret', e })).json();
  assert.deepEqual(after.links, []);
});
