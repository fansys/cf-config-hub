/**
 * 轻量 Markdown 渲染（预览用）：先解析为数据结构，再生成 DOM；
 * 全程只用 createElement / textContent，不产生 HTML 字符串，链接仅允许 http(s) / mailto。
 */

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;

/* ---------- 行内 ---------- */

const INLINE = [
  { re: /`([^`\n]+)`/, make: m => ({ t: 'code', text: m[1] }) },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: m => ({ t: 'link', href: m[2], kids: parseInline(m[1]) }) },
  { re: /\*\*([^\n]+?)\*\*|__([^\n]+?)__/, make: m => ({ t: 'strong', kids: parseInline(m[1] ?? m[2]) }) },
  { re: /(?<![*\w])\*([^*\n]+?)\*(?!\*)|(?<![_\w])_([^_\n]+?)_(?![_\w])/, make: m => ({ t: 'em', kids: parseInline(m[1] ?? m[2]) }) },
  { re: /~~([^\n]+?)~~/, make: m => ({ t: 'del', kids: parseInline(m[1]) }) },
  { re: /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, make: m => ({ t: 'link', href: m[0], kids: [{ t: 'text', text: m[0] }] }) },
];

export function parseInline(src) {
  const out = [];
  let rest = src;
  while (rest) {
    let best = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, rule };
    }
    if (!best) { out.push({ t: 'text', text: rest }); break; }
    if (best.m.index) out.push({ t: 'text', text: rest.slice(0, best.m.index) });
    out.push(best.rule.make(best.m));
    rest = rest.slice(best.m.index + best.m[0].length);
  }
  return out;
}

/* ---------- 块级 ---------- */

const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

export function parseMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { blocks.push({ type: 'heading', level: h[1].length, kids: parseInline(h[2]) }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', head: head.map(parseInline), rows: rows.map(r => r.map(parseInline)) });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', kids: parseInline(body.join(' ')) });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const task = m[3].match(/^\[( |x|X)\]\s+(.*)$/);
        items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2)), task: task ? task[1] !== ' ' : null, kids: parseInline(task ? task[2] : m[3]) });
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) { para.push(lines[i++]); }
    blocks.push({ type: 'para', kids: parseInline(para.join(' ')) });
  }
  return blocks;
}

/* ---------- DOM ---------- */

function inlineNodes(kids) {
  return kids.map(k => {
    switch (k.t) {
      case 'text': return document.createTextNode(k.text);
      case 'code': { const e = document.createElement('code'); e.textContent = k.text; return e; }
      case 'strong': case 'em': case 'del': {
        const e = document.createElement(k.t === 'del' ? 's' : k.t);
        e.append(...inlineNodes(k.kids));
        return e;
      }
      case 'link': {
        if (!SAFE_URL.test(k.href)) { const s = document.createElement('span'); s.title = k.href; s.append(...inlineNodes(k.kids)); return s; }
        const a = document.createElement('a');
        a.href = k.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
        a.append(...inlineNodes(k.kids));
        return a;
      }
      default: return document.createTextNode('');
    }
  });
}

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  for (const b of parseMarkdown(text)) {
    let el;
    switch (b.type) {
      case 'heading': el = document.createElement('h' + b.level); el.append(...inlineNodes(b.kids)); break;
      case 'para': el = document.createElement('p'); el.append(...inlineNodes(b.kids)); break;
      case 'quote': el = document.createElement('blockquote'); el.append(...inlineNodes(b.kids)); break;
      case 'hr': el = document.createElement('hr'); break;
      case 'code': {
        el = document.createElement('pre');
        const c = document.createElement('code');
        c.textContent = b.text;
        el.append(c);
        break;
      }
      case 'list': {
        el = document.createElement(b.ordered ? 'ol' : 'ul');
        for (const it of b.items) {
          const li = document.createElement('li');
          li.style.marginLeft = `${it.depth * 18}px`;
          if (it.task !== null) {
            const box = document.createElement('input');
            box.type = 'checkbox'; box.checked = it.task; box.disabled = true;
            li.append(box, ' ');
          }
          li.append(...inlineNodes(it.kids));
          el.append(li);
        }
        break;
      }
      case 'table': {
        el = document.createElement('table');
        const thead = el.createTHead().insertRow();
        for (const c of b.head) { const th = document.createElement('th'); th.append(...inlineNodes(c)); thead.append(th); }
        const body = el.createTBody();
        for (const r of b.rows) {
          const tr = body.insertRow();
          for (const c of r) { const td = tr.insertCell(); td.append(...inlineNodes(c)); }
        }
        break;
      }
      default: continue;
    }
    frag.append(el);
  }
  return frag;
}
