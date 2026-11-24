/** 与 DOM 无关的路径、体积和换行符工具。 */

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export const encPath = s => s.split('/').map(encodeURIComponent).join('/');

export function b64FromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  }
  return btoa(binary);
}

export function bytesFromB64(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 与后端 cleanPath 规则一致的前端预校验。 */
export function isValidPath(path) {
  return !!path && path.length <= 500 &&
    !path.startsWith('/') && !path.endsWith('/') &&
    !path.includes('\\') && !path.includes('//') &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split('/').some(s => s === '.' || s === '..' || s.toLowerCase() === '.git') &&
    path !== '.github/workflows' && !path.startsWith('.github/workflows/');
}

export const toLF = s => s.replace(/\r\n/g, '\n');

/** 文件整体为 CRLF（没有单独的 LF）时返回 CRLF，否则 LF。 */
export const detectEol = s => (s.includes('\r\n') && !/(^|[^\r])\n/.test(s) ? '\r\n' : '\n');

export const applyEol = (s, eol) => (eol === '\r\n' ? toLF(s).replace(/\n/g, '\r\n') : s);
