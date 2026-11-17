// The pastas popup: pre-written posts to put in a reply (pasta-model.js).
// A popup next to the button it was opened from (a sheet along the bottom
// on a narrow window), not a modal: clicking outside it, Escape or picking
// one closes it. One at a time.
//
// Keys: the search box has the focus; ↓ goes to the list, ↑/↓ move along
// it, Home/End to its ends, →/← to a row's own buttons (pin, edit,
// delete), Enter picks (or presses the button), typing goes back to the
// search, Escape closes and gives the focus back to the button.
//
// Wiring (the shell): openPastas({ anchor: replyButton, settings,
// onSettings: (next, op) => save(next, { op }), onPick: (text) => {
// composer.open({ board, thread }); composer.insertText(text, { board,
// thread }); } }). It returns { close, update }: update(settings) after
// settings came from another window while it is open.

import * as P from './pasta-model.js';
import { h, icon, clear } from './dom.js';
import { confirmDialog } from './offline.js';

const SHEET = '(max-width: 480px)';
const GAP = 6;
const EDGE = 8;

let current = null; // the open popup's { close, update }
let seq = 0;
// An own post being written when the editor went away without Save or
// Cancel (Escape, a click outside, the focus leaving, the popup closing):
// { id ('' = a new one), title, text }. New post (or that post's Edit)
// brings it back, so a stray key or click never throws typed text away.
let ownDraft = null;

/** Whether a popup is open (one at a time). */
export const pastasOpen = () => Boolean(current);

/**
 * Opens the popup (closing one already open).
 * @param {object} o
 * @param {Element} [o.anchor]   the button it opens from: it sits next to
 *   it and the focus goes back to it on Escape and on a pick
 * @param {object} o.settings    the settings (settings.pastas)
 * @param {(next: object, op: [string, Function]) => void} [o.onSettings]
 *   a pin or an own post changed: the new settings, and the change as the
 *   shell's save() takes it (`op`, so it replays on another window's)
 * @param {(text: string, pasta: object) => void} [o.onPick]   a post was
 *   picked (the popup has closed): the text to put in the reply
 * @param {(reason: string) => void} [o.onClose]   'pick', 'escape',
 *   'outside', 'blur', 'button', 'replaced' or 'api'
 * @returns {{ close: (o?: { focus?: boolean }) => void, update: (settings: object) => void }}
 */
