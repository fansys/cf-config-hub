/**
 * GitHub Config Manager — Cloudflare Worker backend
 *
 * 公开接口：
 *   GET  /api/info               仓库元信息（无 token 可访问，用于首页展示）
 *   GET  /file/<path>            公开文件代理（PUBLIC_FILES=true 时启用；
 *                                公开仓库不加 PAT；私有仓库带 PAT 才能读到）
 *
 * 管理接口（必须 Authorization: Bearer <ADMIN_TOKEN>）：
 *   GET  /api/files              递归文件列表 + 最新 Commit SHA
 *   GET  /api/file?path=...      读取文件（返回 Base64 内容 + SHA）
 *   PUT  /api/file?path=...      创建/更新文件
 *   DELETE /api/file?path=...    删除文件
 *
 * 安全模型：
 *   - ADMIN_TOKEN 由 Worker Secret 配置，不在前端暴露
 *   - GITHUB_TOKEN 仅在 Worker 后端使用；公开 /file/ 代理仅对 raw.githubusercontent.com 发请求
 *   - 私有仓库 + PUBLIC_FILES=true 时，Worker 代理会携带 PAT 请求 raw.githubusercontent.com
 *     —— 拿到 Worker 域名即拿到文件，请妥善保管域名；如需更高安全配合 Cloudflare Access
 */
const API_VERSION = '2022-11-28';
const MAX_WRITE_BYTES = 768 * 1024;  // GitHub Contents API 限制
const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/* ---------- 工具 ---------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const enc = v => encodeURIComponent(v);
const encPath = p => p.split('/').map(enc).join('/');

function json(data, status = 200, headersOverride = {}) {
  return Response.json(data, {
    status,
    headers: { ...NO_STORE, ...headersOverride },
  });
}
const err = (message, status = 400) => json({ error: message }, status);

function cleanPath(p, allowEmpty = false) {
  if (typeof p !== 'string' || p.length > 500 ||
      p.includes('\\') || p.includes('\0') ||
      p.startsWith('/') || p.endsWith('/') || p.includes('//')) {
    if (allowEmpty && p === '') return '';
    throw new HttpError(400, '非法文件路径');
  }
  if (!p && allowEmpty) return '';
  if (!p || p.split('/').some(seg => !seg || seg === '.' || seg === '..' || /[\x00-\x1F\x7F]/.test(seg))) {
    throw new HttpError(400, '非法文件路径');
  }
  return p;
}

function cfg(env) {
  const owner = String(env.GITHUB_OWNER || '').trim();
  const repo = String(env.GITHUB_REPO || '').trim();
  const branch = String(env.GITHUB_BRANCH || 'main').trim();
  const root = cleanPath(String(env.ROOT_DIR || '').replace(/^\/+|\/+$/g, ''), true);
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(repo) ||
      !branch || /[\x00-\x1F]/.test(branch)) {
    throw new HttpError(503, '请先配置 GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH');
  }
  return { owner, repo, branch, root };
}

function fullPath(root, rel) { return root ? `${root}/${rel}` : rel; }

function scopedPath(c, raw) {
  const path = cleanPath(raw);
  if (path === '.github/workflows' || path.startsWith('.github/workflows/')) {
    throw new HttpError(403, '禁止通过本工具修改 GitHub Actions 工作流');
  }
  return fullPath(c.root, path);
}

/* ---------- 鉴权 ---------- */

async function validAdmin(req, env) {
  const expected = env.ADMIN_TOKEN;
  const supplied = req.headers.get('Authorization') || '';
  if (!expected || !supplied.startsWith('Bearer ')) return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(supplied.slice(7));
  if (a.length !== b.length) return false;  // 长度不等直接 fast-fail，避免 timing 侧信道暴露
  try {
    const ad = await crypto.subtle.digest('SHA-256', a);
    const bd = await crypto.subtle.digest('SHA-256', b);
    const ua = new Uint8Array(ad);
    const ub = new Uint8Array(bd);
    // Cloudflare Workers runtime 有 crypto.timingSafeEqual（非标准但实际存在）
    // Node.js webcrypto 没有 → 退化成普通比较（长度已相同，字节级逐比依然比字符串 == 好）
    if (typeof crypto.timingSafeEqual === 'function') {
      return crypto.timingSafeEqual(ua, ub);
    }
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  } catch { return false; }
}

/* ---------- GitHub API ---------- */

async function gh(env, urlPath, options = {}) {
  const response = await fetch(`https://api.github.com${urlPath}`, {
    method: options.method || 'GET',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'cf-config-hub',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    let msg = body.message || `GitHub API 返回 HTTP ${response.status}`;
    if (response.status === 409 || response.status === 422) {
      msg += '（文件可能已被他人修改；请刷新后重试）';
    }
    throw new HttpError(response.status, msg);
  }
  return body;
}

async function readBody(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_WRITE_BYTES * 2) {
    throw new HttpError(413, '请求体过大');
  }
  return req.json().catch(() => { throw new HttpError(400, '请求体必须是 JSON'); });
}

