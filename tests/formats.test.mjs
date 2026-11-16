/** 可视化格式解析器：往返保真（解析后再序列化，未改动内容必须逐字节一致）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFormat, parse, serialize } from '../public/js/formats/index.js';
import { parseProxyGroup, serializeProxyGroup } from '../public/js/formats/clash-ini.js';

const roundTrip = (fmt, text) => serialize(parse(fmt, text));

const CLASH = [
  '# 注释行',
  'DOMAIN-SUFFIX,google.com,Proxy',
  'IP-CIDR,1.1.1.0/24,DIRECT,no-resolve',
  'DOMAIN,"a,b.com",Proxy',
  '  DOMAIN-KEYWORD , ads , REJECT  ',
  '// DOMAIN,disabled.com,Proxy',
  '[]GEOIP,CN',
  'payload:',
  '',
].join('\n');

test('Clash list：未修改时逐字节一致（含 no-resolve、引号、缩进、注释）', () => {
  assert.equal(roundTrip('clash-list', CLASH), CLASH);
});

test('Clash list：CRLF 与无结尾换行都得到保留', () => {
  const crlf = CLASH.replace(/\n/g, '\r\n');
  assert.equal(roundTrip('clash-list', crlf), crlf);
  const noEol = 'DOMAIN,a.com,Proxy\nDOMAIN,b.com,Proxy';
  assert.equal(roundTrip('clash-list', noEol), noEol);
});

test('Clash list：只改一行，其他行不变，且保留第 4 列', () => {
  const parsed = parse('clash-list', CLASH);
  const target = parsed.items.find(i => i.rule === '1.1.1.0/24');
  target.action = 'Proxy';
  const out = serialize(parsed).split('\n');
  assert.equal(out[2], 'IP-CIDR,1.1.1.0/24,Proxy,no-resolve');
  assert.equal(out[3], 'DOMAIN,"a,b.com",Proxy');
  assert.equal(out[4], '  DOMAIN-KEYWORD , ads , REJECT  ');
});

test('Clash list：停用/启用规则用注释切换', () => {
  const parsed = parse('clash-list', 'DOMAIN,a.com,Proxy\n// DOMAIN,b.com,DIRECT');
  parsed.items[0].enabled = false;
  parsed.items[1].enabled = true;
  assert.equal(serialize(parsed), '# DOMAIN,a.com,Proxy\nDOMAIN,b.com,DIRECT');
});

const QX = [
  '# QX',
  'HOST-SUFFIX,a.com,Proxy',
  'IP-CIDR,1.1.1.0/24,Direct,no-resolve',
  'USER-AGENT,Telegram*,Proxy',
  '',
].join('\r\n');

test('QX list：往返一致；新增规则不会生成多余的尾部逗号', () => {
  assert.equal(roundTrip('qx-list', QX), QX);
  const parsed = parse('qx-list', 'HOST,a.com,Proxy');
  parsed.items.push({ kind: 'rule', enabled: true, type: 'HOST-SUFFIX', rule: 'b.com', action: '', opts: [], isBracketRule: false });
  assert.equal(serialize(parsed), 'HOST,a.com,Proxy\nHOST-SUFFIX,b.com');
});

const INI = [
  '; 文件头注释',
  'enable_rule_generator=true',
  '',
  '[custom]',
  'ruleset=🎯 全球直连,https://example.com/direct.list',
  'ruleset=🇨🇳 国内,[]GEOIP,CN',
  'ruleset=🐟 漏网之鱼,[]FINAL',
  'custom_proxy_group=🚀 节点选择`select`[]♻️ 自动选择`[]DIRECT`.*',
  'custom_proxy_group=♻️ 自动选择`url-test`.*`http://www.gstatic.com/generate_204`300,,50',
  'unknown line without equals',
  '',
  '[common]',
  'exclude_remarks=(到期|剩余)',
  '',
].join('\n');

test('Clash ini：往返一致（含文件头、未知行、空段位参数）', () => {
  assert.equal(roundTrip('clash-ini', INI), INI);
});

test('Clash ini：文件开头内容归入 section=null，不会丢失', () => {
  const parsed = parse('clash-ini', INI);
  assert.equal(parsed.sections[0].section, null);
  assert.equal(parsed.sections[1].section, 'custom');
});

test('Clash ini：修改 ruleset 后仅该行变化', () => {
  const parsed = parse('clash-ini', INI);
  const rs = parsed.sections[1].entries.find(e => e.kind === 'ruleset');
  rs.url = 'https://example.com/new.list';
  const lines = serialize(parsed).split('\n');
  assert.equal(lines[4], 'ruleset=🎯 全球直连,https://example.com/new.list');
  assert.equal(lines.length, INI.split('\n').length);
});

test('proxy group：解析/序列化保留中间空位', () => {
  const expr = '♻️ 自动选择`url-test`.*`http://x/204`300,,50';
  const pg = parseProxyGroup(expr);
  assert.deepEqual([pg.interval, pg.failure, pg.success], ['300', '', '50']);
  assert.equal(serializeProxyGroup(pg), expr);
});

test('detectFormat：按目录与内容识别', () => {
  assert.equal(detectFormat('clash/rules.list', ''), 'clash-list');
  assert.equal(detectFormat('clash/main.ini', ''), 'clash-ini');
  assert.equal(detectFormat('quantumultx/a.list', ''), 'qx-list');
  assert.equal(detectFormat('clashx/a.list', ''), null);
  assert.equal(detectFormat('notes.txt', 'hello'), null);
  assert.equal(detectFormat('my-rules/x.list', 'DOMAIN,a.com,Proxy'), 'clash-list');
});

test('未知格式抛出错误', () => {
  assert.throws(() => parse('nope', ''));
});
