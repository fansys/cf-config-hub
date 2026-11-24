# 项目状态

## 当前状态

管理界面已改为 Vue 3 + Vite。Worker 与 `shared/` 解析器保持原行为。静态资源目录是 `dist/client`，部署前必须 `npm run build`。

## 当前工作

状态：`completed`

前端重构：Vue 3、Vite、Tailwind CSS v4、Reka UI、CodeMirror 6、虚拟文件树。纯逻辑在 `shared/`。原始内容的高亮语言可以手动切换。文件树只给私有仓库标角标：不能直链显示锁，仅令牌显示分享图标，能直链不显示。目录规则 `dir/` 覆盖其中的文件。文件树每一行都有固定的访问按钮，搜索时也会列出匹配目录。

## 技术决策

- DEC-001 `active`：客户端单独用 Vite，不用 Cloudflare Vite 插件打包 Worker，避免改写 `keep_vars` 和 `run_worker_first`。
- DEC-002 `active`：组件层用 Reka UI（shadcn-vue 的底层）。仓库不是独立 Vite 包，`shadcn-vue init` 无法非交互跑完，组件写在 `client/src/components/ui`。
- DEC-003 `active`：编辑器用 CodeMirror 6，超过 30 万字符关闭语法高亮。文件树只渲染展开后的可见行，并用虚拟列表挂载视口内的行。

## 验证

`npm test`：118 通过。`npm run build` 通过。登录 chunk 不含 CodeMirror 和 js-yaml。

Headless Chrome 打开构建产物后能渲染登录页。没有用真实口令走保存、可视化、只读和窄屏。

## 已知问题

Clash `.ini` 的 url-test 参数（间隔、过滤、测速 URL）在可视化里没有逐项表单，只保留策略名和 select 成员的名称编辑。
