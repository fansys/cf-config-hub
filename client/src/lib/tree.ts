export type RepoFile = { path: string; sha?: string; size?: number };
export type TreeRow =
  | { kind: 'dir'; name: string; path: string; depth: number; open: boolean }
  | { kind: 'file'; name: string; path: string; depth: number; file: RepoFile };

type Node = { dirs: Map<string, Node>; files: RepoFile[] };

function buildTree(files: RepoFile[]) {
  const root: Node = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const part of file.path.split('/').slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part)!;
    }
    node.files.push(file);
  }
  return root;
}

/** 折叠目录不产生子行。有搜索词时列出匹配的目录和文件，方便直接改访问规则。 */
export function visibleRows(files: RepoFile[], closed: string[], query: string): TreeRow[] {
  const q = query.trim().toLowerCase();
  if (q) {
    const dirs = new Set<string>();
    const matched: TreeRow[] = [];
    for (const file of files) {
      const parts = file.path.split('/');
      let dir = '';
      for (const part of parts.slice(0, -1)) {
        dir = dir ? `${dir}/${part}` : part;
        if (dir.toLowerCase().includes(q)) dirs.add(dir);
      }
      if (file.path.toLowerCase().includes(q)) {
        matched.push({ kind: 'file', name: file.path, path: file.path, depth: 0, file });
      }
    }
    const dirRows: TreeRow[] = [...dirs].map(path => ({ kind: 'dir', name: path, path, depth: 0, open: true }));
    return [...dirRows, ...matched].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
  }
  const closedSet = new Set(closed);
  const rows: TreeRow[] = [];
  const walk = (node: Node, parent: string, depth: number) => {
    const dirs = [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
    for (const [name, child] of dirs) {
      const path = parent ? `${parent}/${name}` : name;
      const open = !closedSet.has(path);
      rows.push({ kind: 'dir', name, path, depth, open });
      if (open) walk(child, path, depth + 1);
    }
    const sorted = [...node.files].sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
    for (const file of sorted) {
      rows.push({ kind: 'file', name: file.path.split('/').at(-1) || file.path, path: file.path, depth, file });
    }
  };
  walk(buildTree(files), '', 0);
  return rows;
}

/** 收集所有目录路径，供一键全部折叠使用。 */
export function allDirectories(files: RepoFile[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    let dir = '';
    for (const part of parts.slice(0, -1)) {
      dir = dir ? `${dir}/${part}` : part;
      dirs.add(dir);
    }
  }
  return [...dirs];
}
