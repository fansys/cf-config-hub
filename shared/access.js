/** 与服务端 src/lib/access.js 语义一致：多条规则命中时取最具体的一条，判断某个文件的访问方式。 */
import { globToRegExp } from './glob.js';


/**
 * 规则的"具体程度"（越大越具体），用于在多条规则同时命中时取最小粒度的那条：
 *   1. 精确文件路径（不含通配）永远比通配更具体；
 *   2. 其次比较字面量目录层数——clash/sub/** 比 clash/** 更具体，clash/*.list 与 clash/** 同为 1 层；
 *   3. 再其次不含 ** 的比含 ** 的具体（clash/*.list 比 clash/** 具体）；
 *   4. 最后比较字面量字符数。
 * 具体程度完全相同时，按 deny > direct > token 取更保守的那个。
 */
export function specificity(pattern) {
  const wildcard = /[*?]/.test(pattern);
  const segs = pattern.split('/');
  let literalDepth = 0;
  for (const seg of segs.slice(0, -1)) { if (/[*?]/.test(seg)) break; literalDepth++; }
  return [wildcard ? 0 : 1, literalDepth, pattern.includes('**') ? 0 : 1, pattern.replace(/[*?]/g, '').length];
}

const MODE_RANK = { deny: 3, direct: 2, token: 1 };

function better(a, b) {
  const sa = specificity(a.pattern), sb = specificity(b.pattern);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i];
  return MODE_RANK[a.mode] > MODE_RANK[b.mode];
}

/** 目录规则可以写成 `dir/`，匹配时与 `dir/**` 相同，覆盖该目录下的文件。 */
const rulePattern = pattern => (pattern.endsWith('/') ? `${pattern}**` : pattern);

/** @returns {{ mode: 'open'|'direct'|'token'|'deny'|'none', direct: boolean, token: boolean, rule: { pattern: string, mode: string }|null }} */
export function resolveAccess(rules, path) {
  if (!rules?.length) return { mode: 'open', direct: false, token: true, rule: null };
  let best = null;
  for (const r of rules) {
    const pattern = rulePattern(r.pattern);
    if (globToRegExp(pattern).test(path) && (!best || better({ ...r, pattern }, best))) best = { ...r, pattern };
  }
  if (!best) return { mode: 'none', direct: false, token: false, rule: null };
  return { mode: best.mode, direct: best.mode === 'direct', token: best.mode !== 'deny', rule: best };
}

/**
 * 文件树图标，目录和文件同一套规则。
 * 能直接访问：eye。仅令牌：share。其余（未配置、未命中、禁止）：lock。
 */
export function accessBadge(access) {
  if (access?.direct) return 'eye';
  if (access?.mode === 'token') return 'share';
  return 'lock';
}

export const MODE_LABELS = {
  open: '未配置访问规则（令牌可访问任意文件，无免令牌直链）',
  direct: '免令牌直链（同时允许令牌访问）',
  token: '仅令牌访问',
  deny: '已禁止访问',
  none: '未开放（规则是白名单，此文件没有命中任何规则）',
};

/** 生成可粘贴进 DIRECT_PATHS 的规则文本。 */
export function ruleSnippets(path) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return [
    { label: '此文件：免令牌直链', text: `${path}:direct` },
    { label: '此文件：仅令牌', text: `${path}:token` },
    { label: dir ? '此目录：免令牌直链' : '全部文件：免令牌直链', text: `${dir || '**'}:direct` },
    { label: dir ? '此目录：仅令牌' : '全部文件：仅令牌', text: `${dir || '**'}:token` },
  ];
}
