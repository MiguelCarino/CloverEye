// The pastas panel: pre-written posts to put in a reply (pasta-model.js).
// A panel next to the button it was opened from (a sheet along the bottom
// on a narrow window), not a modal: clicking outside it, Escape or picking
// one closes it. One at a time. Its results are a grid of cards in three
// sections (Pinned, Your own, Built-in), filtered by the search and the
// tag chips under it.
//
// Keys: the search box has the focus; ↓ goes into the grid, the arrow keys
// move across it (up and down by the grid's column count; ↑ from the top
// row goes back to the search), Home/End to its ends, Enter picks, P pins
// or unpins the focused card, Delete deletes an own one, Tab reaches the
// focused card's own buttons (pin, edit, delete), typing goes back to the
// search, Escape closes and gives the focus back to the button.
//
// Wiring (the shell): openPastas({ anchor: replyButton, settings,
// onSettings: (next, op) => save(next, { op }), onPick: (text) => {
// composer.open({ board, thread }); composer.insertText(text, { board,
// thread }); } }). It returns { close, update }: update(settings) after
// settings came from another window while it is open.
//
// savePastaFrom({ text, getSettings, onSettings, opener }): Save as pasta
// (the reply form's button, a post's menu): a small prompt for the title,
// then the text is kept as an own post, saved through onSettings like a
// change made in the panel.

import * as P from './pasta-model.js';
import { h, icon, clear, toast } from './dom.js';
import { confirmDialog } from './offline.js';
import { log } from './log.js';

const SHEET = '(max-width: 480px)';
const GAP = 6;
const EDGE = 8;
/** Below this much room above and below the anchor, the panel takes the
 *  window's height instead (over the anchor): a grid needs the room. */
const MIN_ROOM = 340;

/** The tag chips' labels (pasta-model.js TAGS). */
const TAG_LABELS = {
  all: 'All',
  bump: 'Bump',
  reaction: 'Reaction',
  classic: 'Classics',
  greentext: 'Greentext',
  tech: 'Tech',
  own: 'Yours',
};
const FULL = 'There is no room for more of your own posts: delete one first.';

let current = null; // the open panel's { close, update }
let seq = 0;
// An own post being written when the editor went away without Save or
// Cancel (Escape, a click outside, the focus leaving, the panel closing):
// { id ('' = a new one), title, text }. New pasta (or that post's Edit)
// brings it back, so a stray key or click never throws typed text away.
let ownDraft = null;
// The tag chip picked last: the panel opens on it again.
let lastTag = 'all';

/** Whether a panel is open (one at a time). */
export const pastasOpen = () => Boolean(current);

/** A card's preview: its first lines, greentext ones in the greentext
 *  colour (inline, so the card's line clamp counts them). */
function previewOf(text) {
  const lines = P.previewLines(text, 5);
  const out = [];
  lines.forEach((l, i) => {
    if (i) out.push('\n');
    out.push(l.green ? h('span', { class: 'pastas__green', text: l.text }) : l.text);
  });
  return h('span', { class: 'pastas__preview', translate: 'no' }, out);
}

