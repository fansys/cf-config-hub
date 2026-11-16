/**
 * Clash / QuantumultX / Shadowrocket 三种 `.list` 规则的互相转换（无 DOM 依赖）。
 *
 * 做法：先把源格式的"类型 / 策略"还原成统一的标准名，再换成目标格式的写法。
 * 目标格式不支持的规则不会被悄悄丢掉，而是保留为被注释掉的原文行（`# [未转换] …`）并计入 skipped。
 */
import { serializeRuleList } from './rule-list.js';

export const CONVERT_TARGETS = {
  'clash-list': { label: 'Clash', dir: 'Clash', dirAliases: ['clash'] },
  'qx-list': { label: 'QuantumultX', dir: 'QuantumultX', dirAliases: ['quantumultx', 'qx'] },
  'shadowrocket-list': { label: 'Shadowrocket', dir: 'Shadowrocket', dirAliases: ['shadowrocket'] }, // 目录名固定为 Shadowrocket
};
const FORMATS = Object.keys(CONVERT_TARGETS);

/** 标准类型 → 各格式里的写法；某格式缺失表示该格式不支持这种规则。 */
const TYPES = {
  'DOMAIN': { 'clash-list': 'DOMAIN', 'qx-list': 'HOST', 'shadowrocket-list': 'DOMAIN' },
  'DOMAIN-SUFFIX': { 'clash-list': 'DOMAIN-SUFFIX', 'qx-list': 'HOST-SUFFIX', 'shadowrocket-list': 'DOMAIN-SUFFIX' },
  'DOMAIN-KEYWORD': { 'clash-list': 'DOMAIN-KEYWORD', 'qx-list': 'HOST-KEYWORD', 'shadowrocket-list': 'DOMAIN-KEYWORD' },
  'DOMAIN-REGEX': { 'clash-list': 'DOMAIN-REGEX', 'qx-list': 'HOST-REGEX' },
  'IP-CIDR': { 'clash-list': 'IP-CIDR', 'qx-list': 'IP-CIDR', 'shadowrocket-list': 'IP-CIDR' },
  'IP-CIDR6': { 'clash-list': 'IP-CIDR6', 'qx-list': 'IP-CIDR6', 'shadowrocket-list': 'IP-CIDR6' },
  'IP-ASN': { 'clash-list': 'IP-ASN', 'qx-list': 'IP-ASN', 'shadowrocket-list': 'IP-ASN' },
  'GEOIP': { 'clash-list': 'GEOIP', 'qx-list': 'GEOIP', 'shadowrocket-list': 'GEOIP' },
  'USER-AGENT': { 'qx-list': 'USER-AGENT', 'shadowrocket-list': 'USER-AGENT' },
  'URL-REGEX': { 'qx-list': 'URL-REGEX', 'shadowrocket-list': 'URL-REGEX' },
  'PROCESS-NAME': { 'clash-list': 'PROCESS-NAME', 'shadowrocket-list': 'PROCESS-NAME' },
  'DST-PORT': { 'clash-list': 'DST-PORT', 'shadowrocket-list': 'DST-PORT' },
  'SRC-PORT': { 'clash-list': 'SRC-PORT', 'shadowrocket-list': 'SRC-PORT' },
  'SRC-IP': { 'clash-list': 'SRC-IP-CIDR', 'shadowrocket-list': 'SRC-IP' },
  'FINAL': { 'clash-list': 'MATCH', 'qx-list': 'FINAL', 'shadowrocket-list': 'FINAL' },
};

