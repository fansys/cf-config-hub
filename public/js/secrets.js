/**
 * 敏感信息扫描：保存前提示是否包含令牌、私钥等（尤其是提交到公开仓库时）。
 * 只做本地规则匹配，内容不会离开浏览器；输出的片段已打码。
 */

const RULES = [
  { id: 'github-token', name: 'GitHub 令牌', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { id: 'aws-key', name: 'AWS Access Key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'private-key', name: '私钥', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'slack', name: 'Slack 令牌', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api', name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'jwt', name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { id: 'url-token', name: 'URL 中的凭据参数', re: /[?&](?:token|access_token|api[_-]?key|apikey|secret|password|passwd|sign|key)=([A-Za-z0-9._~%+-]{12,})/gi, group: 1 },
  { id: 'url-userinfo', name: 'URL 中的用户名密码', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/gi, group: 1 },
  { id: 'assignment', name: '疑似密钥赋值', re: /\b[\w.-]*(?:secret|passwd|password|token|api[_-]?key|private[_-]?key|access[_-]?key)[\w.-]*\s*[:=]\s*["']?([A-Za-z0-9/+_=.~-]{16,})["']?/gi, group: 1 },
];

/** 明显是占位符的值，不报。 */
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|<[^>]+>|your[_-]|replace|changeme|example|placeholder|todo|\$\{?[A-Z_]+\}?$|process\.env)/i;

export const mask = s => (s.length <= 8 ? '*'.repeat(s.length) : `${s.slice(0, 3)}…${s.slice(-2)}（${s.length} 字符）`);

/**
 * @returns {{rule:string, name:string, line:number, preview:string}[]}  按行号排序，同行同规则只报一次
 */
export function scanSecrets(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // 压缩文件/二进制样内容，跳过
    const seen = new Set();
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (let m; (m = r.re.exec(line));) {
        const secret = r.group ? m[r.group] : m[0];
        if (!secret || PLACEHOLDER.test(secret) || seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ rule: r.id, name: r.name, line: i + 1, preview: mask(secret) });
      }
    }
  });
  return out;
}
