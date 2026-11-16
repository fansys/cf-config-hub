/** 后端接口封装与登录态持久化。 */
import { state } from './state.js';

const TOKEN_KEY = 'cfhub-token';

/** 未勾选"保持登录"时仅存于当前标签页（sessionStorage），勾选后存入 localStorage。 */
export const tokenStore = {
  load: () => ({
    token: localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '',
    remember: !!localStorage.getItem(TOKEN_KEY),
  }),
  save(token, remember) {
    this.clear();
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

const TARGET_KEY = 'cfhub-target';

/** 当前选择的分支（仓库与管理目录固定为部署配置；为空表示用部署默认分支）。 */
export const target = {
  get() {
    try { const t = JSON.parse(localStorage.getItem(TARGET_KEY)) || {}; return t.branch ? { branch: String(t.branch) } : {}; }
    catch { return {}; }
  },
  set(t) { if (t.branch) localStorage.setItem(TARGET_KEY, JSON.stringify({ branch: t.branch })); else localStorage.removeItem(TARGET_KEY); },
  clear() { localStorage.removeItem(TARGET_KEY); },
};

/** 带鉴权与分支选择的请求头（分支名用 URI 编码，避免非 ASCII 字符问题）。 */
export function authHeaders() {
  const headers = {};
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const t = target.get();
  if (t.branch) headers['X-Cfh-Branch'] = encodeURIComponent(t.branch);
  return headers;
}

export class AuthError extends Error {}

export async function request(url, method = 'GET', body) {
  const headers = authHeaders();
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const message = data.error || `请求失败 (HTTP ${res.status})`;
  if (res.status === 401 && state.token) {
    window.dispatchEvent(new CustomEvent('cfhub:unauthorized'));
    throw new AuthError(message);
  }
  if (res.status === 401) throw new AuthError(message);
  throw Object.assign(new Error(message), { status: res.status });
}

export const fileUrl = path => '/api/file?path=' + encodeURIComponent(path);

/** 下载受保护的二进制资源（如 zip 导出）。 */
export async function downloadBlob(url) {
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `下载失败 (HTTP ${res.status})`);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'download.zip';
  return { blob: await res.blob(), name };
}
