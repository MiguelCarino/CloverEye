// Browser-like tabs inside a pane (shell.js): each pane holds an ordered
// list of tabs and an active one; each tab has its own view, its own back
// and forward history and its own scroll. This is the pure part: where a
// tab goes, which tab is shown after one closes, the closed tabs that come
// back, the tab keys, and a pane's tabs in a window's address (#panes=).
// No DOM, so it runs under `node --test`.

import { keyLetter } from './keys-model.js';

/** Tabs in one pane at most (a toast says so when it is full). */
export const MAX_TABS = 20;
/** Closed tabs kept for Ctrl+Shift+T. */
export const CLOSED_KEEP = 10;
/** Panes in a window at most (shell.js MAX_PANES). */
export const MAX_PANES = 5;
/** The app refuses a window address over 8192 characters (extra.rs
 *  open_window): a window's panes are encoded under this. */
export const HASH_MAX = 8000;

const BOARD = /^[a-z0-9]{1,10}$/;
const TAG_ID = /^[a-z0-9-]{1,40}$/;
const PLAIN = new Set(['boards', 'saved', 'stats', 'library', 'ask']);

/** A view as a window's address may carry it, with only its known fields;
 *  null for anything else (Settings never travels). */
export function cleanView(v) {
  if (!v || typeof v !== 'object') return null;
  if (PLAIN.has(v.kind)) return { kind: v.kind };
  if (v.kind === 'tag') return typeof v.id === 'string' && TAG_ID.test(v.id) ? { kind: 'tag', id: v.id } : null;
  if (v.kind === 'board') return typeof v.board === 'string' && BOARD.test(v.board) ? { kind: 'board', board: v.board } : null;
  if (v.kind === 'thread' || v.kind === 'offline') {
    if (typeof v.board !== 'string' || !BOARD.test(v.board) || !Number.isSafeInteger(v.no) || v.no <= 0) return null;
    // the tab's layout (columns-model.js), when it chose one
    return v.layout === 'list' || v.layout === 'columns' ? { kind: v.kind, board: v.board, no: v.no, layout: v.layout } : { kind: v.kind, board: v.board, no: v.no };
  }
  return null;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Where a new tab of a pane goes: right after the active tab and the tabs
 * already opened from it in a row (as a browser does), so tabs opened one
 * after another from a catalog stay in the order they were opened.
 * @param {{id: number, opener?: number}[]} tabs
 * @param {number} active
 */
export function insertIndex(tabs, active) {
  const opener = tabs[active]?.id;
  let at = clamp(active + 1, 0, tabs.length);
  while (opener !== undefined && at < tabs.length && tabs[at]?.opener === opener) at++;
  return at;
}

/**
 * A pane with one more tab: in the background (the active tab stays) or in
 * front. `at`: a place of its own (a closed tab coming back where it was).
 * Null when the pane already has MAX_TABS.
 * @param {{tabs: object[], active: number}} state
 * @returns {{tabs: object[], active: number, index: number} | null}
 */
export function addTab(state, tab, { background = true, at = null, max = MAX_TABS } = {}) {
  const tabs = state?.tabs || [];
  const active = clamp(state?.active || 0, 0, Math.max(0, tabs.length - 1));
  if (tabs.length >= max) return null;
  const i = at === null || at === undefined ? insertIndex(tabs, active) : clamp(at, 0, tabs.length);
  const next = [...tabs.slice(0, i), tab, ...tabs.slice(i)];
  const shown = !tabs.length ? 0 : background ? (i <= active ? active + 1 : active) : i;
  return { tabs: next, active: shown, index: i };
}

/**
 * A pane without tab `index`. Closing a tab before or after the active one
 * keeps it; closing the active one shows (as a browser does) the next tab
 * opened from the same tab, else the tab it was opened from, else the tab
 * to its right, else the one to its left. Null when `index` is no tab or
 * it is the pane's only tab (the shell closes the pane instead).
 * @returns {{tabs: object[], active: number, closed: object} | null}
 */
export function closeTab(state, index) {
  const tabs = state?.tabs || [];
  if (!Number.isInteger(index) || index < 0 || index >= tabs.length || tabs.length <= 1) return null;
  const active = clamp(state.active || 0, 0, tabs.length - 1);
  const closed = tabs[index];
  const next = tabs.filter((_, j) => j !== index);
  let shown;
  if (index < active) shown = active - 1;
  else if (index > active) shown = active;
  else {
    const opener = closed?.opener;
    const sibling = opener !== undefined && opener !== null && tabs[index + 1]?.opener === opener ? index : -1;
    const from = opener !== undefined && opener !== null ? next.findIndex((t) => t?.id === opener) : -1;
    shown = sibling >= 0 ? sibling : from >= 0 ? from : Math.min(index, next.length - 1);
  }
  return { tabs: next, active: shown, closed };
}

/** The tab `delta` steps from the active one, round the ends. */
export function cycleIndex(state, delta) {
  const n = state?.tabs?.length || 0;
  if (!n) return 0;
  const active = clamp(state.active || 0, 0, n - 1);
  return (((active + delta) % n) + n) % n;
}

/** Ctrl+1…Ctrl+8: that tab (null when the pane has fewer); Ctrl+9: the last. */
export function pickIndex(digit, count) {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || !count) return null;
  if (digit === 9) return count - 1;
  return digit <= count ? digit - 1 : null;
}

