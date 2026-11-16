/**
 * 文件分发：
 *   GET|HEAD /file/<path>                 公开代理：只读公开仓库，**不携带** GITHUB_TOKEN
 *   GET|HEAD /file/<path>?token=<令牌>     带令牌链接（私有仓库可用）
 *   GET|HEAD /t/<令牌>/<path>              同上，令牌放在路径里（方便订阅类客户端）
 *   ?b=<分支>   指定其它分支（缺省为默认分支）；各分支的访问规则、链接版本相互独立
 *   令牌格式：<10 位 hex><6 位分钟数>，只对该文件有效；撤销 = 提升该文件的版本号
 *   DIRECT_PATHS 按文件/目录开放：direct = 私有仓库的免令牌直链（需 PUBLIC_FILES=true）；token = 仅令牌访问；deny = 禁止
 *
 * 只有通过令牌规则校验或命中 DIRECT_PATHS 的请求才会使用 PAT 去读取内容。
 */
import { API_VERSION, MAX_PROXY_BYTES } from '../config.js';
import { resolveAccess } from '../lib/access.js';
import { loadRules } from '../lib/accessstore.js';
import { enc, encPath, err, HttpError } from '../lib/http.js';
import { effectiveVersion, readRegistry } from '../lib/linkversion.js';
import { verifyToken } from '../lib/linktoken.js';
import { mimeFor } from '../lib/mime.js';
import { validBranchName } from './repos.js';
import { cleanPath, scopedPath } from '../lib/paths.js';
import { makeThrottle } from '../lib/throttle.js';

const YEAR = 31536000;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const REASON_TEXT = { malformed: '链接令牌格式不正确', invalid: '链接无效或已被撤销', expired: '链接已过期' };

/** 令牌猜测限流：同一来源 5 分钟内最多 30 次无效尝试。 */
export const linkFailures = makeThrottle(30, 5 * 60 * 1000);

async function cacheLookup(cacheRequest, privateMode) {
  try {
    const cached = await caches.default.match(cacheRequest);
    if (!cached) return null;
    const buf = await cached.arrayBuffer();
    const headers = new Headers(cached.headers);
    headers.set('X-Worker-Cache', 'HIT');
    if (privateMode) headers.set('Cache-Control', headers.get('X-Client-Cache-Control') || 'private, max-age=0');
    headers.delete('X-Client-Cache-Control');
    return new Response(buf, { status: cached.status, headers });
  } catch { return null; }
}

/** 公开模式：raw.githubusercontent.com，不带令牌。私有模式：Contents API（raw），带 PAT。 */
async function fetchUpstream({ privateMode, env, c, ref, path, method }) {
  if (!privateMode) {
    const rawUrl = `https://raw.githubusercontent.com/${enc(c.owner)}/${enc(c.repo)}/${encPath(ref)}/${encPath(path)}`;
    return fetch(rawUrl, { method, headers: { 'User-Agent': 'cf-config-hub' } });
  }
  const url = `https://api.github.com/repos/${enc(c.owner)}/${enc(c.repo)}/contents/${encPath(path)}?ref=${enc(ref)}`;
  return fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.raw+json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'cf-config-hub',
    },
  });
}

/**
 * @param {{ c: object, rel: string, revision?: string|null, privateMode: boolean, req: Request, env: object, ctx: object, origin: string }} o
 */
