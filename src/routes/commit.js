/**
 * POST /api/commit  { message?, changes:[{path, content? | base64?}], deletes:[path] }
 *
 * 多文件**原子**提交（一次 commit）：用于全库替换、zip 导入、模板批量创建等。
 * - 文本用 content（UTF-8 字符串）直接进树；二进制用 base64，先创建 blob。
 * - 内容与现有文件完全相同的条目会被跳过（不产生空改动）。
 */
import { MAX_COMMIT_BYTES, MAX_COMMIT_FILES } from '../config.js';
import { commitMessage, readJsonBody } from '../github.js';
import { gh } from '../github.js';
import { HttpError, json } from '../lib/http.js';
import { scopedPath } from '../lib/paths.js';
import { commitChanges, loadHead } from './rename.js';

const MAX_BLOBS = 20;
const MAX_SINGLE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Git blob 的 SHA-1：sha1("blob <len>\0" + bytes)。用于识别"内容没变"。 */
export async function gitBlobSha(bytes) {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header); all.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

const base64Bytes = b64 => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));

/** 纯函数：校验请求并规范化为 { ops }（路径已加 ROOT_DIR 前缀）。 */
export function normalizeCommitRequest(c, body, scope) {
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const deletes = Array.isArray(body.deletes) ? body.deletes : [];
  if (!changes.length && !deletes.length) throw new HttpError(400, '没有可提交的变更');
  if (changes.length + deletes.length > MAX_COMMIT_FILES) throw new HttpError(413, `单次最多提交 ${MAX_COMMIT_FILES} 个文件`);

  const ops = [];
  const seen = new Set();
  let total = 0;
  let blobs = 0;
  const add = op => {
    if (seen.has(op.path)) throw new HttpError(400, `重复的路径：${op.rel}`);
    seen.add(op.path);
    ops.push(op);
  };

  for (const ch of changes) {
    const rel = ch?.path;
    const path = scope(c, rel);
    const hasText = typeof ch.content === 'string';
    const hasBin = typeof ch.base64 === 'string';
    if (hasText === hasBin) throw new HttpError(400, `${rel}：content 与 base64 必须二选一`);
    if (hasText) {
      const bytes = encoder.encode(ch.content);
      if (bytes.length > MAX_SINGLE_BYTES) throw new HttpError(413, `${rel} 超过 1 MiB`);
      total += bytes.length;
      add({ kind: 'text', rel, path, bytes });
    } else {
      if (!BASE64_RE.test(ch.base64)) throw new HttpError(400, `${rel}：Base64 格式错误`);
      const size = Math.floor(ch.base64.length * 3 / 4);
      if (size > MAX_SINGLE_BYTES) throw new HttpError(413, `${rel} 超过 1 MiB`);
      if (++blobs > MAX_BLOBS) throw new HttpError(413, `单次最多 ${MAX_BLOBS} 个二进制文件`);
      total += size;
      add({ kind: 'binary', rel, path, base64: ch.base64 });
    }
  }
  for (const rel of deletes) add({ kind: 'delete', rel, path: scope(c, rel) });

  if (total > MAX_COMMIT_BYTES) throw new HttpError(413, '单次提交内容过大（上限 3 MiB）');
  const paths = ops.map(o => o.path);
  for (const p of paths) {
    if (paths.some(q => q !== p && p.startsWith(q + '/'))) throw new HttpError(400, `路径冲突：${p} 位于另一个文件之下`);
  }
  return ops;
}

/** 纯函数：对照现有树，检查冲突并生成树条目（跳过未变化的）。 */
export async function planCommit(tree, ops) {
  const byPath = new Map(tree.map(e => [e.path, e]));
  const deletedPaths = new Set(ops.filter(o => o.kind === 'delete').map(o => o.path));
  const entries = [];
  const stats = { changed: 0, skipped: 0, deleted: 0 };

  for (const op of ops) {
    const existing = byPath.get(op.path);
    if (op.kind === 'delete') {
      if (existing?.type === 'blob') { entries.push({ path: op.path, mode: existing.mode, type: 'blob', sha: null }); stats.deleted++; }
      else stats.skipped++;
      continue;
    }
    if (existing?.type === 'tree') throw new HttpError(409, `${op.rel} 已是目录`);
    const parts = op.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (byPath.get(parent)?.type === 'blob' && !deletedPaths.has(parent)) {
        throw new HttpError(409, `${parent} 已是文件，不能作为目录`);
      }
    }
    const bytes = op.kind === 'text' ? op.bytes : base64Bytes(op.base64);
    if (existing?.type === 'blob' && existing.sha === await gitBlobSha(bytes)) { stats.skipped++; continue; }
    entries.push({ op, existing, bytes });
    stats.changed++;
  }
  return { entries, stats };
}

export async function atomicCommit(env, c, req, base, user, scope) {
  const body = await readJsonBody(req, MAX_COMMIT_BYTES * 2);
  const ops = normalizeCommitRequest(c, body, scope);
  const head = await loadHead(env, c, base);
  const { entries, stats } = await planCommit(head.tree, ops);
  if (!entries.length) return json({ commitSha: null, ...stats });

  const treeEntries = [];
  for (const e of entries) {
    if (!e.op) { treeEntries.push(e); continue; } // 删除条目
    const mode = e.existing?.mode || '100644';
    if (e.op.kind === 'text') {
      treeEntries.push({ path: e.op.path, mode, type: 'blob', content: new TextDecoder().decode(e.op.bytes) });
    } else {
      const blob = await gh(env, `${base}/git/blobs`, { method: 'POST', body: { content: e.op.base64, encoding: 'base64' } });
      treeEntries.push({ path: e.op.path, mode, type: 'blob', sha: blob.sha });
    }
  }
  const fallback = `Update ${stats.changed} file(s)${stats.deleted ? `, delete ${stats.deleted}` : ''}`;
  const commitSha = await commitChanges(env, c, base, head, treeEntries, commitMessage(body, fallback, user));
  return json({ commitSha, ...stats });
}
