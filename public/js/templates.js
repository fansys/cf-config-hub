/** 新建文件时可选的模板。match 为文件名/路径的匹配条件。 */

export const TEMPLATES = [
  {
    id: 'clash-list', name: 'Clash 规则列表', desc: '常见规则类型示例，可直接在可视化模式里编辑',
    match: p => /\.list$/i.test(p),
    prefer: p => /(^|\/)clash\//i.test(p),
    content: `# Clash 规则列表
# 类型,内容,动作（动作可省略，由引用它的订阅决定）
DOMAIN-SUFFIX,example.com
DOMAIN-KEYWORD,example
IP-CIDR,192.168.0.0/16,no-resolve
`,
  },
  {
    id: 'qx-list', name: 'QuantumultX 规则列表', desc: 'HOST / IP-CIDR 等 QX 规则示例',
    match: p => /\.(list|conf)$/i.test(p),
    prefer: p => /(^|\/)(quantumultx|qx)\//i.test(p),
    content: `# QuantumultX 规则列表
HOST-SUFFIX,example.com,Proxy
HOST-KEYWORD,example,Proxy
IP-CIDR,192.168.0.0/16,Direct,no-resolve
`,
  },
  {
    id: 'shadowrocket-list', name: 'Shadowrocket 规则列表', desc: 'DOMAIN-SUFFIX / IP-CIDR 等，策略为 PROXY / DIRECT / REJECT',
    match: p => /\.(list|conf)$/i.test(p),
    prefer: p => /(^|\/)shadowrocket\//i.test(p),
    content: `# Shadowrocket 规则列表
DOMAIN-SUFFIX,example.com,PROXY
DOMAIN-KEYWORD,example,PROXY
IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
USER-AGENT,Telegram*,PROXY
`,
  },
  {
    id: 'clash-ini', name: 'Clash 订阅增强 (.ini)', desc: 'subconverter 风格的 ruleset / 策略组骨架',
    match: p => /\.ini$/i.test(p),
    content: `[custom]
ruleset=🎯 全球直连,https://example.com/direct.list
ruleset=🐟 漏网之鱼,[]FINAL

custom_proxy_group=🚀 节点选择\`select\`[]♻️ 自动选择\`[]DIRECT
custom_proxy_group=♻️ 自动选择\`url-test\`.*\`http://www.gstatic.com/generate_204\`300,,50
`,
  },
  {
    id: 'env', name: '环境变量示例 (.env.example)', desc: '只放变量名与占位值，真实密钥不要提交',
    match: p => /(^|\/)\.env(\.[^/]+)?$|\.env$/i.test(p),
    content: `# 示例配置：复制为 .env 后填写真实值（.env 不要提交到仓库）
APP_ENV=production
API_BASE_URL=https://api.example.com
# API_TOKEN=
`,
  },
  { id: 'json', name: 'JSON 对象', desc: '空对象骨架', match: p => /\.json$/i.test(p), content: '{\n  \n}\n' },
  {
    id: 'yaml', name: 'YAML 文档', desc: '带注释的键值与列表示例', match: p => /\.ya?ml$/i.test(p),
    content: `# 配置说明
name: example
enabled: true
items:
  - one
  - two
`,
  },
  {
    id: 'toml', name: 'TOML 文档', desc: '键值与表示例', match: p => /\.toml$/i.test(p),
    content: `# 配置说明
name = "example"
enabled = true

[server]
host = "0.0.0.0"
port = 8080
`,
  },
  {
    id: 'markdown', name: 'Markdown 文档', desc: '标题、说明与列表', match: p => /\.(md|markdown)$/i.test(p),
    content: `# 标题

简要说明。

## 使用方法

- 步骤一
- 步骤二
`,
  },
];

/** 适用于该路径的模板（不含"空白"）。 */
/** 适用于该路径的模板；路径所在目录对应的格式（clash / quantumultx / shadowrocket）排在最前。 */
export const templatesFor = path => TEMPLATES.filter(t => t.match(path)).sort((a, b) => Number(!!b.prefer?.(path)) - Number(!!a.prefer?.(path)));
