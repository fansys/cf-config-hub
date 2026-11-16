/** 规则列表的 Pointer Events 拖拽排序。 */

/**
 * @param {HTMLElement} list  含 .rule-row[data-idx] 的容器
 * @param {(from:number, to:number) => void} onMove  放下后回调（to 为移除 from 后的插入位置）
 */
export function attachDrag(list, onMove) {
  let drag = null;

  const clearMarks = () => list
    .querySelectorAll('.rule-row.drop-before,.rule-row.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));

  list.addEventListener('pointerdown', e => {
    if (e.target.closest('input,select,button,textarea')) return;
    const row = e.target.closest('.rule-row');
    if (!row) return;

    const rect = row.getBoundingClientRect();
    const idx = Number(row.dataset.idx);
    const ghost = row.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('rule-row'); // 避免被 .rule-row 选择器命中
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px',
      width: rect.width + 'px', pointerEvents: 'none', zIndex: '9999',
    });
    document.body.append(ghost);
    row.classList.add('dragging');

    drag = { row, ghost, from: idx, target: idx, before: true, startY: e.clientY, startTop: rect.top, active: false };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    e.preventDefault();
  });

  function move(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.active && Math.abs(dy) > 5) drag.active = true;
    if (!drag.active) return;

    drag.ghost.style.top = (drag.startTop + dy) + 'px';
    clearMarks();
    const hit = document.elementFromPoint(e.clientX + 10, e.clientY)?.closest('.rule-row');
    if (hit && hit !== drag.row) {
      const r = hit.getBoundingClientRect();
      drag.before = e.clientY < r.top + r.height / 2;
      drag.target = Number(hit.dataset.idx);
      hit.classList.add(drag.before ? 'drop-before' : 'drop-after');
    }
  }

  function up() {
    if (!drag) return;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    drag.ghost.remove();
    drag.row.classList.remove('dragging');
    clearMarks();

    if (drag.active && drag.target !== drag.from) {
      let to = drag.before ? drag.target : drag.target + 1;
      if (drag.from < to) to -= 1;
      onMove(drag.from, to);
    }
    drag = null;
  }
}
