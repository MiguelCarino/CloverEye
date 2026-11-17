// A thread's layout (shell.js, browse.js, columns.js): a list read top to
// bottom, or columns that fill the pane's height and are read left to
// right, like a newspaper. Which one a thread uses, and the scroll maths
// that has to work along either axis (where the reader is, what has been
// on screen, where a key, a wheel turn or a jump takes the columns). No
// DOM, so it runs under `node --test`.

export const LAYOUTS = Object.freeze(['list', 'columns']);

const isThreadView = (v) => v?.kind === 'thread' || v?.kind === 'offline';

/** The layout new threads take (Settings → Posts, display.threadLayout). */
export const layoutDefault = (display) => (display?.threadLayout === 'columns' ? 'columns' : 'list');

/** The layout a view shows its thread in: its own (the tab's choice, kept
 *  with the view in history and the window's address), else the default. */
export function layoutOf(view, display) {
  if (!isThreadView(view)) return 'list';
  return LAYOUTS.includes(view.layout) ? view.layout : layoutDefault(display);
}

/** The view switched to the other layout (a new object). */
export function flipLayout(view, display) {
  if (!isThreadView(view)) return view;
  return { ...view, layout: layoutOf(view, display) === 'columns' ? 'list' : 'columns' };
}

/** A view about to replace `from` in a pane: the same thread (live or its
 *  saved copy) keeps the layout chosen for it when `to` does not say. */
export function carryLayout(from, to) {
  if (!isThreadView(to) || to.layout !== undefined || !isThreadView(from) || !LAYOUTS.includes(from.layout)) return to;
  if (from.board !== to.board || from.no !== to.no) return to;
  return { ...to, layout: from.layout };
}

/** 'x' when the posts scroll sideways (columns), else 'y'. */
export const axisOf = (layout) => (layout === 'columns' ? 'x' : 'y');
/** Where a box (a DOMRect's fields) starts and ends along an axis. */
export const startOf = (r, axis) => (axis === 'x' ? r.left : r.top);
export const endOf = (r, axis) => (axis === 'x' ? r.right : r.bottom);

/**
 * The first of `count` items in order (their ends never go back: posts in
 * a list, or posts down one column then the next) still in sight past
 * `viewStart`: the first whose end is beyond it. -1 when none is.
 * @param {number} count
 * @param {(i: number) => number} endAt  the item's end along the axis
 */
