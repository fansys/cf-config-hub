# Cloudflare Config Hub

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fansys/cf-config-hub)

> 👆 点上面按钮直接在 Cloudflare Dashboard 里配置并部署。只需填 GitHub 仓库地址和环境变量（`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`），密钥通过 Worker Secrets 设置（`GITHUB_TOKEN`、`ADMIN_TOKEN`）。

一个适合维护 YAML/JSON/TXT/Clash/QuantumultX 规则列表等配置文件的轻量级 GitHub 文件管理面板。

- GitHub 仓库/分支/子目录管理；文件树、搜索、在线 UTF-8 编辑、下载、新建（含在指定目录下新建）、上传、删除、文件/目录重命名与移动、整目录删除；多文件/拖拽上传；保存前差异预览与提交历史（可对比、载入旧版本）；可视化编辑器的搜索、去重、安全排序、链接导入与规则校验提示；Clash / QuantumultX / Shadowrocket / Loon 四种规则互转；复制文件；登录过期时原地重新登录（保留未保存的编辑）；JSON/YAML/TOML/INI 实时语法校验与错误定位、JSON 格式化/压缩、JSON↔YAML↔TOML 互转；.env 可视化编辑（敏感值遮罩）；Markdown 预览；语法高亮视图可直接编辑；新建文件模板；页面内切换分支并可新建分支，其它分支也可设置公开链接；多口令与只读口令、提交署名与操作记录；保存前敏感信息扫描；全库搜索/替换（原子提交）；整库 zip 导出与 zip 导入（先预览差异）。
- 所有修改通过 GitHub REST API 写入仓库，并生成 Commit；更新/删除带文件 SHA，避免盲目覆盖。
- 生成 GitHub Raw 直连、jsDelivr 分支 CDN、jsDelivr Commit 固定版本、Worker 代理和 Worker 固定版本链接。
- 可粘贴本仓库的 GitHub `blob` / Raw / jsDelivr 分支 / Worker 链接，自动定位到文件。
- 无数据库；静态前端由 Workers Static Assets 提供，后台由 Worker 提供。
- 管理 API 需 `ADMIN_TOKEN`；GitHub PAT 仅在 Worker 后端使用；公开下载代理不携带 PAT。

## 重要：公开仓库与私有仓库

**公开链接（`/file/…`、GitHub Raw、jsDelivr）只适用于公开 GitHub 仓库。** 公开代理请求 `raw.githubusercontent.com` 时**绝不携带** `GITHUB_TOKEN`，不会借 PAT 泄露私有内容。私有仓库的文件请使用「令牌链接」（16 位令牌、可设有效期、可通过提升文件版本撤销，见第 4 节）；需要按文件/目录开放时，用 `DIRECT_PATHS` 配置免令牌直链、仅令牌访问或禁止。

**不要把订阅凭据、API 密钥、私钥、带认证 Token 的私人订阅链接放进公开仓库。** 即使删除，Git 历史和第三方 CDN 缓存仍可能保留旧内容。

## 1. 准备

- Cloudflare 账户（免费版即可）。
- 一个你有写权限的 GitHub 仓库（公开或私有均可），建议单独建一个小型仓库存放配置。
- GitHub fine-grained Personal Access Token：Repository access 选**指定仓库**，权限只给 `Contents: Read and write`。
- 手动部署还需要 Node.js 20+。

## 2. 部署方式一：一键部署（推荐，无需本地环境）

1. 点击页面顶部的 **Deploy to Cloudflare** 按钮，授权 GitHub 后 Cloudflare 会把本项目复制到你的账户下。
2. 在部署页按提示填写（这些值保存在 Cloudflare，之后的部署不会覆盖）：
   - 变量：`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`、`ROOT_DIR`、`PUBLIC_FILES`、`CACHE_TTL`（每项都有说明，默认值可直接用）。
   - 密钥：`GITHUB_TOKEN`（上面的 PAT）、`ADMIN_TOKEN`（登录管理面板的口令，建议 32 位以上随机字符串，可用 `openssl rand -base64 32` 生成）。
3. 点击部署，完成后打开 `https://<worker名>.<你的子域>.workers.dev/`，输入 `ADMIN_TOKEN` 登录。

> 以后修改变量/密钥：Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Variables and Secrets。

## 3. 部署方式二：手动部署（向导脚本）

