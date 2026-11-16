/** 通用弹窗（<dialog>）。 */
import { $, makeEl } from '../util.js';

export function openModal(title, content, { wide = false } = {}) {
  $('modal').classList.toggle('wide', wide);
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(content);
  const dlg = $('modal');
  if (!dlg.open) dlg.showModal();
}

/** 代替 window.alert 的提示弹窗：标题 + 说明 + 可选明细列表 + "知道了"按钮。 */
export function showAlert(title, message, details = []) {
  const box = makeEl('div', 'alert-box');
  box.append(makeEl('p', 'alert-msg', message));
  if (details.length) {
    const list = makeEl('ul', 'alert-list');
    for (const d of details) list.append(makeEl('li', '', d));
    box.append(list);
  }
  const ok = makeEl('button', 'btn primary', '知道了');
  ok.type = 'button';
  ok.addEventListener('click', closeModal);
  const actions = makeEl('div', 'reauth-actions');
  actions.append(ok);
  box.append(actions);
  openModal(title, box);
  ok.focus();
}

export const closeModal = () => { if ($('modal').open) $('modal').close(); };

export function bindModal() {
  $('modalClose').addEventListener('click', closeModal);
  // 点击遮罩关闭
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
}

/* ============================================================
 *  代替 window.confirm / window.prompt 的异步模态窗
 *  每次调用创建独立的 <dialog>，可叠在其它弹窗之上；Esc / 点击遮罩 = 取消。
 * ============================================================ */

function buildDialog(title) {
  const dlg = document.createElement('dialog');
  dlg.className = 'modal dialog-small';
  const form = makeEl('form');
  form.method = 'dialog';
  const head = makeEl('div', 'modal-head');
  head.append(makeEl('h3', '', title));
  const body = makeEl('div', 'modal-body');
  form.append(head, body);
  dlg.append(form);
  return { dlg, form, body };
}

function runDialog({ dlg, form }, focusEl, readResult) {
  return new Promise(resolve => {
    let result = readResult(false);
    form.addEventListener('submit', () => { result = readResult(true); });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
    focusEl?.focus();
    focusEl?.select?.();
  });
}

function actionRow(cancelText, okText, danger) {
  const row = makeEl('div', 'reauth-actions');
  const cancel = makeEl('button', 'btn ghost', cancelText);
  cancel.type = 'button';
  cancel.addEventListener('click', () => cancel.closest('dialog').close());
  const ok = makeEl('button', 'btn ' + (danger ? 'danger-solid' : 'primary'), okText);
  ok.type = 'submit';
  row.append(cancel, ok);
  return { row, ok };
}

function messageBlock(message, details) {
  const box = makeEl('div');
  if (message) box.append(makeEl('p', 'alert-msg', message));
  if (details?.length) {
    const list = makeEl('ul', 'alert-list neutral');
    for (const d of details) list.append(makeEl('li', '', d));
    box.append(list);
  }
  return box;
}

/**
 * 确认框，返回 Promise<boolean>。
 * @param {{title?:string, message?:string, details?:string[], okText?:string, cancelText?:string, danger?:boolean}} o
 */
export function askConfirm({ title = '请确认', message = '', details = [], okText = '确定', cancelText = '取消', danger = false } = {}) {
  const d = buildDialog(title);
  d.body.append(messageBlock(message, details));
  const { row, ok } = actionRow(cancelText, okText, danger);
  d.body.append(row);
  return runDialog(d, ok, submitted => submitted);
}

/**
 * 输入框，返回 Promise<string | null>（取消为 null）。
 * @param {{title?:string, message?:string, defaultValue?:string, placeholder?:string, multiline?:boolean, okText?:string}} o
 */
export function askInput({ title = '请输入', message = '', defaultValue = '', placeholder = '', multiline = false, okText = '确定' } = {}) {
  const d = buildDialog(title);
  d.body.append(messageBlock(message));
  const field = multiline ? makeEl('textarea', 'dialog-field dialog-textarea') : makeEl('input', 'dialog-field');
  if (multiline) field.rows = 10; else field.type = 'text';
  field.value = defaultValue;
  field.placeholder = placeholder;
  field.spellcheck = false;
  if (multiline) {
    // 多行输入里 Enter 是换行，Ctrl/Cmd+Enter 提交
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); field.form.requestSubmit(); }
    });
  }
  d.body.append(field);
  const { row } = actionRow('取消', okText, false);
  d.body.append(row);
  return runDialog(d, field, submitted => (submitted ? field.value : null));
}

/**
 * 单选列表，返回 Promise<选中项 id | null>。
 * @param {{title?:string, message?:string, options:{id:string,name:string,desc?:string}[], selected?:string, okText?:string}} o
 */
export function askChoice({ title = '请选择', message = '', options, selected, okText = '确定' }) {
  const d = buildDialog(title);
  d.body.append(messageBlock(message));
  const group = `choice-${Math.random().toString(36).slice(2)}`;
  const radios = options.map((opt, i) => {
    const label = makeEl('label', 'choice-item');
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = group; radio.value = opt.id;
    radio.checked = opt.id === (selected ?? options[0].id);
    const text = makeEl('span');
    text.append(makeEl('strong', '', opt.name));
    if (opt.desc) text.append(makeEl('small', '', opt.desc));
    label.append(radio, text);
    d.body.append(label);
    return radio;
  });
  const { row, ok } = actionRow('取消', okText, false);
  d.body.append(row);
  return runDialog(d, ok, submitted => (submitted ? radios.find(r => r.checked)?.value ?? null : null));
}
