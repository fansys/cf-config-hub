import { reactive } from 'vue';

export const panels = reactive({
  nav: false,
  links: false,
  linkPath: '',
  linkScope: 'file' as 'file' | 'dir',
  access: false,
  accessPath: '',
  accessKind: 'file' as 'file' | 'dir',
  rules: false,
  search: false,
  history: false,
  activity: false,
  backup: false,
  branch: false,
  diff: null as null | { title: string; oldText: string; newText: string },
  reauth: false,
});

export function openLinks(path: string, scope: 'file' | 'dir' = 'file') {
  panels.linkPath = path;
  panels.linkScope = scope;
  panels.links = true;
}

export function openAccess(path: string, kind: 'file' | 'dir') {
  panels.accessPath = path;
  panels.accessKind = kind;
  panels.access = true;
}
