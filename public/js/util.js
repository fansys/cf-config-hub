/** DOM 与编码小工具。所有不可信文本一律通过 textContent 写入，不使用 innerHTML。 */

export const $ = id => document.getElementById(id);

let toastTimer;
export function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

export function makeEl(tag, className = '', text = '') {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.textContent = text;
  return e;
}

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
  return Uint8Array.from(atob(s.replace(/\s/g, '')), ch => ch.charCodeAt(0));
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

/* ---------- 换行符 ---------- */

export const toLF = s => s.replace(/\r\n/g, '\n');

/** 文件整体为 CRLF（没有单独的 LF）时返回 CRLF，否则 LF。 */
export const detectEol = s => (s.includes('\r\n') && !/(^|[^\r])\n/.test(s) ? '\r\n' : '\n');

export const applyEol = (s, eol) => (eol === '\r\n' ? toLF(s).replace(/\n/g, '\r\n') : s);
