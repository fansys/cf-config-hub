/** /api/* 管理接口。 */
import { authenticate } from '../auth.js';
import { kvAvailable, loadRules, saveRules, setRule } from '../lib/accessstore.js';
import { getConfig, getRequestConfig, MAX_READ_BYTES, MAX_WRITE_BYTES } from '../config.js';
import { commitMessage, editedBy, gh, readJsonBody, SHA_RE, validateBase64 } from '../github.js';
import { err, enc, encPath, HttpError, json } from '../lib/http.js';
import { REGISTRY_NAME } from '../lib/linkversion.js';
import { scopedPath } from '../lib/paths.js';
import { atomicCommit } from './commit.js';
import { exportZip } from './export.js';
import { createLinks, inspectLink, linkVersions, revokeLinks } from './links.js';
import { createBranch, listBranches } from './repos.js';
import { deleteDir, renamePath } from './rename.js';

const PRIVATE_FLAG_TTL = 5 * 60 * 1000;
let privateFlag = { key: '', value: null, at: 0 };

/** 仓库是否私有：同一 isolate 内缓存 5 分钟，避免每次打开页面都消耗 GitHub 配额。 */
async function repoIsPrivate(env, c, base) {
  if (!env.GITHUB_TOKEN) return null;
  const key = `${c.owner}/${c.repo}`;
  if (privateFlag.key === key && Date.now() - privateFlag.at < PRIVATE_FLAG_TTL) return privateFlag.value;
  let value = null;
  try { value = !!(await gh(env, base)).private; } catch { /* 不知道就是不知道 */ }
  privateFlag = { key, value, at: Date.now() };
  return value;
}

async function buildInfo(env, c, base) {
  return {
    owner: c.owner,
    repo: c.repo,
    branch: c.branch,
    root: c.root,
    publicFiles: c.publicFiles,
    maxWriteBytes: MAX_WRITE_BYTES,
    private: await repoIsPrivate(env, c, base),
    // 仅暴露"是否已配置"，用于部署后自检；绝不返回密钥本身
    configured: { githubToken: !!env.GITHUB_TOKEN, adminToken: !!env.ADMIN_TOKEN },
  };
}

async function listFiles(env, c, base) {
  // 先解析分支头：对含 "/" 的分支名更稳，也保证列表与 commitSha 来自同一个快照
  const ref = await gh(env, `${base}/git/ref/heads/${encPath(c.branch)}`);
  const commitSha = ref.object?.sha;
  const data = await gh(env, `${base}/git/trees/${commitSha}?recursive=1`);
  if (data.truncated) {
    throw new HttpError(409, '仓库文件过多，GitHub 返回的目录树被截断。请缩小仓库规模或改用独立配置仓库。');
  }
  const prefix = c.root ? `${c.root}/` : '';
  const files = (data.tree || [])
    .filter(f => f.type === 'blob' && f.path.startsWith(prefix) && f.path.slice(prefix.length) !== REGISTRY_NAME)
    .map(f => ({ path: f.path.slice(prefix.length), size: f.size || 0, sha: f.sha }))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  return json({ files, commitSha });
}

async function readFile(env, c, apiFilePath, rel, ref) {
  const file = await gh(env, `${apiFilePath}?ref=${enc(ref || c.branch)}`);
  if (Array.isArray(file) || file.type !== 'file') throw new HttpError(400, '目标不是普通文件');
  if (file.size > MAX_READ_BYTES || file.encoding !== 'base64') {
    throw new HttpError(413, '只能在编辑器中读取 1 MiB 以下的普通文件');
  }
  return json({
    path: rel,
    content: (file.content || '').replace(/\s/g, ''),
    sha: file.sha,
    size: file.size,
  });
}

async function writeFile(env, c, req, apiFilePath, rel, path, user) {
  const body = await readJsonBody(req);
  validateBase64(body.content);
  if (body.sha != null && !SHA_RE.test(body.sha)) throw new HttpError(400, 'SHA 格式错误');
  const out = await gh(env, apiFilePath, {
    method: 'PUT',
    body: {
      message: commitMessage(body, `Update ${path}`, user),
      content: body.content,
      branch: c.branch,
      ...(body.sha ? { sha: body.sha } : {}),
    },
  });
  return json({ path: rel, sha: out.content?.sha, commitSha: out.commit?.sha });
}

async function deleteFile(env, c, req, apiFilePath, path, user) {
  const body = await readJsonBody(req);
  if (!SHA_RE.test(body.sha || '')) throw new HttpError(400, '删除文件需要当前 SHA');
  const out = await gh(env, apiFilePath, {
    method: 'DELETE',
    body: { message: commitMessage(body, `Delete ${path}`, user), sha: body.sha, branch: c.branch },
  });
  return json({ deleted: true, commitSha: out.commit?.sha });
}

/** 访问规则摘要：当前生效的规则、来源、KV 是否可用。 */
async function accessSummary(env, c, detail = false) {
  const r = await loadRules(env, c);
  return {
    rules: r.rules, source: r.source, kvAvailable: kvAvailable(env), updatedAt: r.updatedAt ?? null, updatedBy: r.updatedBy ?? null,
    ...(detail ? { envRules: String(env.DIRECT_PATHS || '') } : {}),
  };
}

