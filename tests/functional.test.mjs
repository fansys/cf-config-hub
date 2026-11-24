/** 功能性细节：目录删除、换行符/BOM 保真、路径规则。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanPath } from '../src/lib/paths.js';
import { planDeleteDir } from '../src/routes/rename.js';
import { applyEol, detectEol, isValidPath, toLF } from '../shared/text.js';

const blob = path => ({ type: 'blob', mode: '100644', path, sha: 'x' + path.length });
const status = fn => { try { fn(); return 200; } catch (e) { return e.status; } };

test('删除目录：一次删除目录下全部文件，不波及同名前缀', () => {
  const tree = [blob('a/1.txt'), blob('a/b/2.txt'), blob('ab/3.txt'), blob('a.txt')];
  const { entries, deleted } = planDeleteDir(tree, 'a');
  assert.equal(deleted, 2);
  assert.deepEqual(entries.map(e => e.path).sort(), ['a/1.txt', 'a/b/2.txt']);
  assert.ok(entries.every(e => e.sha === null));
});

test('删除目录：不存在 404；含工作流 403', () => {
  assert.equal(status(() => planDeleteDir([blob('a/1')], 'zzz')), 404);
  assert.equal(status(() => planDeleteDir([blob('.github/workflows/ci.yml')], '.github')), 403);
  assert.equal(status(() => planDeleteDir([blob('.github/workflows/ci.yml')], '.github/workflows')), 403);
});

test('换行符：整体 CRLF 的文件保存时还原为 CRLF，混合或 LF 文件保持 LF', () => {
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol('a\r\nb\n'), '\n');
  const edited = 'a\nb\nc\n'; // 文本框总是返回 LF
  assert.equal(applyEol(edited, '\r\n'), 'a\r\nb\r\nc\r\n');
  assert.equal(applyEol(edited, '\n'), edited);
  assert.equal(toLF('a\r\nb'), 'a\nb');
});

test('UTF-8 BOM 在 ignoreBOM 解码后保留，可无损回写', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, 0x61]);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  assert.deepEqual([...new TextEncoder().encode(text)], [...bytes]);
});

test('路径规则：禁止 .git 段（前后端一致）', () => {
  assert.equal(status(() => cleanPath('x/.git/config')), 400);
  assert.equal(status(() => cleanPath('x/.GIT')), 400);
  assert.equal(cleanPath('x/.gitignore'), 'x/.gitignore');
  assert.equal(isValidPath('x/.git/config'), false);
  assert.equal(isValidPath('x/.gitignore'), true);
});
