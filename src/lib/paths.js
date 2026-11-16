/** 路径校验与作用域（ROOT_DIR）处理。 */
import { HttpError } from './http.js';

const MAX_PATH_LEN = 500;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/**
 * 校验仓库内相对路径，拒绝穿越、空段、反斜杠、控制字符。
 * allowEmpty=true 时允许空字符串（用于 ROOT_DIR）。
 */
export function cleanPath(p, allowEmpty = false) {
  if (p === '' && allowEmpty) return '';
  if (typeof p !== 'string' || !p || p.length > MAX_PATH_LEN ||
      p.includes('\\') || p.startsWith('/') || p.endsWith('/') || p.includes('//')) {
    throw new HttpError(400, '非法文件路径');
  }
  for (const seg of p.split('/')) {
    if (!seg || seg === '.' || seg === '..' || seg.toLowerCase() === '.git' || CONTROL_CHARS.test(seg)) {
      throw new HttpError(400, '非法文件路径');
    }
  }
  return p;
}

export const isWorkflowPath = p => p === '.github/workflows' || p.startsWith('.github/workflows/');

export const fullPath = (root, rel) => (root ? `${root}/${rel}` : rel);

/** 校验用户传入路径，并拼上 ROOT_DIR 得到仓库内真实路径。 */
export function scopedPath(config, raw) {
  const path = cleanPath(raw);
  if (path.split('/').at(-1) === '.cfhub-links.json') throw new HttpError(403, '该文件由链接管理功能使用，不能直接操作');
  if (isWorkflowPath(path)) throw new HttpError(403, '禁止通过本工具修改 GitHub Actions 工作流');
  return fullPath(config.root, path);
}