const mapCommit = x => ({
  sha: x.sha,
  message: String(x.commit?.message || '').split('\n')[0].slice(0, 200),
  author: editedBy(x.commit?.message) || x.commit?.author?.name || x.author?.login || '',
  date: x.commit?.author?.date || '',
});

export async function handleApi(req, env, url) {
  const { pathname } = url;

  // 公开信息：无需口令，仅反映部署时的默认配置
  if (pathname === '/api/info' && req.method === 'GET') {
    const c = getConfig(env);
    return json(await buildInfo(env, c, `/repos/${enc(c.owner)}/${enc(c.repo)}`));
  }

  // 以下接口需要 GITHUB_TOKEN + 有效口令
  if (!env.GITHUB_TOKEN) return err('未配置 GITHUB_TOKEN Secret', 503);
  const user = await authenticate(req, env);
  if (!user) return err('管理口令错误或未登录', 401);
  if (req.method !== 'GET' && user.role !== 'rw') return err('当前口令为只读，不能修改内容', 403);

  const c = getRequestConfig(env, req);
  const base = `/repos/${enc(c.owner)}/${enc(c.repo)}`;

  switch (pathname) {
    case '/api/context': {
      const info = await buildInfo(env, c, base);
      return json({ ...info, me: user, defaults: c.defaults, isDefault: c.isDefault, access: await accessSummary(env, c) });
    }
    case '/api/access':
      if (req.method === 'GET') return json(await accessSummary(env, c, true));
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        await saveRules(env, c, body.rules, user);
        return json(await accessSummary(env, c, true));
      }
      break;
    case '/api/access/set': {
      if (req.method !== 'POST') break;
      const body = await readJsonBody(req);
      if (body.mode != null && !['direct', 'token', 'deny'].includes(body.mode)) throw new HttpError(400, 'mode 应为 direct / token / deny，或 null（恢复继承）');
      if (typeof body.pattern === 'string' && body.pattern.length > 0) scopedPath(c, body.pattern.replace(/\/+$/, '').replace(/\*+$/, 'x') || 'x'); // 复用路径合法性校验
      await setRule(env, c, body.pattern, body.mode ?? null, user);
      return json(await accessSummary(env, c, true));
    }
    case '/api/files': if (req.method === 'GET') return listFiles(env, c, base); break;
    case '/api/branches': if (req.method === 'GET') return listBranches(env, c, url); break;
    case '/api/branch': if (req.method === 'POST') return createBranch(env, c, req, base); break;
    case '/api/export': if (req.method === 'GET') return exportZip(env, c, base); break;
    case '/api/links': if (req.method === 'POST') return createLinks(env, c, req); break;
    case '/api/links/revoke': if (req.method === 'POST') return revokeLinks(env, c, req, user); break;
    case '/api/links/versions': if (req.method === 'GET') return linkVersions(env, c, url); break;
    case '/api/links/inspect': if (req.method === 'GET') return inspectLink(env, c, url); break;
    case '/api/commit': if (req.method === 'POST') return atomicCommit(env, c, req, base, user, scopedPath); break;
    case '/api/rename': if (req.method === 'POST') return renamePath(env, c, req, base, user); break;
    case '/api/dir': if (req.method === 'DELETE') return deleteDir(env, c, req, base, user); break;
    case '/api/history': {
      if (req.method !== 'GET') break;
      const path = scopedPath(c, url.searchParams.get('path'));
      const list = await gh(env, `${base}/commits?sha=${enc(c.branch)}&path=${enc(path)}&per_page=20`);
      return json({ commits: (Array.isArray(list) ? list : []).map(mapCommit) });
    }
    case '/api/activity': {
      if (req.method !== 'GET') break;
      const scope = c.root ? `&path=${enc(c.root)}` : '';
      const list = await gh(env, `${base}/commits?sha=${enc(c.branch)}&per_page=30${scope}`);
      return json({ commits: (Array.isArray(list) ? list : []).map(mapCommit) });
    }
    case '/api/file': {
      const rel = url.searchParams.get('path');
      const path = scopedPath(c, rel);
      const apiFilePath = `${base}/contents/${encPath(path)}`;
      switch (req.method) {
        case 'GET': {
          const ref = url.searchParams.get('ref'); // 读取历史版本：必须是 40 位 commit SHA
          if (ref && !SHA_RE.test(ref)) throw new HttpError(400, 'ref 必须是 40 位 commit SHA');
          return readFile(env, c, apiFilePath, rel, ref);
        }
        case 'PUT': return writeFile(env, c, req, apiFilePath, rel, path, user);
        case 'DELETE': return deleteFile(env, c, req, apiFilePath, path, user);
        default: return err('仅支持 GET / PUT / DELETE', 405);
      }
    }
    default: return err('接口不存在', 404);
  }
  return err('不支持的请求方法', 405);
}
