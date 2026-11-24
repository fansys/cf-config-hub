/** 与服务端令牌规则一致：后 6 位是从 2026-01-01 00:00 UTC 起算的分钟数，000000 表示永久。 */
export const TOKEN_EPOCH_MS = Date.UTC(2026, 0, 1);
const TOKEN_RE = /^[0-9a-f]{10}(\d{6})$/;

export function tokenExpiry(token) {
  const matched = TOKEN_RE.exec(String(token || ''));
  if (!matched) return null;
  const minutes = Number(matched[1]);
  if (!minutes) return { permanent: true, expiresAt: null };
  return { permanent: false, expiresAt: TOKEN_EPOCH_MS + minutes * 60000 };
}

export function formatTokenExpiry(token, now = Date.now()) {
  const info = tokenExpiry(token);
  if (!info) return '令牌格式不正确';
  if (info.permanent) return '永久有效';
  const when = new Date(info.expiresAt).toLocaleString();
  return info.expiresAt <= now ? `已于 ${when} 过期` : `到期 ${when}`;
}