/** 源格式里的别名（同一格式里可能有多种写法）。 */
const ALIASES = {
  'clash-list': { FINAL: 'FINAL' },
  'qx-list': { DOMAIN: 'DOMAIN', 'DOMAIN-SUFFIX': 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD': 'DOMAIN-KEYWORD', 'DOMAIN-REGEX': 'DOMAIN-REGEX', MATCH: 'FINAL' },
  'shadowrocket-list': { MATCH: 'FINAL' },
};

const toCanonType = {};
for (const fmt of FORMATS) {
  toCanonType[fmt] = { ...ALIASES[fmt] };
  for (const [canon, per] of Object.entries(TYPES)) if (per[fmt]) toCanonType[fmt][per[fmt]] = canon;
}

/** 标准策略 → 各格式写法（策略名区分大小写的客户端以这里的写法为准）。 */
const ACTIONS = {
  PROXY: { 'clash-list': 'Proxy', 'qx-list': 'Proxy', 'shadowrocket-list': 'PROXY' },
  DIRECT: { 'clash-list': 'DIRECT', 'qx-list': 'Direct', 'shadowrocket-list': 'DIRECT' },
  REJECT: { 'clash-list': 'REJECT', 'qx-list': 'Reject', 'shadowrocket-list': 'REJECT' },
  'REJECT-DROP': { 'clash-list': 'REJECT-DROP', 'qx-list': 'Reject', 'shadowrocket-list': 'REJECT-DROP' },
};
const ACTION_ALIASES = {
  'clash-list': { HIJACKING: 'REJECT', DENY: 'REJECT' },
  'qx-list': { 'REJECT-I': 'REJECT' },
  'shadowrocket-list': { 'REJECT-DICT': 'REJECT', 'REJECT-ARRAY': 'REJECT', 'REJECT-NO-DROP': 'REJECT', 'REJECT-TINYGIF': 'REJECT' },
};
const toCanonAction = {};
for (const fmt of FORMATS) {
  toCanonAction[fmt] = { ...ACTION_ALIASES[fmt] };
  // 多个标准策略在某格式里写法相同时（如 QX 的 Reject 同时对应 REJECT 与 REJECT-DROP），取排在前面的，保证往返不漂移
  for (const [canon, per] of Object.entries(ACTIONS)) toCanonAction[fmt][per[fmt].toUpperCase()] ??= canon;
}

/** 策略转换：已知的换成目标写法；用户自定义的策略组名（如"🚀 节点选择"）原样保留。 */
function convertAction(action, from, to) {
  if (!action) return { value: '', custom: false };
  const canon = toCanonAction[from][action.toUpperCase()];
  return canon ? { value: ACTIONS[canon][to], custom: false } : { value: action, custom: true };
}

/**
 * @param {object} parsed  parse(源格式, 文本) 的结果（fmt 为 clash-list / qx-list / shadowrocket-list）
 * @param {string} to      目标格式
 * @returns {{ text: string, converted: number, skipped: string[], customPolicies: string[] }}
 */
export function convertRuleList(parsed, to) {
  const from = parsed.fmt;
  if (!CONVERT_TARGETS[from] || !CONVERT_TARGETS[to]) throw new Error('不支持的转换');
  if (from === to) throw new Error('源格式与目标格式相同');

  const items = [];
  const skipped = [];
  const custom = new Set();
  let converted = 0;

  for (const it of parsed.items) {
    if (!it.type) { items.push({ ...it, raw: undefined }); continue; } // 注释 / 空行 / 自由文本
    const canon = toCanonType[from][it.type];
    const targetType = canon && TYPES[canon][to];
    if (!targetType) {
      const original = serializeRuleList({ items: [{ ...it, raw: undefined }], eol: '\n' });
      items.push({ kind: 'rule', enabled: false, type: '', rule: `[未转换] ${original}`, action: '', opts: [], isBracketRule: false });
      skipped.push(it.type);
      continue;
    }

    if (canon === 'FINAL') {
      // FINAL / MATCH 的策略写在"内容"那一列：`FINAL,PROXY` / `MATCH,Proxy`（也兼容 `FINAL,,PROXY`）
      const policy = convertAction(it.action || it.rule, from, to);
      if (policy.custom) custom.add(policy.value);
      items.push({ ...it, raw: undefined, type: targetType, rule: policy.value, action: '', isBracketRule: false });
    } else {
      const act = convertAction(it.action, from, to);
      if (act.custom) custom.add(act.value);
      items.push({ ...it, raw: undefined, type: targetType, action: act.value, isBracketRule: false });
    }
    converted++;
  }
  return { text: serializeRuleList({ items, eol: parsed.eol }), converted, skipped, customPolicies: [...custom] };
}

/** 建议的目标路径：把路径里的格式目录（Clash / QuantumultX / Shadowrocket，不区分大小写）换成目标格式的固定目录名，没有则加到文件名前。 */
export function suggestConvertedPath(path, from, to) {
  const segs = path.split('/');
  const name = segs.pop();
  const src = CONVERT_TARGETS[from]?.dirAliases || [];
  const hit = segs.findIndex(s => src.includes(s.toLowerCase()));
  const dir = CONVERT_TARGETS[to].dir;
  if (hit >= 0) segs[hit] = dir; else segs.push(dir);
  return [...segs, name].join('/');
}
