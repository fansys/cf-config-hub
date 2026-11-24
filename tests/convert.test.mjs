/** Clash / QuantumultX / Shadowrocket / Loon 四方规则互转。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertRuleList, detectFormat, parse, serialize, suggestConvertedPath } from '../shared/formats/index.js';
import { TEMPLATES, templatesFor } from '../shared/templates.js';

const conv = (fmt, src, to) => convertRuleList(parse(fmt, src), to);

test('Clash → QX：类型、策略映射，保留 no-resolve、注释与空行；MATCH → FINAL', () => {
  const src = '# 标题\nDOMAIN-SUFFIX,google.com,Proxy\nDOMAIN,b.com,DIRECT\nIP-CIDR,1.1.1.0/24,REJECT,no-resolve\nMATCH,Proxy\n\n';
  const { text, converted, skipped } = conv('clash-list', src, 'qx-list');
  assert.equal(text, '# 标题\nHOST-SUFFIX,google.com,Proxy\nHOST,b.com,Direct\nIP-CIDR,1.1.1.0/24,Reject,no-resolve\nFINAL,Proxy\n\n');
  assert.equal(converted, 4);
  assert.deepEqual(skipped, []);
});

test('Clash → Shadowrocket：策略大写为 PROXY/DIRECT/REJECT，MATCH → FINAL', () => {
  const { text } = conv('clash-list', 'DOMAIN-SUFFIX,a.com,Proxy\nDOMAIN-KEYWORD,ads,REJECT\nIP-CIDR6,2001:db8::/32,DIRECT,no-resolve\nSRC-IP-CIDR,10.0.0.0/8,DIRECT\nMATCH,Proxy', 'shadowrocket-list');
  assert.equal(text, 'DOMAIN-SUFFIX,a.com,PROXY\nDOMAIN-KEYWORD,ads,REJECT\nIP-CIDR6,2001:db8::/32,DIRECT,no-resolve\nSRC-IP,10.0.0.0/8,DIRECT\nFINAL,PROXY');
});

test('Clash / QX / Shadowrocket ↔ Loon：端口 DST-PORT ↔ DEST-PORT、策略映射及不支持项保留', () => {
  const clashToLoon = conv('clash-list', 'DOMAIN-SUFFIX,a.com,Proxy\nDST-PORT,443,DIRECT\nIN-PORT,7890,DIRECT\nSRC-IP-CIDR,10.0.0.0/8,DIRECT\nMATCH,Proxy', 'loon-list');
  assert.equal(clashToLoon.text, 'DOMAIN-SUFFIX,a.com,PROXY\nDEST-PORT,443,DIRECT\nIN-PORT,7890,DIRECT\n# [未转换] SRC-IP-CIDR,10.0.0.0/8,DIRECT\nFINAL,PROXY');
  assert.deepEqual(clashToLoon.skipped, ['SRC-IP-CIDR']);

  const loonToClash = conv('loon-list', 'DOMAIN,a.com,REJECT-IMG\nDEST-PORT,80,DIRECT\nDST-PORT,443,PROXY\nUSER-AGENT,Telegram*,PROXY\nPROTOCOL,QUIC,REJECT\nFINAL,PROXY', 'clash-list');
  assert.equal(loonToClash.text, 'DOMAIN,a.com,REJECT\nDST-PORT,80,DIRECT\nDST-PORT,443,Proxy\n# [未转换] USER-AGENT,Telegram*,PROXY\n# [未转换] PROTOCOL,QUIC,REJECT\nMATCH,Proxy');
  assert.deepEqual(loonToClash.skipped, ['USER-AGENT', 'PROTOCOL']);

  const loonToQx = conv('loon-list', 'DOMAIN-SUFFIX,a.com,PROXY\nUSER-AGENT,Telegram*,PROXY\nURL-REGEX,^https?://ad,REJECT-IMG\nPROCESS-NAME,curl,DIRECT\nFINAL,DIRECT', 'qx-list');
  assert.equal(loonToQx.text, 'HOST-SUFFIX,a.com,Proxy\nUSER-AGENT,Telegram*,Proxy\nURL-REGEX,^https?://ad,Reject\n# [未转换] PROCESS-NAME,curl,DIRECT\nFINAL,Direct');
  assert.deepEqual(loonToQx.skipped, ['PROCESS-NAME']);

  const loonToSr = conv('loon-list', 'DOMAIN-KEYWORD,ads,REJECT-DROP\nDEST-PORT,443,PROXY\nSUBNET,SSID:MyWiFi,DIRECT\nFINAL,PROXY', 'shadowrocket-list');
  assert.equal(loonToSr.text, 'DOMAIN-KEYWORD,ads,REJECT-DROP\nDST-PORT,443,PROXY\n# [未转换] SUBNET,SSID:MyWiFi,DIRECT\nFINAL,PROXY');
  assert.deepEqual(loonToSr.skipped, ['SUBNET']);
});

test('Shadowrocket → Clash / QX / Loon', () => {
  const src = 'DOMAIN-SUFFIX,a.com,PROXY\nUSER-AGENT,Telegram*,PROXY\nDST-PORT,443,DIRECT\nREJECT-TEST\nFINAL,DIRECT';
  const clash = conv('shadowrocket-list', src, 'clash-list');
  assert.equal(clash.text, 'DOMAIN-SUFFIX,a.com,Proxy\n# [未转换] USER-AGENT,Telegram*,PROXY\nDST-PORT,443,DIRECT\nREJECT-TEST\nMATCH,DIRECT');
  assert.deepEqual(clash.skipped, ['USER-AGENT']);
  const qx = conv('shadowrocket-list', 'DOMAIN,x.com,REJECT-DICT\nUSER-AGENT,Telegram*,PROXY\nURL-REGEX,^https?://ad,REJECT\nPROCESS-NAME,curl,DIRECT\nFINAL,PROXY', 'qx-list');
  assert.equal(qx.text, 'HOST,x.com,Reject\nUSER-AGENT,Telegram*,Proxy\nURL-REGEX,^https?://ad,Reject\n# [未转换] PROCESS-NAME,curl,DIRECT\nFINAL,Proxy');
  assert.deepEqual(qx.skipped, ['PROCESS-NAME']);
  const loon = conv('shadowrocket-list', src, 'loon-list');
  assert.equal(loon.text, 'DOMAIN-SUFFIX,a.com,PROXY\nUSER-AGENT,Telegram*,PROXY\nDEST-PORT,443,DIRECT\nREJECT-TEST\nFINAL,DIRECT');
  assert.deepEqual(loon.skipped, []);
});

test('QX → Clash / Shadowrocket / Loon：HOST* 还原，Reject-I 当作 REJECT', () => {
  const src = 'HOST-KEYWORD,ads,Reject-I\nHOST,x.com,Direct\nHOST-REGEX,^a,Proxy\nUSER-AGENT,UA*,Proxy\nFINAL,Proxy';
  const clash = conv('qx-list', src, 'clash-list');
  assert.equal(clash.text, 'DOMAIN-KEYWORD,ads,REJECT\nDOMAIN,x.com,DIRECT\nDOMAIN-REGEX,^a,Proxy\n# [未转换] USER-AGENT,UA*,Proxy\nMATCH,Proxy');
  const sr = conv('qx-list', src, 'shadowrocket-list');
  assert.equal(sr.text, 'DOMAIN-KEYWORD,ads,REJECT\nDOMAIN,x.com,DIRECT\n# [未转换] HOST-REGEX,^a,Proxy\nUSER-AGENT,UA*,PROXY\nFINAL,PROXY');
  assert.deepEqual(sr.skipped, ['HOST-REGEX']);
  const loon = conv('qx-list', src, 'loon-list');
  assert.equal(loon.text, 'DOMAIN-KEYWORD,ads,REJECT\nDOMAIN,x.com,DIRECT\n# [未转换] HOST-REGEX,^a,Proxy\nUSER-AGENT,UA*,PROXY\nFINAL,PROXY');
  assert.deepEqual(loon.skipped, ['HOST-REGEX']);
});

test('自定义策略组原样保留并提示，不会被当作不支持而丢弃', () => {
  const r = conv('clash-list', 'DOMAIN-SUFFIX,a.com,🚀 节点选择\nMATCH,🐟 漏网之鱼', 'shadowrocket-list');
  assert.equal(r.text, 'DOMAIN-SUFFIX,a.com,🚀 节点选择\nFINAL,🐟 漏网之鱼');
  assert.deepEqual(r.customPolicies.sort(), ['🐟 漏网之鱼', '🚀 节点选择'].sort());
  assert.equal(r.converted, 2);
});

test('兼容 `FINAL,,PROXY` 这种带空列的写法；CRLF 保持；被禁用的规则保持禁用', () => {
  assert.equal(conv('clash-list', 'MATCH,,Proxy', 'shadowrocket-list').text, 'FINAL,PROXY');
  const r = conv('clash-list', '# DOMAIN,a.com,Proxy\r\nDOMAIN,b.com,Proxy\r\n', 'qx-list');
  assert.equal(r.text, '# HOST,a.com,Proxy\r\nHOST,b.com,Proxy\r\n');
});

test('四种格式两两互转再转回来，规则的类型与内容不变（支持的子集）', () => {
  const base = 'DOMAIN,a.com,Proxy\nDOMAIN-SUFFIX,b.com,DIRECT\nDOMAIN-KEYWORD,ads,REJECT\nIP-CIDR,1.1.1.0/24,DIRECT,no-resolve\nIP-CIDR6,2001:db8::/32,Proxy\nIP-ASN,13335,DIRECT\nGEOIP,CN,DIRECT\n# 注释\n';
  const fmts = ['clash-list', 'qx-list', 'shadowrocket-list', 'loon-list'];
  for (const a of fmts) for (const b of fmts) {
    if (a === b) continue;
    const there = conv('clash-list', base, a === 'clash-list' ? 'qx-list' : a); // 先得到 a 格式的文本
    const aText = a === 'clash-list' ? base : there.text;
    const out = conv(a, aText, b);
    const back = conv(b, out.text, a);
    assert.equal(back.text, aText, `${a} → ${b} → ${a}`);
    assert.deepEqual([out.skipped.length, back.skipped.length], [0, 0], `${a} → ${b}`);
  }
});

test('不支持的组合会报错', () => {
  assert.throws(() => conv('clash-list', 'MATCH,Proxy', 'clash-list'), /相同/);
  assert.throws(() => convertRuleList({ fmt: 'clash-ini', items: [] }, 'qx-list'), /不支持/);
});

test('建议路径：目录名固定为 Clash / QuantumultX / Shadowrocket / Loon（源目录不区分大小写）', () => {
  assert.equal(suggestConvertedPath('Clash/ads.list', 'clash-list', 'qx-list'), 'QuantumultX/ads.list');
  assert.equal(suggestConvertedPath('clash/ads.list', 'clash-list', 'shadowrocket-list'), 'Shadowrocket/ads.list');
  assert.equal(suggestConvertedPath('clash/ads.list', 'clash-list', 'loon-list'), 'Loon/ads.list');
  assert.equal(suggestConvertedPath('a/QuantumultX/x.list', 'qx-list', 'shadowrocket-list'), 'a/Shadowrocket/x.list');
  assert.equal(suggestConvertedPath('a/QuantumultX/x.list', 'qx-list', 'loon-list'), 'a/Loon/x.list');
  assert.equal(suggestConvertedPath('Shadowrocket/x.list', 'shadowrocket-list', 'clash-list'), 'Clash/x.list');
  assert.equal(suggestConvertedPath('shadowrocket/x.list', 'shadowrocket-list', 'qx-list'), 'QuantumultX/x.list');
  assert.equal(suggestConvertedPath('shadowrocket/x.list', 'shadowrocket-list', 'loon-list'), 'Loon/x.list');
  assert.equal(suggestConvertedPath('Loon/x.list', 'loon-list', 'clash-list'), 'Clash/x.list');
  assert.equal(suggestConvertedPath('loon/x.list', 'loon-list', 'qx-list'), 'QuantumultX/x.list');
  assert.equal(suggestConvertedPath('loon/x.list', 'loon-list', 'shadowrocket-list'), 'Shadowrocket/x.list');
  assert.equal(suggestConvertedPath('rules/x.list', 'clash-list', 'shadowrocket-list'), 'rules/Shadowrocket/x.list');
  assert.equal(suggestConvertedPath('rules/x.list', 'clash-list', 'loon-list'), 'rules/Loon/x.list');
});

test('Shadowrocket / Loon 目录识别、往返保真、新建模板优先', () => {
  for (const p of ['shadowrocket/a.list', 'Shadowrocket/b.conf', 'x/Shadowrocket/c.list']) assert.equal(detectFormat(p, ''), 'shadowrocket-list', p);
  for (const p of ['loon/a.list', 'Loon/b.conf', 'x/Loon/c.list']) assert.equal(detectFormat(p, ''), 'loon-list', p);
  assert.equal(detectFormat('sr/d.list', ''), null, '目录名固定为 Shadowrocket，不再识别 sr 等别名');
  assert.equal(detectFormat('clash/a.list', ''), 'clash-list');
  assert.equal(detectFormat('quantumultx/a.list', ''), 'qx-list');
  const text = 'DOMAIN-SUFFIX,a.com,PROXY\nIP-CIDR,1.1.1.0/24,DIRECT,no-resolve\nUSER-AGENT,"Telegram*, X",PROXY\n# 注释\nFINAL,PROXY\n';
  assert.equal(serialize(parse('shadowrocket-list', text)), text);
  assert.equal(serialize(parse('loon-list', text)), text);
  assert.equal(templatesFor('shadowrocket/new.list')[0].id, 'shadowrocket-list');
  assert.equal(templatesFor('loon/new.list')[0].id, 'loon-list');
  assert.equal(templatesFor('clash/new.list')[0].id, 'clash-list');
  assert.equal(templatesFor('quantumultx/new.list')[0].id, 'qx-list');
  const tpl = TEMPLATES.find(t => t.id === 'shadowrocket-list').content;
  assert.equal(serialize(parse('shadowrocket-list', tpl)), tpl);
  const loonTpl = TEMPLATES.find(t => t.id === 'loon-list').content;
  assert.equal(serialize(parse('loon-list', loonTpl)), loonTpl);
});
