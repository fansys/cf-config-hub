/**
 * 文件链接版本表：保存在仓库里的 .cfhub-links.json（位于管理目录根部）。
 *
 *   { "global": 0, "files": { "clash/a.list": 3 }, "branches": { "dev": { "files": { "clash/a.list": 2 } } } }
 *
 * 文件当前的"链接版本" = global + (该文件版本 ?? 1)；默认分支的文件版本在 files，其它分支在 branches.<分支>.files。
 * 版本表始终读写**默认分支**上的这个文件（不会往其它分支里提交元数据）。
 * 撤销某个文件的链接 = 它的版本 + 1；撤销全部 = global + 1。
 * 版本表读取在同一 isolate 内缓存 LINK_VERSION_TTL 秒（默认 30），撤销最长这么久后全球生效。
 */
import { commitMessage, gh } from '../github.js';
import { enc, encPath, HttpError } from './http.js';

export const REGISTRY_NAME = '.cfhub-links.json';
const cache = new Map();

const registryPath = c => (c.root ? `${c.root}/${REGISTRY_NAME}` : REGISTRY_NAME);
const cacheKey = c => `${c.owner}/${c.repo}@${c.branch}/${c.root}`;
const ttlMs = env => Math.max(0, Math.min(300, Number(env.LINK_VERSION_TTL ?? 30) || 0)) * 1000;
const apiBase = c => `/repos/${enc(c.owner)}/${enc(c.repo)}`;

const cleanFiles = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => Number.isInteger(v) && v >= 1));

function normalize(data) {
  const branches = {};
  for (const [b, v] of Object.entries(data?.branches || {})) {
    const files = cleanFiles(v?.files);
    if (Object.keys(files).length) branches[b] = { files };
  }
  const out = { global: Number.isInteger(data?.global) && data.global >= 0 ? data.global : 0, files: cleanFiles(data?.files) };
  if (Object.keys(branches).length) out.branches = branches;
  return out;
}

/** @returns {Promise<{ data: {global:number, files:Record<string,number>}, sha: string|null }>} */
export async function readRegistry(env, c, { fresh = false } = {}) {
  const key = cacheKey(c);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttlMs(env)) return hit.value;

  let value;
  try {
    const file = await gh(env, `${apiBase(c)}/contents/${encPath(registryPath(c))}?ref=${enc(c.branch)}`);
    const text = new TextDecoder().decode(Uint8Array.from(atob((file.content || '').replace(/\s/g, '')), ch => ch.charCodeAt(0)));
    value = { data: normalize(JSON.parse(text || '{}')), sha: file.sha };
  } catch (e) {
    if (e.status !== 404) throw new HttpError(503, '无法读取链接版本表，请稍后重试');
    value = { data: normalize({}), sha: null };
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** branch 为空串表示默认分支。 */
export const effectiveVersion = (data, path, branch = '') =>
  data.global + ((branch ? data.branches?.[branch]?.files?.[path] : data.files[path]) ?? 1);

/** 撤销：{ path, branch? } 只撤销该文件的链接（branch 为空 = 默认分支）；{ all: true } 撤销全部。返回新的版本表。 */
export async function bumpVersions(env, c, change, user) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readRegistry(env, c, { fresh: true });
    const next = normalize(data);
    if (change.all) next.global += 1;
    else if (change.branch) {
      next.branches ||= {};
      const files = (next.branches[change.branch] ||= { files: {} }).files;
      files[change.path] = (files[change.path] ?? 1) + 1;
    } else next.files[change.path] = (next.files[change.path] ?? 1) + 1;
    try {
      await gh(env, `${apiBase(c)}/contents/${encPath(registryPath(c))}`, {
        method: 'PUT',
        body: {
          message: commitMessage({ message: change.all ? 'Revoke all share links' : `Revoke share links: ${change.branch ? change.branch + ':' : ''}${change.path}` }, '', user),
          content: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n'))),
          branch: c.branch,
          ...(sha ? { sha } : {}),
        },
      });
      cache.delete(cacheKey(c));
      return next;
    } catch (e) {
      if (attempt === 0 && (e.status === 409 || e.status === 422)) continue; // 并发修改：重读后重试一次
      throw e;
    }
  }
  throw new HttpError(409, '版本表被并发修改，请重试');
}

export const _clearVersionCache = () => cache.clear();
