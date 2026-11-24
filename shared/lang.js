/** 由路径和内容推断语言名。只做判断，不加载高亮器。 */

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
