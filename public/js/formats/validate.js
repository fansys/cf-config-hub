/** 规则校验与整理工具（纯函数，无 DOM 依赖）。 */

const OCTET = '(25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const NO_CONTENT_TYPES = new Set(['MATCH', 'FINAL']);
const DOMAIN_TYPES = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'HOST', 'HOST-SUFFIX', 'HOST-KEYWORD']);

const inRange = (s, max) => /^\d+$/.test(s) && Number(s) >= 0 && Number(s) <= max;

/** 单条规则的问题描述；没有问题返回空串。无类型的自由文本行不校验。 */
export function validateRule(it) {
  if (!it.type || NO_CONTENT_TYPES.has(it.type)) return '';
  const rule = (it.rule || '').trim();
  if (!rule) return '规则内容为空';

  if (it.type === 'IP-CIDR' || it.type === 'SRC-IP-CIDR') {
    const [ip, prefix, ...extra] = rule.split('/');
    if (!IPV4.test(ip) || extra.length) return 'IPv4 地址格式不正确';
    if (prefix === undefined) return '缺少前缀长度（如 /24）';
    if (!inRange(prefix, 32)) return '前缀长度应为 0–32';
  } else if (it.type === 'IP-CIDR6') {
    const [ip, prefix] = rule.split('/');
    if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return 'IPv6 地址格式不正确';
    if (prefix === undefined) return '缺少前缀长度（如 /64）';
    if (!inRange(prefix, 128)) return '前缀长度应为 0–128';
  } else if (DOMAIN_TYPES.has(it.type)) {
    if (/[\s/,]/.test(rule)) return '域名/关键字中不应包含空格、逗号或 /';
  } else if (it.type === 'IP-ASN') {
    if (!/^\d+$/.test(rule)) return 'ASN 应为纯数字';
  } else if (it.type === 'GEOIP') {
    if (!/^[A-Za-z][A-Za-z-]*$/.test(rule)) return 'GEOIP 应为国家代码，如 CN';
  }
  return '';
}

/** 规则的去重键：类型 + 内容（不区分大小写）+ 动作。 */
export const ruleKey = it => `${it.type}|${(it.rule || '').trim().toLowerCase()}|${it.action || ''}`;

const isActiveRule = it => it.kind === 'rule' && it.enabled && !!it.type && !NO_CONTENT_TYPES.has(it.type);

/** 汇总所有问题：Map<下标, 描述>。重复规则指向它第一次出现的位置。 */
export function collectIssues(items) {
  const issues = new Map();
  const seen = new Map();
  items.forEach((it, i) => {
    const msg = validateRule(it);
    if (msg) issues.set(i, msg);
    if (!isActiveRule(it)) return;
    const key = ruleKey(it);
    if (seen.has(key)) { if (!issues.has(i)) issues.set(i, `与第 ${seen.get(key) + 1} 条重复`); }
    else seen.set(key, i);
  });
  return issues;
}

/** 删除重复的已启用规则（保留首次出现），返回新数组与删除条数。 */
export function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (isActiveRule(it)) {
      const key = ruleKey(it);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(it);
  }
  return { items: out, removed: items.length - out.length };
}

/**
 * 安全排序：只在"连续、同类型、同动作"的已启用规则段内按内容排序。
 * 规则的匹配是自上而下的，这样不会改变不同动作规则之间的先后顺序。
 * 返回新数组与被调整的段数。
 */
export function sortRuns(items) {
  const out = [];
  let changedRuns = 0;
  for (let i = 0; i < items.length;) {
    if (!isActiveRule(items[i])) { out.push(items[i++]); continue; }
    let j = i;
    while (j < items.length && isActiveRule(items[j]) &&
           items[j].type === items[i].type && (items[j].action || '') === (items[i].action || '')) j++;
    const run = items.slice(i, j);
    const sorted = [...run].sort((a, b) => (a.rule || '').localeCompare(b.rule || '', 'en', { sensitivity: 'base' }));
    if (sorted.some((it, k) => it !== run[k])) changedRuns++;
    out.push(...sorted);
    i = j;
  }
  return { items: out, changedRuns };
}

/** ruleset 条目的问题（.ini）。 */
export function validateRuleset(e) {
  if (!e.label?.trim()) return '标签为空';
  if (!e.embedded && e.url && !/^https?:\/\/\S+$/.test(e.url)) return 'URL 应以 http:// 或 https:// 开头';
  if (!e.embedded && !e.url) return '缺少规则 URL';
  return '';
}
