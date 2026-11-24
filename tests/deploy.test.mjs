/** 部署脚本的纯函数、链接解析与配置完整性测试。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SECRET_KEYS, VAR_KEYS, readVars, validateVars } from '../scripts/lib.mjs';
import { extractPathFromLink } from '../shared/linkpath.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('wrangler.toml 不含 [vars]，且顶层 keep_vars=true（在所有 [section] 之前）：部署不会改动控制台里的变量', () => {
  const toml = read('wrangler.toml');
  assert.ok(!/^\s*\[vars\]/m.test(toml), 'wrangler.toml 不应再声明 [vars]');
  assert.ok(!/^\s*\[env\.[^\]]+\.vars\]/m.test(toml), 'wrangler.toml 不应声明 [env.*.vars]');
  assert.ok(!/^\s*(GITHUB_OWNER|GITHUB_REPO|GITHUB_BRANCH|ROOT_DIR|PUBLIC_FILES|CACHE_TTL)\s*=/m.test(toml));
  assert.match(toml, /^keep_vars\s*=\s*true/m);
  const firstSection = toml.search(/^\s*\[/m);
  const keepVarsPos = toml.search(/^keep_vars\s*=\s*true/m);
  assert.ok(keepVarsPos >= 0 && (firstSection === -1 || keepVarsPos < firstSection), 'keep_vars = true 必须在顶层（第一个 [section] 之前），否则会被 TOML 解析进其它表而失效');
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.deploy, /wrangler deploy --keep-vars/);
  assert.match(pkg.scripts.preview, /wrangler dev --env preview/);
});

test('部署脚本不会改写 wrangler.toml', () => {
  for (const f of ['scripts/setup.mjs', 'scripts/doctor.mjs', 'scripts/lib.mjs']) {
    const src = read(f);
    assert.ok(!/writeFileSync\([^)]*WRANGLER_TOML|writeToml|setVar/.test(src), `${f} 不应写入 wrangler.toml`);
  }
});

test('readVars：环境变量优先于 .dev.vars，且不依赖 wrangler.toml', () => {
  const vars = readVars({ GITHUB_OWNER: 'fromfile', GITHUB_REPO: 'r' }, { GITHUB_OWNER: 'fromenv' });
  assert.equal(vars.GITHUB_OWNER, 'fromenv');
  assert.equal(vars.GITHUB_REPO, 'r');
  assert.equal(vars.ROOT_DIR, '');
});

test('validateVars：占位符与非法值会被发现', () => {
  assert.ok(validateVars({ GITHUB_OWNER: 'YOUR_GITHUB_OWNER', GITHUB_REPO: 'YOUR_GITHUB_REPO', GITHUB_BRANCH: 'main', PUBLIC_FILES: 'true' }).length >= 2);
  const ok = { GITHUB_OWNER: 'alice', GITHUB_REPO: 'cfg', GITHUB_BRANCH: 'main', ROOT_DIR: 'configs', PUBLIC_FILES: 'true' };
  assert.deepEqual(validateVars(ok), []);
  assert.ok(validateVars({ ...ok, ROOT_DIR: '/x/' }).length);
  assert.ok(validateVars({ ...ok, PUBLIC_FILES: 'yes' }).length);
});

test('一键部署元数据：每个变量/密钥都有说明；.dev.vars.example 列出全部变量与密钥', () => {
  const pkg = JSON.parse(read('package.json'));
  const example = read('.dev.vars.example');
  for (const n of [...VAR_KEYS, ...SECRET_KEYS]) {
    assert.ok(pkg.cloudflare.bindings[n]?.description, `package.json 缺少 ${n} 的说明`);
    assert.match(example, new RegExp(`^${n}=`, 'm'), `.dev.vars.example 缺少 ${n}`);
  }
  assert.ok(!/github_pat_[A-Za-z0-9_]{20,}/.test(example), '示例文件不应含真实令牌');
});

test('密钥不得写入 wrangler.toml', () => {
  assert.ok(!/^\s*(GITHUB_TOKEN|ADMIN_TOKEN)\s*=/m.test(read('wrangler.toml')));
});

const info = { owner: 'alice', repo: 'cfg', branch: 'main', root: 'configs' };
const origin = 'https://hub.example.com';

test('链接解析：GitHub / Raw / jsDelivr / Worker', () => {
  const p = u => extractPathFromLink(u, info, origin);
  assert.equal(p('https://github.com/alice/cfg/blob/main/configs/clash/a.list'), 'clash/a.list');
  assert.equal(p('https://raw.githubusercontent.com/Alice/cfg/main/configs/clash/a.list'), 'clash/a.list');
  assert.equal(p('https://cdn.jsdelivr.net/gh/alice/cfg@main/configs/clash/a.list'), 'clash/a.list');
  assert.equal(p('https://hub.example.com/file/clash/a.list?v=' + 'a'.repeat(40)), 'clash/a.list');
  assert.equal(p('https://github.com/other/cfg/blob/main/x'), '');
  assert.equal(p('https://cdn.jsdelivr.net/gh/alice/cfg@dev/configs/a'), '');
});

test('构建产物：阻塞 boot.js、无 inline script，登录 chunk 不含编辑器依赖', () => {
  const html = read('dist/client/index.html');
  assert.match(html, /<head>[\s\S]*<script src="\/boot\.js"><\/script>[\s\S]*<\/head>/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), '不能有 inline script，否则 CSP 会拦截');
  assert.ok(!/<script[^>]*boot\.js[^>]*(defer|async|type="module")/.test(html));
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
  assert.ok(entry, '缺少登录入口');
  const source = read('dist/client' + entry);
  assert.ok(!/js-yaml|@codemirror|codemirror/.test(source), '登录 chunk 不应包含 CodeMirror 或 js-yaml');
  assert.match(read('client/public/boot.js'), /cfhub-token/);
  assert.match(read('client/src/lib/storage.ts'), /TOKEN_KEY = 'cfhub-token'/);
  assert.match(read('client/vite.config.ts'), /modulePreload:\s*\{\s*polyfill:\s*false\s*\}/);
});

test('wrangler.toml 声明了 CONFIG_KV 绑定（访问规则存储），且不带写死的 id', () => {
  const toml = read('wrangler.toml');
  assert.match(toml, /^\[\[kv_namespaces\]\]\s*\nbinding = "CONFIG_KV"/m);
  assert.ok(!/^id\s*=/m.test(toml), '不应写死 id，交给自动创建或用户自行填写');
});

test('编辑器默认是可高亮的原始内容，不再使用 textarea 叠层或纯文本模式', () => {
  const editor = read('client/src/features/editor/EditorPanel.vue');
  assert.ok(!editor.includes('纯文本'));
  assert.match(editor, /原始内容/);
  assert.match(read('client/src/features/editor/CodeEditor.vue'), /HIGHLIGHT_LIMIT = 300_000/);
  assert.ok(!/mode = 'text'|mode: 'text'|setMode\('text'\)/.test(read('client/src/features/editor/actions.ts')));
});
