import { detectFormat, parse, serialize } from '@shared/formats/index.js';
import { applyEol, toLF } from '@shared/text.js';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { fileUrl, request, setSessionToken } from '@/lib/api';
import { bytesFromB64 } from '@shared/text.js';
import { recentStore, tokenStore } from '@/lib/storage';
import { replacePath } from '@/router';

export type CurrentFile = { path: string; sha: string | null; size: number };
export type CachedFile = { sha: string; size: number; bytes: Uint8Array; text: string; binary: boolean };

const MAX_CACHE_ENTRIES = 60;

export const useSession = defineStore('session', () => {
  const saved = tokenStore.load();
  const token = ref(saved.token);
  const remember = ref(saved.remember);
  const info = ref<any>(null);
  const files = ref<any[]>([]);
  const commitSha = ref('');
  const current = ref<CurrentFile | null>(null);
  const loadingPath = ref<string | null>(null);
  const original = ref('');
  const eol = ref('\n');
  const bytes = ref<Uint8Array | null>(null);
  const binary = ref(false);
  const dirty = ref(false);
  const closedFolders = ref<string[]>([]);
  const fmt = ref<string | null>(null);
  const parsed = ref<any>(null);
  const mode = ref<'highlight' | 'visual' | 'preview'>('highlight');
  const editorText = ref('');
  const hlLang = ref('');
  const lintResult = ref<any>(null);
  const authed = ref(false);
  const recentPaths = ref<string[]>([]);
  const fileCache = new Map<string, CachedFile>();
  const inflight = new Map<string, Promise<any>>();

  const readonly = computed(() => info.value?.me?.role !== 'rw');

  function recentScope() {
    if (!info.value?.owner || !info.value?.repo) return '';
    return `${info.value.owner}/${info.value.repo}/${info.value.root || ''}@${info.value.branch || 'main'}`;
  }

  function syncRecent() {
    recentPaths.value = recentStore.load(recentScope());
  }

  function recordRecent(path: string) {
    recentPaths.value = recentStore.record(recentScope(), path);
  }

  function removeRecent(path: string) {
    recentPaths.value = recentStore.remove(recentScope(), path);
  }

  function clearRecent() {
    recentPaths.value = recentStore.clear(recentScope());
  }

  function getCachedFile(path: string, expectedSha?: string | null) {
    const entry = fileCache.get(path);
    if (!entry) return null;
    if (expectedSha && entry.sha !== expectedSha) {
      fileCache.delete(path);
      return null;
    }
    // LRU touch
    fileCache.delete(path);
    fileCache.set(path, entry);
    return entry;
  }

  function setCachedFile(path: string, entry: CachedFile) {
    if (fileCache.has(path)) fileCache.delete(path);
    else if (fileCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = fileCache.keys().next().value;
      if (oldest !== undefined) fileCache.delete(oldest);
    }
    fileCache.set(path, entry);
  }

  function deleteCachedFile(path: string) {
    fileCache.delete(path);
  }

  function clearFileCache() {
    fileCache.clear();
    inflight.clear();
  }

  function fileFullPath(rel: string) {
    return info.value?.root ? `${info.value.root}/${rel}` : rel;
  }

  function getEditorText() {
    return mode.value === 'visual' && parsed.value ? serialize(parsed.value) : editorText.value;
  }

  function textBytes() {
    return new TextEncoder().encode(applyEol(getEditorText(), eol.value));
  }

  function markDirty() {
    dirty.value = toLF(getEditorText()) !== original.value;
    const name = current.value ? current.value.path.split('/').at(-1) + ' · ' : '';
    document.title = `${dirty.value ? '● ' : ''}${name}GitHub Config Hub · 配置管理`;
  }

  function setEditorText(text: string) {
    editorText.value = text;
    markDirty();
  }

  function pickMode(path: string, text: string) {
    fmt.value = null;
    parsed.value = null;
    mode.value = 'highlight';
    try {
      const detected = detectFormat(path, text);
      if (detected) {
        parsed.value = parse(detected, text);
        fmt.value = detected;
        mode.value = 'visual';
      }
    } catch {
      fmt.value = null;
      parsed.value = null;
      mode.value = 'highlight';
    }
  }

  async function loadContext() {
    const data = await request('/api/context');
    info.value = data;
    syncRecent();
    return data;
  }

  async function refreshFiles() {
    const data = await request('/api/files');
    files.value = data.files || [];
    commitSha.value = data.commitSha || '';
  }

  function applyToken(next: string, keep: boolean) {
    token.value = next;
    remember.value = keep;
    setSessionToken(next);
  }

  function clearEditor() {
    current.value = null;
    loadingPath.value = null;
    dirty.value = false;
    fmt.value = null;
    parsed.value = null;
    mode.value = 'highlight';
    editorText.value = '';
    binary.value = false;
    replacePath(null);
    document.title = 'GitHub Config Hub · 配置管理';
  }

  function logout() {
    tokenStore.clear();
    applyToken('', false);
    authed.value = false;
    info.value = null;
    files.value = [];
    clearFileCache();
    clearEditor();
    document.documentElement.classList.remove('has-token');
    document.documentElement.classList.add('ready');
  }

  return {
    token, remember, info, files, commitSha, current, loadingPath, original, eol, bytes, binary, dirty,
    closedFolders, fmt, parsed, mode, editorText, hlLang, lintResult, authed, readonly, inflight, recentPaths,
    fileFullPath, getEditorText, textBytes, markDirty, setEditorText, pickMode, loadContext,
    refreshFiles, applyToken, clearEditor, logout, bytesFromB64, fileUrl,
    getCachedFile, setCachedFile, deleteCachedFile, clearFileCache,
    recordRecent, removeRecent, clearRecent,
  };
});
