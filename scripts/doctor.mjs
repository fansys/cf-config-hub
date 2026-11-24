#!/usr/bin/env node
/**
 * 部署前自检：npm run doctor
 *   - Node 版本、依赖；本地可见变量（环境变量 / .dev.vars）的格式是否合法
 *   - （可选）若 .dev.vars 里有 GITHUB_TOKEN，实际探测仓库/分支是否可访问、权限是否足够
 *   线上变量由 Cloudflare 控制台维护，本脚本与部署都不会修改它们。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, c, log, parseDevVars, readVars, resolveDevVarsFile, validateVars } from './lib.mjs';

async function probeGitHub(vars, token) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'cf-config-hub-doctor', Authorization: `Bearer ${token}` };
  const base = `https://api.github.com/repos/${vars.GITHUB_OWNER}/${vars.GITHUB_REPO}`;
  const repo = await fetch(base, { headers });
  if (repo.status === 404) return { error: '仓库不存在，或 Token 没有访问该仓库的权限' };
  if (repo.status === 401) return { error: 'GITHUB_TOKEN 无效或已过期' };
  if (!repo.ok) return { error: `GitHub 返回 HTTP ${repo.status}` };
  const data = await repo.json();
  const branch = await fetch(`${base}/branches/${encodeURIComponent(vars.GITHUB_BRANCH)}`, { headers });
  if (!branch.ok) return { error: `分支 ${vars.GITHUB_BRANCH} 不存在` };
  return { private: !!data.private, canPush: data.permissions?.push };
}

export async function doctor({ probe = true, quiet = false, envName = '' } = {}) {
  const errors = [];
  const warnings = [];

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) errors.push(`Node.js 版本过低（${process.versions.node}），需要 20 或更高`);
  if (!existsSync(path.join(ROOT, 'node_modules', 'wrangler'))) warnings.push('尚未安装依赖，请先执行 npm install（npx 也会临时下载 wrangler，但会更慢）');

  // 变量只在 Cloudflare 控制台维护，部署不会改动。这里仅校验本地能看到的值（环境变量 / .dev.vars / .dev.vars.preview）。
  const devFile = resolveDevVarsFile(envName);
  const dev = parseDevVars(devFile);
  const vars = readVars(dev);
  const localKnown = !!(vars.GITHUB_OWNER || vars.GITHUB_REPO);
  if (localKnown) {
    errors.push(...validateVars({ ...vars, GITHUB_BRANCH: vars.GITHUB_BRANCH || 'main', PUBLIC_FILES: vars.PUBLIC_FILES || 'true' }));
  } else {
    warnings.push('本地没有变量信息（.dev.vars / 环境变量），已跳过变量校验。请确认 Cloudflare 控制台已配置 GITHUB_OWNER、GITHUB_REPO 等；部署不会修改它们');
  }

  if (!errors.length && localKnown && probe && dev.GITHUB_TOKEN && !/replace_me/.test(dev.GITHUB_TOKEN)) {
    try {
      const r = await probeGitHub(vars, dev.GITHUB_TOKEN);
      if (r.error) errors.push(r.error);
      else {
        if (r.canPush === false) errors.push('GITHUB_TOKEN 对该仓库没有写权限，请授予 Contents: Read and write');
        if (r.private && vars.PUBLIC_FILES === 'true') {
          warnings.push('仓库是私有的，但 PUBLIC_FILES="true"：公开代理读不到私有文件（不会携带令牌），建议改为 "false"');
        }
      }
    } catch (e) { warnings.push('无法连接 GitHub 进行探测：' + e.message); }
  } else if (!dev.GITHUB_TOKEN) {
    warnings.push('未发现 .dev.vars 中的 GITHUB_TOKEN，已跳过 GitHub 连通性探测（仅影响本地自检）');
  }

  if (!quiet || errors.length || warnings.length) {
    log.step('部署前自检');
    for (const w of warnings) log.warn(w);
    for (const e of errors) log.err(e);
    if (!errors.length) log.ok('配置检查通过');
  }
  return { errors, warnings };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('doctor.mjs')) {
  const envIdx = process.argv.findIndex(a => a === '--env' || a === '-e');
  const envName = envIdx >= 0 ? (process.argv[envIdx + 1] || '') : '';
  const { errors } = await doctor({ quiet: process.argv.includes('--quiet'), envName });
  if (errors.length) {
    console.error(`\n${c.red('自检未通过')}：请修正上述问题后重试（编辑 .dev.vars、控制台变量，或运行 npm run setup）。`);
    process.exit(1);
  }
}
