/**
 * 访问规则的存储：Workers KV（绑定名 CONFIG_KV）。
 *
 *   键   access:<owner>/<repo>/<管理目录>[@<分支>]（默认分支不带 @ 后缀）   值 { rules:[{pattern, mode}], updatedAt, updatedBy }
 *   来源 优先使用 KV 里保存的规则（即使是空列表）；KV 里还没有时回退到环境变量 DIRECT_PATHS（兼容旧配置，也可作初始值）。
 *   一致性 KV 是最终一致：修改后全球生效最长约 1 分钟；同一 isolate 内另有 ACCESS_CACHE_TTL 秒（默认 10）的内存缓存。
 */
import { parseAccessRules } from './access.js';
import { HttpError } from './http.js';

const MODES = ['direct', 'token', 'deny'];
const MAX_RULES = 200;
const memory = new Map();

const isOtherBranch = c => !!c.defaultBranch && !!c.branch && c.branch !== c.defaultBranch;
/** 默认分支沿用原来的键；其它分支各自独立保存（互不影响，也不继承默认分支的规则）。 */
const kvKey = c => `access:${c.owner}/${c.repo}/${c.root || ''}${isOtherBranch(c) ? `@${c.branch}` : ''}`;
const ttlMs = env => Math.max(0, Math.min(60, Number(env.ACCESS_CACHE_TTL ?? 10) || 0)) * 1000;

export const kvAvailable = env => !!env.CONFIG_KV && typeof env.CONFIG_KV.get === 'function';

/** 校验并规范化界面提交的规则（目录以 / 结尾会换成 /**）。 */
export function normalizeRules(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'rules 必须是数组');
  if (list.length > MAX_RULES) throw new HttpError(400, `规则最多 ${MAX_RULES} 条`);
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const mode = String(r?.mode || '').toLowerCase();
    let pattern = String(r?.pattern ?? '').trim().replace(/^\/+/, '');
    if (!MODES.includes(mode)) throw new HttpError(400, `模式不合法：${r?.mode}（应为 direct / token / deny）`);
    if (!pattern || pattern.length > 200 || pattern.includes('\\') || /[\x00-\x1f\x7f,]/.test(pattern) ||
        pattern.split('/').some(s => s === '..' || s === '.')) {
      throw new HttpError(400, `规则路径不合法：${pattern || '(空)'}`);
    }
    if (pattern.endsWith('/')) pattern += '**';
    const key = `${pattern}\n${mode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pattern, mode });
  }
  return out;
}

/**
 * 读取当前生效的规则。
 * @returns {Promise<{ rules: {pattern:string, mode:string}[], source: 'kv'|'env'|'none', updatedAt?: number, updatedBy?: string }>}
 */
export async function loadRules(env, c, { fresh = false } = {}) {
  const key = kvKey(c);
  const hit = memory.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttlMs(env)) return hit.value;

  let value;
  // 环境变量 DIRECT_PATHS 只作用于默认分支；其它分支没有保存过规则时视为没有规则
  const envRules = () => (isOtherBranch(c)
    ? { rules: [], source: 'none' }
    : { rules: parseAccessRules(env.DIRECT_PATHS).map(({ pattern, mode }) => ({ pattern, mode })), source: 'env' });
  if (!kvAvailable(env)) value = envRules();
  else {
    let stored;
    try { stored = await env.CONFIG_KV.get(key, { type: 'json' }); }
    catch { throw new HttpError(503, '无法读取访问规则（KV 不可用）'); }
    value = stored && Array.isArray(stored.rules)
      ? { rules: stored.rules, source: 'kv', updatedAt: stored.updatedAt, updatedBy: stored.updatedBy }
      : envRules();
  }
  memory.set(key, { at: Date.now(), value });
  return value;
}

export async function saveRules(env, c, rawRules, user) {
  if (!kvAvailable(env)) throw new HttpError(503, '未绑定 KV（CONFIG_KV），无法保存规则；规则目前来自环境变量 DIRECT_PATHS');
  const rules = normalizeRules(rawRules);
  const record = { rules, updatedAt: Date.now(), updatedBy: user?.name || 'admin' };
  await env.CONFIG_KV.put(kvKey(c), JSON.stringify(record));
  const value = { rules, source: 'kv', updatedAt: record.updatedAt, updatedBy: record.updatedBy };
  memory.set(kvKey(c), { at: Date.now(), value });
  return value;
}

/**
 * 设置（或移除）某个路径自己的那条规则，其它规则保持不变：先读最新值再改，避免覆盖别人刚做的修改。
 * @param {string} pattern  文件路径、目录/（会规范为 目录/**）或通配
 * @param {'direct'|'token'|'deny'|null} mode  null = 移除这条规则（恢复为继承上级）
 */
export async function setRule(env, c, pattern, mode, user) {
  if (!kvAvailable(env)) throw new HttpError(503, '未绑定 KV（CONFIG_KV），无法保存规则；规则目前来自环境变量 DIRECT_PATHS');
  const [target] = normalizeRules([{ pattern, mode: mode || 'token' }]);
  const { rules } = await loadRules(env, c, { fresh: true });
  const next = rules.filter(r => r.pattern !== target.pattern);
  if (mode) next.push({ pattern: target.pattern, mode: target.mode });
  return saveRules(env, c, next, user);
}

export const _clearAccessCache = () => memory.clear();
