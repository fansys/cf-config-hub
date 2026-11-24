<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from '@codemirror/commands';
import { StreamLanguage, bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { closeSearchPanel, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { detectLanguage } from '@shared/lang.js';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { HighlightLanguage } from './languages';

const props = withDefaults(defineProps<{
  modelValue: string;
  path: string;
  lang: string;
  readonly: boolean;
  wrap?: boolean;
}>(), {
  wrap: true,
});
const emit = defineEmits<{
  'update:modelValue': [string];
  detected: [string];
  cursor: [{ line: number; col: number; selected: number }];
}>();
const host = ref<HTMLElement | null>(null);
const languageConf = new Compartment();
const editConf = new Compartment();
const wrapConf = new Compartment();
let view: EditorView | null = null;
let searchOpen = false;
const HIGHLIGHT_LIMIT = 300_000;

const loaders: Record<HighlightLanguage, () => Promise<Extension>> = {
  json: () => import('@codemirror/lang-json').then(mod => mod.json()),
  javascript: () => import('@codemirror/lang-javascript').then(mod => mod.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then(mod => mod.javascript({ typescript: true })),
  markdown: () => import('@codemirror/lang-markdown').then(mod => mod.markdown()),
  html: () => import('@codemirror/lang-html').then(mod => mod.html()),
  xml: () => import('@codemirror/lang-html').then(mod => mod.html()),
  css: () => import('@codemirror/lang-css').then(mod => mod.css()),
  scss: () => import('@codemirror/lang-css').then(mod => mod.css()),
  yaml: () => import('@codemirror/lang-yaml').then(mod => mod.yaml()),
  bash: () => import('@codemirror/legacy-modes/mode/shell').then(mod => StreamLanguage.define(mod.shell)),
  python: () => import('@codemirror/legacy-modes/mode/python').then(mod => StreamLanguage.define(mod.python)),
  go: () => import('@codemirror/legacy-modes/mode/go').then(mod => StreamLanguage.define(mod.go)),
  rust: () => import('@codemirror/legacy-modes/mode/rust').then(mod => StreamLanguage.define(mod.rust)),
  c: () => import('@codemirror/legacy-modes/mode/clike').then(mod => StreamLanguage.define(mod.c)),
  cpp: () => import('@codemirror/legacy-modes/mode/clike').then(mod => StreamLanguage.define(mod.cpp)),
  java: () => import('@codemirror/legacy-modes/mode/clike').then(mod => StreamLanguage.define(mod.java)),
  kotlin: () => import('@codemirror/legacy-modes/mode/clike').then(mod => StreamLanguage.define(mod.kotlin)),
  nginx: () => import('@codemirror/legacy-modes/mode/nginx').then(mod => StreamLanguage.define(mod.nginx)),
  ini: () => import('@codemirror/legacy-modes/mode/properties').then(mod => StreamLanguage.define(mod.properties)),
  toml: () => import('@codemirror/legacy-modes/mode/toml').then(mod => StreamLanguage.define(mod.toml)),
  sql: () => import('@codemirror/legacy-modes/mode/sql').then(mod => StreamLanguage.define(mod.sql({}))),
  perl: () => import('@codemirror/legacy-modes/mode/perl').then(mod => StreamLanguage.define(mod.perl)),
  ruby: () => import('@codemirror/legacy-modes/mode/ruby').then(mod => StreamLanguage.define(mod.ruby)),
  swift: () => import('@codemirror/legacy-modes/mode/swift').then(mod => StreamLanguage.define(mod.swift)),
  lua: () => import('@codemirror/legacy-modes/mode/lua').then(mod => StreamLanguage.define(mod.lua)),
  dockerfile: () => import('@codemirror/legacy-modes/mode/dockerfile').then(mod => StreamLanguage.define(mod.dockerFile)),
  cmake: () => import('@codemirror/legacy-modes/mode/cmake').then(mod => StreamLanguage.define(mod.cmake)),
};

let requestSeq = 0;
let applied = '';

function resolvedName(text: string) {
  if (text.length > HIGHLIGHT_LIMIT) return '';
  return props.lang || detectLanguage(props.path, text);
}

async function extensionsFor(text: string) {
  const ticket = ++requestSeq;
  const name = resolvedName(text);
  emit('detected', text.length > HIGHLIGHT_LIMIT ? '文件较大，已关闭高亮' : props.lang ? name : `自动 → ${name}`);
  if (name === applied) return null;
  const load = loaders[name as HighlightLanguage];
  const extensions = load ? [await load()] : [];
  if (ticket !== requestSeq) return null;
  applied = name;
  return extensions;
}

function editable() {
  return [EditorView.editable.of(!props.readonly), EditorState.readOnly.of(props.readonly)];
}

async function applyLanguage(text: string) {
  const extensions = await extensionsFor(text);
  if (!view || !extensions) return;
  view.dispatch({ effects: languageConf.reconfigure(extensions) });
}

function reportCursor(state: EditorState) {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  emit('cursor', {
    line: line.number,
    col: main.head - line.from + 1,
    selected: Math.abs(main.to - main.from),
  });
}

onMounted(async () => {
  const language = await extensionsFor(props.modelValue);
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        search({ top: true }),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
        wrapConf.of(props.wrap ? EditorView.lineWrapping : []),
        languageConf.of(language || []),
        editConf.of(editable()),
        EditorView.updateListener.of(update => {
          if (update.selectionSet || update.docChanged) {
            reportCursor(update.state);
          }
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          emit('update:modelValue', text);
          if (!props.lang) void applyLanguage(text);
        }),
      ],
    }),
  });
  reportCursor(view.state);
});

watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  void applyLanguage(value);
});

watch(() => [props.lang, props.path], () => {
  if (!view) return;
  void applyLanguage(view.state.doc.toString());
});

watch(() => props.readonly, () => {
  view?.dispatch({ effects: editConf.reconfigure(editable()) });
});

watch(() => props.wrap, (wrap) => {
  view?.dispatch({ effects: wrapConf.reconfigure(wrap ? EditorView.lineWrapping : []) });
});

onBeforeUnmount(() => view?.destroy());

function gotoLine(line: number, col = 1) {
  if (!view) return;
  const info = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  const pos = Math.min(info.to, info.from + Math.max(0, col - 1));
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function toggleSearch() {
  if (!view) return;
  if (searchOpen && host.value?.querySelector('.cm-panel.cm-search')) {
    closeSearchPanel(view);
    searchOpen = false;
  } else {
    openSearchPanel(view);
    searchOpen = true;
  }
}

function triggerUndo() {
  if (!view) return;
  undo(view);
  view.focus();
}

function triggerRedo() {
  if (!view) return;
  redo(view);
  view.focus();
}

defineExpose({
  gotoLine,
  focus: () => view?.focus(),
  toggleSearch,
  undo: triggerUndo,
  redo: triggerRedo,
});
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden bg-white" />
</template>