/**
 * Opens the panel (closing one already open).
 * @param {object} o
 * @param {Element} [o.anchor]   the button it opens from: it sits next to
 *   it and the focus goes back to it on Escape and on a pick
 * @param {object} o.settings    the settings (settings.pastas)
 * @param {(next: object, op: [string, Function]) => void} [o.onSettings]
 *   a pin or an own post changed: the new settings, and the change as the
 *   shell's save() takes it (`op`, so it replays on another window's)
 * @param {(text: string, pasta: object) => void} [o.onPick]   a post was
 *   picked (the panel has closed): the text to put in the reply
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
  let tag = P.TAGS.includes(lastTag) ? lastTag : 'all';
  let active = 0; // the card Tab lands on (a roving tabindex)
  let sizes = [0, 0, 0]; // the sections' card counts, as drawn
  let editing = null; // { id ('' = a new one), title, text, problem }
  let asking = false; // a confirmDialog is up
  let closed = false;
  let frame = 0;
  // for the log: when it opened, and the search as last logged (its length)
  const openedAt = performance.now();
  let loggedQuery = '';
  let longestQuery = 0;
  /** A pasta for the log: a built-in one by its id, one of the person's
   *  own only as 'own' (its id says when it was made, its title what). */
  const idOf = (p) => (!p?.own && P.BUILT_IN.some((b) => b.id === p?.id) ? String(p.id) : 'own');

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
  const chips = h('div', { class: 'pastas__chips', role: 'radiogroup', 'aria-label': 'Filter by tag', onkeydown: chipKeys });
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
        // not for a confirm over it, or a card drawn again (no target)
        const to = e.relatedTarget;
        if (closed || asking || !to || box.contains(to) || to.closest?.('dialog')) return;
        close({ focus: false, reason: 'blur' });
      },
    },
    h(
      'div',
      { class: 'pastas__head' },
      h('span', { class: 'pastas__find' }, icon('search', 'pastas__glass'), search),
      h('button', { type: 'button', class: 'btn btn--sm pastas__new', title: 'Write a pasta of your own', 'data-key': 'pastas-new', onclick: () => startEdit() }, icon('plus'), h('span', { text: 'New pasta' })),
      h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close', title: 'Close (Esc)', 'data-key': 'pastas-close', onclick: () => close({ reason: 'button' }) }, icon('x')),
    ),
    chips,
    body,
    foot,
  );

  // ------------------------------------------------------------- the chips

  function drawChips() {
    clear(chips);
    for (const t of P.TAGS) {
      const on = t === tag;
      chips.append(
        h('button', {
          type: 'button',
          role: 'radio',
          class: 'pastas__chip',
          'aria-checked': on ? 'true' : 'false',
          tabindex: on ? '0' : '-1',
          'data-tag': t,
          'data-key': `pastas-tag-${t}`,
          onclick: () => setTag(t),
          text: TAG_LABELS[t],
        }),
      );
    }
  }

  function setTag(t, { focus = false } = {}) {
    if (!P.TAGS.includes(t)) return;
    if (t !== tag) {
      log.info('pasta', 'pasta.chip', { chip: t, from: tag });
      tag = lastTag = t;
      active = 0;
      for (const c of chips.children) {
        const on = c.dataset.tag === t;
        c.setAttribute('aria-checked', on ? 'true' : 'false');
        c.tabIndex = on ? 0 : -1;
      }
      drawList();
    }
    if (focus) chips.querySelector(`[data-tag="${t}"]`)?.focus();
  }

  /** ←/→ (and Home/End) along the chips pick, as radio buttons do. */
  function chipKeys(e) {
    const i = P.TAGS.indexOf(e.target?.dataset?.tag);
    if (i < 0 || e.ctrlKey || e.altKey || e.metaKey) return;
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: P.TAGS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setTag(P.TAGS[(to + P.TAGS.length) % P.TAGS.length], { focus: true });
  }

  // -------------------------------------------------------------- the grid

  const cardsOf = () => [...list.querySelectorAll('.pastas__pick')];
  const findPasta = (id) => P.allPastas(s).find((p) => p.id === id);

  function card(p, i, pinned) {
    const mine = i === active;
    const tab = mine ? '0' : '-1';
    const chipsOf = (p.own ? ['own'] : p.tags).filter((t) => TAG_LABELS[t]);
    return h(
      'li',
      {
        class: `pastas__card${p.own ? ' pastas__card--own' : ''}${pinned ? ' pastas__card--pinned' : ''}`,
        'data-pasta-id': p.id,
        // a click anywhere on the card but its buttons picks it
        onclick: (e) => !e.target.closest?.('.pastas__tool') && pick(p),
      },
      h(
        'button',
        { type: 'button', class: 'pastas__pick', tabindex: tab, 'data-row': String(i), 'data-focus': `pick:${p.id}` },
        h('span', { class: 'pastas__title', translate: 'no', text: p.title }),
        previewOf(p.text),
      ),
      h(
        'div',
        { class: 'pastas__foot' },
        h(
          'span',
          { class: 'pastas__tags' },
          chipsOf.map((t) => h('span', { class: `pastas__tag pastas__tag--${t}`, text: TAG_LABELS[t] })),
        ),
        h(
          'span',
          { class: 'pastas__tools' },
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn icon-btn--sm pastas__tool pastas__pin',
              tabindex: tab,
              'aria-pressed': pinned ? 'true' : 'false',
              'aria-label': 'Pin',
              title: pinned ? 'Unpin (P)' : 'Pin to the top (P)',
              'data-focus': `pin:${p.id}`,
              onclick: () => setPin(p.id, !pinned),
            },
            icon('bookmark'),
          ),
          p.own ? h('button', { type: 'button', class: 'btn btn--ghost btn--sm pastas__tool pastas__edit-btn', tabindex: tab, 'data-focus': `edit:${p.id}`, onclick: () => startEdit(p), text: 'Edit' }) : null,
          p.own
            ? h(
                'button',
                { type: 'button', class: 'icon-btn icon-btn--sm pastas__tool pastas__delete', tabindex: tab, 'aria-label': 'Delete', title: 'Delete', 'data-focus': `delete:${p.id}`, onclick: (e) => remove(p, e.currentTarget) },
                icon('trash'),
              )
            : null,
        ),
      ),
    );
  }

  /** Draws the grid again (once per query, tag or change; never per key
   *  press in it); the focus stays on the same control (by its data-focus)
   *  when it was in the grid. */
  function drawList(focusKey = null) {
    if (closed) return;
    const had = focusKey || (list.contains(document.activeElement) ? document.activeElement?.dataset?.focus : null);
    const sec = P.sections(query, s, P.MAX_SHOWN, tag);
    const pinned = new Set(P.pastasOf(s).pinned);
    sizes = [sec.pinned.length, sec.own.length, sec.builtIn.length];
    // a new search (once per drawn query, never per key): its length and
    // what it found, never what was typed
    if (query !== loggedQuery) {
      loggedQuery = query;
      longestQuery = Math.max(longestQuery, query.length);
      log.debug('pasta', 'pasta.search', { queryChars: query.trim().length, chip: tag, found: sec.total, shown: sec.shown });
    }
    let i = 0;
    const max = sec.shown;
    if (active >= max) active = Math.max(0, max - 1);
    const group = (key, title, items) => {
      if (!items.length) return null;
      const id = `${listId}-${key}`;
      return h(
        'section',
        { class: 'pastas__group' },
        h('h3', { class: 'pastas__section', id }, h('span', { text: title }), h('span', { class: 'pastas__n', text: String(items.length) })),
        h('ul', { class: 'pastas__grid pastas__rows', role: 'list', 'aria-labelledby': id }, items.map((p) => card(p, i++, pinned.has(p.id)))),
      );
    };
    const parts = [group('pinned', 'Pinned', sec.pinned), group('own', 'Your own', sec.own), group('builtin', 'Built in', sec.builtIn)].filter(Boolean);
    if (!sec.total) {
      const filtered = query.trim() || tag !== 'all';
      parts.push(
        h(
          'div',
          { class: 'pastas__empty' },
          h('p', { text: tag === 'own' && !query.trim() ? 'No pastas of your own yet: New pasta writes one.' : filtered ? 'Nothing matches your search.' : 'No posts here yet.' }),
          filtered ? h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'pastas-clear', onclick: clearSearch, text: 'Clear the search' }) : null,
        ),
      );
    }
    list.replaceChildren(...parts);
    count.textContent = sec.total > sec.shown ? `Showing ${sec.shown} of ${sec.total}: search to find the rest.` : '';
    count.hidden = !count.textContent;
    // the height changed (a chip, a search, another window's save): placed
    // again, or a panel above its button floats off it or runs off the window
    place();
    if (had) {
      const el = list.querySelector(`[data-focus="${CSS.escape(had)}"]`);
      if (el) {
        moveTo(el);
        return;
      }
      // the control went (an unpin under a filter, a delete): the card now there
      const c = cardsOf()[active];
      if (c) moveTo(c);
    }
  }

  function clearSearch() {
    search.value = '';
    query = '';
    active = 0;
    if (tag !== 'all') setTag('all');
    else drawList();
    search.focus();
  }

  /** Focuses a control in the grid and makes its card the one Tab lands
   *  on (its buttons too). */
  function moveTo(el) {
    const c = el.closest('.pastas__card');
    const pick = c?.querySelector('.pastas__pick');
    if (!pick) return;
    const was = active;
    active = Number(pick.dataset.row) || 0;
    if (was !== active || pick.tabIndex !== 0) {
      for (const b of list.querySelectorAll('.pastas__card button')) b.tabIndex = -1;
      for (const b of c.querySelectorAll('button')) b.tabIndex = 0;
    }
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
  }

  /** The grid's column count now (all sections share it). */
  function columns() {
    const g = list.querySelector('.pastas__grid');
    return g ? P.columnCount(getComputedStyle(g).gridTemplateColumns) : 1;
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
    const focus = list.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    change(P.pastaOp('pin', id, pin));
    log.info('pasta', pin ? 'pasta.pinned' : 'pasta.unpinned', { id: idOf(findPasta(id) || { id }), pins: P.pastasOf(s).pinned.length });
    drawList(focus?.startsWith('pick:') ? focus : `pin:${id}`);
  }

  function pick(p) {
    const text = P.pastaText(p);
    log.info('pasta', 'pasta.picked', { id: idOf(p), chars: text.length, pinned: P.isPinned(s, p.id), searched: Boolean(query.trim()), chip: tag });
    close({ reason: 'pick' });
    onPick?.(text, p);
  }

  // ------------------------------------------------------------- own posts

  function startEdit(p = null) {
    const id = p?.id || '';
    const kept = ownDraft?.id === id ? ownDraft : null;
    editing = kept ? { ...kept, problem: '' } : { id, title: p?.title || '', text: p?.text || '', problem: '' };
    drawFoot();
    const ta = foot.querySelector('[data-key="pastas-own-text"]');
    ta?.focus();
    ta?.scrollIntoView({ block: 'nearest' });
  }

  /** Whether the editor holds text that Save has not kept. */
  function unsaved() {
    if (!editing) return false;
    const { id, title, text } = editing;
    if (!id) return Boolean(title.trim() || text.trim());
    const p = findPasta(id);
    return !p || p.title !== title || p.text !== text;
  }

  /** Keeps the editor's unsaved text for the next New pasta / Edit. */
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
    else box.querySelector('[data-key="pastas-new"]')?.focus();
  }

  function saveEdit() {
    if (!editing) return;
    const { id, title, text } = editing;
    const problem = P.ownProblem(s, { id, title, text });
    if (problem) {
      log.info('pasta', 'pasta.own.refused', { problem: String(problem), edit: Boolean(id) });
      editing.problem = problem === 'empty' ? 'Write the post first.' : FULL;
      drawFoot();
      foot.querySelector('[data-key="pastas-own-text"]')?.focus();
      return;
    }
    const at = Date.now();
    const made = id || P.newOwnId(at);
    // the pin goes with it: an add, pin, edit still waiting to be saved
    // replays pin first (pasta-model.js pastaOp)
    change(P.pastaOp('put', made, { id: made, title, text, at }, { pinned: P.isPinned(s, made) }));
    log.info('pasta', id ? 'pasta.own.edited' : 'pasta.own.saved', { from: 'panel', chars: text.length, titleChars: title.trim().length, own: P.pastasOf(s).own.length });
    if (!id && (query.trim() || !['all', 'own'].includes(tag))) {
      // a new one shows even under a search or another tag
      search.value = '';
      query = '';
      if (tag !== 'all') setTag('all');
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
    log.info('pasta', 'pasta.own.deleted', { own: P.pastasOf(s).own.length, pins: P.pastasOf(s).pinned.length });
    drawList();
    drawFoot();
    const c = cardsOf()[active];
    if (c) moveTo(c);
    else search.focus();
  }

  function drawFoot() {
    clear(foot);
    foot.classList.toggle('pastas__own--editing', Boolean(editing));
    if (!editing) {
      foot.append(h('span', { class: 'pastas__hint', text: 'Arrows to move, Enter to use, P to pin, Esc to close' }));
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
    if (closed || e.isComposing || e.defaultPrevented) return;
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
    const cards = cardsOf();
    if (t === search) {
      if (e.key === 'ArrowDown' && cards.length) {
        e.preventDefault();
        moveTo(cards[Math.min(active, cards.length - 1)]);
      } else if (e.key === 'Enter' && cards.length) {
        e.preventDefault();
        cards[Math.min(active, cards.length - 1)].click();
      }
      return;
    }
    const c = t.closest?.('.pastas__card');
    if (!c || !list.contains(c)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const pickBtn = c.querySelector('.pastas__pick');
    const at = cards.indexOf(pickBtn);
    const id = c.dataset.pastaId;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End': {
        e.preventDefault();
        const to = P.gridStep(sizes, at, e.key, columns());
        if (to < 0) search.focus();
        else if (cards[to]) moveTo(cards[to]);
        return;
      }
      case 'p':
      case 'P':
        e.preventDefault();
        if (!e.repeat) setPin(id, !P.isPinned(s, id));
        return;
      case 'Delete': {
        const p = findPasta(id);
        if (p?.own) {
          e.preventDefault();
          remove(p, t);
        }
        return;
      }
      default:
        // typing goes on in the search box
        if (e.key.length === 1 && e.key !== ' ') search.focus();
    }
  }

  // ------------------------------------------------------------- placement

  /** Next to the anchor (below it, or above when there is more room
   *  there), inside the window; the window's height when neither side has
   *  room for a grid; a sheet along the bottom when narrow. */
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
      box.style.setProperty('top', `${Math.round(Math.max(EDGE, H * 0.1))}px`);
      box.style.setProperty('max-height', `${Math.round(H * 0.8)}px`);
      return;
    }
    const below = H - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const natural = box.offsetHeight;
    let left = r.left;
    if (left + w > W - EDGE) left = r.right - w; // the anchor's right edge instead
    left = Math.min(W - EDGE - w, Math.max(EDGE, left));
    box.style.setProperty('left', `${Math.round(left)}px`);
    if (Math.max(below, above) < Math.min(natural, MIN_ROOM)) {
      // no room on either side: the window's height, over the anchor
      box.style.setProperty('max-height', `${Math.round(H - 2 * EDGE)}px`);
      box.style.setProperty('top', `${Math.round(Math.max(EDGE, (H - box.offsetHeight) / 2))}px`);
      return;
    }
    const down = below >= Math.min(natural, MIN_ROOM) || below >= above;
    const room = down ? below : above;
    box.style.setProperty('max-height', `${Math.round(room)}px`);
    const height = box.offsetHeight;
    let top = down ? r.bottom + GAP : r.top - GAP - height;
    top = Math.min(H - EDGE - height, Math.max(EDGE, top));
    box.style.setProperty('top', `${Math.round(top)}px`);
  }

  // ------------------------------------------------------------ open/close

  function close({ focus = true, reason = 'api' } = {}) {
    if (closed) return;
    keepDraft();
    closed = true;
    log.info('pasta', 'pasta.panel.closed', { reason, open_s: Math.round((performance.now() - openedAt) / 1000), searchMaxChars: longestQuery, chip: tag, draftKept: Boolean(ownDraft) });
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

  {
    const own = P.pastasOf(s);
    log.info('pasta', 'pasta.panel.opened', { from: String(anchor?.dataset?.key || '').replace(/^p\d+-/, '').slice(0, 32) || 'none', chip: tag, own: own.own.length, pins: own.pinned.length });
  }
  drawChips();
  drawList();
  drawFoot();
  document.body.append(box);
  place();
  search.focus({ preventScroll: true });
  return api;
}

