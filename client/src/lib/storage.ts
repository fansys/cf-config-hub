const TOKEN_KEY = 'cfhub-token';
const TARGET_KEY = 'cfhub-target';
const RECENT_KEY = 'cfhub-recent';
const MAX_RECENT = 12;

/** 未勾选「保持登录」时只放 sessionStorage。 */
export const tokenStore = {
  load: () => ({
    token: localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '',
    remember: !!localStorage.getItem(TOKEN_KEY),
  }),
  save(token: string, remember: boolean) {
    this.clear();
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  },
};

/** 当前分支。空字符串表示部署默认分支。 */
export const target = {
  get(): { branch?: string } {
    try {
      const saved = JSON.parse(localStorage.getItem(TARGET_KEY) || '{}') as { branch?: string };
      return saved.branch ? { branch: String(saved.branch) } : {};
    } catch {
      return {};
    }
  },
  set(branch: string) {
    if (branch) localStorage.setItem(TARGET_KEY, JSON.stringify({ branch }));
    else localStorage.removeItem(TARGET_KEY);
  },
  clear() {
    localStorage.removeItem(TARGET_KEY);
  },
};

/** 最近打开的文件路径（按 仓库@分支 隔离保存）。 */
export const recentStore = {
  load(scope: string): string[] {
    if (!scope) return [];
    try {
      const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}') as Record<string, string[]>;
      const list = all[scope];
      return Array.isArray(list) ? list.filter(p => typeof p === 'string' && p) : [];
    } catch {
      return [];
    }
  },
  save(scope: string, paths: string[]) {
    if (!scope) return;
    try {
      const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '{}') as Record<string, string[]>;
      if (paths.length) all[scope] = paths.slice(0, MAX_RECENT);
      else delete all[scope];
      localStorage.setItem(RECENT_KEY, JSON.stringify(all));
    } catch { /* localStorage 不可用时忽略 */ }
  },
  record(scope: string, path: string): string[] {
    if (!scope || !path) return [];
    const next = [path, ...this.load(scope).filter(item => item !== path)].slice(0, MAX_RECENT);
    this.save(scope, next);
    return next;
  },
  remove(scope: string, path: string): string[] {
    if (!scope) return [];
    const next = this.load(scope).filter(item => item !== path);
    this.save(scope, next);
    return next;
  },
  clear(scope: string): string[] {
    this.save(scope, []);
    return [];
  },
};
