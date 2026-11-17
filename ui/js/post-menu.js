// A small menu of actions (a post's "…" button): opened by its button,
// moved through with the arrow keys, closed by Esc, Tab, a click outside,
// scrolling or resizing. It sits on the page, not in the pane, so a thread
// redrawing itself under it does not close it; its actions keep working.

import { h, isRestoreScroll } from './dom.js';

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

/** Whether `anchor` is the button of the open menu `cur` ({anchor, key}):
 *  the same element, or the one a redraw drew in its place (the same
 *  data-key). */
export function isMenuAnchor(cur, anchor) {
  if (!cur || !anchor) return false;
  if (cur.anchor === anchor) return true;
  return Boolean(cur.key) && cur.key === anchor.dataset?.key;
}

// The open menu's button: the thread may have redrawn, and the same button
// is found again by its key.
function liveAnchor() {
  if (!current) return null;
  const { anchor, key } = current;
  if (anchor.isConnected) return anchor;
  return key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
}

/** After a redraw: the open menu follows its button drawn anew (its
 *  aria-expanded; a click on it closes the menu). */
export function menuAnchorRedrawn() {
  const btn = liveAnchor();
  if (!btn || btn === current.anchor) return;
  current.anchor = btn;
  btn.setAttribute('aria-expanded', 'true');
}

export function closeMenu({ focus = false } = {}) {
  if (!current) return;
  const btn = liveAnchor();
  const { menu, cleanup } = current;
  current = null;
  cleanup();
  menu.remove();
  btn?.setAttribute('aria-expanded', 'false');
  if (focus) btn?.focus();
}

/**
 * @param {HTMLElement} anchor   the button that opens it (aria-haspopup)
 * @param {{label: string, onSelect: () => void, danger?: boolean}[]} items
 * @param {string} label         the menu's accessible name
 */
export function openMenu(anchor, items, label) {
  const same = isMenuAnchor(current, anchor);
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
  // a press on its button (or on the one a redraw drew in its place) is
  // left to the button's click, which closes it
  const onDown = (e) => {
    if (menu.contains(e.target) || liveAnchor()?.contains(e.target)) return;
    closeMenu();
  };
  // Scrolling closes it once its button moves: a pane redrawn and put back
  // where it was (or kept in place as its pictures load), or another pane
  // scrolled, leaves the button where it was, and the menu by it.
  const at = { top: r.top, left: r.left };
  const onScroll = (e) => {
    if (menu.contains(e.target) || isRestoreScroll(e)) return;
    const now = liveAnchor()?.getBoundingClientRect();
    if (now && now.width && Math.abs(now.top - at.top) < 2 && Math.abs(now.left - at.left) < 2) return;
    closeMenu();
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