async function serve({ c, rel, revision, privateMode, req, env, ctx, origin }) {
  const path = scopedPath(c, rel);
  const ref = revision || c.branch;
  const ttl = revision ? YEAR : c.cacheTtl;

  const cacheUrl = privateMode
    ? new URL(`${origin}/__priv/${enc(c.owner)}/${enc(c.repo)}/${encPath(ref)}/${encPath(path)}`)
    : new URL(`${origin}/file/${encPath(rel)}`);
  if (!privateMode && revision) cacheUrl.searchParams.set('v', revision);
  if (!privateMode && c.defaultBranch && c.branch !== c.defaultBranch) cacheUrl.searchParams.set('b', c.branch);
  const cacheRequest = new Request(cacheUrl.toString());

  if (req.method === 'GET') {
    const hit = await cacheLookup(cacheRequest, privateMode);
    if (hit) return hit;
  }

  const upstream = await fetchUpstream({ privateMode, env, c, ref, path, method: req.method === 'HEAD' && !privateMode ? 'HEAD' : 'GET' });
  if (!upstream.ok) {
    return err(`GitHub 返回 HTTP ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  }
  const type = upstream.headers.get('content-type') || '';
  if (privateMode && type.includes('application/json')) return err('目标不是文件', 404); // 目录会返回 JSON 列表
  if (Number(upstream.headers.get('content-length') || 0) > MAX_PROXY_BYTES) return err('文件过大，代理不支持', 413);

  const clientCache = privateMode
    ? `private, max-age=${revision ? YEAR : Math.min(60, ttl)}${revision ? ', immutable' : ''}`
    : `public, max-age=${revision ? YEAR : Math.min(60, ttl)}, s-maxage=${ttl}${revision ? ', immutable' : ''}`;
  const headers = new Headers({
    'Content-Type': mimeFor(path, privateMode ? '' : type),
    'Cache-Control': clientCache,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'X-Worker-Cache': 'MISS',
    ...(privateMode ? { 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } : {}),
  });
  const etag = upstream.headers.get('etag');
  if (etag) headers.set('ETag', etag);

  if (req.method === 'HEAD') return new Response(null, { status: 200, headers });

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_PROXY_BYTES) return err('文件过大，代理不支持', 413);

  const response = new Response(body, { status: 200, headers });
  // 存入边缘缓存的副本：对外 Cache-Control 在私有模式下是 private，缓存里改用 s-maxage 并记下对外值
  const stored = new Response(body, { status: 200, headers: new Headers(headers) });
  if (privateMode) {
    stored.headers.set('X-Client-Cache-Control', clientCache);
    stored.headers.set('Cache-Control', `public, s-maxage=${ttl}`);
  }
  ctx.waitUntil(caches.default.put(cacheRequest, stored).catch(() => {}));
  return response;
}

export async function handlePublicFile(req, env, ctx, url, defaultCfg) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return err('只允许 GET / HEAD', 405);

  let token = url.searchParams.get('token');
  let relRaw;
  if (url.pathname.startsWith('/t/')) {
    const rest = url.pathname.slice(3);
    const slash = rest.indexOf('/');
    if (slash < 1) throw new HttpError(400, '链接格式应为 /t/<令牌>/<文件路径>');
    token = rest.slice(0, slash);
    relRaw = rest.slice(slash + 1);
  } else {
    relRaw = url.pathname.slice('/file/'.length);
  }
  let rel;
  try { rel = decodeURIComponent(relRaw); } catch { throw new HttpError(400, '路径编码错误'); }
  cleanPath(rel);

  const revisionParam = url.searchParams.get('v');
  if (revisionParam && !COMMIT_RE.test(revisionParam)) throw new HttpError(400, 'v 必须是 40 位 Git commit SHA');

  // 分支：默认服务部署的默认分支；?b=<分支> 可指定其它分支（各分支的访问规则与链接版本相互独立）
  const branchParam = url.searchParams.get('b');
  if (branchParam && !validBranchName(branchParam)) throw new HttpError(400, 'b 不是合法的分支名');
  const c = { ...defaultCfg, defaultBranch: defaultCfg.branch, branch: branchParam || defaultCfg.branch };
  const otherBranch = c.branch !== defaultCfg.branch;

  /* ---- 带令牌：按该文件"当前版本"验签；撤销 = 版本 +1，旧令牌随即对不上 ---- */
  if (token) {
    let rules;
    try { ({ rules } = await loadRules(env, c)); }
    catch (e) { return err(e.message || '无法读取访问规则', 503); } // 读不到规则时拒绝，宁可误拒
    if (!resolveAccess(rules, rel).token) return err('该文件未开放令牌访问', 403);
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    linkFailures.check(ip);
    let current;
    try { ({ data: current } = await readRegistry(env, defaultCfg)); } // 版本表固定在默认分支
    catch (e) { return err(e.message || '无法校验链接版本', 503); } // 读不到版本表时宁可拒绝
    const r = await verifyToken(env, c, token, rel, effectiveVersion(current, rel, otherBranch ? c.branch : ''));
    if (!r.ok) {
      if (r.reason !== 'expired') linkFailures.fail(ip); // 过期是正常现象，不计入暴力猜测
      return err(REASON_TEXT[r.reason] || '链接无效或已撤销', 401);
    }
    return serve({ c, rel, revision: null, privateMode: true, req, env, ctx, origin: url.origin });
  }

  /* ---- 无令牌：公开代理 / 私有仓库的免令牌直链（DIRECT_PATHS） ---- */
  if (!defaultCfg.publicFiles) return err('未启用公开文件代理', 404);
  let direct = false;
  try { direct = resolveAccess((await loadRules(env, c)).rules, rel).direct; } catch { /* 读不到规则：不开放直链 */ }
  return serve({ c, rel, revision: revisionParam, privateMode: direct, req, env, ctx, origin: url.origin });
}
