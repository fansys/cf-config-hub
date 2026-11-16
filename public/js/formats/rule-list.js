/** Clash `.list` 与 QuantumultX `.list` 的解析 / 序列化（结构相同，规则类型集合不同）。 */
import {
  detectEol, isCommentOrBlank, seal, splitLines, splitRuleLine, trimTrailingEmpty, unchanged,
} from './common.js';

export const CLASH_RULE_TYPES = [
  '', // 空占位，界面显示为 "-"
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'DOMAIN-SUFFIX-EXCLUDED', 'DOMAIN-SET',
  'GEOSITE', 'GEOIP', 'IP-CIDR', 'IP-CIDR6', 'IP-ASN',
  'SRC-IP-CIDR', 'SRC-PORT', 'DST-PORT', 'IN-PORT',
  'PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-PATH',
  'NETWORK', 'UID', 'UID-RANGE', 'UID-NAME',
  'RULE-SET', 'SUB-RULE', 'AND', 'OR', 'NOT',
  'MATCH', 'FINAL',
];

export const QX_RULE_TYPES = [
  '',
  'HOST', 'HOST-SUFFIX', 'HOST-KEYWORD', 'HOST-REGEX',
  'HOST-IP', 'HOST-PATH', 'HOST-PORT', 'HOST-QUERY',
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX',
  'DOMAIN-IP', 'DOMAIN-PATH', 'DOMAIN-PORT', 'DOMAIN-QUERY',
  'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'IP-REGEX',
  'GEOIP', 'GEOSITE',
  'USER-AGENT', 'URL-REGEX',
  'PROCESS-NAME', 'PROCESS-PID', 'PROCESS-NAME-PATH',
  'MATCH', 'FINAL',
];

// Shadowrocket（与 Surge 风格相同）：每行 类型,内容,策略[,选项]
export const SR_RULE_TYPES = [
  '',
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD',
  'IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP',
  'USER-AGENT', 'URL-REGEX', 'PROCESS-NAME',
  'DST-PORT', 'SRC-PORT', 'SRC-IP',
  'RULE-SET', 'AND', 'OR', 'NOT',
  'FINAL',
];
export const SR_ACTIONS = ['PROXY', 'DIRECT', 'REJECT', 'REJECT-DICT', 'REJECT-ARRAY', 'REJECT-DROP', 'REJECT-NO-DROP'];

export const CLASH_ACTIONS = ['Proxy', 'DIRECT', 'REJECT', 'Hijacking', 'DENY', 'REJECT-DROP'];
export const QX_ACTIONS = ['Proxy', 'Direct', 'Reject', 'Reject-I', 'Quic'];

const COMMENT_PREFIX = /^(?:#|\/\/|;)\s?/;

/** 把一行（已去掉注释前缀）解析为规则；类型未知时返回 null。 */
function parseRule(body, knownTypes, allowBracket) {
  const parts = splitRuleLine(body);
  const head = parts[0] || '';
  const bracket = allowBracket && head.startsWith('[]');
  const type = bracket ? head.slice(2) : head;
  if (!type || !knownTypes.includes(type)) return null;
  return {
    kind: 'rule', enabled: true, type,
    rule: parts[1] || '',
    action: parts[2] || '',
    opts: parts.slice(3),           // no-resolve 等额外列
    isBracketRule: bracket,
  };
}

function parseList(text, knownTypes, allowBracket) {
  const items = splitLines(text).map(raw => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return seal({ kind: 'rule', enabled: true, type: '', rule: '', action: '', opts: [], isBracketRule: false, raw });
    }
    const isComment = /^(?:#|\/\/|;)/.test(trimmed);
    const body = isComment ? trimmed.replace(COMMENT_PREFIX, '') : trimmed;
    const rule = parseRule(body, knownTypes, allowBracket);
    const item = rule
      ? { ...rule, enabled: !isComment, raw }
      // 无法识别的行（普通注释、payload: 等）：作为无类型文本行原样保留
      : { kind: 'rule', enabled: !isComment, type: '', rule: body, action: '', opts: [], isBracketRule: false, raw };
    return seal(item);
  });
  return { eol: detectEol(text), items };
}

function buildLine(it) {
  if (!it.type) return (it.rule || '').trim() ? it.rule : '';
  const head = (it.isBracketRule ? '[]' : '') + it.type;
  return trimTrailingEmpty([head, it.rule || '', it.action || '', ...(it.opts || [])]).join(',');
}

function serializeList(items, eol) {
  return items.map(it => {
    if (unchanged(it)) return it.raw;
    const content = buildLine(it);
    return it.enabled ? content : (content ? `# ${content}` : '#');
  }).join(eol);
}

export const parseClashList = text => parseList(text, CLASH_RULE_TYPES, true);
export const parseQxList = text => parseList(text, QX_RULE_TYPES, false);
export const parseShadowrocketList = text => parseList(text, SR_RULE_TYPES, false);

/** 各规则列表格式的类型 / 动作 / 输入框提示。 */
export const LIST_FORMATS = {
  'clash-list': { types: CLASH_RULE_TYPES, actions: CLASH_ACTIONS, bracket: true, placeholder: '域名 / IP / CIDR' },
  'qx-list': { types: QX_RULE_TYPES, actions: QX_ACTIONS, bracket: false, placeholder: '域名 / IP' },
  'shadowrocket-list': { types: SR_RULE_TYPES, actions: SR_ACTIONS, bracket: false, placeholder: '域名 / IP / CIDR' },
};
export const isListFormat = fmt => fmt in LIST_FORMATS;
export const serializeRuleList = ({ items, eol }) => serializeList(items, eol || '\n');

/** 供批量粘贴 / 导入使用：把任意一行转成规则条目（无 raw，视为新条目）。 */
export function lineToItem(rawLine, fmt) {
  const spec = LIST_FORMATS[fmt] || LIST_FORMATS['clash-list'];
  const plain = (rule, enabled) => ({ kind: 'rule', enabled, type: '', rule, action: '', opts: [], isBracketRule: false });
  const cb = isCommentOrBlank(rawLine);
  if (cb?.kind === 'blank') return plain('', true);
  const body = cb ? cb.text.replace(COMMENT_PREFIX, '') : rawLine.trim();
  const rule = parseRule(body, spec.types, spec.bracket);
  if (rule) return { ...rule, enabled: !cb };
  return plain(body, !cb);
}
