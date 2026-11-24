/**
 * 文件访问策略（环境变量 DIRECT_PATHS）：按文件或目录决定"免令牌直链"还是"令牌访问"。
 *
 *   DIRECT_PATHS = "规则[:模式],规则[:模式],…"
 *
 *   规则  文件路径 clash/a.list ；目录 clash/（末尾斜杠 = 整个目录含子目录，等同 clash/**）；
 *         通配 clash/*.list（* 单层，** 多层，? 单个字符）。路径相对管理目录。
 *   模式  direct  免令牌直链：/file/<路径> 直接可读（需 PUBLIC_FILES=true）；同时也允许令牌访问。省略模式时默认 direct。
 *         token   仅令牌访问：必须带有效令牌；
 *         deny    禁止：即使命中其它规则也不开放（例外）。
 *   匹配 多条规则同时命中时取**最具体（粒度最小）**的一条：精确文件 > 更深的目录 > 单层通配 > 递归通配；
 *         完全同样具体时 deny > direct > token。例：clash/ 开放、clash/abc.list:token，则 clash/abc.list 需要令牌。
 *
 * 一旦配置了任何规则，就变成白名单：没有命中 direct/token 规则的文件，令牌也无法访问，
 * 且不能为它们生成链接。完全没有配置规则时保持宽松：令牌可访问任意文件，没有免令牌直链。
 * 想对所有文件开放令牌访问：加一条 "**:token"。
 */
import { globToRegExp } from './glob.js';

const MODES = new Set(['direct', 'token', 'deny']);

export function parseAccessRules(raw) {
  const rules = [];
  for (const entry of String(raw || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = entry.match(/^(.*?):(direct|token|deny)$/i);
    const mode = m ? m[2].toLowerCase() : 'direct';
    let pattern = (m ? m[1] : entry).trim().replace(/^\/+/, '');
    if (!pattern || pattern.includes('\\') || pattern.split('/').some(s => s === '..' || s === '.')) continue;
    if (pattern.endsWith('/')) pattern += '**';
    if (MODES.has(mode)) rules.push({ pattern, mode, source: entry });
  }
  return rules;
}

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

/** @returns {{ mode: 'open'|'direct'|'token'|'deny'|'none', direct: boolean, token: boolean, rule: object|null }} */
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
