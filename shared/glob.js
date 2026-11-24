/** 与服务端 src/lib/glob.js 语义一致的路径通配（用于预览"直链规则"是否命中）。 */
const cache = new Map();

export function globToRegExp(pattern) {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { src += '.*'; i++; if (pattern[i + 1] === '/') i++; }
      else src += '[^/]*';
    } else if (ch === '?') src += '[^/]';
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const re = new RegExp(`^${src}$`);
  if (cache.size > 500) cache.clear();
  cache.set(pattern, re);
  return re;
}
export const matchAny = (patterns, path) => (patterns || []).some(p => globToRegExp(p).test(path));
