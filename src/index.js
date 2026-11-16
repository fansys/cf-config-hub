/**
 * Cloudflare Config Hub — Worker 入口
 *
 *   GET  /api/info              仓库元信息（无需口令）
 *   GET  /api/files             递归文件列表 + 最新 commit SHA        [admin]
 *   GET|PUT|DELETE /api/file    读取 / 创建更新 / 删除文件             [admin]
 *   GET|HEAD /file/<path>       公开文件代理（PUBLIC_FILES=true；不携带 PAT）
 *
 * 其余路径由 Workers Static Assets 提供前端页面。
 */
import { getConfig } from './config.js';
import { err, HttpError } from './lib/http.js';
import { handleApi } from './routes/api.js';
import { handlePublicFile } from './routes/file.js';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, env, url);
      if (url.pathname.startsWith('/file/') || url.pathname.startsWith('/t/')) return await handlePublicFile(req, env, ctx, url, getConfig(env));
      return err('页面不存在', 404);
    } catch (e) {
      if (e instanceof HttpError) return err(e.message, e.status);
      console.error('Worker error:', e);
      return err('服务暂时不可用，请查看 Worker 日志', 500);
    }
  },
};
