/** 管理口令校验：摘要后恒定时间比较 + 简易失败限流（按 isolate 内存，尽力而为）。 */
import { HttpError } from './lib/http.js';

const encoder = new TextEncoder();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // ip -> { count, resetAt }

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function constantTimeEqual(a, b) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ (b[i] ?? 0);
  return diff === 0;
}

function clientKey(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

function checkThrottle(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (rec && rec.resetAt > now && rec.count >= MAX_FAILURES) {
    throw new HttpError(429, '尝试次数过多，请稍后再试');
  }
}

function recordFailure(key) {
  const now = Date.now();
  if (failures.size > 1000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
  }
  const rec = failures.get(key);
  if (!rec || rec.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else rec.count++;
}

/**
 * 口令表：ADMIN_TOKEN（读写，用户名 admin）、READONLY_TOKEN（只读，viewer）、
 * USERS（逗号分隔的 "name:rw|ro:token"，用于多人协作与提交署名）。
 */
export function tokenTable(env) {
  const rows = [];
  if (env.ADMIN_TOKEN) rows.push({ name: 'admin', role: 'rw', token: String(env.ADMIN_TOKEN) });
  if (env.READONLY_TOKEN) rows.push({ name: 'viewer', role: 'ro', token: String(env.READONLY_TOKEN) });
  for (const entry of String(env.USERS || '').split(',')) {
    const m = entry.trim().match(/^([A-Za-z0-9_.-]{1,32}):(rw|ro):(.+)$/);
    if (m) rows.push({ name: m[1], role: m[2], token: m[3] });
  }
  return rows;
}

/**
 * 校验 Authorization: Bearer，返回 { name, role } 或 null；被限流时抛 429。
 * 对所有候选口令都做恒定时间比较（不因命中而提前返回）。
 */
export async function authenticate(req, env) {
  const header = req.headers.get('Authorization') || '';
  const rows = tokenTable(env);
  if (!rows.length || !header.startsWith('Bearer ')) return null;

  const key = clientKey(req);
  checkThrottle(key);

  const supplied = await sha256(header.slice(7));
  let found = null;
  for (const row of rows) {
    if (constantTimeEqual(await sha256(row.token), supplied) && !found) found = { name: row.name, role: row.role };
  }
  if (found) failures.delete(key); else recordFailure(key);
  return found;
}

/** 兼容旧调用：是否为有效口令。 */
export async function validAdmin(req, env) { return !!(await authenticate(req, env)); }

/** 仅供测试：清空限流状态。 */
export function _resetThrottle() { failures.clear(); }
