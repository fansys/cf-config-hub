/** 部署脚本的纯函数、链接解析与配置完整性测试。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SECRET_KEYS, VAR_KEYS, readVars, validateVars } from '../scripts/lib.mjs';
import { extractPathFromLink } from '../public/js/ui/links.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('wrangler.toml 不含 [vars]，且 keep_vars=true：部署不会改动控制台里的变量', () => {
  const toml = read('wrangler.toml');
  assert.ok(!/^\s*\[vars\]/m.test(toml), 'wrangler.toml 不应再声明 [vars]');
  assert.ok(!/^\s*(GITHUB_OWNER|GITHUB_REPO|GITHUB_BRANCH|ROOT_DIR|PUBLIC_FILES|CACHE_TTL)\s*=/m.test(toml));
  assert.match(toml, /^keep_vars\s*=\s*true/m);
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

test('前端模块的导入关系完整（缺失的导出会在链接阶段报错）', async () => {
  for (const m of ['search', 'zipio', 'target', 'session', 'history', 'files', 'visual', 'editor', 'links', 'modal', 'access']) {
    await import(`../public/js/ui/${m}.js`);
  }
});

test('页面里引用的元素 id 都存在于 index.html', async () => {
  const { readdirSync } = await import('node:fs');
  const html = read('public/index.html');
  const dirs = ['public/js', 'public/js/ui'];
  const ids = new Set();
  for (const d of dirs) {
    for (const f of readdirSync(new URL('../' + d, import.meta.url)).filter(x => x.endsWith('.js'))) {
      for (const m of read(`${d}/${f}`).matchAll(/\$\('([A-Za-z]+)'\)|getElementById\('([A-Za-z]+)'\)/g)) ids.add(m[1] || m[2]);
    }
  }
  const missing = [...ids].filter(id => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, []);
});

test('wrangler.toml 声明了 CONFIG_KV 绑定（访问规则存储），且不带写死的 id', () => {
  const toml = read('wrangler.toml');
  assert.match(toml, /^\[\[kv_namespaces\]\]\s*\nbinding = "CONFIG_KV"/m);
  assert.ok(!/^id\s*=/m.test(toml), '不应写死 id，交给自动创建或用户自行填写');
});

test('首屏防闪烁：<head> 里同步加载 boot.js，CSS 在 has-token 时隐藏登录页', () => {
  const html = read('public/index.html');
  assert.match(html, /<head>[\s\S]*<script src="\/js\/boot\.js"><\/script>[\s\S]*<\/head>/, 'boot.js 必须是 head 里的普通脚本');
  assert.ok(!/<script[^>]*boot\.js[^>]*(defer|async|type="module")/.test(html), 'boot.js 不能是 defer/async/module，否则晚于首次绘制');
  assert.match(read('public/style.css'), /html\.has-token #loginView\s*\{\s*display:\s*none/);
  assert.match(read('public/js/boot.js'), /cfhub-token/);
  assert.equal(JSON.stringify(read('public/js/api.js').match(/TOKEN_KEY = '([^']+)'/)?.[1]), '"cfhub-token"', '与 api.js 使用的存储键一致');
});

test('编辑器：没有"纯文本"标签；语法高亮是可编辑的叠加层，默认模式为 highlight', () => {
  const html = read('public/index.html');
  assert.ok(!html.includes('纯文本'), '不再有纯文本标签');
  assert.match(html, /data-mode="highlight"[^>]*>原始内容</, '有标签页时，高亮视图显示为"原始内容"');
  // 高亮层与 textarea 在同一个容器里叠放
  assert.match(html, /id="codeWrap"[\s\S]*class="code-hl"[\s\S]*<textarea id="editor"/);
  const css = read('public/style.css');
  assert.match(css, /\.code-wrap #editor[^}]*color:\s*transparent/);
  assert.match(css, /\.code-hl, \.code-wrap #editor\s*\{[^}]*font:[^}]*padding:/, '两层共用同一组字体与内边距，才能逐字对齐');
  assert.match(read('public/js/state.js'), /mode: 'highlight'/);
  assert.ok(!/mode = 'text'|mode: 'text'|setMode\('text'\)/.test(read('public/js/ui/editor.js')), '代码里不应再使用 text 模式');
});