```bash
git clone https://github.com/fansys/cf-config-hub.git && cd cf-config-hub
npm install
npm run setup
```

`npm run setup` 会依次：检查 Node/wrangler → 引导登录 Cloudflare → 询问仓库信息 → 询问 `GITHUB_TOKEN`（输入时不回显），`ADMIN_TOKEN` 留空则自动生成强随机口令 → 部署（首次通过 `--var` 把变量写进 Cloudflare）→ 用 `wrangler secret bulk` 写入密钥 → 请求线上 `/api/info` 验证 → 打印访问地址和（自动生成的）管理口令。

**部署不会修改环境变量。** `wrangler.toml` 里不再声明 `[vars]`，并设置了 `keep_vars = true`：此后无论 `npm run deploy`、`wrangler deploy` 还是 Git 推送触发的构建，都不会覆盖或删除你在 Cloudflare 控制台（Workers & Pages → 本 Worker → Settings → Variables and Secrets）里维护的变量与密钥。向导也不会改写 `wrangler.toml`，只会把变量记到本地 `.dev.vars`（已被 git 忽略）。要改线上变量，直接在控制台修改即可。

常用选项与环境变量：

| 用法 | 说明 |
| --- | --- |
| `npm run setup -- --no-deploy` | 只记录配置，不部署 |
| `npm run setup -- --no-vars` | 不设置变量，沿用控制台里已有的值（首次之后换密钥/重装时用） |
| `npm run setup -- --yes` | 非交互模式，缺少必填环境变量时直接报错（适合 CI） |
| `GITHUB_OWNER` `GITHUB_REPO` `GITHUB_BRANCH` `ROOT_DIR` `PUBLIC_FILES` | 预先提供即可跳过对应提问 |
| `GITHUB_TOKEN` `ADMIN_TOKEN` | 同上；`ADMIN_TOKEN` 不提供则自动生成 |
| `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ACCOUNT_ID` | CI 中代替 `wrangler login` |

**完全手动**也可以：

```bash
npx wrangler login
npm run deploy                      # 部署前先运行 doctor 自检，不会改动控制台变量
# 首次需要在控制台（或用命令）设置变量与密钥：
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
# GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH / ROOT_DIR / PUBLIC_FILES / CACHE_TTL 在控制台添加为变量
```

首次部署时若 `secret put` 提示 Worker 不存在，先执行一次 `npm run deploy` 即可。密钥不要写进 `wrangler.toml`。

**部署前自检**：`npm run doctor` 检查 Node 版本、依赖，以及本地可见变量（环境变量 / `.dev.vars`）的格式；若 `.dev.vars` 里有令牌，还会探测仓库/分支是否存在、令牌是否有写权限、私有仓库是否误开了公开代理。线上变量它看不到，只会提示你确认控制台已配置。

### 本地开发

```bash
cp .dev.vars.example .dev.vars           # 本地开发环境变量（npm run dev 使用）
cp .dev.vars.example .dev.vars.preview   # （可选）本地 preview 独立环境变量（npm run preview / npm run dev:preview 使用）
npm install
npm run dev          # Vite 5173 + wrangler 8787（读取 .dev.vars）。页面打开 http://127.0.0.1:5173
npm run dev:preview  # Vite 5173 + wrangler 8787（优先读取 .dev.vars.preview，未创建则回退 .dev.vars）
npm run preview      # 构建前端并用 wrangler dev --env preview 本地预览构建产物
```

前端需要构建后才能部署：`npm run build` 产出 `dist/client`，`npm run deploy` 会先构建再通过 `wrangler deploy --keep-vars` 发布（`wrangler.toml` 顶层也配置了 `keep_vars = true`，绝不覆盖生产环境变量）。一键部署的 Build command 用 `npm run build`，Deploy command 用 `npx wrangler deploy --keep-vars`。

`.dev.vars` 与 `.dev.vars.*`（含 `.dev.vars.preview`）均已被 `.gitignore` 忽略。

### 自定义域名与访问保护

Cloudflare Dashboard → Workers & Pages → Worker → Settings → Domains & Routes → 添加 Custom Domain。

建议把管理面板与公开文件代理分到不同域名/Worker。若用 Cloudflare Access 保护整个域名，需要给 `/file/*` 单独设置放行策略，否则下载端也会被拦截。

## 4. 私有仓库的文件链接