// ------------------------------------------------------------ Save as pasta

/**
 * Save as pasta: asks for a title (its first line to start with) and keeps
 * `text` as a new own post. A toast says it was saved, or why not (no
 * text, no room left).
 * @param {object} o
 * @param {string} o.text      the text (a reply's comment, a post's plain text)
 * @param {() => object} o.getSettings   the window's settings now
 * @param {(next: object, op: [string, Function]) => void} o.onSettings
 *   the change, as the panel makes it (the shell saves it with `op`)
 * @param {Element} [o.opener]  the focus goes back to it
 * @returns {Promise<boolean>} whether it was saved
 */
export function savePastaFrom({ text, getSettings, onSettings, opener = null }) {
  const found = P.pastaFromText(text);
  const from = String(opener?.dataset?.key || '').startsWith('compose') ? 'reply' : 'post';
  if (!found) {
    log.info('pasta', 'pasta.save.empty', { from });
    toast('There is no text to save.');
    return Promise.resolve(false);
  }
  if (P.ownProblem(getSettings(), { title: found.title, text: found.text }) === 'full') {
    log.info('pasta', 'pasta.save.full', { from, own: P.pastasOf(getSettings()).own.length });
    toast(FULL);
    return Promise.resolve(false);
  }
  log.info('pasta', 'pasta.save.asked', { from, chars: found.text.length });
  current?.close({ focus: false, reason: 'replaced' });
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) log.info('pasta', 'pasta.save.cancelled', { from });
      if (d.open) d.close();
      d.remove();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(ok);
    };
    const n = ++seq;
    const title = h('input', { class: 'input', id: `pasta-save-title-${n}`, maxlength: String(P.MAX_TITLE), value: found.title, 'data-key': 'pasta-save-title' });
    const err = h('p', { class: 'field__error', role: 'alert', hidden: true });
    const lines = P.previewLines(found.text, 12);
    const lineCount = P.previewLines(found.text, Infinity, Infinity).length;
    const sizeId = `pasta-save-size-${n}`;
    const save = () => {
      const s = getSettings();
      const problem = P.ownProblem(s, { title: title.value, text: found.text });
      if (problem) {
        err.hidden = false;
        err.textContent = problem === 'full' ? FULL : 'There is no text to save.';
        return;
      }
      const at = Date.now();
      const id = P.newOwnId(at);
      const op = P.pastaOp('put', id, { id, title: title.value, text: found.text, at });
      const next = op[1](s);
      if (next === s) return;
      onSettings?.(next, op);
      log.info('pasta', 'pasta.own.saved', { from, chars: found.text.length, titleChars: title.value.trim().length, titleChanged: Boolean(title.value !== found.title), own: P.pastasOf(next).own.length });
      finish(true);
      toast('Saved to your pastas');
    };
    const d = h(
      'dialog',
      { class: 'pasta-save', 'aria-labelledby': `pasta-save-h-${n}`, 'data-key': 'pasta-save' },
      h(
        'form',
        { onsubmit: (e) => (e.preventDefault(), save()) },
        h(
          'div',
          { class: 'dialog__body' },
          h('h2', { class: 'dialog__title', id: `pasta-save-h-${n}`, text: 'Save as pasta' }),
          // all of it is saved: the box scrolls, and says how much there is
          h(
            'div',
            { class: 'pasta-save__text', translate: 'no', tabindex: '0', role: 'region', 'aria-labelledby': sizeId, 'data-key': 'pasta-save-text' },
            lines.map((l) => h('span', { class: l.green ? 'pastas__green' : null, text: l.text })),
            lineCount > lines.length ? h('span', { class: 'pasta-save__more', text: '…' }) : null,
          ),
          h('p', {
            class: 'field__hint pasta-save__size',
            id: sizeId,
            'data-key': 'pasta-save-size',
            text: lineCount === 1 ? `1 line, ${found.text.length} characters` : `${lineCount} lines, ${found.text.length} characters`,
          }),
          h('label', { class: 'field__label', for: `pasta-save-title-${n}`, text: 'Title' }),
          title,
          err,
        ),
        h(
          'div',
          { class: 'dialog__actions' },
          h('button', { type: 'button', class: 'btn', 'data-key': 'pasta-save-cancel', onclick: () => finish(false), text: 'Cancel' }),
          h('button', { type: 'submit', class: 'btn btn--primary', 'data-key': 'pasta-save-ok', text: 'Save' }),
        ),
      ),
    );
    d.addEventListener('close', () => finish(false));
    document.body.append(d);
    d.showModal();
    title.focus();
    title.select();
  });
}
