'use strict';
/**
 * visual-editors.js —— 策略文件可视化编辑器
 * 支持三类文件：
 *   1) Clash .list        每行一条规则，可选第三列
 *   2) Clash .ini         订阅增强语法，[custom] 节下的 ruleset / custom_proxy_group / 其他 key=value
 *   3) QuantumultX .list  每行一条规则，逗号分三列
 *
 * 核心数据模型：所有规则行统一抽象为 { kind, raw, ...fields }
 *   kind ∈ 'rule' | 'comment' | 'blank' | 'unknown'
 */

/* ============================================================
 *  公共规则类型常量
 * ============================================================ */

// Clash .list 常见规则类型
const CLASH_RULE_TYPES = [
  '',  // 空占位：渲染为 "-"，rule 为空时序列化输出空行
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'DOMAIN-SUFFIX-EXCLUDED', 'DOMAIN-SET',
  'GEOSITE', 'GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN',
  'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT', 'IN-PORT',
  'PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-PATH',
  'NETWORK', 'UID', 'UID-RANGE', 'UID-NAME',
  'SUB-RULE', 'AND', 'OR', 'NOT',
  'MATCH', 'FINAL',
];

// QuantumultX .list 规则类型
const QX_RULE_TYPES = [
  '',  // 空占位：渲染为 "-"，rule 为空时序列化输出空行
  'HOST', 'HOST-SUFFIX', 'HOST-KEYWORD', 'HOST-REGEX',
  'HOST-IP', 'HOST-PATH', 'HOST-PORT', 'HOST-QUERY',
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'DOMAIN-IP', 'DOMAIN-PATH', 'DOMAIN-PORT', 'DOMAIN-QUERY',
  'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'IP-REGEX',
  'GEOIP', 'GEOSITE',
  'USER-AGENT', 'URL-REGEX',
  'PROCESS-NAME', 'PROCESS-PID', 'PROCESS-NAME-PATH',
  'MATCH', 'FINAL',
];

// Clash 常见动作（Clash 规则的第三列）
const CLASH_ACTIONS = ['Proxy', 'DIRECT', 'REJECT', 'Hijacking', 'DENY', 'REJECT-DROP'];

// QX 常见动作（第三列）
const QX_ACTIONS = ['Proxy', 'Direct', 'Reject', 'Reject-I', 'Quic'];

/* ============================================================
 *  工具函数
 * ============================================================ */

function splitRuleLine(line) {
  // 按逗号分三列，但要去掉首尾空格
  const parts = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ',' && !inQuote) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim());
}

function isCommentOrBlank(line) {
  const t = line.trim();
  if (!t) return { kind: 'blank', text: '' };
  if (t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) return { kind: 'comment', text: t };
  return null;
}

/* ============================================================
 *  1) Clash .list 解析 / 序列化
 * ============================================================ */