私有仓库的文件无法通过 GitHub Raw / jsDelivr 访问，本工具提供两种方式，均由 Worker 用 `GITHUB_TOKEN` 代为读取：

**令牌链接（推荐）**：点击编辑器里的「获取文件链接」→「令牌链接」，选择范围和有效期即可生成：

| 项目 | 说明 |
| --- | --- |
| 生成范围 | 仅此文件，或同目录 / 目录及子目录下的全部文件（批量，单次最多 100 个，每个文件各一条链接） |
| 有效期 | 快捷项：1 天、7 天、30 天、180 天、1 年、永久；也可自定义 1–365 天 |

**令牌格式**（共 16 个字符）：`<10 位 hex><6 位分钟数>`

- **6 位分钟数**：到期时间，从 `2026-01-01 00:00 UTC` 起算的分钟数，补零到 6 位；`000000` 表示永久有效（6 位最多表示约 694 天，所以有效期上限取 365 天）。
- **10 位 hex**：`HMAC-SHA256(密钥, 仓库 | 文件名 | 文件版本 | 6 位分钟数)` 的前 10 位（40 位）。**文件版本不写在令牌里**，由服务端从版本表读取后参与验签。

例如：`https://你的域名/t/3f9a1c07be525600/clash/a.list`（也支持 `/file/clash/a.list?token=3f9a1c07be525600`）。令牌只对签发时的那个文件有效（文件名参与签名）；改令牌里的分钟数、换文件或换版本，签名都会对不上。

**撤销 = 更新文件版本**：版本表保存在管理目录里的 `.cfhub-links.json`（一次提交，可在 Git 历史追溯；该文件不会出现在文件列表，也不能被直接读写）。一个文件当前的链接版本 = `全局偏移 + 该文件版本（默认 1）`。

- 「撤销此文件的链接」：该文件版本 +1，之前为它生成的所有令牌立即对不上；重新生成的新链接带新版本，可正常使用。
- 「撤销全部文件的链接」：全局偏移 +1，所有文件的旧链接全部失效。
- 版本表读取在 Worker 里缓存 `LINK_VERSION_TTL` 秒（默认 30），所以撤销最长约 30 秒后全球生效；读不到版本表时一律拒绝访问（失败即关闭）。边缘缓存里即使还有文件内容，也要先通过令牌校验才会返回。
- 「检查令牌」可以粘贴令牌或完整链接，显示有效 / 已过期 / 已撤销（并给出令牌版本与当前版本）/ 无效。

**限制与取舍**：
- 令牌里没有分支信息：默认分支的令牌不带 `?b=`，其它分支的令牌必须带 `?b=<分支>`（分支名参与签名）。
- 令牌不含范围通配、IP 白名单、固定 commit 等规则：一个令牌 = 一个文件；固定内容的需求请直接分享 jsDelivr 固定版本链接（公开仓库）或在需要时撤销重发。
- hex 只有 10 位（40 位），换来更短的链接。为防暴力猜测，同一来源 5 分钟内累计 30 次无效尝试会被拒绝（429）；仍建议对敏感文件设置较短有效期。重命名文件后旧文件名下的链接不会自动迁移，需要重新生成。
- **签名密钥**：设置 Secret `LINK_SECRET`（推荐）；未设置时由 `ADMIN_TOKEN` 派生，此时更换口令会让已发出的链接全部失效。
- 令牌出现在 URL 里，可能被日志或代理记录；持有令牌的人就能读取对应文件，请谨慎分发。

**按文件 / 目录开放访问（访问规则，保存在 KV）**：决定哪些文件可以免令牌直链、哪些必须带令牌、哪些禁止。在「获取文件链接」弹窗里点「管理访问规则…」即可增删改，保存后写入 Workers KV（绑定名 `CONFIG_KV`，`wrangler.toml` 已声明，首次部署时由 wrangler / 一键部署自动创建；若你的 wrangler 不支持自动创建，先执行 `npx wrangler kv namespace create CONFIG_KV`，把返回的 `id` 填进 `wrangler.toml` 的 `[[kv_namespaces]]`）。

