/** 全局状态：所有字段在此声明，避免隐式创建。 */
import { serialize } from './formats/index.js';
import { $, applyEol } from './util.js';

export const state = {
  // 鉴权
  token: '',
  // 仓库
  info: null,            // /api/context（含 me、defaults、isDefault）
  readonly: false,       // 当前口令是否只读
  files: [],             // /api/files
  commitSha: '',         // 分支最新 commit
  // 当前文件
  current: null,         // { path, sha, size }
  original: '',          // 脏标记基线（统一为 LF）
  eol: '\n',             // 文件原有换行符，保存时还原
  bytes: null,           // 原始二进制
  binary: false,
  dirty: false,
  // UI
  closedFolders: new Set(),
  // 编辑模式
  fmt: null,             // 'clash-list' | 'clash-ini' | 'qx-list' | null
  parsed: null,
  mode: 'highlight',     // 'highlight'（可编辑的语法高亮 / 原始内容）| 'visual' | 'preview'
  lint: null,            // 最近一次语法校验结果
  hlLang: '',            // ''= 自动检测
  hlDetectEl: null,
};

/** 当前编辑内容（可视化模式下由解析结果序列化而来）。 */
export function getEditorText() {
  return state.mode === 'visual' && state.parsed ? serialize(state.parsed) : $('editor').value;
}

export const textBytes = () => new TextEncoder().encode(applyEol(getEditorText(), state.eol));

export const fileFullPath = rel => (state.info?.root ? `${state.info.root}/${rel}` : rel);
