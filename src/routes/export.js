/** GET /api/export：把当前分支打包为 zip 下载（GitHub zipball 透传）。 */
import { API_VERSION } from '../config.js';
import { gh } from '../github.js';
import { encPath, HttpError, NO_STORE } from '../lib/http.js';

const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

export async function exportZip(env, c, base) {
  const ref = await gh(env, `${base}/git/ref/heads/${encPath(c.branch)}`);
  const sha = ref.object?.sha;
  const upstream = await fetch(`https://api.github.com${base}/zipball/${sha}`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': 'cf-config-hub',
    },
  });
  if (!upstream.ok) throw new HttpError(upstream.status === 404 ? 404 : 502, `GitHub 打包失败（HTTP ${upstream.status}）`);
  if (Number(upstream.headers.get('content-length') || 0) > MAX_EXPORT_BYTES) throw new HttpError(413, '仓库过大，无法在线导出');
  const name = `${c.repo}-${c.branch}`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100);
  return new Response(upstream.body, {
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}.zip"`,
    },
  });
}