function validateBase64(s) {
  if (typeof s !== 'string' ||
      s.length > Math.ceil(MAX_WRITE_BYTES / 3) * 4 + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new HttpError(413, '文件应为不超过 768 KiB 的 Base64 内容');
  }
}

/* ---------- MIME ---------- */

const TEXT_EXTS = new Set(['yaml', 'yml', 'txt', 'list', 'ini', 'conf', 'rule', 'md', 'toml']);
const BLOCKED_EXT = new Set(['html', 'htm', 'svg', 'xml', 'xhtml']);  // 统一 text/plain 防 XSS

function mime(path, original) {
  const ext = path.split('.').pop().toLowerCase();
  if (BLOCKED_EXT.has(ext)) return 'text/plain; charset=utf-8';
  if (TEXT_EXTS.has(ext)) return 'text/plain; charset=utf-8';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  return original || 'application/octet-stream';
}

/* ---------- API 路由 ---------- */

async function handleApi(req, env, url) {
  const c = cfg(env);
  const base = `/repos/${enc(c.owner)}/${enc(c.repo)}`;
  const pathname = url.pathname;

  // ---- /api/info：允许无 token（公开仓库也要能看到基本信息）----
  if (pathname === '/api/info' && req.method === 'GET') {
    const info = {
      owner: c.owner,
      repo: c.repo,
      branch: c.branch,
      root: c.root,
      publicFiles: env.PUBLIC_FILES === 'true',
      maxWriteBytes: MAX_WRITE_BYTES,
    };
    // 有 PAT 就查 private 状态；无 PAT 跳过（节省一次 API 调用，且公开仓库无需）
    if (env.GITHUB_TOKEN) {
      try {
        const repoInfo = await gh(env, base);
        info.private = !!repoInfo.private;
      } catch { info.private = null; }  // 静默失败：不知道就是不知道
    } else {
      info.private = null;  // 明确标记：无 PAT 无法确认
    }
    return json(info);
  }

  // ---- 以下接口需要 admin 鉴权 + 已配置 GITHUB_TOKEN ----
  if (!env.GITHUB_TOKEN) return err('未配置 GITHUB_TOKEN Secret', 503);
  if (!(await validAdmin(req, env))) return err('管理口令错误或未登录', 401);

  // /api/files
  if (pathname === '/api/files' && req.method === 'GET') {
    const data = await gh(env, `${base}/git/trees/${enc(c.branch)}?recursive=1`);
    if (data.truncated) {
      throw new HttpError(409, '仓库文件过多，GitHub 返回的目录树被截断。请缩小仓库规模或改用独立配置仓库。');
    }
    const prefix = c.root ? `${c.root}/` : '';
    const files = (data.tree || [])
      .filter(f => f.type === 'blob' && f.path.startsWith(prefix))
      .map(f => ({ path: f.path.slice(prefix.length), size: f.size || 0, sha: f.sha }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    const commit = await gh(env, `${base}/commits/${enc(c.branch)}`);
    return json({ files, commitSha: commit.sha });
  }

  // /api/file
  if (pathname === '/api/file') {
    const rel = url.searchParams.get('path');
    const path = scopedPath(c, rel);
    const apiFilePath = `${base}/contents/${encPath(path)}`;

    if (req.method === 'GET') {
      const file = await gh(env, `${apiFilePath}?ref=${enc(c.branch)}`);
      if (Array.isArray(file) || file.type !== 'file') {
        throw new HttpError(400, '目标不是普通文件');
      }
      if (file.size > 1024 * 1024 || file.encoding !== 'base64') {
        throw new HttpError(413, '只能在编辑器中读取 1 MiB 以下的普通文件');
      }
      return json({
        path: rel,
        content: (file.content || '').replace(/\s/g, ''),
        sha: file.sha,
        size: file.size,
      });
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      validateBase64(body.content);
      if (body.sha !== undefined && body.sha !== null && !/^[0-9a-f]{40}$/.test(body.sha)) {
        throw new HttpError(400, 'SHA 格式错误');
      }
      const msg = String(body.message || `Update ${path}`).trim().slice(0, 200);
      const out = await gh(env, apiFilePath, {
        method: 'PUT',
        body: {
          message: msg || `Update ${path}`,
          content: body.content,
          branch: c.branch,
          ...(body.sha ? { sha: body.sha } : {}),
        },
      });
      return json({
        path: rel,
        sha: out.content?.sha,
        commitSha: out.commit?.sha,
      });
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req);
      if (!/^[0-9a-f]{40}$/.test(body.sha || '')) {
        throw new HttpError(400, '删除文件需要当前 SHA');
      }
      const msg = String(body.message || `Delete ${path}`).trim().slice(0, 200);
      const out = await gh(env, apiFilePath, {
        method: 'DELETE',
        body: {
          message: msg || `Delete ${path}`,
          sha: body.sha,
          branch: c.branch,
        },
      });
      return json({ deleted: true, commitSha: out.commit?.sha });
    }

    return err('仅支持 GET / PUT / DELETE', 405);
  }

  return err('接口不存在', 404);
}

/* ---------- 公开文件代理 ---------- */

async function handlePublicFile(req, env, ctx, url) {
  if (env.PUBLIC_FILES !== 'true') return err('未启用公开文件代理', 404);
  if (req.method !== 'GET' && req.method !== 'HEAD') return err('只允许 GET / HEAD', 405);

  const c = cfg(env);
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice('/file/'.length)); }
  catch { throw new HttpError(400, '路径编码错误'); }

  const path = scopedPath(c, rel);
  const revision = url.searchParams.get('v');
  if (revision && !/^[0-9a-f]{40}$/.test(revision)) {
    throw new HttpError(400, 'v 必须是 40 位 Git commit SHA');
  }
  const ref = revision || c.branch;
  const ttl = revision ? 31536000 : Math.max(1, Math.min(3600, Number(env.CACHE_TTL || 60) || 60));

  // 缓存键：完整 rel + revision
  const cacheUrl = new URL(url.origin + `/file/${encPath(rel)}`);
  if (revision) cacheUrl.searchParams.set('v', revision);
  const cacheRequest = new Request(cacheUrl.toString());

  // 尝试命中缓存
  if (req.method === 'GET') {
    try {
      const cached = await caches.default.match(cacheRequest);
      if (cached) {
        // ⚠️ 关键：先把 cached.body 读成 ArrayBuffer，再构造 Response。
        // ReadableStream 有 one-shot 限制 + ownership 语义，miniflare 本地 SW 想 clone 时会炸。
        // 用 ArrayBuffer 彻底规避：数据在内存里，谁想怎么 clone 都行。
        const buf = await cached.arrayBuffer();
        const h = new Headers(cached.headers);
        h.set('X-Worker-Cache', 'HIT');
        return new Response(buf, { status: cached.status, headers: h });
      }
    } catch { /* Cache API 在 preview 环境可能不可用，忽略 */ }
  }

  const rawUrl = `https://raw.githubusercontent.com/${enc(c.owner)}/${enc(c.repo)}/${enc(ref)}/${encPath(path)}`;
  // 私有仓库必须带 PAT 才能读到；公开仓库不带（避免 token 泄露到 GitHub 日志）。
  // 这里简化处理：只要配置了 PAT 就带上（最安全的做法是先查 repo.private，但那多一次 API 调用）。
  const fetchHeaders = { 'User-Agent': 'cf-config-hub' };
  if (env.GITHUB_TOKEN) fetchHeaders['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;

  const upstream = await fetch(rawUrl, { method: req.method, headers: fetchHeaders });
  if (!upstream.ok) {
    return err(`GitHub Raw 返回 HTTP ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  }

  const headers = new Headers({
    'Content-Type': mime(path, upstream.headers.get('content-type')),
    'Cache-Control': `public, max-age=${revision ? 31536000 : Math.min(60, ttl)}, s-maxage=${ttl}${revision ? ', immutable' : ''}`,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'X-Worker-Cache': 'MISS',
  });
  if (upstream.headers.has('etag')) headers.set('ETag', upstream.headers.get('etag'));

  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });

  // ⚠️ 关键：把 upstream.body 读成 ArrayBuffer 再构造 Response。
  // ReadableStream 的 ownership/clone 语义在 miniflare 本地 SW 和 Cloudflare 边缘都容易踩坑。
  // ArrayBuffer 在内存里，无状态，谁想 clone 都不会炸。文件都 ≤ 5 MiB，完全够用。
  const bodyBuf = await upstream.arrayBuffer();
  const response = new Response(bodyBuf, { status: 200, headers });

  const bytes = bodyBuf.byteLength;
  if (!bytes || bytes <= 5 * 1024 * 1024) {
    ctx.waitUntil(caches.default.put(cacheRequest, response.clone()).catch(() => {}));
  }

  return response;
}

/* ---------- 入口 ---------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url);
      if (url.pathname.startsWith('/file/')) return await handlePublicFile(req, env, ctx, url);
      return err('页面不存在', 404);
    } catch (e) {
      if (e instanceof HttpError) return err(e.message, e.status);
      console.error('Worker error:', e);
      return err('服务暂时不可用，请查看 Worker 日志', 500);
    }
  },
};