- **来源与优先级**：KV 里保存过规则（哪怕是空列表）就以 KV 为准；KV 里还没有时回退到环境变量 `DIRECT_PATHS`（旧配置、初始值），编辑器里保存一次后即迁移到 KV。没有绑定 KV 时规则只读，来自 `DIRECT_PATHS`。
- **生效延迟**：KV 最终一致，修改后全球生效最长约 1 分钟；Worker 内另有 `ACCESS_CACHE_TTL`（默认 10 秒）内存缓存。读不到规则时，令牌访问返回 503，免令牌直链不开放（失败即关闭）。
- **权限**：只读口令可以查看规则，不能修改；规则按 `仓库/管理目录/分支` 保存，各分支独立。

规则的写法（界面里逐条填写；环境变量 `DIRECT_PATHS` 使用同样语法，逗号分隔 `规则[:模式]`）：

| 写法 | 含义 |
| --- | --- |
| `clash/a.list:direct` | 单个文件，免令牌直链：`/file/clash/a.list` 直接可读（需 `PUBLIC_FILES=true`），同时也允许令牌访问 |
| `clash/:direct` | 整个目录（含子目录），以 `/` 结尾；等同 `clash/**` |
| `docs/:token` | 整个目录仅令牌访问：必须带有效令牌 |
| `clash/secret/:deny` | 禁止：比上级目录 `clash/` 更具体，所以只关闭这个子目录 |
| `clash/*.list:token` | 通配：`*` 匹配单层，`**` 匹配多层，`?` 单个字符 |
| `**:token` | 全部文件开放令牌访问（不产生免令牌直链） |

省略模式时默认 `direct`。规则路径都相对管理目录。

**多条规则同时命中时，取最具体（粒度最小）的一条**，与书写顺序无关：精确文件 > 更深的目录 > 单层通配（`*`）> 递归通配（`**` / 目录）。例如 `clash/:direct` 加 `clash/abc.list:token`：`clash/` 下的文件免令牌直链，唯独 `clash/abc.list` 需要令牌；`a/:deny` 加 `a/ok.txt:token`：`a/` 下默认禁止，只有 `a/ok.txt` 凭令牌可访问。完全同样具体（如同一路径写了两种模式）时，取更保守的：`deny` > `direct` > `token`。

- **白名单语义**：一旦配置了任何规则，没有命中 `direct` / `token` 的文件就**不能**凭令牌访问，也**不能**为它们生成链接（接口返回 403 并给出建议的规则）。规则变更后，已发出的令牌对未开放文件立即失效，不需要撤销。
- **完全不配置**：保持宽松——令牌可访问任意文件，没有免令牌直链。已经在用 `DIRECT_PATHS=规则` 旧写法的部署，其规则等价于 `规则:direct`；但请注意此时令牌访问也只对命中规则的文件开放，需要的话加一条 `**:token`。
- **直接在文件 / 目录上设置**：文件树里每个文件和目录右侧都有 ⚙（鼠标悬停显示），编辑器「更多 ▾ → 访问设置」也能打开。弹窗里选「继承上级 / 免令牌直链 / 仅令牌访问 / 禁止访问」，会实时预览保存后的结果（目录会统计其中各种访问方式的文件数），保存时只改这一条规则，其它规则不动；选「继承上级」即删除这条规则。文件树角标：不能直接访问的文件显示 🔒，规则允许令牌访问的显示 🔗，能直接访问的不显示。公开仓库不显示角标。没配规则时文件显示 🔒，目录本身不显示。
- 「获取文件链接」弹窗顶部显示该文件当前的访问策略和命中的规则；批量生成链接时会自动跳过未开放的文件。顶部「更多 ▾ → 文件访问规则」可以查看并批量编辑全部规则。
- 免令牌直链等于有意公开这些文件，请只对确实可以公开的内容使用 `direct`。

**规则文件的目录约定与互转**：路径中包含对应目录名的 `.list` / `.conf` 文件会自动进入可视化编辑：

| 目录名（不区分大小写） | 格式 | 规则写法 |
| --- | --- | --- |
| `Clash/` | Clash 规则列表（`.ini` 为订阅增强） | `DOMAIN-SUFFIX,example.com,Proxy` |
| `QuantumultX/`（也识别 `qx/`） | QuantumultX 规则列表 | `HOST-SUFFIX,example.com,Proxy` |
| `Shadowrocket/`（目录名固定） | Shadowrocket 规则列表 | `DOMAIN-SUFFIX,example.com,PROXY` |
| `Loon/`（目录名固定） | Loon 规则列表 | `DOMAIN-SUFFIX,example.com,PROXY` |

