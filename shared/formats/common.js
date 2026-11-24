/**
 * 格式解析器的公共工具。
 *
 * 往返保真原则：解析时给每个条目打"签名"，序列化时若条目未被修改就原样输出 raw，
 * 因此仅打开可视化模式、或只改了其中一行，不会改动文件中的其他任何字节
 * （引号、多余列、缩进、注释写法、行尾 CRLF 都保持不变）。
 */

/** 探测换行符，默认 LF。 */
export const detectEol = text => (text.includes('\r\n') ? '\r\n' : '\n');

export const splitLines = text => text.split(/\r?\n/);

/**
 * 按逗号切列；引号内的逗号不切，且**保留引号字符**，保证重新拼接后与原文一致。
 */
export function splitRuleLine(line) {
  const parts = [];
  let cur = '';
  let quote = false;
  for (const ch of line) {
    if (ch === '"') { quote = !quote; cur += ch; }
    else if (ch === ',' && !quote) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim());
}

export function isCommentOrBlank(line) {
  const t = line.trim();
  if (!t) return { kind: 'blank', text: '' };
  if (t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) return { kind: 'comment', text: t };
  return null;
}

/* ---------- 签名 / 原样输出 ---------- */

const signature = item => JSON.stringify(item, (k, v) => (k === 'raw' ? undefined : v));

/** 给刚解析出的条目盖章（非枚举属性，不影响 JSON 与遍历）。 */
export function seal(item) {
  Object.defineProperty(item, '_sig', { value: signature(item), writable: true, enumerable: false });
  return item;
}

/** 条目自解析以来是否未被改动。 */
export const unchanged = item => item.raw !== undefined && item._sig === signature(item);

/** 去掉末尾的空列，如 ['A','b',''] → ['A','b']。 */
export function trimTrailingEmpty(cols) {
  const out = [...cols];
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}
