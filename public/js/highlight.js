/**
 * 语法高亮：语言推断 + highlight.js 外置语言包按需加载。
 * highlight.min.js 内置 36 种语言；其余 17 种放在 /hljs-languages/，通过 <script> 加载
 * （页面 CSP 禁止 eval，因此不能用 new Function 执行语言包）。
 */

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', pac: 'javascript',
  ts: 'typescript', mts: 'typescript',
  sh: 'bash', bash: 'bash', zsh: 'bash', rc: 'bash',
  py: 'python', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'scss', json: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  conf: 'nginx', cfg: 'nginx', ini: 'ini',
  pl: 'perl', rb: 'ruby', swift: 'swift', kt: 'kotlin', lua: 'lua',
  dockerfile: 'dockerfile', makefile: 'makefile', mk: 'makefile',
  txt: 'plaintext',
};

const BASENAME_LANG = {
  dockerfile: 'dockerfile', makefile: 'makefile',
  vagrantfile: 'ruby', gemfile: 'ruby', rakefile: 'ruby', 'cmakelists.txt': 'cmake',
};

const SHEBANG_LANG = [
  ['node', 'javascript'], ['python', 'python'], ['pypy', 'python'], ['perl', 'perl'],
  ['ruby', 'ruby'], ['bash', 'bash'], ['php', 'php'], ['lua', 'lua'], ['sh', 'bash'],
];

export function detectLanguage(path, text = '') {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop() || '';
  if (BASENAME_LANG[base]) return BASENAME_LANG[base];

  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext];

  const first = text.split(/\r?\n/, 1)[0] || '';
  if (first.startsWith('#!')) return SHEBANG_LANG.find(([k]) => first.includes(k))?.[1] || 'bash';
  if (text.includes('function FindProxyForURL')) return 'javascript';
  if (/^\s*(import|export|const|let|var)\s/m.test(text)) return 'javascript';
  if (/^package\s+\w+|^import\s+\(|^func\s+\w+\(/m.test(text)) return 'go';
  if (/^---\s*$|^[a-zA-Z_]+\s*:\s*[$\w{-]/m.test(text) && !text.includes('{')) return 'yaml';
  return 'plaintext';
}

const BUNDLED = new Set([
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'go', 'graphql', 'ini', 'java',
  'javascript', 'json', 'kotlin', 'less', 'lua', 'makefile', 'markdown',
  'objectivec', 'perl', 'php', 'plaintext', 'python', 'r', 'ruby', 'rust',
  'scss', 'shell', 'sql', 'swift', 'typescript', 'vbnet', 'wasm', 'xml', 'yaml',
]);

const EXTRA = new Set([
  'apache', 'clojure', 'cmake', 'coffeescript', 'dart', 'dockerfile', 'dos',
  'elixir', 'erlang', 'fsharp', 'groovy', 'haskell', 'http', 'nginx', 'powershell',
  'properties', 'scheme',
]);

const loading = new Map();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('加载失败 ' + src));
    document.head.append(s);
  });
}

/** 确保语言已在 hljs 注册。语言包是 CommonJS 产物，需要一个哑 module 对象吞掉 `module.exports=xxx`。 */
export function ensureLanguageLoaded(name) {
  const hljs = window.hljs;
  if (!hljs || !name || BUNDLED.has(name) || hljs.getLanguage(name) || !EXTRA.has(name)) {
    return Promise.resolve();
  }
  if (loading.has(name)) return loading.get(name);

  const task = (async () => {
    try {
      window.module ||= { exports: {} };
      await loadScript(`/hljs-languages/${name}.min.js`);
      const factory = window[name];
      if (typeof factory === 'function') hljs.registerLanguage(name, factory);
    } catch (e) {
      console.warn('[hljs]', e);
    }
  })();
  loading.set(name, task);
  return task;
}

export const allLanguages = () =>
  [...BUNDLED, ...EXTRA].filter(n => n !== 'plaintext').sort();