可视化面板「更多 ▾ → 转为 … 规则」可在四种格式间两两互转，结果作为新文件打开（默认路径把目录换成目标格式的固定目录名 `Clash` / `QuantumultX` / `Shadowrocket` / `Loon`），保存后才提交，原文件不动：

- 类型自动对应（如 `DOMAIN-SUFFIX` ↔ `HOST-SUFFIX`，`MATCH` ↔ `FINAL`，`SRC-IP-CIDR` ↔ `SRC-IP`），策略名换成目标写法（`Proxy` / `PROXY`、`Direct` / `DIRECT`、`Reject` / `REJECT`），`no-resolve` 等附加选项、注释、空行、换行符都会保留。
- 目标格式不支持的规则（如 Clash 没有 `USER-AGENT`、QuantumultX 没有 `PROCESS-NAME`、Shadowrocket 没有 `DOMAIN-REGEX`）不会被丢弃，而是保留为 `# [未转换] 原文` 的注释行，并在提示里统计。
- 你自己的策略组名（如「🚀 节点选择」）原样保留，转换后请确认目标客户端里存在同名策略。

## 5. 使用场景与进阶配置

**多人协作与权限**（均为可选 Secrets，在控制台添加即可，部署不会覆盖）

| 变量 | 作用 |
| --- | --- |
| `READONLY_TOKEN` | 只读口令：可浏览、搜索、导出，界面自动隐藏所有写操作，服务端同样拒绝写入（403） |
| `USERS` | 多人口令，逗号分隔的 `name:rw\|ro:token`，如 `alice:rw:xxx,bob:ro:yyy`。非 `admin` 用户产生的提交说明会附带 `Edited-by: alice`，在「操作记录」里按人显示 |

「操作记录」直接读取分支的提交历史，不需要额外存储；署名只是提交说明里的一行文字，不具备防篡改效力，需要强审计请开启 GitHub 的分支保护与审计日志。

**切换分支**：侧栏「⎇ 分支」可以切换分支，也能基于所选分支新建分支。**仓库与管理目录固定为部署配置，不能在页面里切换**（带不同仓库或目录的请求会被拒绝，403）。分支选择只保存在本浏览器，不改动部署变量。

**其它分支也可以设置公开链接**：在任何分支上都能设置访问规则、生成令牌链接、复制 Worker 链接，链接会带上 `?b=<分支>`，例如 `https://你的域名/t/<令牌>/clash/a.list?b=dev`、`/file/clash/a.list?b=dev`。

- **规则按分支独立**：默认分支的规则沿用原来的存储键（并可回退到环境变量 `DIRECT_PATHS`）；其它分支各自单独保存、互不继承。其它分支没有规则时没有免令牌直链，令牌也只对管理员主动签发的链接有效——因此开放默认分支的目录，不会让其它分支的同名文件被公开。
- **令牌绑定分支**：非默认分支的令牌把分支名也纳入签名，必须带 `?b=` 访问；默认分支的令牌格式不变，已发出的链接不受影响。各分支的链接版本相互独立，撤销某个分支上的文件链接不影响其它分支。
- **版本表始终放在默认分支**：`.cfhub-links.json` 只写默认分支，其它分支的版本记在 `branches.<分支>` 下，不会往其它分支里提交元数据。
- 公开代理（无令牌）在公开仓库上本来就能读取任意分支；`?b=` 只是指定分支。

**保存前的敏感信息检查**：保存时在本地扫描本次**新增**的内容（GitHub/AWS/Slack/Google 令牌、私钥、JWT、URL 中的凭据参数与用户名密码、疑似密钥赋值），命中会弹窗确认；仓库不是私有时提示更强烈。内容不会离开浏览器；占位符和 `${VAR}` 引用不会误报。

**全库搜索 / 替换**：支持普通、正则（替换可用 `$1`）、区分大小写、全词、路径过滤；只搜索 512 KiB 以下的文本文件。「全部替换」会先列出受影响文件，确认后以**一次原子提交**写回（超过 50 个文件或 2.5 MiB 自动分批）。

**备份与迁移**：「导出/导入」可下载整个分支的 zip；导入 zip 时先预览新增/覆盖/未变化，内容完全相同的文件自动跳过，确认后原子提交。

