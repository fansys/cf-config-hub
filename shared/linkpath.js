/** 从 GitHub / Raw / jsDelivr / Worker 链接里取出管理目录下的相对路径。 */
export function extractPathFromLink(input, info, origin) {
  const u = new URL(input.trim());
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const { owner, repo, branch, root } = info;
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  let path = '';
  if (eq(u.hostname, 'github.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === 'blob' && seg[3] === branch) {
    path = seg.slice(4).join('/');
  } else if (eq(u.hostname, 'raw.githubusercontent.com') && eq(seg[0], owner) && eq(seg[1], repo) && seg[2] === branch) {
    path = seg.slice(3).join('/');
  } else if (eq(u.hostname, 'cdn.jsdelivr.net') && seg[0] === 'gh' && eq(seg[1], owner) && seg[2]?.startsWith(repo + '@')) {
    if (seg[2].slice(repo.length + 1) === branch) path = seg.slice(3).join('/');
  } else if (u.origin === origin && (seg[0] === 'file' || seg[0] === 't')) {
    return seg.slice(seg[0] === 't' ? 2 : 1).join('/');
  }
  if (root && path.startsWith(root + '/')) path = path.slice(root.length + 1);
  return path;
}
