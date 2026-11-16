/** 路径通配规则：`*` 匹配单层、`**` 匹配多层、`?` 匹配单个字符，其余按字面量，整体锚定。 */
import { HttpError } from './http.js';

const cache = new Map();

export function globToRegExp(pattern) {
  let re = cache.get(pattern);
  if (re) return re;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { src += '.*'; i++; if (pattern[i + 1] === '/') i++; } // "**/" 也匹配零层目录
      else src += '[^/]*';
    } else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp(`^${src}$`);
  if (cache.size > 500) cache.clear();
  cache.set(pattern, re);
  return re;
}

export const matchAny = (patterns, path) => (patterns || []).some(p => globToRegExp(p).test(path));

/** 校验并规范化用户提供的规则列表。 */
export function normalizePatterns(list, { max = 20 } = {}) {
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, '至少需要一条路径规则');
  if (list.length > max) throw new HttpError(400, `路径规则最多 ${max} 条`);
  return list.map(raw => {
    const p = String(raw ?? '').trim();
    if (!p || p.length > 200 || p.startsWith('/') || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p) ||
        p.split('/').some(seg => seg === '..' || seg === '.')) {
      throw new HttpError(400, `路径规则不合法：${p || '(空)'}`);
    }
    return p;
  });
}