export function firstInView(count, endAt, viewStart) {
  let lo = 0;
  let hi = count - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (endAt(mid) > viewStart) {
      at = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return at;
}

/** How far an anchor (what was first in sight, `offset` from the view's
 *  start) has moved: the scroll to add to put it back. Under a pixel is
 *  nothing (a redraw's rounding). */
export function anchorShift(start, viewStart, offset) {
  const d = start - viewStart - offset;
  return Math.abs(d) >= 1 ? d : 0;
}

/**
 * The columns a box of `width` shows when each wants `want` px with `gap`
 * between them, as CSS multi-column lays them out: as many as fit (at
 * least one, which then takes the whole width), their width, and the step
 * from one column to the next.
 */
export function columnMetrics(width, want, gap = 0) {
  const w = Math.max(0, width);
  const g = Math.max(0, gap);
  const count = want > 0 ? Math.max(1, Math.floor((w + g) / (want + g))) : 1;
  const col = Math.max(0, (w - (count - 1) * g) / count);
  return { count, width: col, step: col + g };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** The least height a columns box gets (app.css min-height: 10rem). */
export const MIN_COLUMNS_H = 160;

/** A columns box's height in whole px: from its `top` down to the body's
 *  content `bottom`, less what follows it (`after`); never under
 *  MIN_COLUMNS_H, never nothing (columns at no height never end). */
export function columnsHeight({ top, bottom, after = 0, min = MIN_COLUMNS_H }) {
  const h = Math.floor((Number(bottom) || 0) - (Number(top) || 0) - (Number(after) || 0));
  return Math.max(Math.max(1, min), Number.isFinite(h) ? h : 0);
}

/** The next column's start from `pos` going `dir` (+1 or -1): columns
 *  start every `step` px from 0. A position just off a start (rounding)
 *  counts as on it. */
export function columnStop(pos, step, dir, max) {
  if (!(step > 0)) return clamp(pos, 0, max);
  const at = pos / step;
  const i = dir > 0 ? Math.floor(at + 0.02) + 1 : Math.ceil(at - 0.02) - 1;
  return clamp(i * step, 0, max);
}

/**
 * Where a key moves a columns box, or null for a key it leaves alone.
 * The arrows move one column, PageUp / PageDown (and Space, Shift+Space)
 * the columns in sight, Home / End to either end.
 * @param {{key: string, shiftKey?: boolean}} e
 * @param {{pos: number, step: number, count: number, max: number}} box
 */
export function keyScroll(e, { pos, step, count = 1, max }) {
  const page = Math.max(1, count);
  const by = (dir, n) => {
    let x = pos;
    for (let k = 0; k < n; k++) x = columnStop(x, step, dir, max);
    return x;
  };
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return by(1, 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return by(-1, 1);
    case 'PageDown':
      return by(1, page);
    case 'PageUp':
      return by(-1, page);
    case ' ':
      return by(e.shiftKey ? -1 : 1, page);
    case 'Home':
      return 0;
    case 'End':
      return Math.max(0, max);
    default:
      return null;
  }
}

export const LINE_PX = 40;
/** A mouse wheel's notch glides further than its pixels say (a column is
 *  about 450 px): smooth, but not slow. */
export const WHEEL_GAIN = 1.5;

/**
 * How far a wheel turn moves a columns box sideways, in px: its up-down
 * part (a notch, a line or a page); 0 when the wheel is left to the
 * webview: with Shift (it scrolls sideways itself), Ctrl or ⌘ (zoom), Alt,
 * or a gesture that is mostly sideways already (a touchpad).
 */
export function wheelPixels(e, page) {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return 0;
  const dy = Number(e.deltaY) || 0;
  if (!dy || Math.abs(Number(e.deltaX) || 0) >= Math.abs(dy)) return 0;
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? Math.max(1, page) : 1;
  return dy * unit;
}

/** Whether a wheel's move glides (a mouse's notches, lines, pages) or is
 *  followed as it comes (a touchpad's many small steps). */
export const wheelGlides = (px, deltaMode) => deltaMode !== 0 || Math.abs(px) >= 50;

/** Whether an element that scrolls up and down itself (a long code block,
 *  an open quote box) can still go `dy`'s way: then the wheel is its. */
export function canScrollY({ scrollTop, scrollHeight, clientHeight }, dy) {
  if (scrollHeight <= clientHeight + 1) return false;
  return dy > 0 ? scrollTop + clientHeight < scrollHeight - 1 : scrollTop > 0;
}

/** One frame of a glide from `pos` to `target`: most of the way in about
 *  a tenth of a second whatever the frame rate, then exactly there. */
export function glideStep(pos, target, dt, tau = 45) {
  const k = 1 - Math.exp(-Math.max(0, dt) / tau);
  const next = pos + (target - pos) * k;
  return Math.abs(target - next) < 0.75 ? target : next;
}

/**
 * Where a columns box scrolls to show a post: its first part's column at
 * the start (`align` 'start'), or, for 'nearest' and 'center', only when
 * the post is not wholly in sight already. Positions are in the box's
 * scroll coordinates.
 * @param {{pos: number, view: number, max: number, start: number, end: number, align?: string}} o
 */
export function revealPos({ pos, view, max, start, end, align = 'start' }) {
  if (align !== 'start' && start >= pos - 1 && end <= pos + view + 1) return pos;
  return clamp(start, 0, Math.max(0, max));
}

/**
 * Where a thread goes when its layout is switched. `now`: where the layout
 * left was (its scroll `pos`, the post first in sight `no`); `memo`: what
 * is known of the layout coming back ({ arrived: the other layout's scroll
 * just after it was last switched away from }) or null. When the reader
 * has not moved since that switch, it comes back to its own place
 * ({ back: true }: the redraw puts it back by what was first in sight
 * there, as for any redraw; the same pixels are not the same place in a
 * fresh page); else the post first in sight now is first in sight there.
 * @returns {{back: true} | {no: number} | {pos: 0}}
 */
export function placeAfterSwitch(now, memo) {
  if (memo && Number.isFinite(memo.arrived) && Math.abs((now?.pos || 0) - memo.arrived) <= 1) return { back: true };
  return now?.no ? { no: Number(now.no) } : { pos: 0 };
}
