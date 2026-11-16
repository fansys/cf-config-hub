/**
 * 令牌链接：令牌 = <10 位 hex><6 位分钟数>，共 16 个字符。
 *
 *   分钟数  到期时间，从 2026-01-01 00:00 UTC 起算的分钟数，补零到 6 位；000000 表示永久有效
 *           （6 位最大 999999 分钟，约 694 天）
 *   hex     HMAC-SHA256(密钥, 目标仓库 | 文件名 | 文件版本 | 6 位分钟数[ | 非默认分支名]) 的前 10 位十六进制（40 位）
 *
 * 文件版本**不写进令牌**，由服务端从版本表（linkversion.js）读取并参与验签：
 * 把文件版本 +1，旧令牌按新版本重算后对不上，即视为撤销。
 * 令牌只对签发时的那个文件有效（文件名参与签名）。
 *
 * 签名密钥：LINK_SECRET（推荐）；未设置时由 ADMIN_TOKEN 派生（改口令会让已发出的链接全部失效）。
 */
import { HttpError } from './http.js';

const enc = new TextEncoder();

export const EPOCH_MS = Date.UTC(2026, 0, 1);
export const HEX_LEN = 10;
export const MINUTE_DIGITS = 6;
export const MAX_MINUTES = 10 ** MINUTE_DIGITS - 1;
const TOKEN_RE = /^([0-9a-f]{10})(\d{6})$/;

/** 毫秒时间戳 → 从 2026-01-01 起的分钟数（向上取整，保证不早于期望的到期时间）。 */
export const toExpiryMinutes = ms => Math.max(1, Math.ceil((ms - EPOCH_MS) / 60000));
export const minutesToMs = m => EPOCH_MS + m * 60000;
const pad = m => String(m).padStart(MINUTE_DIGITS, '0');

async function hmacKey(env) {
  const secret = env.LINK_SECRET ? String(env.LINK_SECRET) : (env.ADMIN_TOKEN ? `cfhub-link:${env.ADMIN_TOKEN}` : '');
  if (!secret) throw new HttpError(503, '未配置 LINK_SECRET（或 ADMIN_TOKEN），无法签发/校验链接令牌');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** 前 10 位 hex。c 为部署默认目标（owner/repo/root）；path 为相对管理目录的文件名。 */
export async function linkHex(env, c, path, version, minutes) {
  const parts = ['cfhub-link-v3', `${c.owner}/${c.repo}`, c.root || '', path, version, pad(minutes)];
  // 非默认分支的令牌把分支名也纳入签名（默认分支保持原样，已发出的链接不受影响）
  if (c.defaultBranch && c.branch && c.branch !== c.defaultBranch) parts.push(`branch:${c.branch}`);
  const msg = parts.join('\n');
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(msg)));
  return [...sig.subarray(0, 5)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** @param {{expiresAtMs?: number|null, version: number}} o  不传 expiresAtMs = 永久 */
export async function makeToken(env, c, path, { expiresAtMs = null, version }) {
  const minutes = expiresAtMs ? toExpiryMinutes(expiresAtMs) : 0;
  if (minutes > MAX_MINUTES) throw new HttpError(400, '有效期过长（令牌最多表示约 694 天）');
  return (await linkHex(env, c, path, version, minutes)) + pad(minutes);
}

export function parseToken(token) {
  const m = TOKEN_RE.exec(String(token || ''));
  return m ? { hex: m[1], minutes: Number(m[2]) } : null;
}

const safeEqual = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * 按"当前文件版本"验签并检查有效期。
 * @returns {Promise<{ ok: boolean, reason?: 'malformed'|'invalid'|'expired', minutes?: number }>}
 *   invalid = 签名对不上（伪造、换了文件、或该文件的版本已提升即已撤销，三者无法区分）
 */
export async function verifyToken(env, c, token, path, version, { now = Date.now() } = {}) {
  const t = parseToken(token);
  if (!t) return { ok: false, reason: 'malformed' };
  if (!safeEqual(await linkHex(env, c, path, version, t.minutes), t.hex)) return { ok: false, reason: 'invalid' };
  if (t.minutes && now >= minutesToMs(t.minutes)) return { ok: false, reason: 'expired', minutes: t.minutes };
  return { ok: true, minutes: t.minutes };
}

/**
 * 管理员检查用：除了当前版本，再回溯旧版本（最多 200 个），判断令牌是否"曾经有效但已撤销"。
 * @returns {Promise<{ status: 'valid'|'expired'|'revoked'|'invalid'|'malformed', minutes?: number, version?: number }>}
 */
export async function inspectToken(env, c, token, path, currentVersion, { now = Date.now() } = {}) {
  const t = parseToken(token);
  if (!t) return { status: 'malformed' };
  const floor = Math.max(1, currentVersion - 200);
  for (let v = currentVersion; v >= floor; v--) {
    if (safeEqual(await linkHex(env, c, path, v, t.minutes), t.hex)) {
      const expired = t.minutes && now >= minutesToMs(t.minutes);
      const status = v !== currentVersion ? 'revoked' : expired ? 'expired' : 'valid';
      return { status, minutes: t.minutes, version: v };
    }
  }
  return { status: 'invalid', minutes: t.minutes };
}
