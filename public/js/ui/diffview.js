/** 差异视图。 */
import { collapse, diffLines, diffStats } from '../diff.js';
import { makeEl } from '../util.js';
import { openModal } from './modal.js';

export function buildDiffView(oldText, newText) {
  const ops = diffLines(oldText, newText);
  const { add, del, changed } = diffStats(ops);
  const box = makeEl('div');

  const stat = makeEl('div', 'diff-stat');
  if (!changed) { stat.textContent = '两个版本内容完全一致。'; box.append(stat); return box; }
  stat.append(makeEl('span', 'add', `+${add}`), ' ', makeEl('span', 'del', `−${del}`), ` 行变化（左侧为旧版本，右侧为新版本的行号）`);
  box.append(stat);

  const view = makeEl('div', 'diff');
  for (const row of collapse(ops, 3)) {
    if (row.type === 'gap') { view.append(makeEl('div', 'diff-gap', `⋯ 省略 ${row.count} 行未变化内容`)); continue; }
    const line = makeEl('div', 'diff-line ' + row.type);
    line.append(
      makeEl('span', 'no', row.a ?? ''),
      makeEl('span', 'no', row.b ?? ''),
      makeEl('span', 'sign', row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''),
      makeEl('span', 'txt', row.text),
    );
    view.append(line);
  }
  box.append(view);
  return box;
}

export function showDiff(title, oldText, newText) {
  openModal(title, buildDiffView(oldText, newText));
}
