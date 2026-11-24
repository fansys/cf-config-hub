# Agent 操作说明

Worker 在 `src/`，由 wrangler 打包。管理界面在 `client/`，由 Vite 打包到 `dist/client`。无 DOM 的解析与工具在 `shared/`，Node 测试直接 import，不要改成只能被 Vite 打包的写法。

## 命令

- `npm run dev`：Vite `127.0.0.1:5173`，把 `/api`、`/file`、`/t` 代理到 `wrangler dev` 的 8787。
- `npm run build`：产出 `dist/client`。`wrangler.toml` 的 `[assets] directory` 指向这里。
- `npm run deploy`：doctor、build、`wrangler deploy`。
- `npm test`：`node --test`。改前端产物约定后先 build，再跑 `tests/deploy.test.mjs`。

## 必须守住

- `client/index.html` 的 `/boot.js` 是 head 里的阻塞经典脚本，不能加 `defer`、`async` 或 `type="module"`。
- `client/vite.config.ts` 里 `build.modulePreload.polyfill` 保持 `false`。CSP 是 `script-src 'self'`，禁止 inline script 和 eval。
- 不开启 assets 的 SPA fallback。路由是 hash。`run_worker_first` 保持 `/api/*`、`/file/*`、`/t/*`。
- 不要把 Worker 变量写进 `VITE_` 环境变量。不要把密钥写进 `wrangler.toml`。
- 不可信仓库内容不要用 `v-html`。Markdown 预览继续走 `shared/markdown.js`。
- 登录入口不要静态引用 CodeMirror 或 `js-yaml`。这两项在打开编辑器或校验时再加载。
