/** 备份：整库 zip 导出；zip 导入（预览差异后原子提交）。 */
import { downloadBlob, request } from '../api.js';
import { gitBlobSha } from '../gitsha.js';
import { planImport, readZip } from '../zip.js';
import { state } from '../state.js';
import { b64FromBytes, isValidPath, makeEl, toast } from '../util.js';
import { refreshFiles } from './files.js';
import { askConfirm, closeModal, openModal } from './modal.js';

const MAX_FILE = 1024 * 1024;
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function doExport(btn) {
  btn.disabled = true;
  try {
    const { blob, name } = await downloadBlob('/api/export');
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast('已开始下载');
  } catch (e) { toast('导出失败：' + e.message); }
  btn.disabled = false;
}

/** 把 zip 条目整理成可提交的变更，并与当前仓库比对。 */
async function analyze(files, opts) {
  const plan = planImport(files, opts);
  const known = new Map(state.files.map(f => [f.path, f.sha]));
  const rows = [];
  for (const it of plan.items) {
    const row = { path: it.path, size: it.bytes.length, bytes: it.bytes, status: '', skip: '' };
    if (!isValidPath(it.path)) row.skip = '路径不合法或属于 Actions 工作流';
    else if (it.bytes.length > MAX_FILE) row.skip = '超过 1 MiB';
    else {
      row.sha = await gitBlobSha(it.bytes);
      row.status = !known.has(it.path) ? '新增' : known.get(it.path) === row.sha ? '未变化' : '覆盖';
      try { row.text = strict.decode(it.bytes); } catch { row.binary = true; }
    }
    rows.push(row);
  }
  return { rows, ignored: plan.ignored, stripped: plan.stripped };
}

async function commitRows(rows, message) {
  const batches = [];
  let cur = [], bytes = 0, bins = 0;
  for (const r of rows) {
    const full = r.bytes.length;
    if (cur.length >= 50 || bytes + full > 2.5 * 1024 * 1024 || (r.binary && bins >= 20)) { batches.push(cur); cur = []; bytes = 0; bins = 0; }
    cur.push(r); bytes += full; if (r.binary) bins++;
  }
  if (cur.length) batches.push(cur);
  for (const b of batches) {
    await request('/api/commit', 'POST', {
      message: batches.length > 1 ? `${message} (${batches.indexOf(b) + 1}/${batches.length})` : message,
      changes: b.map(r => (r.binary ? { path: r.path, base64: b64FromBytes(r.bytes) } : { path: r.path, content: r.text })),
    });
  }
  return batches.length;
}

export function showBackup() {
  const body = makeEl('div');

  const exportBtn = makeEl('button', 'btn secondary', '⇣ 导出当前分支为 zip');
  exportBtn.addEventListener('click', () => doExport(exportBtn));
  body.append(makeEl('h4', '', '导出备份'),
    makeEl('p', 'muted small-text', `导出 ${state.info.owner}/${state.info.repo} 的 ${state.info.branch} 分支（整个仓库，不受管理目录限制）。`), exportBtn);

  if (!state.readonly) {
    const file = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip,application/zip' });
    const strip = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true });
    const stripLab = makeEl('label', 'chk'); stripLab.append(strip, '去掉 zip 的顶层目录（GitHub 导出的包需要勾选）');
    const prefix = Object.assign(makeEl('input', 'dialog-field'), { type: 'text', placeholder: '导入到目录（相对于管理目录，留空=根目录）' });
    const analyzeBtn = makeEl('button', 'btn', '分析 zip');
    const out = makeEl('div');
    let zipFiles = null;

    async function refresh() {
      if (!zipFiles) return;
      out.replaceChildren(makeEl('p', 'muted', '分析中…'));
      const { rows, ignored, stripped } = await analyze(zipFiles, { stripTop: strip.checked, prefix: prefix.value });
      const ok = rows.filter(r => !r.skip);
      const todo = ok.filter(r => r.status !== '未变化');
      const count = s => ok.filter(r => r.status === s).length;
      const summary = makeEl('div', 'diff-stat', `共 ${rows.length} 个文件：新增 ${count('新增')}、覆盖 ${count('覆盖')}、未变化 ${count('未变化')}、跳过 ${rows.length - ok.length}` +
        (ignored ? `；已忽略 ${ignored} 个（.git、__MACOSX、.DS_Store）` : '') + (stripped ? `；已去掉顶层目录 ${stripped}/` : ''));
      const table = makeEl('table', 'tbl');
      const head = table.createTHead().insertRow();
      for (const t of ['文件', '大小', '状态']) head.append(Object.assign(document.createElement('th'), { textContent: t }));
      const tb = table.createTBody();
      for (const r of rows.slice(0, 300)) {
        const tr = tb.insertRow();
        tr.insertCell().textContent = r.path;
        tr.insertCell().textContent = `${r.size} B${r.binary ? ' · 二进制' : ''}`;
        tr.insertCell().textContent = r.skip ? `跳过：${r.skip}` : r.status;
      }
      const wrap = makeEl('div'); wrap.style.cssText = 'max-height:32vh;overflow:auto;margin:8px 0';
      wrap.append(table);
      const go = makeEl('button', 'btn primary', `导入 ${todo.length} 个文件`);
      go.disabled = !todo.length;
      go.addEventListener('click', async () => {
        const sure = await askConfirm({
          title: '确认导入', okText: '导入并提交', danger: true,
          message: `将向 GitHub 提交 ${todo.length} 个文件（新增 ${count('新增')}、覆盖 ${count('覆盖')}）。每批最多 50 个文件为一次原子提交，可在 Git 历史中回退。`,
        });
        if (!sure) return;
        go.disabled = true;
        try {
          const n = await commitRows(todo, `Import ${todo.length} file(s) from zip`);
          await refreshFiles();
          closeModal();
          toast(`导入完成：${todo.length} 个文件，${n} 次提交`);
        } catch (e) { toast('导入失败：' + e.message); go.disabled = false; }
      });
      out.replaceChildren(summary, wrap, go);
    }

    analyzeBtn.addEventListener('click', async () => {
      const f = file.files[0];
      if (!f) return toast('请先选择 zip 文件');
      try { zipFiles = await readZip(await f.arrayBuffer()); await refresh(); }
      catch (e) { toast('读取失败：' + e.message); }
    });
    strip.addEventListener('change', refresh);
    prefix.addEventListener('change', refresh);

    body.append(makeEl('hr'), makeEl('h4', '', '导入 zip'),
      makeEl('p', 'muted small-text', '选择 zip → 预览新增/覆盖/未变化 → 确认后原子提交。内容完全相同的文件会自动跳过。'),
      file, makeEl('div', 'spacer'), stripLab, makeEl('div', 'spacer'), prefix, makeEl('div', 'spacer'), analyzeBtn, out);
  }
  openModal('导出 / 导入', body, { wide: true });
}
