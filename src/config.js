/** 运行时配置读取与校验。 */
import { HttpError } from './lib/http.js';
import { cleanPath } from './lib/paths.js';

export const MAX_WRITE_BYTES = 768 * 1024;      // GitHub Contents API 写入上限
export const MAX_READ_BYTES = 1024 * 1024;      // 编辑器可读取上限
export const MAX_PROXY_BYTES = 5 * 1024 * 1024; // 公开代理可转发的上游体积上限
export const MAX_COMMIT_FILES = 50;             // 单次原子提交的文件数上限
export const MAX_COMMIT_BYTES = 3 * 1024 * 1024; // 单次原子提交的内容体积上限
export const API_VERSION = '2022-11-28';

const OWNER_RE = /^[A-Za-z0-9-]{1,39}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

function build(owner, repo, branch, rootRaw, env) {
  const root = cleanPath(String(rootRaw || '').replace(/^\/+|\/+$/g, ''), true);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || !branch || /[\x00-\x1F]/.test(branch)) {
    throw new HttpError(503, '请先配置 GITHUB_OWNER、GITHUB_REPO、GITHUB_BRANCH');
  }
  return {
    owner, repo, branch, root,
    publicFiles: env.PUBLIC_FILES === 'true',
    cacheTtl: Math.max(1, Math.min(3600, Number(env.CACHE_TTL || 60) || 60)),
  };
}

/** 部署时配置的默认目标（公开代理 /file/ 与未登录的 /api/info 只使用它）。 */
export function getConfig(env) {
  return build(
    String(env.GITHUB_OWNER || '').trim(),
    String(env.GITHUB_REPO || '').trim(),
    String(env.GITHUB_BRANCH || 'main').trim(),
    env.ROOT_DIR, env,
  );
}

const headerText = (req, name) => {
  const v = req.headers.get(name);
  if (v == null) return null;
  try { return decodeURIComponent(v); } catch { throw new HttpError(400, `请求头 ${name} 编码错误`); }
};

/**
 * 登录后的管理接口：仓库与管理目录固定为部署配置，只允许通过请求头 X-Cfh-Branch 切换分支。
 * 请求头里带了不同的仓库（X-Cfh-Repo）或管理目录（X-Cfh-Root）一律拒绝。
 */
export function getRequestConfig(env, req) {
  const base = getConfig(env);
  const repoHdr = headerText(req, 'X-Cfh-Repo');
  if (repoHdr && repoHdr.toLowerCase() !== `${base.owner}/${base.repo}`.toLowerCase()) {
    throw new HttpError(403, '不允许切换仓库，只能切换分支');
  }
  const rootHdr = headerText(req, 'X-Cfh-Root');
  if (rootHdr !== null && rootHdr.replace(/^\/+|\/+$/g, '') !== base.root) {
    throw new HttpError(403, '不允许切换管理目录，只能切换分支');
  }
  const branch = (headerText(req, 'X-Cfh-Branch') || base.branch).trim();

  const cfg = build(base.owner, base.repo, branch, base.root, env);
  cfg.defaultBranch = base.branch;
  cfg.defaults = { owner: base.owner, repo: base.repo, branch: base.branch, root: base.root };
  cfg.isDefault = cfg.branch === base.branch; // 是否在默认分支上（公开代理与令牌链接只服务默认分支）
  return cfg;
}
