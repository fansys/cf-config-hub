/** Git blob 的 SHA-1：sha1("blob <len>\0" + bytes)，用于判断文件内容是否与仓库中一致。 */
export async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}
