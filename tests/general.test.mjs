/** 通用配置编辑：校验/转换、敏感信息、搜索替换、Markdown、zip、.env、模板。 */
import assert from 'node:assert/strict';
import { CompressionStream as _CS } from 'node:stream/web';
import { test } from 'node:test';
import { convertData, convertedName, formatJson, langOf, lint } from '../shared/lint.js';
import { parseInline, parseMarkdown } from '../shared/markdown.js';
import { buildMatcher, findInText, replaceInText, searchable } from '../shared/searchlib.js';
import { mask, scanSecrets } from '../shared/secrets.js';
import { TEMPLATES, templatesFor } from '../shared/templates.js';
import { gitBlobSha } from '../shared/gitsha.js';
import { planImport, readZip, writeZip } from '../shared/zip.js';
import { detectFormat, envIssues, isSensitiveKey, parse, serialize } from '../shared/formats/index.js';

const enc = s => new TextEncoder().encode(s);

test('校验：JSON / YAML / TOML / INI 的对错与位置', async () => {
  assert.equal((await lint('a.json', '{"a":1}')).ok, true);
  const bad = await lint('a.json', '{\n  "a": 1,\n}');
  assert.equal(bad.ok, false);
  assert.equal(bad.line, 3);
  assert.equal((await lint('a.yaml', 'a: 1\nb: [1, 2]')).ok, true);
  const y = await lint('a.yml', 'a: [1,\nb: 2');
  assert.equal(y.ok, false);
  assert.ok(y.line >= 1);
  assert.equal((await lint('a.toml', 'a = 1\n[t]\nb = "x"')).ok, true);
  assert.equal((await lint('a.toml', 'a = ')).ok, false);
  assert.equal((await lint('x.ini', '[s]\nk=v\n; c')).ok, true);
  assert.deepEqual([(await lint('x.ini', '[s]\nbroken')).ok, (await lint('x.ini', '[s]\nbroken')).line], [false, 2]);
  assert.equal(await lint('a.txt', 'whatever'), null);
  assert.equal((await lint('a.json', '  ')).ok, true);
  assert.equal(langOf('x/.babelrc'), 'json');
});

