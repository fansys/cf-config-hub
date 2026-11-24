/** 与旧页面一致：`#/` 后面每段单独编码。 */
export function hashForPath(path: string) {
  return '#/' + path.split('/').map(encodeURIComponent).join('/');
}

export function pathFromHash(hash: string) {
  if (!hash.startsWith('#/')) return null;
  try {
    return hash.slice(2).split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}
