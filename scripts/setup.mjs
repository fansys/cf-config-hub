#!/usr/bin/env node
/**
 * 手动部署向导：npm run setup
 *
 * 流程：环境检查 → 登录 Cloudflare → 收集变量 → 部署（首次通过 --var 写入变量）→ 设置 Secrets → 自检线上服务
 *
 * 变量只会写入 Cloudflare（以及本地 .dev.vars），**不会改动 wrangler.toml**；wrangler.toml 里 keep_vars = true，
 * 之后的任何部署都不会覆盖或删除你在控制台里维护的变量与密钥。
 *
 * 选项：
 *   --no-deploy       只记录配置，不部署
 *   --no-vars         不设置变量（控制台已配置好时使用；部署完全不触碰变量）
 *   --yes, -y         非交互：全部从环境变量读取（见下），缺失即报错，适合 CI
 *
 * 环境变量（非交互或想跳过提问时使用）：
 *   GITHUB_OWNER GITHUB_REPO GITHUB_BRANCH ROOT_DIR PUBLIC_FILES
 *   GITHUB_TOKEN ADMIN_TOKEN（未提供 ADMIN_TOKEN 时自动生成随机口令）
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（CI 场景下代替 wrangler login）
 */
import { existsSync } from 'node:fs';
import { doctor } from './doctor.mjs';
import {
  DEV_VARS, appendDevVars, ask, c, confirm, isInteractive, log, npx, randomToken, readVars,
} from './lib.mjs';

const args = new Set(process.argv.slice(2));
const noDeploy = args.has('--no-deploy');
const noVars = args.has('--no-vars');
const nonInteractive = args.has('--yes') || args.has('-y') || !isInteractive();

function fail(msg) {
  log.err(msg);
  process.exit(1);
}

/** 优先环境变量 → 非交互时用默认值/报错 → 交互提问。 */
async function value(name, question, { def = '', secret = false, required = false } = {}) {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  if (nonInteractive) {
    if (required && !def) fail(`非交互模式下缺少环境变量 ${name}`);
    return def;
  }
  for (;;) {
    const v = await ask(question, { defaultValue: def, secret });
    if (v || !required) return v;
    log.warn('此项必填');
  }
}

/* ---------- 1. 环境 ---------- */

async function checkEnvironment() {
  log.step('检查环境');
  if (Number(process.versions.node.split('.')[0]) < 20) fail(`需要 Node.js 20+，当前 ${process.versions.node}`);
  log.ok(`Node.js ${process.versions.node}`);

  const r = await npx(['--version'], { capture: true, quiet: true });
  if (r.code !== 0) fail('无法运行 wrangler，请先执行 npm install，并确认网络可访问 npm');
  log.ok(`wrangler ${r.stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? ''}`);
}

/* ---------- 2. Cloudflare 登录 ---------- */

async function ensureLogin() {
  log.step('检查 Cloudflare 登录状态');
  if (process.env.CLOUDFLARE_API_TOKEN) { log.ok('使用环境变量 CLOUDFLARE_API_TOKEN'); return; }
  const who = await npx(['whoami'], { capture: true, quiet: true });
  if (who.code === 0 && !/not authenticated/i.test(who.stdout)) { log.ok('已登录 Cloudflare'); return; }
  if (nonInteractive) fail('未登录 Cloudflare：请设置 CLOUDFLARE_API_TOKEN，或先运行 npx wrangler login');
  log.info('即将打开浏览器完成授权…');
  if ((await npx(['login'])).code !== 0) fail('登录失败');
}

/* ---------- 3. 配置 ---------- */

async function collectConfig() {
  log.step('配置 GitHub 仓库');
  const cur = readVars(); // 环境变量 > .dev.vars
  const cfg = {
    GITHUB_OWNER: await value('GITHUB_OWNER', 'GitHub 用户名/组织名', { def: cur.GITHUB_OWNER, required: true }),
    GITHUB_REPO: await value('GITHUB_REPO', '存放配置的仓库名', { def: cur.GITHUB_REPO, required: true }),
    GITHUB_BRANCH: await value('GITHUB_BRANCH', '分支', { def: cur.GITHUB_BRANCH || 'main' }),
    ROOT_DIR: await value('ROOT_DIR', '只管理的子目录（留空=整个仓库）', { def: cur.ROOT_DIR }),
    PUBLIC_FILES: await value('PUBLIC_FILES', '启用公开文件代理 /file/（仅公开仓库有效）true/false', { def: cur.PUBLIC_FILES || 'true' }),
    CACHE_TTL: cur.CACHE_TTL || '60',
  };
  cfg.ROOT_DIR = cfg.ROOT_DIR.replace(/^\/+|\/+$/g, '');
  if (/["\\\n]/.test(Object.values(cfg).join(''))) fail('变量中不能包含引号、反斜杠或换行');
  return cfg;
}

async function collectSecrets() {
  log.step('配置密钥（仅保存到 Cloudflare Secrets，不会写入仓库文件）');
  if (!nonInteractive) {
    log.info('GITHUB_TOKEN：fine-grained PAT，仅授权目标仓库的 Contents: Read and write');
    log.info('ADMIN_TOKEN：登录管理面板的口令，直接回车将自动生成强随机口令');
  }
  const githubToken = await value('GITHUB_TOKEN', 'GITHUB_TOKEN', { secret: true, required: true });
  if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_)/.test(githubToken)) log.warn('GITHUB_TOKEN 看起来不像 GitHub 令牌，请确认没有粘贴错');
  let adminToken = await value('ADMIN_TOKEN', 'ADMIN_TOKEN', { secret: true });
  let generated = false;
  if (!adminToken) { adminToken = randomToken(); generated = true; }
  else if (adminToken.length < 16) log.warn('ADMIN_TOKEN 较短，建议 16 位以上（越长越安全）');
  return { githubToken, adminToken, generated };
}

