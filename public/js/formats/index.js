/** 可视化格式统一入口：探测、解析、序列化。无 DOM 依赖，可直接在 Node 中测试。 */
import { parseClashIni, serializeClashIni } from './clash-ini.js';
import { parseEnv, serializeEnv } from './env.js';
import { parseClashList, parseQxList, parseShadowrocketList, serializeRuleList } from './rule-list.js';

export * from './rule-list.js';
export * from './validate.js';
export { envIssues, isSensitiveKey } from './env.js';
export { CONVERT_TARGETS, convertRuleList, suggestConvertedPath } from './convert.js';
export { parseProxyGroup, serializeProxyGroup } from './clash-ini.js';

export const FORMAT_LABELS = {
  'clash-list': 'Clash 规则列表',
  'clash-ini': 'Clash 订阅增强 (.ini)',
  'qx-list': 'QuantumultX 规则列表',
  'shadowrocket-list': 'Shadowrocket 规则列表',
  'env': '环境变量 (.env)',
};

const isCommentLine = l => /^\s*[#;]/.test(l);

/**
 * 判断文件适用哪种可视化编辑器，不适用返回 null。
 * 路径约定优先（含 clash / quantumultx / qx 目录段）；其次在路径暗示为代理配置时做内容嗅探。
 */
export function detectFormat(path, text) {
  const lower = path.toLowerCase();
  const base = lower.split('/').pop();
  if (/^\.env(\..+)?$/.test(base) || base.endsWith('.env')) return 'env';
  const segs = lower.split('/');
  const inClash = segs.includes('clash');
  const inQx = segs.includes('quantumultx') || segs.includes('qx');
  const inSr = segs.includes('shadowrocket'); // 目录名固定为 Shadowrocket（不区分大小写）

  if (inQx && (lower.endsWith('.list') || lower.endsWith('.conf'))) return 'qx-list';
  if (inSr && (lower.endsWith('.list') || lower.endsWith('.conf'))) return 'shadowrocket-list';
  if (inClash && lower.endsWith('.ini')) return 'clash-ini';
  if (inClash && lower.endsWith('.list')) return 'clash-list';

  if (/(proxy|rule|config|订阅|配置|规则)/.test(lower)) {
    if (/^\[[^\]]+\]\s*$/m.test(text) && text.includes('ruleset=')) return 'clash-ini';
    const first = text.split(/\r?\n/).find(l => l.trim() && !isCommentLine(l)) || '';
    if (/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|GEOSITE|GEOIP|IP-CIDR|IP-CIDR6|MATCH|FINAL),/.test(first)) return 'clash-list';
    if (/^(HOST|HOST-SUFFIX|HOST-KEYWORD),/.test(first)) return 'qx-list';
  }
  return null;
}

export function parse(fmt, text) {
  switch (fmt) {
    case 'clash-list': return { fmt, ...parseClashList(text) };
    case 'qx-list': return { fmt, ...parseQxList(text) };
    case 'shadowrocket-list': return { fmt, ...parseShadowrocketList(text) };
    case 'clash-ini': return { fmt, ...parseClashIni(text) };
    case 'env': return { fmt, ...parseEnv(text) };
    default: throw new Error('未知格式: ' + fmt);
  }
}

export function serialize(parsed) {
  switch (parsed.fmt) {
    case 'clash-list':
    case 'qx-list':
    case 'shadowrocket-list': return serializeRuleList(parsed);
    case 'clash-ini': return serializeClashIni(parsed);
    case 'env': return serializeEnv(parsed);
    default: throw new Error('未知格式: ' + parsed.fmt);
  }
}
