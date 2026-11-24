/** 差异算法、规则校验、去重与安全排序。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapse, diffLines, diffStats } from '../shared/diff.js';
import { collectIssues, dedupe, parse, serialize, sortRuns, validateRule, validateRuleset } from '../shared/formats/index.js';

const apply = ops => ({
  a: ops.filter(o => o.type !== 'add').map(o => o.text).join('\n'),
  b: ops.filter(o => o.type !== 'del').map(o => o.text).join('\n'),
});

test('diff：相同内容无变化；增删改被正确识别', () => {
  assert.equal(diffStats(diffLines('a\nb', 'a\nb')).changed, false);
  const ops = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(diffStats(ops), { add: 2, del: 1, changed: true });
  assert.deepEqual(apply(ops), { a: 'a\nb\nc\nd', b: 'a\nB\nc\nd\ne' });
});

test('diff：空文本与整体替换；还原性（任意输入）', () => {
  assert.deepEqual(diffStats(diffLines('', 'x\ny')), { add: 2, del: 0, changed: true });
  assert.deepEqual(diffStats(diffLines('x\ny', '')), { add: 0, del: 2, changed: true });
  const a = Array.from({ length: 60 }, (_, i) => `line${i % 7}`).join('\n');
  const b = Array.from({ length: 55 }, (_, i) => `line${(i * 3) % 5}`).join('\n');
  assert.deepEqual(apply(diffLines(a, b)), { a, b });
});

test('diff：超大差异退化为整体替换而不卡死', () => {
  const a = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n');
  const ops = diffLines(a, b);
  assert.deepEqual(apply(ops), { a, b });
});

test('diff：collapse 折叠未变化的长段并保留上下文', () => {
  const a = Array.from({ length: 40 }, (_, i) => 'l' + i).join('\n');
  const b = a.replace('l20', 'CHANGED');
  const rows = collapse(diffLines(a, b), 2);
  assert.equal(rows.filter(r => r.type === 'gap').length, 2);
  assert.ok(rows.some(r => r.type === 'add' && r.text === 'CHANGED'));
  assert.ok(rows.length < 12);
});

const rule = (type, rule, action = '', enabled = true) => ({ kind: 'rule', enabled, type, rule, action, opts: [] });

test('校验：CIDR / 域名 / 空内容 / GEOIP', () => {
  assert.equal(validateRule(rule('IP-CIDR', '1.1.1.0/24')), '');
  assert.match(validateRule(rule('IP-CIDR', '1.1.1.0')), /前缀/);
  assert.match(validateRule(rule('IP-CIDR', '1.1.1.0/33')), /0–32/);
  assert.match(validateRule(rule('IP-CIDR', '999.1.1.1/8')), /IPv4/);
  assert.equal(validateRule(rule('IP-CIDR6', '2001:db8::/32')), '');
  assert.match(validateRule(rule('IP-CIDR6', '2001:db8::/129')), /0–128/);
  assert.match(validateRule(rule('DOMAIN-SUFFIX', 'a b.com')), /空格/);
  assert.match(validateRule(rule('DOMAIN', '')), /为空/);
  assert.equal(validateRule(rule('MATCH', '')), '');
  assert.equal(validateRule(rule('', 'free text')), '');
  assert.equal(validateRule(rule('GEOIP', 'CN')), '');
  assert.match(validateRule(rule('GEOIP', '1')), /国家代码/);
});

test('重复检测不区分大小写，禁用的规则不参与', () => {
  const items = [rule('DOMAIN', 'A.com', 'Proxy'), rule('DOMAIN', 'a.com', 'Proxy'), rule('DOMAIN', 'a.com', 'Proxy', false), rule('DOMAIN', 'a.com', 'DIRECT')];
  const issues = collectIssues(items);
  assert.match(issues.get(1), /第 1 条重复/);
  assert.equal(issues.has(2), false);
  assert.equal(issues.has(3), false);
  const { items: out, removed } = dedupe(items);
  assert.equal(removed, 1);
  assert.equal(out.length, 3);
});

test('安全排序：只在同类型同动作的连续段内排序，不跨越其它规则', () => {
  const items = [
    rule('DOMAIN', 'z.com', 'Proxy'), rule('DOMAIN', 'a.com', 'Proxy'),
    rule('DOMAIN', 'm.com', 'DIRECT'),
    rule('DOMAIN', 'c.com', 'Proxy'), rule('DOMAIN', 'b.com', 'Proxy'),
  ];
  const { items: out, changedRuns } = sortRuns(items);
  assert.equal(changedRuns, 2);
  assert.deepEqual(out.map(i => i.rule), ['a.com', 'z.com', 'm.com', 'b.com', 'c.com']);
});

test('整理后未改动的行仍原样输出（排序只重排，不重写内容）', () => {
  const text = 'DOMAIN,"z,x.com",Proxy\nDOMAIN,"a,y.com",Proxy\n';
  const parsed = parse('clash-list', text);
  parsed.items = sortRuns(parsed.items).items;
  assert.equal(serialize(parsed), 'DOMAIN,"a,y.com",Proxy\nDOMAIN,"z,x.com",Proxy\n');
});

test('ruleset 校验', () => {
  assert.equal(validateRuleset({ label: 'x', url: 'https://a.com/x.list', embedded: null }), '');
  assert.match(validateRuleset({ label: 'x', url: 'ftp://a', embedded: null }), /http/);
  assert.match(validateRuleset({ label: '', url: 'https://a.com', embedded: null }), /标签/);
  assert.equal(validateRuleset({ label: 'x', url: '', embedded: { type: 'GEOIP', rule: 'CN' } }), '');
});
