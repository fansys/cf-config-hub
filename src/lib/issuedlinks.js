/** 已签发的令牌保存在 KV，按仓库、分支和文件回显。不写入 Git。 */
import { kvAvailable } from './accessstore.js';
import { effectiveVersion } from './linkversion.js';

const keyFor = (c, branch) => `issued:${c.owner}/${c.repo}/${c.root || ''}${branch ? `@${branch}` : ''}`;

async function readDoc(env, c, branch) {
  if (!kvAvailable(env)) return { files: {} };
  const raw = await env.CONFIG_KV.get(keyFor(c, branch));
  if (!raw) return { files: {} };
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return doc && typeof doc.files === 'object' && doc.files ? doc : { files: {} };
}

async function writeDoc(env, c, branch, doc) {
  await env.CONFIG_KV.put(keyFor(c, branch), JSON.stringify({ files: doc.files || {} }));
}

/** 记住刚签发的令牌。没有 KV 时跳过，不影响签发。 */
export async function rememberIssued(env, c, branch, items) {
  if (!kvAvailable(env) || !items?.length) return;
  const doc = await readDoc(env, c, branch);
  const files = { ...doc.files };
  const now = Date.now();
  for (const item of items) {
    files[item.path] = [{ token: item.token, version: item.version, expiresAt: item.expiresAt ?? null, createdAt: now }];
  }
  await writeDoc(env, c, branch, { files });
}

/** 仍有效的已保存令牌。prefix 为真时返回该目录下所有文件的令牌。版本不符或已过期的不返回。 */
export async function listIssued(env, c, branch, path, data, { prefix = false } = {}) {
  if (!kvAvailable(env)) return [];
  const doc = await readDoc(env, c, branch);
  const now = Date.now();
  const entries = prefix
    ? Object.entries(doc.files).filter(([file]) => file === path || file.startsWith(`${path}/`))
    : [[path, doc.files[path] || []]];
  const links = [];
  for (const [file, rows] of entries) {
    const current = effectiveVersion(data, file, branch);
    for (const row of rows || []) {
      if (row.version === current && (row.expiresAt == null || row.expiresAt > now)) links.push({ ...row, path: file });
    }
  }
  return links;
}

export async function clearIssued(env, c, branch, path) {
  if (!kvAvailable(env)) return;
  if (!path) {
    await env.CONFIG_KV.delete(keyFor(c, branch));
    return;
  }
  const doc = await readDoc(env, c, branch);
  if (!doc.files[path]) return;
  const files = { ...doc.files };
  delete files[path];
  await writeDoc(env, c, branch, { files });
}
