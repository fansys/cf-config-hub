/**
 * 最小 zip 读写（无依赖）：读取支持 stored / deflate；写入仅 stored（供测试与小型导出）。
 * 读取依赖 DecompressionStream('deflate-raw')（现代浏览器与 Node 18+ 均支持）。
 */

const td = new TextDecoder();
const te = new TextEncoder();

let crcTable;
export function crc32(bytes) {
  crcTable ||= Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const MAX_ENTRIES = 5000;
const MAX_TOTAL = 200 * 1024 * 1024;

/** @returns {Promise<{name:string, bytes:Uint8Array}[]>}  仅文件（目录条目被忽略） */
export async function readZip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // 从末尾找 End of Central Directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count > MAX_ENTRIES) throw new Error(`zip 内文件过多（上限 ${MAX_ENTRIES}）`);

  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip 目录损坏');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(`${name}：不支持加密的 zip`);

    total += usize;
    if (total > MAX_TOTAL) throw new Error('zip 解压后过大（上限 200 MiB）');
    const lhNameLen = dv.getUint16(local + 26, true);
    const lhExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lhNameLen + lhExtraLen;
    const raw = u8.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) bytes = await inflateRaw(raw);
    else throw new Error(`${name}：不支持的压缩方式 ${method}`);
    files.push({ name, bytes });
  }
  return files;
}

/** 写入 stored（不压缩）zip。 */
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = b => { chunks.push(b); offset += b.length; };
  for (const { name, bytes } of entries) {
    const nameBytes = te.encode(name);
    const crc = crc32(bytes);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint32(14, crc, true); head.setUint32(18, bytes.length, true); head.setUint32(22, bytes.length, true);
    head.setUint16(26, nameBytes.length, true);
    central.push({ nameBytes, crc, size: bytes.length, offset });
    push(new Uint8Array(head.buffer)); push(nameBytes); push(bytes);
  }
  const cdStart = offset;
  for (const c of central) {
    const h = new DataView(new ArrayBuffer(46));
    h.setUint32(0, 0x02014b50, true); h.setUint16(4, 20, true); h.setUint16(6, 20, true); h.setUint16(8, 0x0800, true);
    h.setUint32(16, c.crc, true); h.setUint32(20, c.size, true); h.setUint32(24, c.size, true);
    h.setUint16(28, c.nameBytes.length, true); h.setUint32(42, c.offset, true);
    push(new Uint8Array(h.buffer)); push(c.nameBytes);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, central.length, true); end.setUint16(10, central.length, true);
  end.setUint32(12, offset - cdStart, true); end.setUint32(16, cdStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * 整理导入路径：去掉公共顶层目录（GitHub zipball 形如 owner-repo-sha/…）、
 * 忽略 .git/、__MACOSX/、.DS_Store，并加上目标目录前缀。
 * @returns {{ items: {path:string, bytes:Uint8Array}[], ignored: number, stripped: string }}
 */
export function planImport(files, { stripTop = true, prefix = '' } = {}) {
  let stripped = '';
  if (stripTop && files.length) {
    const tops = new Set(files.map(f => f.name.split('/')[0]));
    if (tops.size === 1 && files.every(f => f.name.includes('/'))) stripped = [...tops][0];
  }
  const items = [];
  let ignored = 0;
  const pre = prefix.replace(/^\/+|\/+$/g, '');
  for (const f of files) {
    const rel = stripped ? f.name.slice(stripped.length + 1) : f.name;
    const segs = rel.split('/');
    if (!rel || segs.includes('.git') || segs.includes('__MACOSX') || segs.at(-1) === '.DS_Store' || segs.some(s => s === '..' || s === '.')) { ignored++; continue; }
    items.push({ path: pre ? `${pre}/${rel}` : rel, bytes: f.bytes });
  }
  return { items, ignored, stripped };
}
