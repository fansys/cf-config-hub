import { CONVERT_TARGETS, convertRuleList, parse, suggestConvertedPath } from '@shared/formats/index.js';
import { convertData, convertedName, formatJson, LANG_LABELS, langOf } from '@shared/lint.js';
import { scanSecrets } from '@shared/secrets.js';
import { templatesFor } from '@shared/templates.js';
import { applyEol, b64FromBytes, bytesFromB64, detectEol, isValidPath, toLF } from '@shared/text.js';
import { fileUrl, request } from '@/lib/api';
import { askChoice, askConfirm, askInput, showAlert } from '@/lib/dialogs';
import { replacePath, routePath } from '@/router';
import { target } from '@/lib/storage';
import { toast } from '@/lib/toast';
import { useSession, type CachedFile } from '@/stores/session';

let openSeq = 0;

export function decodeBytes(bytes: Uint8Array) {
  if (bytes.includes(0)) return { binary: true, text: '' };
  try {
    return { binary: false, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { binary: true, text: '' };
  }
}

export function useFileActions() {
  const session = useSession();

  async function checkUnsaved() {
    if (!session.dirty) return true;
    return askConfirm({ title: '有未保存的修改', message: '当前文件有未保存的修改，确定放弃吗？', okText: '放弃修改', danger: true });
  }

  function pathConflict(path: string) {
    if (session.files.some(file => file.path.startsWith(path + '/'))) return `${path} 已是目录`;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (session.files.some(file => file.path === parent)) return `${parent} 已是文件，不能作为目录`;
    }
    return '';
  }

  function replaceHash(path: string | null) {
    replacePath(path);
  }

  async function fetchFileCached(path: string): Promise<CachedFile> {
    const meta = session.files.find(file => file.path === path);
    const cached = session.getCachedFile(path, meta?.sha);
    if (cached) return cached;
    let pending = session.inflight.get(path);
    if (!pending) {
      pending = request(fileUrl(path)).then(data => {
        const raw = bytesFromB64(data.content);
        const decoded = decodeBytes(raw);
        const entry: CachedFile = { sha: data.sha, size: data.size, bytes: raw, text: decoded.text, binary: decoded.binary };
        session.setCachedFile(path, entry);
        return entry;
      }).finally(() => {
        session.inflight.delete(path);
      });
      session.inflight.set(path, pending);
    }
    return pending;
  }

  function prefetchFile(path: string) {
    if (!session.authed || !path) return;
    const meta = session.files.find(file => file.path === path);
    if (!meta || meta.size > 256 * 1024) return;
    if (session.getCachedFile(path, meta.sha) || session.inflight.has(path)) return;
    void fetchFileCached(path).catch(() => { /* 静默忽略预取失败 */ });
  }

  function applyLoadedFile(path: string, entry: CachedFile) {
    session.current = { path, sha: entry.sha, size: entry.size };
    session.loadingPath = null;
    session.bytes = entry.bytes;
    session.original = toLF(entry.text);
    session.eol = detectEol(entry.text);
    session.binary = entry.binary;
    session.dirty = false;
    session.hlLang = '';
    session.editorText = entry.text;
    if (entry.binary) {
      session.fmt = null;
      session.parsed = null;
      session.mode = 'highlight';
    } else session.pickMode(path, entry.text);
    session.recordRecent(path);
    session.markDirty();
    replaceHash(path);
  }

  async function openFile(path: string) {
    if (session.current?.path === path && !session.loadingPath) return;
    if (!(await checkUnsaved())) {
      if (session.current) replaceHash(session.current.path);
      return;
    }
    const meta = session.files.find(file => file.path === path);
    const cached = session.getCachedFile(path, meta?.sha);
    if (cached) {
      ++openSeq;
      applyLoadedFile(path, cached);
      return;
    }
    const seq = ++openSeq;
    const prev = session.current;
    session.loadingPath = path;
    session.current = { path, sha: meta?.sha || null, size: meta?.size || 0 };
    replaceHash(path);
    try {
      const entry = await fetchFileCached(path);
      if (seq !== openSeq) return;
      applyLoadedFile(path, entry);
    } catch (error) {
      if (seq !== openSeq) return;
      session.loadingPath = null;
      session.current = prev;
      replaceHash(prev?.path || null);
      toast('打开失败：' + (error as Error).message);
    }
  }

  async function openFromHash() {
    const path = routePath();
    if (!session.authed || !path || session.current?.path === path) return;
    if (session.files.some(file => file.path === path)) await openFile(path);
  }

  function startNewFile(path: string, text = '') {
    session.current = { path, sha: null, size: 0 };
    session.binary = false;
    session.bytes = new Uint8Array();
    session.original = '';
    session.eol = '\n';
    session.editorText = text;
    session.hlLang = '';
    if (text) session.pickMode(path, text);
    else {
      session.fmt = null;
      session.parsed = null;
      session.mode = 'highlight';
    }
    session.dirty = true;
    session.markDirty();
    replaceHash(path);
  }

  async function askNewPath(title: string, message: string, fallback: string) {
    const input = await askInput({ title, message, defaultValue: fallback });
    if (input === null) return null;
    const path = input.trim();
    if (!isValidPath(path)) {
      toast('路径无效：禁止空路径、../ 或反斜杠');
      return null;
    }
    if (session.files.some(file => file.path === path)) {
      await openFile(path);
      return null;
    }
    const conflict = pathConflict(path);
    if (conflict) {
      toast('路径冲突：' + conflict);
      return null;
    }
    return path;
  }

  async function newFile(dir = '') {
    if (!(await checkUnsaved())) return;
    const path = await askNewPath('新建文件', '输入新文件路径（相对于仓库管理目录）：', dir ? `${dir}/` : 'example.yaml');
    if (!path) return;
    let content = '';
    const templates = templatesFor(path);
    if (templates.length) {
      const id = await askChoice({
        title: '选择模板',
        message: `为 ${path} 选择一个起始模板：`,
        okText: '创建',
        options: [{ id: '', name: '空白文件' }, ...templates.map((item: any) => ({ id: item.id, name: item.name, desc: item.desc }))],
        selected: templates[0].id,
      });
      if (id === null) return;
      content = templates.find((item: any) => item.id === id)?.content || '';
    }
    startNewFile(path, content);
  }

  async function renamePath(from: string, kind: 'file' | 'dir') {
    if (!(await checkUnsaved())) return;
    const label = kind === 'dir' ? '目录' : '文件';
    const input = await askInput({
      title: `重命名 / 移动${label}`,
      message: `输入新的${label}路径（相对于仓库管理目录，可包含 / 以移动位置）：`,
      defaultValue: from,
    });
    if (input === null) return;
    const to = input.trim().replace(/\/+$/, '');
    if (to === from) return;
    if (!isValidPath(to)) return toast('路径无效：禁止空路径、../ 或反斜杠');
    try {
      const wasOpen = session.current?.path;
      await request('/api/rename', 'POST', { from, to, kind, message: `Rename ${session.fileFullPath(from)} → ${session.fileFullPath(to)}` });
      session.clearFileCache();
      session.dirty = false;
      let next: string | null = null;
      if (wasOpen === from) next = to;
      else if (kind === 'dir' && wasOpen?.startsWith(from + '/')) next = to + wasOpen.slice(from.length);
      if (next) session.current = null;
      await session.refreshFiles();
      if (next) await openFile(next);
      toast('重命名成功，已提交到 GitHub');
    } catch (error) {
      toast('重命名失败：' + (error as Error).message);
    }
  }

  async function duplicateCurrent() {
    if (!session.current || session.binary || !(await checkUnsaved())) return;
    const text = session.getEditorText();
    const dot = session.current.path.lastIndexOf('.');
    const fallback = dot > session.current.path.lastIndexOf('/')
      ? `${session.current.path.slice(0, dot)}-copy${session.current.path.slice(dot)}`
      : session.current.path + '-copy';
    const path = await askNewPath('复制文件', '复制为（新文件路径）：', fallback);
    if (!path) return;
    startNewFile(path, text);
    toast('已创建副本，保存后才会提交');
  }

  async function saveFile() {
    if (!session.current || session.binary || session.readonly) return;
    const raw = session.textBytes();
    if (raw.length > session.info.maxWriteBytes) return toast('文件不能超过 768 KiB');
    const text = new TextDecoder().decode(raw);
    const before = new Set(scanSecrets(session.original).map((item: any) => `${item.rule}|${item.preview}`));
    const found = scanSecrets(text).filter((item: any) => !before.has(`${item.rule}|${item.preview}`));
    if (found.length) {
      const publicRepo = session.info.private !== true;
      const ok = await askConfirm({
        title: publicRepo ? '检测到疑似密钥（公开仓库）' : '检测到疑似密钥',
        message: publicRepo
          ? '这个仓库不是私有的：一旦提交，密钥会出现在公开的 Git 历史里，即使之后删除也可能已被抓取。建议改用占位符，并立即轮换已泄露的密钥。'
          : '本次修改新增了疑似密钥的内容，请确认这是你有意提交的。',
        details: found.slice(0, 10).map((item: any) => `第 ${item.line} 行 · ${item.name} · ${item.preview}`),
        okText: '仍然保存',
        cancelText: '返回修改',
        danger: publicRepo,
      });
      if (!ok) return;
    }
    const { path, sha } = session.current;
    try {
      const out = await request(fileUrl(path), 'PUT', {
        content: b64FromBytes(raw),
        sha: sha || undefined,
        message: `${sha ? 'Update' : 'Create'} ${session.fileFullPath(path)}`,
      });
      session.current = { ...session.current, sha: out.sha, size: raw.length };
      session.bytes = raw;
      session.original = toLF(session.getEditorText());
      session.dirty = false;
      if (out.sha) session.setCachedFile(path, { sha: out.sha, size: raw.length, bytes: raw, text: applyEol(session.getEditorText(), session.eol), binary: false });
      if (out.commitSha) session.commitSha = out.commitSha;
      session.recordRecent(path);
      session.markDirty();
      await session.refreshFiles();
      toast('保存成功，已提交到 GitHub');
    } catch (error: any) {
      toast('保存失败：' + error.message);
      if (sha && (error.status === 409 || error.status === 422) && await askConfirm({
        title: '远端文件已变化',
        message: '无法保存：远端文件已被修改。是否放弃本地修改并重新加载远端版本？选择「保留当前内容」可先复制备份，再手动重新加载。',
        okText: '放弃本地并重新加载',
        cancelText: '保留当前内容',
        danger: true,
      })) {
        session.deleteCachedFile(path);
        await session.refreshFiles();
        session.current = null;
        session.dirty = false;
        await openFile(path);
      }
    }
  }

  async function deleteFile() {
    if (!session.current?.sha) return;
    const { path, sha } = session.current;
    if (!await askConfirm({ title: '删除文件', message: `确认删除 ${path}？该操作会向 GitHub 提交一次删除记录。`, okText: '删除', danger: true })) return;
    try {
      await request(fileUrl(path), 'DELETE', { sha, message: `Delete ${session.fileFullPath(path)}` });
      session.deleteCachedFile(path);
      session.removeRecent(path);
      session.clearEditor();
      await session.refreshFiles();
      toast('已从 GitHub 删除文件');
    } catch (error) {
      toast('删除失败：' + (error as Error).message);
    }
  }

  async function deleteFolder(dir: string) {
    const count = session.files.filter(file => file.path.startsWith(dir + '/')).length;
    if (!count) return toast('目录为空或不存在');
    const affectsCurrent = session.current?.path.startsWith(dir + '/');
    if (affectsCurrent && !(await checkUnsaved())) return;
    if (!await askConfirm({ title: '删除目录', message: `确认删除目录 ${dir}？其中 ${count} 个文件会在一次提交中被删除。`, okText: '删除', danger: true })) return;
    try {
      await request('/api/dir', 'DELETE', { path: dir, message: `Delete ${session.fileFullPath(dir)}/` });
      session.clearFileCache();
      if (affectsCurrent) session.clearEditor();
      await session.refreshFiles();
      toast(`已删除目录（${count} 个文件）`);
    } catch (error) {
      toast('删除目录失败：' + (error as Error).message);
    }
  }

  async function uploadFiles(fileList: File[]) {
    const files = [...fileList];
    if (!files.length || !(await checkUnsaved())) return;
    const max = session.info.maxWriteBytes;
    const tooBig = files.filter(file => file.size > max);
    const ok = files.filter(file => file.size <= max);
    if (tooBig.length) toast(`已跳过 ${tooBig.length} 个超过 768 KiB 的文件：${tooBig.map(file => file.name).join('、')}`);
    if (!ok.length) return;
    const curDir = session.current ? session.current.path.replace(/[^/]+$/, '') : '';
    let targets: string[] = [];
    if (ok.length === 1) {
      const input = await askInput({ title: '上传文件', message: '输入仓库上传路径（相对于管理目录）：', defaultValue: curDir + ok[0].name, okText: '上传' });
      if (input === null) return;
      targets = [input.trim()];
    } else {
      const input = await askInput({
        title: `上传 ${ok.length} 个文件`,
        message: '输入目标目录（相对于管理目录，留空=根目录）：',
        defaultValue: curDir.replace(/\/$/, ''),
        okText: '上传',
      });
      if (input === null) return;
      const dir = input.trim().replace(/^\/+|\/+$/g, '');
      targets = ok.map(file => (dir ? `${dir}/${file.name}` : file.name));
    }
    const bad = targets.find(path => !isValidPath(path));
    if (bad !== undefined) return toast(`上传路径无效：${bad || '(空)'}`);
    if (new Set(targets).size !== targets.length) return toast('存在重名文件，请调整后重试');
    const conflict = targets.map(pathConflict).find(Boolean);
    if (conflict) return toast('路径冲突：' + conflict);
    const existing = targets.filter(path => session.files.some(file => file.path === path));
    if (existing.length && !await askConfirm({
      title: '覆盖已有文件',
      message: `以下 ${existing.length} 个文件已存在，将被覆盖：`,
      details: existing.length > 8 ? [...existing.slice(0, 8), `…另有 ${existing.length - 8} 个`] : existing,
      okText: '覆盖并上传',
      danger: true,
    })) return;
    let done = 0;
    const failed: string[] = [];
    for (const [index, file] of ok.entries()) {
      const path = targets[index];
      if (ok.length > 1) toast(`上传中 ${index + 1}/${ok.length}：${path}`);
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        const put = (sha?: string) => request(fileUrl(path), 'PUT', {
          sha: sha || undefined,
          content: b64FromBytes(raw),
          message: `Upload ${session.fileFullPath(path)}`,
        });
        const sha = session.files.find(item => item.path === path)?.sha;
        try { await put(sha); }
        catch (error: any) {
          if (error.status !== 409 && error.status !== 422) throw error;
          await session.refreshFiles();
          await put(session.files.find(item => item.path === path)?.sha);
        }
        done++;
      } catch (error) {
        failed.push(`${path}（${(error as Error).message}）`);
      }
    }
    await session.refreshFiles();
    if (done === 1 && ok.length === 1) {
      session.current = null;
      session.dirty = false;
      await openFile(targets[0]);
    }
    if (failed.length) await showAlert('上传完成（部分失败）', `成功 ${done} 个，失败 ${failed.length} 个：`, failed);
    else toast(`上传成功：${done} 个文件`);
  }

  function downloadCurrent() {
    if (!session.current) return;
    const raw = session.binary && session.bytes ? session.bytes : session.textBytes();
    const url = URL.createObjectURL(new Blob([raw as unknown as BlobPart], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = session.current.path.split('/').at(-1) || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function replaceContent(text: string) {
    session.editorText = text;
    if (session.fmt) {
      try { session.parsed = parse(session.fmt, text); }
      catch {
        session.fmt = null;
        session.parsed = null;
        session.mode = 'highlight';
      }
    }
    session.markDirty();
  }

  async function setMode(next: 'highlight' | 'visual' | 'preview') {
    if (next === session.mode) return;
    if (session.mode === 'visual' && session.parsed) session.editorText = session.getEditorText();
    else if (next === 'visual' && session.fmt) {
      try { session.parsed = parse(session.fmt, session.editorText); }
      catch (error) { return toast('可视化解析失败：' + (error as Error).message); }
    }
    session.mode = next;
    session.markDirty();
  }

  async function convertCurrent(to: string) {
    if (!session.current || !CONVERT_TARGETS[session.fmt as string] || !CONVERT_TARGETS[to] || session.fmt === to) return;
    const label = CONVERT_TARGETS[to].label;
    const result = convertRuleList(parse(session.fmt, session.getEditorText()), to);
    if (!(await checkUnsaved())) return;
    const path = await askNewPath(`转换为 ${label} 规则`, `转换为 ${label} 规则，保存到：`, suggestConvertedPath(session.current.path, session.fmt, to));
    if (!path) return;
    startNewFile(path, result.text);
    const notes = [];
    if (result.skipped.length) notes.push(`${result.skipped.length} 条不支持，已保留为注释（${[...new Set(result.skipped)].slice(0, 5).join('、')}）`);
    if (result.customPolicies.length) notes.push(`自定义策略组（${result.customPolicies.slice(0, 3).join('、')}${result.customPolicies.length > 3 ? ' 等' : ''}）原样保留，请确认目标客户端里存在同名策略`);
    toast(`已转换 ${result.converted} 条${notes.length ? '；' + notes.join('；') : ''}。保存后才会提交`);
  }

  async function convertDataFile() {
    const from = langOf(session.current?.path || '');
    if (!from || !(await checkUnsaved())) return;
    const to = await askChoice({
      title: '转换格式',
      message: `把 ${LANG_LABELS[from]} 转换为：（会生成新文件，原文件不变；注释无法保留）`,
      options: ['json', 'yaml', 'toml'].filter(lang => lang !== from).map(lang => ({ id: lang, name: LANG_LABELS[lang] })),
      okText: '下一步',
    });
    if (!to || !session.current) return;
    try {
      const text = await convertData(from, to, session.getEditorText());
      const path = await askNewPath('转换为 ' + LANG_LABELS[to], '保存到：', convertedName(session.current.path, to));
      if (!path) return;
      startNewFile(path, text);
      toast('已转换，原文件中的注释不会保留。保存后才会提交');
    } catch (error) {
      toast('转换失败：' + (error as Error).message);
    }
  }

  async function reformat(minify: boolean) {
    try { await replaceContent(formatJson(session.getEditorText(), minify)); }
    catch (error) { toast('无法处理：' + (error as Error).message); }
  }

  async function applyBranch(branch: string) {
    const previous = target.get().branch || '';
    target.set(branch);
    try {
      session.clearFileCache();
      session.clearEditor();
      await Promise.all([session.loadContext(), session.refreshFiles()]);
      return true;
    } catch (error) {
      target.set(previous);
      try { await Promise.all([session.loadContext(), session.refreshFiles()]); } catch { /* 保持当前 */ }
      toast('切换失败：' + (error as Error).message);
      return false;
    }
  }

  return {
    checkUnsaved, openFile, prefetchFile, openFromHash, newFile, renamePath, duplicateCurrent, saveFile, deleteFile,
    deleteFolder, uploadFiles, downloadCurrent, replaceContent, setMode, convertCurrent, convertDataFile,
    reformat, applyBranch,
  };
}
