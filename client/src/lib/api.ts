import { target } from './storage';

let sessionToken = '';
let onUnauthorized = () => {};

export function setSessionToken(token: string) {
  sessionToken = token;
}

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export class AuthError extends Error {
  status = 401;
}

export async function request(url: string, method = 'GET', body?: unknown) {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
  const branch = target.get().branch;
  if (branch) headers['X-Cfh-Branch'] = encodeURIComponent(branch);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const message = data.error || `请求失败 (HTTP ${res.status})`;
  if (res.status === 401) {
    if (sessionToken) onUnauthorized();
    throw Object.assign(new AuthError(message), { status: 401 });
  }
  throw Object.assign(new Error(message), { status: res.status });
}

export const fileUrl = (path: string) => '/api/file?path=' + encodeURIComponent(path);

export async function downloadBlob(url: string) {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = 'Bearer ' + sessionToken;
  const branch = target.get().branch;
  if (branch) headers['X-Cfh-Branch'] = encodeURIComponent(branch);
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `下载失败 (HTTP ${res.status})`);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'download.zip';
  return { blob: await res.blob(), name };
}