export function openPastas({ anchor = null, settings = {}, onSettings = null, onPick = null, onClose = null } = {}) {
  current?.close({ focus: false, reason: 'replaced' });
  const n = ++seq;
  const listId = `pastas-list-${n}`;
  const ac = new AbortController();
  const on = { signal: ac.signal };
  let s = settings || {};
  let query = '';
  let active = 0; // the row Tab lands on (a roving tabindex)
  let editing = null; // { id ('' = a new one), title, text, problem }
  let asking = false; // a confirmDialog is up
  let closed = false;
  let frame = 0;

  const search = h('input', {
    type: 'search',
    class: 'input pastas__search',
    placeholder: 'Search posts',
    'aria-label': 'Search pre-written posts',
    'aria-controls': listId,
    autocomplete: 'off',
    spellcheck: 'false',
    'data-key': 'pastas-search',
    oninput: () => {
      query = search.value;
      active = 0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => drawList());
    },
  });
  const list = h('div', { class: 'pastas__list', id: listId });
  const count = h('p', { class: 'pastas__count', 'aria-live': 'polite' });
  const body = h('div', { class: 'pastas__body' }, list, count);
  const foot = h('div', { class: 'pastas__own' });
  const box = h(
    'div',
    {
      class: 'pastas',
      role: 'dialog',
      'aria-label': 'Pre-written posts',
      'data-key': 'pastas',
      onkeydown: keys,
      onfocusout: (e) => {
        // the focus went somewhere else on the page (Tab out): it closes;
        // not for a confirm over it, or a row drawn again (no target)
        const to = e.relatedTarget;
        if (closed || asking || !to || box.contains(to) || to.closest?.('dialog')) return;
        close({ focus: false, reason: 'blur' });
      },
    },
    h(
      'div',
      { class: 'pastas__head' },
      icon('search', 'pastas__glass'),
      search,
      h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close', title: 'Close (Esc)', 'data-key': 'pastas-close', onclick: () => close({ reason: 'button' }) }, icon('x')),
    ),
    body,
    foot,
  );

  // ------------------------------------------------------------- the list

  const rowsOf = () => [...list.querySelectorAll('.pastas__pick')];
  const findPasta = (id) => P.allPastas(s).find((p) => p.id === id);

  function row(p, i, pinned) {
    const label = pinned ? 'Unpin' : 'Pin to the top';
    return h(
      'li',
      { class: `pastas__row${p.own ? ' pastas__row--own' : ''}`, 'data-pasta-id': p.id },
      h(
        'button',
        { type: 'button', class: 'pastas__pick', tabindex: i === active ? '0' : '-1', 'data-row': String(i), 'data-focus': `pick:${p.id}`, onclick: () => pick(p) },
        h('span', { class: 'pastas__title', translate: 'no', text: p.title }),
        h('span', { class: 'pastas__preview', translate: 'no', text: P.preview(p.text) }),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn icon-btn--sm pastas__pin',
          tabindex: '-1',
          'aria-pressed': pinned ? 'true' : 'false',
          'aria-label': 'Pin',
          title: label,
          'data-focus': `pin:${p.id}`,
          onclick: () => setPin(p.id, !pinned),
        },
        icon('bookmark'),
      ),
      p.own ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm pastas__edit-btn', tabindex: '-1', 'data-focus': `edit:${p.id}`, onclick: () => startEdit(p), text: 'Edit' }) : null,
      p.own ? h('button', { type: 'button', class: 'icon-btn icon-btn--sm pastas__delete', tabindex: '-1', 'aria-label': 'Delete', title: 'Delete', 'data-focus': `delete:${p.id}`, onclick: (e) => remove(p, e.currentTarget) }, icon('trash')) : null,
    );
  }

  /** Draws the list again; the focus stays on the same control (by its
   *  data-focus) when it was in the list. */
  function drawList(focusKey = null) {
    if (closed) return;
    const had = focusKey || (list.contains(document.activeElement) ? document.activeElement?.dataset?.focus : null);
    const sec = P.sections(query, s);
    const pinned = new Set(P.pastasOf(s).pinned);
    let i = 0;
    const max = sec.pinned.length + sec.own.length + sec.builtIn.length;
    if (active >= max) active = Math.max(0, max - 1);
    const group = (title, items) => {
      if (!items.length) return null;
      const id = `${listId}-${title.replace(/\W+/g, '').toLowerCase()}`;
      return [h('h3', { class: 'pastas__section', id, text: title }), h('ul', { class: 'pastas__rows', role: 'list', 'aria-labelledby': id }, items.map((p) => row(p, i++, pinned.has(p.id))))];
    };
    clear(list);
    list.append(...[group('Pinned', sec.pinned), group('Your own', sec.own), group('Pre-written posts', sec.builtIn)].flat().filter(Boolean));
    if (!sec.total) {
      list.append(
        h(
          'div',
          { class: 'pastas__empty' },
          h('p', { text: query.trim() ? 'Nothing matches your search.' : 'No posts here yet.' }),
          query.trim() ? h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'pastas-clear', onclick: clearSearch, text: 'Clear the search' }) : null,
        ),
      );
    }
    count.textContent = sec.total > sec.shown ? `Showing ${sec.shown} of ${sec.total}: search to find the rest.` : '';
    count.hidden = !count.textContent;
    if (had) {
      const el = list.querySelector(`[data-focus="${CSS.escape(had)}"]`);
      if (el) {
        moveTo(el);
        return;
      }
      // the control went (an unpin under a search, a delete): the row now there
      rowsOf()[active]?.focus({ preventScroll: false });
    }
  }

  function clearSearch() {
    search.value = '';
    query = '';
    active = 0;
    drawList();
    search.focus();
  }

  /** Focuses a control in the list and makes its row the one Tab lands on. */
  function moveTo(el) {
    const pick = el.closest('.pastas__row')?.querySelector('.pastas__pick');
    if (!pick) return;
    active = Number(pick.dataset.row) || 0;
    for (const r of rowsOf()) r.tabIndex = r === pick ? 0 : -1;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  // --------------------------------------------------------------- changes

  function change(op) {
    if (!op) return;
    const next = op[1](s);
    if (next === s) return;
    s = next;
    onSettings?.(next, op);
  }

  function setPin(id, pin) {
    change(P.pastaOp('pin', id, pin));
    drawList(`pin:${id}`);
  }

  function pick(p) {
    const text = P.pastaText(p);
    close({ reason: 'pick' });
    onPick?.(text, p);
  }

  // ------------------------------------------------------------- own posts

  function startEdit(p = null) {
    const id = p?.id || '';
    const kept = ownDraft?.id === id ? ownDraft : null;
    editing = kept ? { ...kept, problem: '' } : { id, title: p?.title || '', text: p?.text || '', problem: '' };
    drawFoot();
    foot.querySelector('[data-key="pastas-own-text"]')?.focus();
  }

  /** Whether the editor holds text that Save has not kept. */
  function unsaved() {
    if (!editing) return false;
    const { id, title, text } = editing;
    if (!id) return Boolean(title.trim() || text.trim());
    const p = findPasta(id);
    return !p || p.title !== title || p.text !== text;
  }

  /** Keeps the editor's unsaved text for the next New post / Edit. */
  function keepDraft() {
    if (!editing) return;
    if (unsaved()) ownDraft = { id: editing.id, title: editing.title, text: editing.text };
    else if (ownDraft?.id === editing.id) ownDraft = null;
  }

  /** Closes the editor. `keep`: its unsaved text is kept (Escape), else
   *  it goes (Cancel, Save). */
  function stopEdit(focusKey = null, { keep = false } = {}) {
    if (keep) keepDraft();
    else if (editing && ownDraft?.id === editing.id) ownDraft = null;
    editing = null;
    drawFoot();
    const back = focusKey && list.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
    if (back) moveTo(back);
    else foot.querySelector('[data-key="pastas-new"]')?.focus();
  }

  function saveEdit() {
    if (!editing) return;
    const { id, title, text } = editing;
    const problem = P.ownProblem(s, { id, title, text });
    if (problem) {
      editing.problem = problem === 'empty' ? 'Write the post first.' : 'There is no room for more of your own posts: delete one first.';
      drawFoot();
      foot.querySelector('[data-key="pastas-own-text"]')?.focus();
      return;
    }
    const at = Date.now();
    const made = id || P.newOwnId(at);
    // the pin goes with it: an add, pin, edit still waiting to be saved
    // replays pin first (pasta-model.js pastaOp)
    change(P.pastaOp('put', made, { id: made, title, text, at }, { pinned: P.isPinned(s, made) }));
    if (!id && query.trim()) {
      // a new one shows even under a search
      search.value = '';
      query = '';
    }
    drawList();
    stopEdit(`pick:${made}`);
  }

  async function remove(p, button) {
    if (asking) return;
    asking = true;
    let ok = false;
    try {
      ok = await confirmDialog({ title: 'Delete this post of your own?', text: 'It goes from your own posts for good.', confirm: 'Delete', opener: button });
    } finally {
      asking = false;
    }
    if (closed || !ok) return;
    if (editing?.id === p.id) editing = null;
    if (ownDraft?.id === p.id) ownDraft = null;
    change(P.pastaOp('remove', p.id));
    drawList();
    drawFoot();
    (rowsOf()[active] || search).focus();
  }

  function drawFoot() {
    clear(foot);
    if (!editing) {
      foot.append(
        h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'pastas-new', onclick: () => startEdit() }, icon('plus'), 'New post'),
        h('span', { class: 'pastas__hint', text: '↑ ↓ to move, Enter to use, Esc to close' }),
      );
      return;
    }
    const counter = h('span', { class: 'pastas__chars', text: `${editing.text.length} / ${P.MAX_TEXT}` });
    const titleId = `pastas-own-title-${n}`;
    const textId = `pastas-own-text-${n}`;
    foot.append(
      h(
        'div',
        { class: 'pastas__edit', role: 'group', 'aria-label': editing.id ? 'Edit your post' : 'New post of your own' },
        h('label', { class: 'pastas__label', for: titleId, text: 'Title' }),
        h('input', {
          id: titleId,
          class: 'input',
          maxlength: String(P.MAX_TITLE),
          value: editing.title,
          placeholder: 'Its first line when left empty',
          'data-key': 'pastas-own-title',
          oninput: (e) => (editing.title = e.target.value),
        }),
        h('label', { class: 'pastas__label', for: textId, text: 'Text' }),
        h('textarea', {
          id: textId,
          class: 'input pastas__text',
          rows: '4',
          maxlength: String(P.MAX_TEXT),
          translate: 'no',
          'data-key': 'pastas-own-text',
          oninput: (e) => {
            editing.text = e.target.value;
            counter.textContent = `${editing.text.length} / ${P.MAX_TEXT}`;
          },
        }),
        counter,
        editing.problem ? h('p', { class: 'pastas__problem', role: 'alert', text: editing.problem }) : null,
        h(
          'div',
          { class: 'pastas__actions' },
          h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'pastas-own-cancel', onclick: () => stopEdit(editing?.id ? `edit:${editing.id}` : null), text: 'Cancel' }),
          h('button', { type: 'button', class: 'btn btn--primary btn--sm', 'data-key': 'pastas-own-save', onclick: saveEdit, text: 'Save' }),
        ),
      ),
    );
    foot.querySelector('textarea').value = editing.text;
    place();
  }

  // ------------------------------------------------------------------ keys

  function keys(e) {
    if (closed || e.isComposing) return;
    const t = e.target;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      if (editing && foot.contains(t)) stopEdit(editing.id ? `edit:${editing.id}` : null, { keep: true });
      else close({ reason: 'escape' });
      return;
    }
    if (foot.contains(t)) {
      if (editing && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEdit();
      }
      return;
    }
    const rows = rowsOf();
    if (t === search) {
      if (e.key === 'ArrowDown' && rows.length) {
        e.preventDefault();
        moveTo(rows[Math.min(active, rows.length - 1)]);
      } else if (e.key === 'Enter' && rows.length) {
        e.preventDefault();
        rows[Math.min(active, rows.length - 1)].click();
      }
      return;
    }
    const r = t.closest?.('.pastas__row');
    if (!r || !list.contains(r)) return;
    const pickBtn = r.querySelector('.pastas__pick');
    const at = rows.indexOf(pickBtn);
    const controls = [...r.querySelectorAll('button')];
    const ci = controls.indexOf(t);
    const go = (i) => {
      e.preventDefault();
      if (i < 0) {
        search.focus();
        return;
      }
      moveTo(rows[Math.min(rows.length - 1, i)]);
    };
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    switch (e.key) {
      case 'ArrowDown':
        return go(at + 1);
      case 'ArrowUp':
        return go(at - 1);
      case 'Home':
        return go(0);
      case 'End':
        return go(rows.length - 1);
      case 'ArrowRight':
        e.preventDefault();
        if (ci < controls.length - 1) moveTo(controls[ci + 1]);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (ci > 0) moveTo(controls[ci - 1]);
        return;
      default:
        // typing goes on in the search box
        if (e.key.length === 1 && e.key !== ' ') search.focus();
    }
  }

  // ------------------------------------------------------------- placement

  /** Next to the anchor (below it, or above when there is more room
   *  there), inside the window; a sheet along the bottom when narrow. */
  function place() {
    if (closed) return;
    const sheet = matchMedia(SHEET).matches;
    box.classList.toggle('pastas--sheet', sheet);
    for (const k of ['left', 'top', 'max-height']) box.style.removeProperty(k);
    if (sheet) return;
    const W = document.documentElement.clientWidth || innerWidth;
    const H = innerHeight;
    const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    const w = box.offsetWidth;
    if (!r || (!r.width && !r.height)) {
      box.style.setProperty('left', `${Math.round(Math.max(EDGE, (W - w) / 2))}px`);
      box.style.setProperty('top', `${Math.round(Math.max(EDGE, H * 0.15))}px`);
      box.style.setProperty('max-height', `${Math.round(H * 0.7)}px`);
      return;
    }
    const below = H - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const natural = box.offsetHeight;
    const down = below >= Math.min(natural, 320) || below >= above;
    const room = Math.max(160, down ? below : above);
    box.style.setProperty('max-height', `${Math.round(room)}px`);
    const height = box.offsetHeight;
    let left = r.left;
    if (left + w > W - EDGE) left = r.right - w; // the anchor's right edge instead
    left = Math.min(W - EDGE - w, Math.max(EDGE, left));
    let top = down ? r.bottom + GAP : r.top - GAP - height;
    top = Math.min(H - EDGE - height, Math.max(EDGE, top));
    box.style.setProperty('left', `${Math.round(left)}px`);
    box.style.setProperty('top', `${Math.round(top)}px`);
  }

  // ------------------------------------------------------------ open/close

  function close({ focus = true, reason = 'api' } = {}) {
    if (closed) return;
    keepDraft();
    closed = true;
    cancelAnimationFrame(frame);
    ac.abort();
    box.remove();
    if (current === api) current = null;
    if (focus) {
      // the anchor, or the button drawn in its place (the same data-key)
      const key = anchor?.dataset?.key;
      const back = anchor?.isConnected ? anchor : key ? document.querySelector(`[data-key="${CSS.escape(key)}"]`) : null;
      back?.focus({ preventScroll: true });
    }
    onClose?.(reason);
  }

  function update(next) {
    if (closed || !next || next === s) return;
    s = next;
    drawList();
  }

  const api = { close, update };
  current = api;

  // a press outside closes it (the anchor too: pressing it again toggles);
  // not one in a confirm over it
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (closed || asking) return;
      const t = e.target;
      if (box.contains(t) || t?.closest?.('dialog')) return;
      close({ focus: false, reason: 'outside' });
    },
    { capture: true, signal: ac.signal },
  );
  addEventListener('resize', place, on);
  // the anchor scrolled with its pane: it follows
  document.addEventListener('scroll', (e) => !box.contains(e.target) && place(), { capture: true, passive: true, signal: ac.signal });

  drawList();
  drawFoot();
  document.body.append(box);
  place();
  search.focus({ preventScroll: true });
  return api;
}
