// A small menu of actions (a post's "…" button): opened by its button,
// moved through with the arrow keys, closed by Esc, Tab, a click outside,
// scrolling or resizing. It sits on the page, not in the pane, so a thread
// redrawing itself under it does not close it; its actions keep working.

import { h } from './dom.js';

let current = null; // { menu, anchor, key, cleanup }

/** Where the menu goes: under the button, right edges lined up, inside
 *  the window (above the button when there is no room below). */
export function placeMenu(anchor, size, view, gap = 4) {
  const margin = 8;
  let left = anchor.right - size.width;
  left = Math.max(margin, Math.min(left, view.width - size.width - margin));
  let top = anchor.bottom + gap;
  if (top + size.height > view.height - margin && anchor.top - gap - size.height >= margin) top = anchor.top - gap - size.height;
  top = Math.max(margin, Math.min(top, view.height - size.height - margin));
  return { left: Math.round(left), top: Math.round(top) };
}

export function closeMenu({ focus = false } = {}) {
  if (!current) return;
  const { menu, anchor, key, cleanup } = current;
  current = null;
  cleanup();
  menu.remove();
  // The thread may have redrawn: the same button is found again by its key.
  const btn = anchor.isConnected ? anchor : key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
  btn?.setAttribute('aria-expanded', 'false');
  if (focus) btn?.focus();
}

/**
 * @param {HTMLElement} anchor   the button that opens it (aria-haspopup)
 * @param {{label: string, onSelect: () => void, danger?: boolean}[]} items
 * @param {string} label         the menu's accessible name
 */
export function openMenu(anchor, items, label) {
  const same = current?.anchor === anchor;
  closeMenu();
  if (same || !items.length) return;
  const buttons = items.map((it) =>
    h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu__item${it.danger ? ' menu__item--danger' : ''}`,
      tabindex: '-1',
      onclick: () => {
        closeMenu({ focus: true });
        it.onSelect();
      },
      text: it.label,
    }),
  );
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label }, buttons);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const pos = placeMenu(r, { width: menu.offsetWidth, height: menu.offsetHeight }, { width: innerWidth, height: innerHeight });
  menu.style.setProperty('left', `${pos.left}px`);
  menu.style.setProperty('top', `${pos.top}px`);
  anchor.setAttribute('aria-expanded', 'true');

  const move = (step) => {
    const i = buttons.indexOf(document.activeElement);
    const n = buttons.length;
    buttons[(i + step + n) % n].focus();
  };
  // Caught on the document first, so while the menu is open Esc only closes
  // it, wherever the focus is (the shell's Esc would leave the thread).
  const onKey = (e) => {
    if (e.key !== 'Escape' && !menu.contains(document.activeElement)) return;
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Home') buttons[0].focus();
    else if (e.key === 'End') buttons[buttons.length - 1].focus();
    else if (e.key === 'Escape') closeMenu({ focus: true });
    else if (e.key === 'Tab') {
      closeMenu();
      return;
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu();
  };
  const onScroll = (e) => {
    if (!menu.contains(e.target)) closeMenu();
  };
  const onResize = () => closeMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  current = {
    menu,
    anchor,
    key: anchor.dataset.key || '',
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    },
  };
  buttons[0].focus();
}