function tryParseClashRule(line) {
  const parts = splitRuleLine(line);
  if (!parts[0] || parts[0].match(/^[#/;]/)) return null;
  const type = parts[0] || '';
  const isBracketRule = type.startsWith('[]');
  const bareType = isBracketRule ? type.slice(2) : type;
  // type 必须是已知 Clash 规则类型，否则当作非规则（type 空的占位行）
  if (!CLASH_RULE_TYPES.includes(bareType)) return null;
  return {
    kind: 'rule',
    enabled: true,
    type: bareType,
    rule: parts[1] || '',
    action: parts[2] || '',
    isBracketRule,
  };
}
function buildClashLine(it) {
  const prefix = it.isBracketRule ? '[]' : '';
  let line = `${prefix}${it.type || ''},${it.rule || ''}`;
  if (it.action) line += `,${it.action}`;
  return line;
}

function parseClashList(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { items.push({ kind: 'rule', enabled: true, type: '', rule: '', action: '', isBracketRule: false, raw }); continue; }
    let enabled = true;
    let body = trimmed;
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith(';')) {
      enabled = false;
      body = trimmed.replace(/^[#/;]\s?/, '');
    }
    const parsed = tryParseClashRule(body);
    if (parsed) {
      parsed.enabled = enabled;
      parsed.raw = raw;
    } else {
      items.push({ kind: 'rule', enabled, type: '', rule: body, action: '', isBracketRule: false, raw });
      continue;
    }
    items.push(parsed);
  }
  return items;
}

function serializeClashList(items) {
  return items.map(it => {
    let content;
    if (it.type) {
      content = buildClashLine(it);
    } else {
      content = (it.rule || '').trim() ? it.rule : '';
    }
    return it.enabled ? content : (content ? '# ' + content : '#');
  }).join('\n');
}

/* ============================================================
 *  2) QuantumultX .list 解析 / 序列化
 * ============================================================ */

function tryParseQxRule(line) {
  const parts = splitRuleLine(line);
  if (!parts[0] || parts[0].match(/^[#/;]/)) return null;
  const type = parts[0] || '';
  if (!QX_RULE_TYPES.includes(type)) return null;
  return {
    kind: 'rule',
    enabled: true,
    type,
    rule: parts[1] || '',
    action: parts[2] || '',
    opts: parts.slice(3),
  };
}

function parseQxList(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) { items.push({ kind: 'rule', enabled: true, type: '', rule: '', action: '', opts: [], raw }); continue; }
    let enabled = true;
    let body = trimmed;
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith(';')) {
      enabled = false;
      body = trimmed.replace(/^[#/;]\s?/, '');
    }
    const parsed = tryParseQxRule(body);
    if (parsed) {
      parsed.enabled = enabled;
      parsed.raw = raw;
    } else {
      items.push({ kind: 'rule', enabled, type: '', rule: body, action: '', opts: [], raw });
      continue;
    }
    items.push(parsed);
  }
  return items;
}

function serializeQxList(items) {
  return items.map(it => {
    let content;
    if (it.type) {
      content = `${it.type || ''},${it.rule || ''},${it.action || ''}`;
      if (it.opts && it.opts.length) content += ',' + it.opts.join(',');
    } else {
      content = (it.rule || '').trim() ? it.rule : '';
    }
    return it.enabled ? content : (content ? '# ' + content : '#');
  }).join('\n');
}

/* ============================================================
 *  3) Clash .ini（Quantumult 订阅增强）解析 / 序列化
 * ============================================================ */

/* ---- 数据模型 ----
 * select 模式: { name, strategy:'select', members: [{name:'[]DIRECT', prefix:'[]', glob:false}] }
 * url-test/fallback/domain-test/load-balance:
 *   { name, strategy:'url-test', filters:'.*'|'(香港)', url:'http://...', interval:'300', failure:'5', success:'100' }
 *
 * 原始语法（按反引号 `` ` `` 切）:
 *   select:   `name`select`m1`m2`m3
 *   url-test: `name`url-test`filters`url`interval[,failure[,success]]`
 */

function parseProxyGroup(expr) {
  const parts = expr.split('`');
  const name = parts[0] || '';
  const strategy = parts[1] || 'select';

  if (strategy === 'select') {
    const members = parts.slice(2).map(m => {
      const glob = m.endsWith('.*');
      const core = glob ? m.slice(0, -2) : m;
      return {
        raw: m,
        name: core.startsWith('[]') ? core.slice(2) : core,
        prefix: core.startsWith('[]') ? '[]' : '',
        glob,
      };
    });
    return { name, strategy, members, raw: expr };
  }

  // url-test / fallback / domain-test / load-balance
  const filters = parts[2] || '';
  const url = parts[3] || '';
  const paramStr = parts[4] || '';
  const params = paramStr.split(',').map(s => s.trim()).filter(Boolean);
  return {
    name, strategy,
    filters,         // '.*' 或 '(香港)' 或 ''
    url,
    interval: params[0] || '',
    failure: params[1] || '',
    success: params[2] || '',
    raw: expr,
  };
}

function serializeProxyGroup(pg) {
  let out = pg.name + '`' + pg.strategy + '`';
  if (pg.strategy === 'select') {
    out += (pg.members || []).map(m => (m.prefix || '') + m.name + (m.glob ? '.*' : '')).join('`');
  } else {
    out += (pg.filters || '') + '`' + (pg.url || '');
    const params = [];
    if (pg.interval) params.push(pg.interval);
    if (pg.failure) params.push(pg.failure);
    if (pg.success) params.push(pg.success);
    if (params.length) out += '`' + params.join(',');
  }
  return out;
}

function parseClashIni(text) {
  const sections = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    // section header [xxx]
    const secMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      current = { section: secMatch[1], entries: [], _raw: [] };
      sections.push(current);
      current._raw.push(raw);
      continue;
    }
    if (!current) continue;
    current._raw.push(raw);

    // 注释或空行
    const cb = isCommentOrBlank(raw);
    if (cb) {
      current.entries.push({ kind: cb.kind, raw, text: cb.text });
      continue;
    }

    // 按第一个 = 切 key=value
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      current.entries.push({ kind: 'unknown', raw });
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();

    if (key === 'ruleset') {
      // ruleset=标签,URL   或   ruleset=标签,[]GEOIP,CN
      const parts = val.split(',').map(s => s.trim());
      const label = parts[0] || '';
      const rest = parts.slice(1).join(',');
      // 进一步检测 URL vs 内嵌规则
      let embedded = null;
      if (rest.startsWith('[]')) {
        const inner = rest.slice(2);  // GEOIP,CN
        const ip = inner.indexOf(',');
        embedded = ip > 0
          ? { type: inner.slice(0, ip), rule: inner.slice(ip + 1).trim() }
          : { type: inner, rule: '' };
      }
      current.entries.push({
        kind: 'ruleset',
        raw,
        label,
        url: embedded ? '' : rest,
        embedded,
      });
    } else if (key === 'custom_proxy_group') {
      const pg = parseProxyGroup(val);
      current.entries.push({ kind: 'proxy_group', raw, ...pg });
    } else {
      current.entries.push({ kind: 'kv', raw, key, value: val });
    }
  }
  return sections;
}

function serializeClashIni(sections) {
  return sections.map(sec => {
    const header = `[${sec.section}]`;
    const body = sec.entries.map(e => {
      if (e.kind === 'blank') return '';
      if (e.kind === 'comment') return e.text;
      if (e.kind === 'unknown') return e.raw;
      if (e.kind === 'kv') return `${e.key}=${e.value}`;
      if (e.kind === 'ruleset') {
        let val = e.label;
        if (e.embedded) {
          val += `,[]${e.embedded.type}${e.embedded.rule ? ',' + e.embedded.rule : ''}`;
        } else {
          val += `,${e.url || ''}`;
        }
        return `ruleset=${val}`;
      }
      if (e.kind === 'proxy_group') {
        return `custom_proxy_group=${serializeProxyGroup(e)}`;
      }
      return e.raw || '';
    }).join('\n');
    return header + '\n' + body;
  }).join('\n');
}

/* ============================================================
 *  格式探测
 * ============================================================ */

function detectFormat(path, text) {
  const lower = path.toLowerCase();
  // 目录名强约定：只有路径中包含 clash / quantumultx 目录才允许用可视化编辑器
  // 用 / 切分路径段，检查整段等于 clash 或 quantumultx（避免 clashX / quantumultx-backup 误命中）
  const segs = lower.split('/');
  const inClash = segs.includes('clash');
  const inQx = segs.includes('quantumultx') || segs.includes('qx');

  if (inQx) {
    if (lower.endsWith('.list') || lower.endsWith('.conf')) return 'qx-list';
  }
  if (inClash) {
    if (lower.endsWith('.ini')) return 'clash-ini';
    if (lower.endsWith('.list')) return 'clash-list';
  }
  // 兜底：只有路径暗示可能是代理规则目录时才做内容嗅探
  if (/(proxy|rule|config|订阅|配置|规则)/.test(lower)) {
    if (/^\[[^\]]+\]\s*$/m.test(text) && text.includes('ruleset=')) return 'clash-ini';
    const first = text.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith(';')) || '';
    if (/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6|MATCH|FINAL),/.test(first)) return 'clash-list';
    if (/^(HOST|HOST-SUFFIX|HOST-KEYWORD|DOMAIN|DOMAIN-SUFFIX|IP-CIDR),/.test(first)) return 'qx-list';
  }
  return null;
}

