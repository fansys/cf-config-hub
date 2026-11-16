/**
 * 通用配置文件的语法校验、格式化与互转（JSON / YAML / TOML / INI）。
 * YAML、TOML 解析器按需从 /vendor 动态加载；无 DOM 依赖，可在 Node 中测试。
 */

const vendor = {};
const load = async name => (vendor[name] ||= import(new URL(`../vendor/${name}.js`, import.meta.url).href));

export const LANG_LABELS = { json: 'JSON', yaml: 'YAML', toml: 'TOML', ini: 'INI' };

/** 由文件名判断可校验的语言；不支持返回 null。 */
export function langOf(path) {
  const base = path.split('/').pop().toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (ext === 'json' || base === '.babelrc') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'toml') return 'toml';
  if (ext === 'ini' || ext === 'cfg') return 'ini';
  return null;
}

const posToLineCol = (text, pos) => {
  const before = text.slice(0, Math.min(pos, text.length));
  const lines = before.split('\n');
  return { line: lines.length, col: lines.at(-1).length + 1 };
};

function jsonError(text, e) {
  const msg = String(e.message || e);
  let line, col;
  const lc = msg.match(/line (\d+) column (\d+)/);
  const pos = msg.match(/position (\d+)/);
  if (lc) { line = Number(lc[1]); col = Number(lc[2]); }
  else if (pos) ({ line, col } = posToLineCol(text, Number(pos[1])));
  return { message: msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, ''), line, col };
}

function iniCheck(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /^[#;]/.test(t)) continue;
    if (/^\[[^\]]+\]$/.test(t)) continue;
    if (/^[^=:\s][^=:]*[=:]/.test(t)) continue;
    return { message: '无法识别的行（应为 [section] 或 key=value）', line: i + 1, col: 1 };
  }
  return null;
}

/** @returns {Promise<{lang:string, ok:boolean, message?:string, line?:number, col?:number} | null>} */
export async function lint(path, text) {
  const lang = langOf(path);
  if (!lang) return null;
  if (!text.trim()) return { lang, ok: true };
  try {
    if (lang === 'json') JSON.parse(text);
    else if (lang === 'yaml') (await load('js-yaml')).loadAll(text);
    else if (lang === 'toml') (await load('smol-toml')).parse(text);
    else {
      const bad = iniCheck(text);
      if (bad) return { lang, ok: false, ...bad };
    }
    return { lang, ok: true };
  } catch (e) {
    if (lang === 'json') return { lang, ok: false, ...jsonError(text, e) };
    if (lang === 'yaml') {
      const first = String(e.reason || e.message).split('\n')[0];
      return { lang, ok: false, message: first, line: e.mark ? e.mark.line + 1 : undefined, col: e.mark ? e.mark.column + 1 : undefined };
    }
    return { lang, ok: false, message: String(e.message).split('\n')[0], line: e.line, col: e.column };
  }
}

/** JSON 美化（缩进 2）或压缩；内容不合法时抛错。 */
export function formatJson(text, minify = false) {
  const value = JSON.parse(text);
  return minify ? JSON.stringify(value) : JSON.stringify(value, null, 2) + '\n';
}

async function parseData(lang, text) {
  if (lang === 'json') return JSON.parse(text);
  if (lang === 'yaml') return (await load('js-yaml')).load(text);
  if (lang === 'toml') return (await load('smol-toml')).parse(text);
  throw new Error('不支持的格式');
}

/**
 * 在 JSON / YAML / TOML 之间转换。注释无法保留，调用方应提示用户。
 * @returns {Promise<string>}
 */
export async function convertData(fromLang, toLang, text) {
  const data = await parseData(fromLang, text);
  if (toLang === 'json') return JSON.stringify(data, null, 2) + '\n';
  if (toLang === 'yaml') return (await load('js-yaml')).dump(data, { lineWidth: -1, noRefs: true });
  if (toLang === 'toml') {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('TOML 的顶层必须是键值对象');
    return (await load('smol-toml')).stringify(data) + '\n';
  }
  throw new Error('不支持的目标格式');
}

/** 转换后建议的文件名。 */
export const convertedName = (path, toLang) => path.replace(/\.[^./]+$/, '') + '.' + (toLang === 'yaml' ? 'yaml' : toLang);
