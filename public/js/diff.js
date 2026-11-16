/**
 * 行级 diff（无 DOM 依赖）。
 * 先剥掉公共首尾，再对中间部分做 LCS；中间部分过大时退化为"整体替换"，避免卡死页面。
 */

const MAX_CELLS = 4_000_000;

/** @returns {{type:'eq'|'add'|'del', text:string}[]} */
export function diffLines(a, b) {
  const A = a === '' ? [] : a.split('\n');
  const B = b === '' ? [] : b.split('\n');

  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length, endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }

  const ops = A.slice(0, start).map(text => ({ type: 'eq', text }));
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);

  if (midA.length * midB.length > MAX_CELLS) {
    ops.push(...midA.map(text => ({ type: 'del', text })), ...midB.map(text => ({ type: 'add', text })));
  } else {
    ops.push(...lcsDiff(midA, midB));
  }
  ops.push(...A.slice(endA).map(text => ({ type: 'eq', text })));
  return ops;
}

function lcsDiff(A, B) {
  const n = A.length, m = B.length;
  if (!n) return B.map(text => ({ type: 'add', text }));
  if (!m) return A.map(text => ({ type: 'del', text }));

  // dp[i][j] = A[i..] 与 B[j..] 的 LCS 长度
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ type: 'eq', text: A[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({ type: 'del', text: A[i++] });
    else ops.push({ type: 'add', text: B[j++] });
  }
  while (i < n) ops.push({ type: 'del', text: A[i++] });
  while (j < m) ops.push({ type: 'add', text: B[j++] });
  return ops;
}

export function diffStats(ops) {
  let add = 0, del = 0;
  for (const o of ops) { if (o.type === 'add') add++; else if (o.type === 'del') del++; }
  return { add, del, changed: add + del > 0 };
}

/**
 * 折叠无变化的长段落，只保留变化前后 context 行。
 * @returns {({type:'eq'|'add'|'del', text:string, a?:number, b?:number} | {type:'gap', count:number})[]}
 */
export function collapse(ops, context = 3) {
  const numbered = [];
  let a = 0, b = 0;
  for (const o of ops) {
    if (o.type === 'eq') numbered.push({ ...o, a: ++a, b: ++b });
    else if (o.type === 'del') numbered.push({ ...o, a: ++a });
    else numbered.push({ ...o, b: ++b });
  }
  const keep = new Array(numbered.length).fill(false);
  numbered.forEach((o, i) => {
    if (o.type === 'eq') return;
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let gap = 0;
  numbered.forEach((o, i) => {
    if (keep[i]) {
      if (gap) { out.push({ type: 'gap', count: gap }); gap = 0; }
      out.push(o);
    } else gap++;
  });
  if (gap) out.push({ type: 'gap', count: gap });
  return out;
}
