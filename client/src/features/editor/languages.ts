/** 原始内容里可以手动切换的高亮语言。空字符串表示按文件自动识别。 */
export const HIGHLIGHT_LANGUAGES = [
  'bash', 'c', 'cmake', 'cpp', 'css', 'dockerfile', 'go', 'html', 'ini', 'java',
  'javascript', 'json', 'kotlin', 'lua', 'markdown', 'nginx', 'perl', 'python',
  'ruby', 'rust', 'scss', 'sql', 'swift', 'toml', 'typescript', 'xml', 'yaml',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];
