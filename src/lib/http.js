/** HTTP 相关的小工具：错误类型、JSON 响应、URL 编码。 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const NO_STORE = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export const enc = v => encodeURIComponent(v);
export const encPath = p => p.split('/').map(enc).join('/');

export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export const err = (message, status = 400, headers = {}) => json({ error: message }, status, headers);