**通用配置文件**：`.json/.yaml/.yml/.toml/.ini/.cfg` 编辑时实时校验，点击错误提示可跳到出错行；JSON 可一键格式化/压缩；JSON、YAML、TOML 可互转为新文件（注释不会保留）。`.env*` 文件用可视化编辑，名称含 `PASSWORD/SECRET/TOKEN/KEY` 的值默认遮罩。`.md` 文件有安全的预览模式（不渲染原始 HTML，仅允许 http(s)/mailto 链接）。新建文件时会按扩展名提供模板。

## 6. 文件链接

假设 `GITHUB_OWNER=alice`、`GITHUB_REPO=my-config`、`GITHUB_BRANCH=main`、`ROOT_DIR=configs`，管理面板中所见文件 `clash/main.yaml` 的仓库实际路径是 `configs/clash/main.yaml`。

| 类型 | 地址示例 |
| --- | --- |
| GitHub Raw | `https://raw.githubusercontent.com/alice/my-config/main/configs/clash/main.yaml` |
| jsDelivr 分支 | `https://cdn.jsdelivr.net/gh/alice/my-config@main/configs/clash/main.yaml` |
| jsDelivr 固定 Commit | `https://cdn.jsdelivr.net/gh/alice/my-config@<40位commit SHA>/configs/clash/main.yaml` |
| Worker 稳定代理 | `https://config.example.com/file/clash/main.yaml` |
| Worker 固定版本 | `https://config.example.com/file/clash/main.yaml?v=<40位commit SHA>` |

说明：

1. `ROOT_DIR` 只在 Worker `/file/` 地址中省略；GitHub Raw / jsDelivr 地址使用仓库中的完整实际路径。
2. jsDelivr 的 `cdn.jsdelivr.net` 是多 CDN 网络，实际可使用 Fastly 或 Cloudflare，并不保证固定提供商。分支类型可能缓存约 12 小时；Commit 固定版属于不可变版本，**每次更新需换成新 Commit SHA URL**。
3. Worker 稳定代理默认仅缓存约 60 秒，可通过 `CACHE_TTL` 调整；固定版本链接的 `v=` 参数必须是 40 位 Commit SHA。
4. Worker 的缓存是按边缘数据中心建立的，`Cache API` 并非自动全球同步。编辑后如需立即读取新版，优先使用新 Commit 固定链接，而非依赖手动清除全网缓存。
5. 面板使用 GitHub Contents API 管理文件，单个上传/编辑的文件大小限制为 **768 KiB**。不支持直接在线修改大文件、符号链接和 GitHub Actions Workflow。
6. GitHub `git/trees?recursive=1` 接口对超大仓库有截断限制；本工具会在发现 `truncated=true` 时给出错误。建议使用独立的小型配置仓库。
7. 当前最适合简单的 `main`/`master` 分支；带斜杠的复杂分支名称涉及 GitHub Raw 地址解析差异，建议先验证后投入使用。

## 7. 接口说明

管理接口必须在请求头传入：

