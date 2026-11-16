/** 公开代理的 Content-Type 策略：可执行/可渲染类型一律降级为 text/plain，防 XSS。 */

const PLAIN_EXTS = new Set([
  'yaml', 'yml', 'txt', 'list', 'ini', 'conf', 'rule', 'md', 'toml',
  'html', 'htm', 'svg', 'xml', 'xhtml',
]);

export function mimeFor(path, upstreamType) {
  const ext = path.split('.').pop().toLowerCase();
  if (PLAIN_EXTS.has(ext)) return 'text/plain; charset=utf-8';
  if (ext === 'json') return 'application/json; charset=utf-8';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript; charset=utf-8';
  if (ext === 'css') return 'text/css; charset=utf-8';
  return upstreamType || 'application/octet-stream';
}