/* ---- 语言推断（给 highlight.js 用）---- */
const EXT_LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', mts: 'typescript',
  sh: 'bash', bash: 'bash', zsh: 'bash', rc: 'bash',
  py: 'python',
  go: 'go',
  rs: 'rust',
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java',
  html: 'xml', htm: 'xml', xml: 'xml',
  css: 'css', scss: 'scss',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown',
  conf: 'nginx', cfg: 'nginx',
  ini: 'ini',
  pac: 'javascript',  // JetBrains proxy auto-config 本质是 JS
  pl: 'perl',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  lua: 'lua',
  dockerfile: 'dockerfile',
  makefile: 'makefile', mk: 'makefile',
  txt: 'plaintext',
};

function detectLanguage(path, text) {
  const lower = path.toLowerCase();
  // 先看文件名（比如 Dockerfile, Makefile, Vagrantfile）
  const base = lower.split('/').pop() || '';
  const basenameLang = {
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'vagrantfile': 'ruby',
    'gemfile': 'ruby',
    'rakefile': 'ruby',
    'cmakelists.txt': 'cmake',
  }[base];
  if (basenameLang) return basenameLang;

  // 再看扩展名
  const ext = lower.split('.').pop();
  if (ext && EXT_LANG_MAP[ext]) return EXT_LANG_MAP[ext];

  // 扩展名没命中：内容嗅探
  const firstLine = (text || '').split(/\r?\n/)[0] || '';
  if (firstLine.startsWith('#!')) {
    if (firstLine.includes('node')) return 'javascript';
    if (firstLine.includes('python') || firstLine.includes('pypy')) return 'python';
    if (firstLine.includes('perl')) return 'perl';
    if (firstLine.includes('ruby')) return 'ruby';
    if (firstLine.includes('bash') || firstLine.includes('sh')) return 'bash';
    if (firstLine.includes('php')) return 'php';
    if (firstLine.includes('lua')) return 'lua';
    return 'bash';  // 大多数 shebang 脚本用 bash
  }
  if (text && text.includes('function FindProxyForURL')) return 'javascript';  // PAC
  if (text && /^\s*(import|export|const|let|var)\s/m.test(text)) return 'javascript';
  if (text && /^package\s+\w+|^import\s+\(|^func\s+\w+\(/.test(text)) return 'go';
  if (text && /^---\s*$|^[a-zA-Z_]+\s*:\s*[$\w\{\-]/.test(text) && !text.includes('{')) return 'yaml';
  return 'plaintext';
}

/* ============================================================
 *  highlight.js 外置语言包动态加载
 *  highlight.min.js 内置 36 种，外置 17 种在 /hljs-languages/{name}.min.js
 *  每个外置文件只定义 function nginx(hljs) { ... }，
 *  需要手动调用 hljs.registerLanguage(name, fn) 注册。
 * ============================================================ */

/** highlight.min.js 内置的 36 种语言（启动时自动可用） */
const HLJS_BUNDLED = new Set([
  'bash','c','cpp','csharp','css','diff','go','graphql','ini','java',
  'javascript','json','kotlin','less','lua','makefile','markdown',
  'objectivec','perl','php','php-template','plaintext','python','python-repl',
  'r','ruby','rust','scss','shell','sql','swift','typescript','vbnet','wasm','xml','yaml'
]);

/** 需要动态加载的外置语言（本地存放在 /hljs-languages/{name}.min.js） */
const HLJS_EXTRA = new Set([
  'apache','clojure','cmake','coffeescript','dart','dockerfile','dos',
  'elixir','erlang','fsharp','groovy','haskell','http','nginx','powershell',
  'properties','scheme'
]);

/** 记录已经加载过的外置语言名 → Promise（避免并发多次 fetch） */
const _loadingPromises = {};

/** 确保某语言已在 hljs 中注册。返回 Promise，resolve 时可用。 */
function ensureLanguageLoaded(name) {
  if (!name || name === 'plaintext') return Promise.resolve();
  if (!window.hljs) return Promise.resolve();
  // 已注册 or 内置的直接返回
  if (window.hljs.getLanguage(name)) return Promise.resolve();
  if (HLJS_BUNDLED.has(name)) return Promise.resolve();
  // 外置语言
  if (!HLJS_EXTRA.has(name)) return Promise.resolve();  // 未知，跳过

  if (_loadingPromises[name]) return _loadingPromises[name];

  _loadingPromises[name] = (async () => {
    try {
      const resp = await fetch('/hljs-languages/' + name + '.min.js');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let src = await resp.text();
      // ⚠️ jsDelivr 压缩后的语言包末尾有 `module.exports=xxx;`（CommonJS），
      // 后面还跟 `//# sourceMappingURL=...` 注释，浏览器里没有 module 对象 → eval 直接炸。
      // 匹配 module.exports=xxx 一直到文件末尾（包括 sourceMappingURL 注释），全部剥掉。
      src = src.replace(/module\.exports\s*=\s*\w+\s*;?[\s\S]*?$/, '');
      // 再用一个沙箱：屏蔽 module / require，防止漏网之鱼
      const factory = new Function('module','exports', src + '\nreturn ' + name)(undefined, undefined);
      if (typeof factory === 'function') {
        window.hljs.registerLanguage(name, factory);
      }
    } catch (e) {
      console.warn('[hljs] failed to load language', name, e);
    }
  })();
  return _loadingPromises[name];
}

/** 所有可用于下拉选择的语言（内置 + 外置，按字母排序） */
function allHljsLanguages() {
  const arr = [...HLJS_BUNDLED, ...HLJS_EXTRA].filter(n => n !== 'plaintext' && n !== 'php-template' && n !== 'python-repl');
  return arr.sort();
}

/* ============================================================
 *  导出给 app.js 的统一 API
 * ============================================================ */

const VisualEditors = {
  detectFormat,
  detectLanguage,
  ensureLanguageLoaded,
  allHljsLanguages,
  CLASH_RULE_TYPES,
  QX_RULE_TYPES,
  CLASH_ACTIONS,
  QX_ACTIONS,

  parse(fmt, text) {
    if (fmt === 'clash-list') return { fmt, items: parseClashList(text) };
    if (fmt === 'qx-list')     return { fmt, items: parseQxList(text) };
    if (fmt === 'clash-ini')   return { fmt, sections: parseClashIni(text) };
    throw new Error('未知格式: ' + fmt);
  },

  serialize(parsed) {
    if (parsed.fmt === 'clash-list') return serializeClashList(parsed.items);
    if (parsed.fmt === 'qx-list')     return serializeQxList(parsed.items);
    if (parsed.fmt === 'clash-ini')   return serializeClashIni(parsed.sections);
    throw new Error('未知格式: ' + parsed.fmt);
  },

  /* ---- 增删改 helpers（解析结果对象上操作） ---- */
  addRule(parsed, { sectionIndex, sectionKind, type, rule, action, opts }) {
    if (parsed.fmt === 'clash-list' || parsed.fmt === 'qx-list') {
      parsed.items.push({ kind: 'rule', type: type || '', rule: rule || '', action: action || '', opts: opts || [] });
      return;
    }
    if (parsed.fmt === 'clash-ini') {
      const sec = parsed.sections[sectionIndex || 0];
      if (!sec) throw new Error('无 section');
      if (sectionKind === 'ruleset') {
        sec.entries.push({ kind: 'ruleset', label: type || '', url: rule || '', embedded: null });
      } else if (sectionKind === 'proxy_group') {
        sec.entries.push({ kind: 'proxy_group', name: type || '', strategy: 'select', members: [] });
      } else {        sec.entries.push({ kind: 'kv', key: type || '', value: rule || '' });
      }
    }
  },

  removeRule(parsed, index, sectionIndex) {
    if (parsed.fmt === 'clash-list' || parsed.fmt === 'qx-list') {
      parsed.items.splice(index, 1);
    } else if (parsed.fmt === 'clash-ini') {
      const sec = parsed.sections[sectionIndex || 0];
      if (sec) sec.entries.splice(index, 1);
    }
  },
};

// 全局挂载，供 app.js 使用
window.VisualEditors = VisualEditors;
