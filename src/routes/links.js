/** 分享链接（令牌 v2）：批量签发、撤销（提升文件版本）、版本表、检查。任意分支可用，各分支的规则与版本独立。 */
import { loadRules } from '../lib/accessstore.js';
import { readJsonBody } from '../github.js';
import { resolveAccess } from '../lib/access.js';
import { HttpError, json } from '../lib/http.js';
import { clearIssued, listIssued, rememberIssued } from '../lib/issuedlinks.js';
import { effectiveVersion, bumpVersions, readRegistry } from '../lib/linkversion.js';
import { inspectToken, makeToken, minutesToMs, parseToken } from '../lib/linktoken.js';
import { scopedPath } from '../lib/paths.js';

const MAX_TTL = 365 * 24 * 3600;
const MAX_PATHS = 100;

/** 版本表固定放在默认分支上。 */
const registryCfg = c => ({ ...c, branch: c.defaults.branch });
/** 版本表里用来区分分支的键：默认分支为空串。 */
const branchKey = c => (c.branch === c.defaults.branch ? '' : c.branch);

/** POST /api/links { paths:[文件路径], expiresIn?: 秒（省略 = 永久；60 秒 – 365 天） } */
export async function createLinks(env, c, req, user) {
  const body = await readJsonBody(req);
  const paths = [...new Set(Array.isArray(body.paths) ? body.paths : [])];
  if (!paths.length) throw new HttpError(400, '请指定至少一个文件');
  if (paths.length > MAX_PATHS) throw new HttpError(400, `单次最多为 ${MAX_PATHS} 个文件生成链接`);
  paths.forEach(p => scopedPath(c, p)); // 校验路径合法、非工作流、非保留文件
  const { rules } = await loadRules(env, c);
  const blocked = paths.filter(p => !resolveAccess(rules, p).token);
  if (blocked.length) {
    throw new HttpError(403, `以下文件未开放令牌访问：${blocked.slice(0, 5).join('、')}${blocked.length > 5 ? ` 等 ${blocked.length} 个` : ''}。请在「访问规则」中为它们添加规则（如 ${blocked[0]}:token）；其它分支的规则需要在该分支上单独设置。`);
  }

  let expiresAtMs = null;
  if (body.expiresIn != null) {
    const ttl = Number(body.expiresIn);
    if (!Number.isFinite(ttl) || ttl < 60 || ttl > MAX_TTL) throw new HttpError(400, '有效期应在 1 分钟到 365 天之间；永久有效请留空');
    expiresAtMs = Date.now() + Math.floor(ttl) * 1000;
  }
  const reg = registryCfg(c);
  const branch = branchKey(c);
  let { data } = await readRegistry(env, reg, { fresh: true });
  const stale = [];
  for (const path of paths) {
    if ((await listIssued(env, c, branch, path, data)).length) stale.push(path);
  }
  for (const path of stale) data = await bumpVersions(env, reg, { path, branch }, user);
  const links = [];
  for (const path of paths) {
    const version = effectiveVersion(data, path, branch);
    const token = await makeToken(env, c, path, { expiresAtMs, version });
    links.push({ path, token, version });
  }
  const minutes = parseToken(links[0].token).minutes;
  const expiresAt = minutes ? minutesToMs(minutes) : null;
  try { await rememberIssued(env, c, branch, links.map(link => ({ ...link, expiresAt }))); } catch { /* 记住失败不影响本次签发 */ }
  return json({ links, branch: branchKey(c), expiresAt });
}

/** POST /api/links/revoke { path } | { all: true }：提升版本号，旧链接立即（≤缓存时间）失效。 */
export async function revokeLinks(env, c, req, user) {
  const body = await readJsonBody(req);
  if (!body.all) scopedPath(c, body.path);
  const next = await bumpVersions(env, registryCfg(c), body.all ? { all: true } : { path: body.path, branch: branchKey(c) }, user);
  try { await clearIssued(env, c, branchKey(c), body.all ? '' : body.path); } catch { /* 清记录失败不影响撤销 */ }
  return json({ global: next.global, version: body.all ? null : effectiveVersion(next, body.path, branchKey(c)) });
}

/** GET /api/links/issued?path=…：回显该文件仍有效的已保存令牌。 */
export async function issuedLinks(env, c, url) {
  const path = url.searchParams.get('path') || '';
  scopedPath(c, path);
  const { data } = await readRegistry(env, registryCfg(c));
  const links = await listIssued(env, c, branchKey(c), path, data, { prefix: url.searchParams.get('prefix') === '1' });
  return json({ path, links });
}

/** GET /api/links/versions：版本表（供界面显示当前版本）。 */
export async function linkVersions(env, c, url) {
  const { data } = await readRegistry(env, registryCfg(c), { fresh: true });
  return json({ ...data, branch: branchKey(c), version: url.searchParams.get('path') ? effectiveVersion(data, url.searchParams.get('path'), branchKey(c)) : null });
}

/** GET /api/links/inspect?token=…&path=…：检查某个令牌对该文件是否仍然有效（可识别"已撤销"）。 */
export async function inspectLink(env, c, url) {
  const token = (url.searchParams.get('token') || '').trim();
  const path = url.searchParams.get('path') || '';
  scopedPath(c, path);
  const { data } = await readRegistry(env, registryCfg(c), { fresh: true });
  const currentVersion = effectiveVersion(data, path, branchKey(c));
  const r = await inspectToken(env, c, token, path, currentVersion);
  return json({
    valid: r.status === 'valid', status: r.status, path, currentVersion, version: r.version ?? null,
    expiresAt: r.minutes ? minutesToMs(r.minutes) : null, permanent: r.minutes === 0,
  });
}
