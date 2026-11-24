/** `.env` 文件的解析 / 序列化：逐行保真，敏感变量识别。 */
import { detectEol, seal, splitLines, unchanged } from './common.js';

const KV = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
export const SENSITIVE_KEY = /(PASS(WORD|WD)?|SECRET|TOKEN|PRIVATE|CREDENTIAL|AUTH|API[_-]?KEY|ACCESS[_-]?KEY|_KEY$|^KEY$|SIGN)/i;

export const isSensitiveKey = key => SENSITIVE_KEY.test(key);

export function parseEnv(text) {
  const items = splitLines(text).map(raw => {
    const t = raw.trim();
    if (!t) return seal({ kind: 'blank', raw });
    if (t.startsWith('#')) return seal({ kind: 'comment', text: raw, raw });
    const m = raw.match(KV);
    if (!m) return seal({ kind: 'unknown', raw });
    return seal({ kind: 'kv', raw, exported: !!m[1], key: m[2], value: m[3].trim() });
  });
  return { eol: detectEol(text), items };
}

const itemLine = it => {
  if (unchanged(it)) return it.raw;
  switch (it.kind) {
    case 'blank': return '';
    case 'comment': return it.text;
    case 'kv': return `${it.exported ? 'export ' : ''}${it.key}=${it.value}`;
    default: return it.raw || '';
  }
};

export const serializeEnv = ({ items, eol }) => items.map(itemLine).join(eol || '\n');

/** 问题：非法变量名、重复变量名（后者覆盖前者）。Map<下标, 描述> */
export function envIssues(items) {
  const issues = new Map();
  const seen = new Map();
  items.forEach((it, i) => {
    if (it.kind === 'unknown') issues.set(i, '无法识别的行（应为 KEY=value）');
    if (it.kind !== 'kv') return;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(it.key)) issues.set(i, '变量名不合法');
    else if (seen.has(it.key)) issues.set(i, `与第 ${seen.get(it.key) + 1} 行重复，后者会覆盖前者`);
    else seen.set(it.key, i);
  });
  return issues;
}
