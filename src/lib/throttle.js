/** 失败次数限流（按 isolate 内存，尽力而为）：窗口内失败达到上限后拒绝，直到窗口过期。 */
import { HttpError } from './http.js';

export function makeThrottle(max, windowMs) {
  const map = new Map();
  return {
    check(key) {
      const rec = map.get(key);
      if (rec && rec.resetAt > Date.now() && rec.count >= max) throw new HttpError(429, '尝试次数过多，请稍后再试');
    },
    fail(key) {
      const now = Date.now();
      if (map.size > 2000) for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
      const rec = map.get(key);
      if (!rec || rec.resetAt <= now) map.set(key, { count: 1, resetAt: now + windowMs });
      else rec.count++;
    },
    reset() { map.clear(); },
  };
}
