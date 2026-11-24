/** setup / doctor 脚本共用的小工具（零依赖）。 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = code => s => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), dim: paint(2), bold: paint(1) };

export const log = {
  step: msg => console.log(`\n${c.bold(c.cyan('▸ ' + msg))}`),
  ok: msg => console.log(`${c.green('✔')} ${msg}`),
  warn: msg => console.log(`${c.yellow('!')} ${msg}`),
  err: msg => console.error(`${c.red('✘')} ${msg}`),
  info: msg => console.log(c.dim('  ' + msg)),
};

/* ---------- 变量来源：环境变量 > .dev.vars ---------- */
// 部署脚本绝不改写 wrangler.toml 里的变量（它已不含 [vars]）；线上变量只在 Cloudflare 控制台维护。

export const DEV_VARS = path.join(ROOT, '.dev.vars');
export const PREVIEW_DEV_VARS = path.join(ROOT, '.dev.vars.preview');
export const VAR_KEYS = ['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BRANCH', 'ROOT_DIR', 'PUBLIC_FILES', 'CACHE_TTL'];
export const SECRET_KEYS = ['GITHUB_TOKEN', 'ADMIN_TOKEN'];

export const readToml = () => readFileSync(WRANGLER_TOML, 'utf8');

/** 根据环境名解析对应的本地变量文件（例如 env='preview' 时优先读 .dev.vars.preview，不存在则回退 .dev.vars）。 */
export function resolveDevVarsFile(envName = '') {
  if (envName) {
    const candidate = path.join(ROOT, `.dev.vars.${envName}`);
    if (existsSync(candidate)) return candidate;
  }
  return DEV_VARS;
}

export function parseDevVars(file = DEV_VARS) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"#]*)"?\s*(?:#.*)?$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** 本地可见的变量（用于自检和首次部署）：环境变量优先，其次 .dev.vars（或指定环境的 .dev.vars.<env>）。 */
export function readVars(dev = parseDevVars(), env = process.env) {
  return Object.fromEntries(VAR_KEYS.map(k => [k, env[k] || dev[k] || '']));
}

/** 把缺失的非敏感变量追加到 .dev.vars（只追加、不覆盖已有项）。 */
export function appendDevVars(entries) {
  const have = parseDevVars();
  const lines = Object.entries(entries).filter(([k, v]) => v !== '' && !(k in have)).map(([k, v]) => `${k}="${v}"`);
  if (!lines.length) return;
  const prefix = existsSync(DEV_VARS) && !readFileSync(DEV_VARS, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(DEV_VARS, prefix + lines.join('\n') + '\n', { mode: 0o600 });
}

/* ---------- 配置校验（与 Worker 内的规则保持一致） ---------- */

export const PLACEHOLDER = /^YOUR_/;

export function validateVars(v) {
  const problems = [];
  if (!v.GITHUB_OWNER || PLACEHOLDER.test(v.GITHUB_OWNER)) problems.push('GITHUB_OWNER 还是占位符，请改成你的 GitHub 用户名/组织名');
  else if (!/^[A-Za-z0-9-]{1,39}$/.test(v.GITHUB_OWNER)) problems.push('GITHUB_OWNER 格式不正确（仅字母、数字、连字符）');
  if (!v.GITHUB_REPO || PLACEHOLDER.test(v.GITHUB_REPO)) problems.push('GITHUB_REPO 还是占位符，请改成存放配置的仓库名');
  else if (!/^[A-Za-z0-9._-]{1,100}$/.test(v.GITHUB_REPO)) problems.push('GITHUB_REPO 格式不正确');
  if (!v.GITHUB_BRANCH) problems.push('GITHUB_BRANCH 不能为空');
  if (v.ROOT_DIR && (/^\/|\/$|\.\.|\\/.test(v.ROOT_DIR))) problems.push('ROOT_DIR 不能以 / 开头或结尾，也不能包含 .. 或反斜杠');
  if (!['true', 'false'].includes(v.PUBLIC_FILES)) problems.push('PUBLIC_FILES 必须是 "true" 或 "false"');
  return problems;
}

/* ---------- 交互输入 ---------- */

export const isInteractive = () => !!(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question, { defaultValue = '', secret = false } = {}) {
  const hint = defaultValue && !secret ? c.dim(` (${defaultValue})`) : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) {
    // 隐藏输入：覆写输出，仅让提示语通过
    const write = rl._writeToOutput;
    rl._writeToOutput = s => { if (s.includes(question)) write.call(rl, s); };
  }
  return new Promise(resolve => {
    rl.question(`${question}${hint}: `, answer => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer.trim() || defaultValue);
    });
  });
}

export async function confirm(question, def = true) {
  const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'}`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

/* ---------- 子进程 ---------- */

/**
 * 运行命令。capture=true 时同时回显并收集输出；input 会写入 stdin。
 * 返回 { code, stdout }。
 */
export function run(cmd, args, { input, capture = false, quiet = false } = {}) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      stdio: [input !== undefined ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    const onData = stream => d => { stdout += d; if (!quiet) stream.write(d); };
    child.stdout?.on('data', onData(process.stdout));
    child.stderr?.on('data', onData(process.stderr));
    child.on('error', e => resolve({ code: 127, stdout: String(e) }));
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
    if (input !== undefined) child.stdin.end(input);
  });
}

export const npx = (args, opts) => run('npx', ['--yes', 'wrangler', ...args], opts);

export function randomToken(bytes = 24) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}