```
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/info`：仓库元信息（无需口令）；包括是否私有、目录范围、公开代理开关，以及 `configured`（两个 Secret 是否已设置，不含密钥本身）。
- `GET /api/files`：递归文件列表及最新 Commit SHA。
- `GET /api/file?path=clash/main.yaml`：读取文件（Base64 内容、SHA）。
- `PUT /api/file?path=clash/main.yaml`：创建/更新文件，JSON `{"content":"<Base64>","sha":"<已有文件的blob SHA>","message":"..."}`；新增时不传 `sha`。
- `DELETE /api/file?path=clash/main.yaml`：删除文件，JSON `{"sha":"<当前blob SHA>","message":"..."}`。
- `POST /api/rename`：重命名/移动文件或目录，JSON `{"from":"clash/a.list","to":"rules/a.list","kind":"file"}`（目录用 `"kind":"dir"`）。通过 Git Data API 在**一次提交**内原子完成，目录会递归移动；目标已存在、移入自身子目录、涉及 Actions 工作流或 Git 子模块会被拒绝。
- `GET /api/history?path=clash/a.list`：该文件最近 20 次提交（sha、首行说明、作者、时间）。`GET /api/file?path=...&ref=<40位commit SHA>` 可读取历史版本。
- `DELETE /api/dir`：删除整个目录，JSON `{"path":"clash"}`，一次提交完成；含 Actions 工作流的目录会被拒绝。
- `GET /api/context`：当前生效的仓库/分支/目录、`me`（用户名与角色）、`defaults`、`isDefault`（是否在默认分支）。请求头 `X-Cfh-Branch`（URI 编码）可切换分支；`X-Cfh-Repo` / `X-Cfh-Root` 与部署配置不一致时返回 403。
- `GET /api/branches`、`POST /api/branch`（`{"name":"feature/x","from":"main"}`）：分支列表与新建分支。
- `POST /api/commit`：多文件原子提交，`{"message":"…","changes":[{"path":"a.txt","content":"文本"},{"path":"b.bin","base64":"…"}],"deletes":["old.txt"]}`；单次最多 50 个文件、3 MiB；内容未变化的文件自动跳过。
- `GET /api/activity`：分支最近 30 次提交（含 `Edited-by` 署名）。`GET /api/export`：下载分支 zip。
- 写操作（PUT / POST / DELETE）需要 `rw` 角色，只读口令返回 403。
- `POST /api/access/set`：只改一条规则，`{"pattern":"clash/","mode":"token"}`（`mode` 为 `null` 表示删除这条规则、恢复继承；目录写法以 `/` 结尾），服务端读最新值再写，避免覆盖他人的修改。
- `GET /api/access`：当前生效的访问规则、来源（`kv` / `env`）、KV 是否可用；`PUT /api/access`（`{"rules":[{"pattern":"clash/","mode":"direct"}]}`，需读写角色）覆盖保存到 KV。
- `POST /api/links`：批量签发 `{"paths":["clash/a.list","clash/b.list"],"expiresIn":604800}`，返回每个文件的 `token`（`expiresIn` 秒，省略 = 永久，60 秒–365 天；需读写角色，仅默认目标）。`POST /api/links/revoke`（`{"path":"clash/a.list"}` 或 `{"all":true}`）提升文件版本即撤销；`GET /api/links/versions` 版本表；`GET /api/links/inspect?path=…&token=…` 检查令牌。
- `GET /file/clash/main.yaml`：无鉴权的公开文件代理（需 `PUBLIC_FILES=true`；不携带 GitHub 令牌，上游超过 5 MiB 会拒绝）。
- `GET /file/clash/main.yaml?v=<40位commit SHA>`：读取特定 Git 版本（需开启公开代理）。

**安全建议**

- 为 `ADMIN_TOKEN` 使用随机强口令；切勿把 Token 复制进公开文件或 URL。
- PAT 的权限仅授予目标仓库的 `Contents: Read and write`；定期更换、设置有效期。
- 后台前端不会将 GitHub PAT 暴露给浏览器。ADMIN_TOKEN 登录口令可选择暂存浏览器当前标签页的 `sessionStorage`；共用电脑请不要勾选“保留登录”。
- 对更高安全要求，可另外配置 Cloudflare Access、WAF/速率限制和独立管理子域名。

## 8. 测试

```bash
npm test
```

无需网络，覆盖：管理鉴权与失败限流、ROOT_DIR 隔离、读写删、路径穿越、公开代理（缓存、固定版本、**不携带令牌**、体积上限）、Clash/QX/ini 解析器**往返保真**（未改动内容逐字节一致）、部署脚本与一键部署元数据完整性。这些是模拟测试，不能替代部署后的真实 GitHub/Cloudflare 联调；部署后可再运行 `npm run setup` 的验证步骤，或访问 `/api/info` 确认 `configured` 均为 `true`。

## 9. 项目结构

```
src/                Worker 入口、鉴权、GitHub API、公开代理
shared/             无 DOM 的解析、diff、lint、zip、markdown（Node 测试直接 import）
client/             Vue 3 + Vite 管理界面
  index.html        入口；head 里的 /boot.js 必须是阻塞经典脚本
  src/features/     登录、文件树、CodeMirror、可视化、链接与搜索
scripts/            setup.mjs（部署向导）、doctor.mjs（自检）、lib.mjs
tests/              node:test 测试
```

管理界面用 Vue 3、Vite、Tailwind CSS 和 Reka UI。登录口令默认只保存在当前标签页（sessionStorage），勾选「保持登录」才写入 localStorage。`npm test` 不启动浏览器；发布前要先 `npm run build`。

## 参考文档

- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [GitHub REST API — Contents](https://docs.github.com/en/rest/repos/contents)
- [GitHub REST API — Trees](https://docs.github.com/en/rest/git/trees)
- [jsDelivr GitHub CDN 文档](https://www.jsdelivr.com/documentation)