/* ---------- 4. 部署 ---------- */

async function deploy(cfg) {
  log.step('部署 Worker');
  // 变量通过 --var 只随本次部署写入；wrangler.toml 保持不变，keep_vars=true 保证后续部署不会清掉它们
  const varArgs = noVars ? [] : Object.entries(cfg).filter(([, v]) => v !== '').flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  if (noVars) log.info('--no-vars：不设置变量，沿用控制台里已有的值');
  const r = await npx(['deploy', ...varArgs], { capture: true });
  if (r.code !== 0) fail('部署失败，请查看上方 wrangler 输出');
  const url = r.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (url) log.ok(`已部署：${url}`);
  else log.warn('部署成功，但未能从输出中解析访问地址，请在 Cloudflare Dashboard 查看');
  return url;
}

async function putSecrets({ githubToken, adminToken }) {
  log.step('写入 Secrets');
  const r = await npx(['secret', 'bulk'], {
    input: JSON.stringify({ GITHUB_TOKEN: githubToken, ADMIN_TOKEN: adminToken }),
    capture: true,
  });
  if (r.code !== 0) fail('写入 Secrets 失败。可手动执行：npx wrangler secret put GITHUB_TOKEN / ADMIN_TOKEN');
  log.ok('GITHUB_TOKEN、ADMIN_TOKEN 已设置');
}

/* ---------- 5. 线上验证 ---------- */

async function verify(url) {
  log.step('验证线上服务');
  if (!url) { log.warn('跳过（没有访问地址）'); return false; }
  for (let i = 1; i <= 8; i++) {
    try {
      const res = await fetch(`${url}/api/info`, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.ok) {
        const info = await res.json();
        const miss = Object.entries(info.configured || {}).filter(([, ok]) => !ok).map(([k]) => k);
        if (miss.length) { log.warn(`尚未生效的 Secret：${miss.join(', ')}（可能还在传播，稍后刷新再试）`); }
        else log.ok(`服务正常：${info.owner}/${info.repo}@${info.branch}${info.private === null ? '' : info.private ? '（私有仓库）' : '（公开仓库）'}`);
        if (info.private && info.publicFiles) log.warn('私有仓库的公开代理不可用，建议将 PUBLIC_FILES 设为 "false"');
        return !miss.length;
      }
    } catch { /* workers.dev 子域刚创建时 DNS 可能还没生效 */ }
    await new Promise(r => setTimeout(r, 2500));
  }
  log.warn('暂时无法访问，workers.dev 域名可能还在生效，请稍后手动打开访问地址确认');
  return false;
}

function writeDevVars({ githubToken, adminToken }) {
  const before = existsSync(DEV_VARS);
  appendDevVars({ GITHUB_TOKEN: githubToken, ADMIN_TOKEN: adminToken });
  if (!before) log.ok('已创建 .dev.vars（本地开发用，已被 .gitignore 忽略）');
}

/* ---------- main ---------- */

console.log(c.bold('\nCloudflare Config Hub · 部署向导'));
await checkEnvironment();
if (!noDeploy) await ensureLogin();

const cfg = noVars ? {} : await collectConfig();
if (!noVars) {
  appendDevVars(cfg); // 仅追加到本地 .dev.vars（已被 git 忽略），方便本地开发与下次默认值
  const { errors } = await doctor({ probe: false });
  if (errors.length) fail('配置有误，请修正后重新运行');
}

const secrets = await collectSecrets();
writeDevVars(secrets);

if (noDeploy) {
  log.ok('配置完成（--no-deploy）。之后运行 npm run deploy 部署；线上变量请在 Cloudflare 控制台设置，或去掉 --no-deploy 重新运行本向导。');
  process.exit(0);
}

if (!nonInteractive && !(await confirm('现在部署到 Cloudflare？'))) process.exit(0);

const url = await deploy(cfg);
await putSecrets(secrets);
await verify(url);

console.log(`\n${c.bold('完成 🎉')}`);
if (url) console.log(`  管理面板：${c.cyan(url)}`);
if (secrets.generated) {
  console.log(`  管理口令：${c.yellow(secrets.adminToken)}  ${c.dim('← 自动生成，仅显示这一次，请立即保存')}`);
} else {
  console.log('  管理口令：你刚才输入的 ADMIN_TOKEN');
}
console.log(c.dim('  之后重新部署（npm run deploy）不会改动控制台里的变量和密钥。'));