/**
 * What a key press does to the tabs, or null: Ctrl+T a new tab, Ctrl+W
 * close, Ctrl+Shift+T reopen the last closed, Ctrl+Tab / Ctrl+PageDown the
 * next tab, Ctrl+Shift+Tab / Ctrl+PageUp the one before, Ctrl+1…9 pick
 * one. ⌘ works as Ctrl (a Mac), except with Tab (the system's app switcher).
 * @param {{key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} e
 * @returns {{kind: 'new'|'close'|'reopen'|'next'|'prev'|'pick', digit?: number} | null}
 */
export function tabKeyAction(e) {
  if (!e || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  const key = String(e.key || '');
  if (key === 'Tab') return e.ctrlKey ? { kind: e.shiftKey ? 'prev' : 'next' } : null;
  if (key === 'PageDown' || key === 'PageUp') return e.shiftKey ? null : { kind: key === 'PageDown' ? 'next' : 'prev' };
  // the letter typed; e.code only when the layout types no Latin letter
  const letter = keyLetter(e);
  if (letter === 't') return { kind: e.shiftKey ? 'reopen' : 'new' };
  if (letter === 'w' && !e.shiftKey) return { kind: 'close' };
  if (e.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(e.code || '')?.[1] || (/^[1-9]$/.test(key) ? key : null);
  return digit ? { kind: 'pick', digit: Number(digit) } : null;
}

/** How a click asks to open what it points at: in a new background tab
 *  (Ctrl/⌘+click, a middle click), a new tab in front (with Shift), or
 *  null (a plain click: in the pane, as before). */
export function clickTab(e) {
  if (!e) return null;
  const middle = e.button === 1;
  if (!middle && !e.ctrlKey && !e.metaKey) return null;
  return { background: !e.shiftKey };
}

/** The closed tabs with one more: the newest last, CLOSED_KEEP at most. */
export function pushClosed(stack, entry) {
  return [...(stack || []), entry].slice(-CLOSED_KEEP);
}

/** The newest closed tab and the stack without it, or null. */
export function popClosed(stack) {
  if (!stack?.length) return null;
  return { entry: stack[stack.length - 1], stack: stack.slice(0, -1) };
}

/** A tab's name for the views that are not a board or a thread (those are
 *  named after the board and the thread's subject). */
export function kindLabel(kind) {
  return (
    {
      settings: 'Settings',
      boards: 'All boards',
      saved: 'Saved threads',
      library: 'Library',
      stats: 'Stats',
      ask: 'Ask',
      tag: 'Tag',
      board: 'Catalog',
    }[kind] || ''
  );
}

// ----------------------------------------------------- a window's address

/** One pane from what an address carries: a view (the old format) or
 *  { tabs: [view…], active }; null when nothing in it is known. */
function cleanGroup(entry) {
  if (entry && Array.isArray(entry.tabs)) {
    const raw = Number.isInteger(entry.active) ? entry.active : 0;
    const tabs = [];
    let active = -1;
    entry.tabs.forEach((v, j) => {
      const c = cleanView(v);
      if (!c || tabs.length >= MAX_TABS) return;
      if (j <= raw) active = tabs.length;
      tabs.push(c);
    });
    if (!tabs.length) return null;
    return { tabs, active: clamp(active, 0, tabs.length - 1) };
  }
  const v = cleanView(entry);
  return v ? { tabs: [v], active: 0 } : null;
}

/**
 * The panes an extra window's address carries: #panes=<encoded JSON list>.
 * Each item is a view (the old format: a one-tab pane) or a pane with tabs,
 * { tabs: [view…], active }. Only known view shapes pass; at most MAX_PANES
 * panes of MAX_TABS tabs. Null when there is no list or nothing known.
 * @returns {{tabs: object[], active: number}[] | null}
 */
export function decodePanes(hash) {
  const m = /^#panes=(.+)$/.exec(hash || '');
  if (!m) return null;
  let list;
  try {
    list = JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const groups = list.map(cleanGroup).filter(Boolean).slice(0, MAX_PANES);
  return groups.length ? groups : null;
}

/**
 * Panes for a window's address (what decodePanes reads), URI-encoded. A
 * one-tab pane is written as its view, so an older reader still opens it.
 * Over `max` characters, background tabs go, the farthest from their
 * pane's active tab first (the active tabs always stay).
 * @param {(object | {tabs: object[], active: number})[]} entries  views or panes with tabs
 */
export function encodePanes(entries, max = HASH_MAX) {
  let groups = (entries || []).map(cleanGroup).filter(Boolean).slice(0, MAX_PANES);
  if (!groups.length) groups = [{ tabs: [{ kind: 'boards' }], active: 0 }];
  const write = () => encodeURIComponent(JSON.stringify(groups.map((g) => (g.tabs.length === 1 ? g.tabs[0] : { tabs: g.tabs, active: g.active }))));
  let out = write();
  while (out.length > max) {
    const g = groups.reduce((a, b) => (b.tabs.length > a.tabs.length ? b : a));
    if (g.tabs.length <= 1) break;
    // the background tab farthest from the active one (the later on a tie)
    let far = -1;
    g.tabs.forEach((_, j) => {
      if (j !== g.active && (far < 0 || Math.abs(j - g.active) >= Math.abs(far - g.active))) far = j;
    });
    g.tabs = g.tabs.filter((_, j) => j !== far);
    if (far < g.active) g.active -= 1;
    out = write();
  }
  return out;
}