test('格式化与互转', async () => {
  assert.equal(formatJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  assert.equal(formatJson('{\n "a": 1\n}', true), '{"a":1}');
  assert.throws(() => formatJson('{'));
  assert.deepEqual(JSON.parse(await convertData('yaml', 'json', 'a: 1\nb:\n  - x')), { a: 1, b: ['x'] });
  assert.match(await convertData('json', 'yaml', '{"a":1,"b":["x"]}'), /a: 1\nb:\n {2}- x/);
  assert.match(await convertData('json', 'toml', '{"a":1,"t":{"b":"x"}}'), /a = 1[\s\S]*\[t\][\s\S]*b = "x"/);
  await assert.rejects(convertData('json', 'toml', '[1,2]'), /顶层/);
  assert.equal(convertedName('conf/app.yaml', 'json'), 'conf/app.json');
});

test('敏感信息扫描：命中真实形态，放过占位符，输出打码', () => {
  const ghp = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const text = [
    `token: ${ghp}`,
    'aws = AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'url: https://x.com/sub?token=abcdef1234567890abcd',
    'db: postgres://user:Sup3rS3cret@db.example.com/app',
    'API_KEY=your_api_key_here_please_replace',
    'password: ${DB_PASSWORD}',
    'normal: value',
  ].join('\n');
  const found = scanSecrets(text);
  const rules = found.map(f => f.rule);
  for (const r of ['github-token', 'aws-key', 'private-key', 'url-token', 'url-userinfo']) assert.ok(rules.includes(r), r);
  assert.ok(!found.some(f => f.line === 6 || f.line === 7 || f.line === 8), '占位符/变量引用不应报');
  assert.ok(found.every(f => !f.preview.includes(ghp)), '预览必须打码');
  assert.equal(mask('abcdefghijkl'), 'abc…kl（12 字符）');
});

test('搜索：普通/正则/全词/大小写，空匹配不死循环', () => {
  const text = 'Foo foo\nfoobar\nnothing\nFOO';
  const m = buildMatcher({ query: 'foo' });
  const r = findInText(text, m);
  assert.deepEqual([r.total, r.lines.map(l => l.line)], [4, [1, 2, 4]]);
  assert.equal(findInText(text, buildMatcher({ query: 'foo', caseSensitive: true })).total, 2);
  assert.equal(findInText(text, buildMatcher({ query: 'foo', wholeWord: true })).total, 3);
  assert.equal(findInText('a.b', buildMatcher({ query: '.' })).total, 1); // 非正则：按字面量
  assert.equal(findInText('a.b', buildMatcher({ query: '.', regex: true })).total, 3);
  assert.equal(findInText('abc', buildMatcher({ query: 'x*', regex: true })).total >= 0, true);
  assert.throws(() => buildMatcher({ query: '(', regex: true }), /正则/);
  assert.throws(() => buildMatcher({ query: '' }));
  assert.equal(searchable('a.png', 10), false);
  assert.equal(searchable('a.txt', 10 * 1024 * 1024), false);
  assert.equal(searchable('a.yaml', 100), true);
});

test('替换：字面量、$1 反向引用、不影响其它内容', () => {
  assert.deepEqual(replaceInText('a.b a.b', buildMatcher({ query: 'a.b' }), 'X$1', false), { text: 'X$1 X$1', count: 2 });
  assert.deepEqual(replaceInText('id=12 id=7', buildMatcher({ query: 'id=(\\d+)', regex: true }), 'n:$1', true), { text: 'n:12 n:7', count: 2 });
  assert.equal(replaceInText('x', buildMatcher({ query: 'y' }), 'z', false).count, 0);
  assert.equal(replaceInText('line1\r\nline2', buildMatcher({ query: 'line' }), 'L', false).text, 'L1\r\nL2');
});

test('Markdown：块级结构与安全的链接', () => {
  const blocks = parseMarkdown('# 标题\n\n段落 **粗** `c`\n\n- a\n- [x](https://a.com)\n\n```js\nlet a;\n```\n\n| h1 | h2 |\n|----|----|\n| 1 | 2 |\n\n> 引用\n\n---');
  assert.deepEqual(blocks.map(b => b.type), ['heading', 'para', 'list', 'code', 'table', 'quote', 'hr']);
  assert.equal(blocks[3].text, 'let a;');
  const links = parseInline('[ok](https://a.com) [bad](javascript:alert(1))').filter(n => n.t === 'link');
  assert.equal(links[0].href, 'https://a.com');
  assert.ok(!/^https?:|^mailto:/.test(links[1].href), 'javascript: 不是安全链接，渲染层会降级为纯文本');
  // 原始 HTML 不被解释：<script> 只是文本节点
  assert.deepEqual(parseInline('<script>alert(1)</script>'), [{ t: 'text', text: '<script>alert(1)</script>' }]);
});

test('zip：写入后读回一致；支持 deflate；整理导入路径', async () => {
  const zip = writeZip([
    { name: 'repo-abc/a.txt', bytes: enc('hello') },
    { name: 'repo-abc/dir/b.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
    { name: 'repo-abc/.git/config', bytes: enc('x') },
    { name: 'repo-abc/.DS_Store', bytes: enc('x') },
  ]);
  const files = await readZip(zip.buffer);
  assert.deepEqual(files.map(f => f.name), ['repo-abc/a.txt', 'repo-abc/dir/b.bin', 'repo-abc/.git/config', 'repo-abc/.DS_Store']);
  assert.deepEqual([...files[1].bytes], [0, 1, 2, 255]);
  const plan = planImport(files, { prefix: 'in/' });
  assert.deepEqual(plan.items.map(i => i.path), ['in/a.txt', 'in/dir/b.bin']);
  assert.deepEqual([plan.ignored, plan.stripped], [2, 'repo-abc']);
  assert.deepEqual(planImport(files, { stripTop: false }).items.map(i => i.path), ['repo-abc/a.txt', 'repo-abc/dir/b.bin']);
  assert.deepEqual(planImport([{ name: '../evil', bytes: enc('x') }], { stripTop: false }).items, []);
  await assert.rejects(readZip(enc('not a zip at all, definitely not')), /zip/);

  // 手工构造 deflate 条目：用 CompressionStream 压缩后拼 zip 头
  const payload = enc('deflate me '.repeat(50));
  const comp = new Uint8Array(await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  const stored = writeZip([{ name: 'd.txt', bytes: payload }]);
  const dv = new DataView(stored.buffer);
  const nameLen = 5;
  // 重新组装：local header(method=8, csize=comp.length) + 数据 + central + eoc
  const lh = new Uint8Array(30 + nameLen + comp.length);
  lh.set(stored.subarray(0, 30 + nameLen)); lh.set(comp, 30 + nameLen);
  const ldv = new DataView(lh.buffer);
  ldv.setUint16(8, 8, true); ldv.setUint32(18, comp.length, true);
  const cdStart = 30 + nameLen + payload.length;
  const cd = stored.slice(cdStart);
  const cdv = new DataView(cd.buffer);
  cdv.setUint16(10, 8, true); cdv.setUint32(20, comp.length, true);
  const eocOff = cd.length - 22;
  cdv.setUint32(eocOff + 16, 30 + nameLen + comp.length, true);
  const all = new Uint8Array(lh.length + cd.length); all.set(lh); all.set(cd, lh.length);
  const back = await readZip(all.buffer);
  assert.equal(new TextDecoder().decode(back[0].bytes), 'deflate me '.repeat(50));
  void dv;
});

test('gitBlobSha 与 git 一致', async () => {
  assert.equal(await gitBlobSha(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(await gitBlobSha(enc('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('.env：往返保真、敏感变量识别、重复/非法检测、文件名识别', () => {
  const text = '# 注释\nexport A=1\nDB_PASSWORD="p w"\n\nBAD LINE\nA=2\n';
  const parsed = parse('env', text);
  assert.equal(serialize(parsed), text);
  parsed.items.find(i => i.key === 'DB_PASSWORD').value = 'new';
  assert.match(serialize(parsed), /DB_PASSWORD=new\n/);
  assert.match(serialize(parsed), /export A=1/);
  const issues = [...envIssues(parse('env', text).items)].map(([i, m]) => [i, m]);
  assert.deepEqual(issues.map(x => x[0]), [4, 5]);
  for (const k of ['API_KEY', 'DB_PASSWORD', 'GITHUB_TOKEN', 'client_secret', 'PRIVATE_KEY']) assert.ok(isSensitiveKey(k), k);
  for (const k of ['APP_ENV', 'PORT', 'HOSTNAME']) assert.ok(!isSensitiveKey(k), k);
  assert.equal(detectFormat('.env', ''), 'env');
  assert.equal(detectFormat('app/.env.production', ''), 'env');
  assert.equal(detectFormat('envs/notes.txt', ''), null);
});

test('模板：按路径匹配，内容自洽', async () => {
  assert.ok(templatesFor('a.yaml').some(t => t.id === 'yaml'));
  assert.ok(templatesFor('.env.example').some(t => t.id === 'env'));
  assert.equal(templatesFor('a.exe').length, 0);
  for (const t of TEMPLATES) {
    if (t.id === 'json') assert.equal((await lint('x.json', t.content)).ok, true, t.id);
    if (t.id === 'yaml') assert.equal((await lint('x.yaml', t.content)).ok, true, t.id);
    if (t.id === 'toml') assert.equal((await lint('x.toml', t.content)).ok, true, t.id);
  }
  assert.equal(serialize(parse('clash-list', TEMPLATES.find(t => t.id === 'clash-list').content)), TEMPLATES.find(t => t.id === 'clash-list').content);
  assert.equal(serialize(parse('clash-ini', TEMPLATES.find(t => t.id === 'clash-ini').content)), TEMPLATES.find(t => t.id === 'clash-ini').content);
  void _CS;
});
