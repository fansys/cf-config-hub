/** 折叠菜单（"更多 ▾"）：静态 HTML 与动态生成共用同一套样式与事件。 */
import { makeEl } from '../util.js';

/**
 * 动态创建一个折叠菜单。
 * @param {string} label 触发按钮文字
 * @param {{label:string, onClick:()=>void, danger?:boolean, disabled?:boolean, hidden?:boolean, title?:string}[]} items
 * @param {{ cls?: string, align?: 'left'|'right' }} [opts]
 */
export function makeMenu(label, items, { cls = 'btn ghost small', align = 'right' } = {}) {
  const wrap = makeEl('div', 'menu');
  const toggle = makeEl('button', `${cls} menu-btn`, `${label} ▾`);
  toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  const list = makeEl('div', 'menu-list' + (align === 'left' ? ' left' : ''));
  list.hidden = true;
  list.setAttribute('role', 'menu');
  for (const it of items) {
    const b = makeEl('button', 'btn ghost small menu-item' + (it.danger ? ' danger' : ''), it.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it.disabled;
    b.hidden = !!it.hidden;
    if (it.title) b.title = it.title;
    b.addEventListener('click', it.onClick);
    list.append(b);
  }
  wrap.append(toggle, list);
  return wrap;
}

function closeAll(except) {
  document.querySelectorAll('.menu-list:not([hidden])').forEach(list => {
    if (list === except) return;
    list.hidden = true;
    list.parentElement.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'false');
  });
}

/** 全局委托：点击触发按钮开合；点击菜单项、空白处或按 Esc 关闭。只需调用一次。 */
export function bindMenus() {
  document.addEventListener('click', e => {
    const toggle = e.target.closest('.menu-btn');
    if (toggle) {
      const list = toggle.parentElement.querySelector('.menu-list');
      const open = list.hidden;
      closeAll(open ? list : null);
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      return;
    }
    if (e.target.closest('.menu-list')) { closeAll(); return; } // 点了菜单项：它自己的处理器已先执行
    closeAll();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
}
