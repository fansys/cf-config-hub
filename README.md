# Cloudflare Config Hub

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fansys/cf-config-hub)

> 👆 点上面按钮直接在 Cloudflare Dashboard 里配置并部署。只需填 GitHub 仓库地址和环境变量（`GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_BRANCH`），密钥通过 Worker Secrets 设置（`GITHUB_TOKEN`、`ADMIN_TOKEN`）。

一个适合维护 YAML/JSON/TXT/Clash/QuantumultX 规则列表等配置文件的轻量级 GitHub 文件管理面板。

- GitHub 仓库/分支/子目录管理；文件树、搜索、在线 UTF-8 编辑、下载、新建、上传、删除。
- 所有修改通过 GitHub REST API 写入仓库，并生成 Commit；更新/删除带文件 SHA，避免盲目覆盖。
- 生成 GitHub Raw 直连、jsDelivr 分支 CDN、jsDelivr Commit 固定版本、Worker 代理和 Worker 固定版本链接。
- 可粘贴本仓库的 GitHub `blob` / Raw / jsDelivr 分支 / Worker 链接，自动定位到文件。
- 无数据库；静态前端由 Workers Static Assets 提供，后台由 Worker 提供。
- 管理 API 需 `ADMIN_TOKEN`；GitHub PAT 仅在 Worker 后端使用；公开下载代理不携带 PAT。

## 重要：公开仓库与私有仓库

**本工具的公开链接功能仅适用于公开 GitHub 仓库。** `PUBLIC_FILES=true` 时，`/file/...` 使用不带任何授权令牌的 `raw.githubusercontent.com` 请求；不会把私有仓库内容通过 PAT 泄露出来。私有仓库可使用管理后台编辑，但 Raw/jsDelivr/公开 Worker 代理链接无法获取私有文件。

**不要将订阅凭据、API 密钥、私钥、含认证 Token 的私人订阅链接等上传到公开仓库。** 即使删除，Git 提交历史以及第三方 CDN 缓存仍可能保存旧内容。

## 1. 环境准备

- Cloudflare 账户，已授权使用 Workers。
- Node.js（推荐 20 及以上）和 npm。
- 一个自己拥有写入权限的 GitHub 仓库，建议单独建立公开仓库存放可公开配置。
- GitHub fine-grained Personal Access Token：Repository access 选择**指定仓库**，授予 `Contents: Read and write`。不需要全仓库权限或管理权限。

## 2. 配置仓库

修改 `wrangler.toml`：

```toml
name = "github-config-manager"
main = "src/index.js"
compatibility_date = "2026-11-13"

[assets]
directory = "./public"

[vars]
GITHUB_OWNER = "your-github-name"
GITHUB_REPO = "config-repo"
GITHUB_BRANCH = "main"
ROOT_DIR = ""           # "" 表示管理整个仓库；"configs" 表示只管理 configs/ 子目录
PUBLIC_FILES = "true"  # 私有仓库请改为 "false"
CACHE_TTL = "60"       # Worker 可变分支链接缓存 TTL（秒）
```

**不要把真实 GitHub Token 和管理口令写入 `wrangler.toml`。** 它们必须配置为 Worker Secrets。

## 3. 部署

在项目目录执行：

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

每个 `secret put` 命令都会提示你在命令行输入密钥：

- `GITHUB_TOKEN`：上述 GitHub fine-grained PAT。
- `ADMIN_TOKEN`：自定义的高强度随机管理口令（建议 32 位以上随机值）。

**注意首次部署顺序：** 某些 Wrangler 环境要求 Worker 已创建后才能设置 Secret。如果 `secret put` 提示尚未创建 Worker，可先 `npx wrangler deploy` 创建实例，随后执行两条 `secret put`，再运行 `npx wrangler deploy` 验证部署配置。Secret 独立于普通 `vars`，请勿在 `.env` 公共文件里长期明文存放。

部署完成后打开 Worker 地址（一般是 `https://github-config-manager.<你的子域>.workers.dev/`），输入 `ADMIN_TOKEN` 登录。

### 本地开发

先复制一份 `.dev.vars.example` 到 `.dev.vars`，填入测试密钥后：

```bash
npm install
npm run dev
```

`.dev.vars` 已加入 `.gitignore`，不要上传到任何公开仓库。

### 绑定自定义域名

Cloudflare Dashboard → Workers & Pages → 当前 Worker → Settings / Domains & Routes → 添加 Custom Domain。例如 `config.example.com`。

建议将管理面板和公共文件代理分离到不同域名/独立 Worker；如使用 Cloudflare Access 保护整个管理域名，需要为公开 `/file/` 链接单独设置访问策略，否则下载端也会被 Access 拦截。

## 4. 文件链接

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

## 5. 接口说明

管理接口必须在请求头传入：

```
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/info`：仓库元信息；包括是否私有、目录范围、公开代理开关。
- `GET /api/files`：递归文件列表及最新 Commit SHA。
- `GET /api/file?path=clash/main.yaml`：读取文件（Base64 内容、SHA）。
- `PUT /api/file?path=clash/main.yaml`：创建/更新文件，JSON `{"content":"<Base64>","sha":"<已有文件的blob SHA>","message":"..."}`；新增时不传 `sha`。
- `DELETE /api/file?path=clash/main.yaml`：删除文件，JSON `{"sha":"<当前blob SHA>","message":"..."}`。
- `GET /file/clash/main.yaml`：无鉴权的公开文件代理（需 `PUBLIC_FILES=true`）。
- `GET /file/clash/main.yaml?v=<40位commit SHA>`：读取特定 Git 版本（需开启公开代理）。

**安全建议**

- 为 `ADMIN_TOKEN` 使用随机强口令；切勿把 Token 复制进公开文件或 URL。
- PAT 的权限仅授予目标仓库的 `Contents: Read and write`；定期更换、设置有效期。
- 后台前端不会将 GitHub PAT 暴露给浏览器。ADMIN_TOKEN 登录口令可选择暂存浏览器当前标签页的 `sessionStorage`；共用电脑请不要勾选“保留登录”。
- 对更高安全要求，可另外配置 Cloudflare Access、WAF/速率限制和独立管理子域名。

## 6. 自检

项目内有不需要网络连接的模拟 API 测试：

```bash
node tests/smoke.mjs
node --check src/index.js
node --check public/app.js
```

测试涵盖：管理鉴权、仓库信息、目录隔离、新建/读取/删除、路径穿越拦截、公开代理、缓存及公开功能关闭。该测试是模拟测试，不能替代部署后的真实 GitHub/Cloudflare 联调。

## 参考文档

- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [GitHub REST API — Contents](https://docs.github.com/en/rest/repos/contents)
- [GitHub REST API — Trees](https://docs.github.com/en/rest/git/trees)
- [jsDelivr GitHub CDN 文档](https://www.jsdelivr.com/documentation)
