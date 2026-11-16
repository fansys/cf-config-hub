/**
 * Clash 订阅增强 `.ini`（subconverter 风格）：
 *   ruleset=标签,URL | ruleset=标签,[]GEOIP,CN
 *   custom_proxy_group=名称`select`成员...  /  名称`url-test`过滤`测速URL`interval,failure,success
 */
import { detectEol, isCommentOrBlank, seal, splitLines, unchanged } from './common.js';

/* ---------- proxy group ---------- */

export function parseProxyGroup(expr) {
  const parts = expr.split('`');
  const name = parts[0] || '';
  const strategy = parts[1] || 'select';

  if (strategy === 'select') {
    const members = parts.slice(2).map(m => {
      const glob = m.endsWith('.*');
      const core = glob ? m.slice(0, -2) : m;
      const bracket = core.startsWith('[]');
      return { name: bracket ? core.slice(2) : core, prefix: bracket ? '[]' : '', glob };
    });
    return { name, strategy, members };
  }

  // 不过滤空值：`300,,50` 中间的空位是有意义的
  const params = (parts[4] || '').split(',').map(s => s.trim());
  return {
    name, strategy,
    filters: parts[2] || '',
    url: parts[3] || '',
    interval: params[0] || '',
    failure: params[1] || '',
    success: params[2] || '',
  };
}

export function serializeProxyGroup(pg) {
  let out = `${pg.name}\`${pg.strategy}\``;
  if (pg.strategy === 'select') {
    return out + (pg.members || []).map(m => (m.prefix || '') + m.name + (m.glob ? '.*' : '')).join('`');
  }
  out += `${pg.filters || ''}\`${pg.url || ''}`;
  const params = [pg.interval || '', pg.failure || '', pg.success || ''];
  while (params.length && !params[params.length - 1]) params.pop();
  if (params.length) out += '`' + params.join(',');
  return out;
}

/* ---------- 整个文件 ---------- */

function parseRuleset(val) {
  const comma = val.indexOf(',');
  if (comma === -1) return { label: val.trim(), url: '', embedded: null };
  const label = val.slice(0, comma).trim();
  const rest = val.slice(comma + 1).trim();
  if (!rest.startsWith('[]')) return { label, url: rest, embedded: null };
  const inner = rest.slice(2);
  const i = inner.indexOf(',');
  const embedded = i > 0
    ? { type: inner.slice(0, i).trim(), rule: inner.slice(i + 1).trim() }
    : { type: inner.trim(), rule: '' };
  return { label, url: '', embedded };
}

function parseEntry(raw) {
  const cb = isCommentOrBlank(raw);
  if (cb) return { kind: cb.kind, text: raw, raw };

  const trimmed = raw.trim();
  const eq = trimmed.indexOf('=');
  if (eq === -1) return { kind: 'unknown', raw };

  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (key === 'ruleset') return { kind: 'ruleset', raw, ...parseRuleset(val) };
  if (key === 'custom_proxy_group') return { kind: 'proxy_group', raw, ...parseProxyGroup(val) };
  return { kind: 'kv', raw, key, value: val };
}

/** 第一个 [section] 之前的内容归入 section=null 的"文件开头"，不会丢失。 */
export function parseClashIni(text) {
  const sections = [];
  let current = null;
  for (const raw of splitLines(text)) {
    const m = raw.trim().match(/^\[([^\]]+)\]$/);
    if (m) {
      current = { section: m[1], headerRaw: raw, entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { section: null, entries: [] };
      sections.push(current);
    }
    current.entries.push(seal(parseEntry(raw)));
  }
  return { eol: detectEol(text), sections };
}

function entryToLine(e) {
  if (unchanged(e)) return e.raw;
  switch (e.kind) {
    case 'blank': return '';
    case 'comment': return e.text;
    case 'unknown': return e.raw || '';
    case 'kv': return `${e.key}=${e.value}`;
    case 'ruleset': {
      const tail = e.embedded
        ? `[]${e.embedded.type}${e.embedded.rule ? ',' + e.embedded.rule : ''}`
        : (e.url || '');
      return `ruleset=${e.label},${tail}`;
    }
    case 'proxy_group': return `custom_proxy_group=${serializeProxyGroup(e)}`;
    default: return e.raw || '';
  }
}

export function serializeClashIni({ sections, eol }) {
  const lines = [];
  for (const sec of sections) {
    if (sec.section !== null) lines.push(sec.headerRaw ?? `[${sec.section}]`);
    for (const e of sec.entries) lines.push(entryToLine(e));
  }
  return lines.join(eol || '\n');
}
