/** GitHub REST API 封装与请求体校验。 */
import { API_VERSION, MAX_WRITE_BYTES } from './config.js';
import { HttpError } from './lib/http.js';

export async function gh(env, urlPath, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'cf-config-hub',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    let msg = data.message || `GitHub API 返回 HTTP ${response.status}`;
    if (response.status === 409 || response.status === 422) {
      msg += '（文件可能已被他人修改；请刷新后重试）';
    }
    throw new HttpError(response.status, msg);
  }
  return data;
}

export async function readJsonBody(req, limit = MAX_WRITE_BYTES * 2) {
  if (Number(req.headers.get('content-length') || 0) > limit) {
    throw new HttpError(413, '请求体过大');
  }
  const body = await req.json().catch(() => { throw new HttpError(400, '请求体必须是 JSON'); });
  if (!body || typeof body !== 'object') throw new HttpError(400, '请求体必须是 JSON 对象');
  return body;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export const SHA_RE = /^[0-9a-f]{40}$/;

export function validateBase64(s) {
  if (typeof s !== 'string' ||
      s.length > Math.ceil(MAX_WRITE_BYTES / 3) * 4 + 8 ||
      !BASE64_RE.test(s)) {
    throw new HttpError(413, '文件应为不超过 768 KiB 的 Base64 内容');
  }
}

/** 提交说明；多人协作时（非默认 admin）追加 Edited-by 署名，供"操作记录"追溯。 */
export function commitMessage(body, fallback, user) {
  const msg = String(body.message || '').trim().slice(0, 200) || fallback;
  return user && user.name !== 'admin' ? `${msg}\n\nEdited-by: ${user.name}` : msg;
}

export const editedBy = message => String(message || '').match(/^Edited-by:\s*(.+)$/m)?.[1]?.trim() || '';
