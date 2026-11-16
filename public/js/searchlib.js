/** 全库搜索 / 替换的纯函数（无 DOM 依赖）。 */

/** 构造匹配器；正则非法时抛出带说明的错误。 */
export function buildMatcher({ query, regex = false, caseSensitive = false, wholeWord = false }) {
  if (!query) throw new Error('请输入要搜索的内容');
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `\\b(?:${src})\\b`;
  try { return new RegExp(src, caseSensitive ? 'g' : 'gi'); }
  catch (e) { throw new Error('正则表达式不合法：' + e.message); }
}

/** 找出所有匹配行：[{ line(1 起), text, count }]；单行超长时截取命中附近。 */
export function findInText(text, matcher, { maxLines = 50 } = {}) {
  const out = [];
  let total = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    matcher.lastIndex = 0;
    let count = 0, first = -1;
    for (let m; (m = matcher.exec(lines[i]));) {
      if (first < 0) first = m.index;
      count++;
      if (m[0] === '') matcher.lastIndex++; // 防止空匹配死循环
    }
    if (!count) continue;
    total += count;
    if (out.length < maxLines) {
      const t = lines[i];
      const start = Math.max(0, first - 40);
      out.push({ line: i + 1, count, text: (start ? '…' : '') + t.slice(start, start + 160) + (t.length > start + 160 ? '…' : '') });
    }
  }
  return { lines: out, total };
}

/** 替换全部；regex 模式下 replacement 支持 $1、$& 等。返回新文本与替换次数。 */
export function replaceInText(text, matcher, replacement, regex) {
  let count = 0;
  matcher.lastIndex = 0;
  const next = text.replace(matcher, (...args) => {
    count++;
    if (!regex) return replacement;
    // 手动展开 $1 / $& / $$，避免依赖 replace 的特殊序列处理
    const groups = args.slice(0, args.findIndex(a => typeof a === 'number'));
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (_, k) => (k === '$' ? '$' : k === '&' ? groups[0] : (groups[Number(k)] ?? '')));
  });
  return { text: next, count };
}

/** 判断是否应跳过（二进制/过大）。 */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|mp[34]|mov|avi|wasm|bin|exe|dll|so|dylib|class|jar)$/i;
export const searchable = (path, size) => !BINARY_EXT.test(path) && size <= 512 * 1024;
