// A thread in columns (columns-model.js): its post list is the box that
// scrolls, sideways. This is the DOM side: which element scrolls a pane
// body and along which axis, putting a scroll back as a redraw does (so
// quote previews and the read marks can tell it from the reader's own),
// the wheel's up-down turned sideways, the keys moving a column at a time,
// showing a post, and the media fitted to a column's height.

import { restoreScroll, isRestoreScroll as isRestoreY } from './dom.js';
import * as C from './columns-model.js';

export const COLUMNS_CLASS = 'thread--columns';

/** Is `el` a thread's post list laid out in columns (it scrolls sideways)? */
export const isColumnsBox = (el) => Boolean(el?.classList?.contains(COLUMNS_CLASS));

/** The element that scrolls a pane body: a thread's columns, else the body. */
const SCROLLER = ':scope > .browse > .thread--columns';
export function scrollerOf(body) {
  return body?.querySelector?.(SCROLLER) || body;
}

/** 'x' for columns, else 'y'. */
export const axisOfBox = (sc) => (isColumnsBox(sc) ? 'x' : 'y');

/** How far `sc` is scrolled along its axis. */
export const scrollPos = (sc) => (isColumnsBox(sc) ? sc.scrollLeft : sc.scrollTop);

const restoredX = new WeakMap(); // element → the scrollLeft it was put back to

/** Puts a box back at a scroll position along its axis, as a redraw does
 *  (dom.js restoreScroll for the up-down ones). */
export function setScroll(sc, pos) {
  if (!isColumnsBox(sc)) {
    restoreScroll(sc, pos);
    return;
  }
  stopGlide(sc);
  sc.scrollLeft = pos;
  restoredX.set(sc, sc.scrollLeft);
}

/** dom.js isRestoreScroll for either axis: whether a scroll event is only
 *  a redraw putting a box back where it was. */
export function isRestoreAnyAxis(e) {
  const el = e?.target;
  if (el && restoredX.has(el)) {
    if (el.scrollLeft === restoredX.get(el)) return true;
    restoredX.delete(el);
    return false;
  }
  return isRestoreY(e);
}

// --------------------------------------------------------------- geometry

const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A columns box's columns: count, width, step, and its scroll range. */
export function columnsOf(sc) {
  const cs = getComputedStyle(sc);
  const gap = parseFloat(cs.columnGap) || 0;
  const inner = sc.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const want = parseFloat(cs.columnWidth) || inner;
  return { ...C.columnMetrics(inner, want, gap), view: sc.clientWidth, max: Math.max(0, sc.scrollWidth - sc.clientWidth) };
}

/** Where `rect` (on screen) starts in a columns box's scroll coordinates. */
const scrollX = (sc, rect) => rect.left - sc.getBoundingClientRect().left - sc.clientLeft - (parseFloat(getComputedStyle(sc).paddingLeft) || 0) + sc.scrollLeft;

/** A post's first part (a post taller than a column goes on in the next). */
export const firstPart = (el) => el.getClientRects()[0] || el.getBoundingClientRect();

/**
 * Gives a columns box its height in px (--col-h, app.css): what its pane
 * body has left below the thread's bar, less what follows the columns (a
 * closed thread's line). Media in a column fit that height too. The height
 * is never left to flex or grid: a multi-column box laid out at no height
 * (a sizing pass) makes columns without end. Called when a pane is drawn
 * and whenever the body or the bar changes size (attachColumns).
 */
export function fitColumns(sc) {
  if (!isColumnsBox(sc) || !sc.isConnected) return;
  const body = sc.closest('.centre__body');
  if (!body) return;
  // drawn detached (browse.js threadView): watched from its first fit
  if (!watched.has(sc)) {
    watched.add(sc);
    watchSize(sc);
  }
  const cs = getComputedStyle(body);
  const bottom = body.getBoundingClientRect().bottom - (parseFloat(cs.paddingBottom) || 0) - (parseFloat(cs.borderBottomWidth) || 0);
  const gap = parseFloat(getComputedStyle(sc.parentElement).rowGap) || 0;
  let after = 0;
  for (let el = sc.nextElementSibling; el; el = el.nextElementSibling) {
    if (getComputedStyle(el).position !== 'absolute') after += el.getBoundingClientRect().height + gap;
  }
  const px = `${C.columnsHeight({ top: sc.getBoundingClientRect().top, bottom, after })}px`;
  if (sc.style.getPropertyValue('--col-h') !== px) sc.style.setProperty('--col-h', px);
}

// The box's body and the thread's bar, watched for size: either changes
// what the columns have left.
let sizes = null;
const watched = new WeakSet(); // columns boxes whose body and bar are watched
const sizeOf = new WeakMap(); // watched element → its columns box
function watchSize(sc) {
  if (typeof ResizeObserver !== 'function') return;
  sizes ||= new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = sizeOf.get(e.target);
      if (!box?.isConnected || !e.target.isConnected) {
        sizes.unobserve(e.target);
        sizeOf.delete(e.target);
      } else fitColumns(box);
    }
  });
  for (const el of [sc.closest('.centre__body'), sc.parentElement?.querySelector(':scope > [data-thread-tools]')]) {
    if (!el) continue;
    sizeOf.set(el, sc);
    sizes.observe(el);
  }
}

// ------------------------------------------------------------------ glide

const glides = new WeakMap(); // box → { target, frame, at, pos }

function stopGlide(sc) {
  const g = glides.get(sc);
  if (g?.frame) cancelAnimationFrame(g.frame);
  glides.delete(sc);
}

/** Scrolls a columns box to `x`: gliding, or at once (reduced motion). */
export function glideTo(sc, x, { smooth = true } = {}) {
  const max = Math.max(0, sc.scrollWidth - sc.clientWidth);
  const target = Math.max(0, Math.min(max, x));
  if (!smooth || reduced()) {
    stopGlide(sc);
    sc.scrollLeft = target;
    return;
  }
  let g = glides.get(sc);
  if (!g) {
    g = { target, frame: 0, at: 0, pos: sc.scrollLeft };
    glides.set(sc, g);
  }
  g.target = target;
  if (g.frame) return;
  const tick = (t) => {
    g.frame = 0;
    if (!sc.isConnected || glides.get(sc) !== g) return;
    // the reader moved it meanwhile (the scrollbar, a touch): from there
    if (Math.abs(sc.scrollLeft - g.pos) > 2) g.pos = sc.scrollLeft;
    const dt = g.at ? t - g.at : 16;
    g.at = t;
    g.pos = C.glideStep(g.pos, g.target, dt);
    sc.scrollLeft = g.pos;
    if (g.pos === g.target) {
      glides.delete(sc);
      return;
    }
    g.frame = requestAnimationFrame(tick);
  };
  g.frame = requestAnimationFrame(tick);
}

/** Where a glide on `sc` is heading (else where it is). */
const heading = (sc) => glides.get(sc)?.target ?? sc.scrollLeft;

// ------------------------------------------------------------ reveal post

/**
 * Scrolls a thread to show a post: in columns its column comes into sight
 * (first, for 'start'); in a list, as scrollIntoView does.
 * @param {Element} el  a post (or its line) in a thread's list
 * @param {{align?: 'start'|'center'|'nearest', smooth?: boolean}} o
 */
export function revealPost(el, { align = 'center', smooth = false } = {}) {
  const sc = el?.closest?.(`.${COLUMNS_CLASS}`);
  if (!sc) {
    el?.scrollIntoView({ block: align, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    return;
  }
  const { view, max } = columnsOf(sc);
  const r = el.getBoundingClientRect();
  const start = scrollX(sc, firstPart(el));
  const end = start + (r.right - firstPart(el).left);
  glideTo(sc, C.revealPos({ pos: sc.scrollLeft, view, max, start, end, align }), { smooth });
}

// ------------------------------------------------------------------ input

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], video, audio, iframe';
const PRESSABLE = 'button, a[href], summary, [role="button"], [role="menuitem"], [role="tab"]';

/** Is anything over a quote preview right now (quotes.js)? Its wheel is
 *  left alone while one shows. */
const previewOpen = () => Boolean(document.querySelector('.quote-preview:not([hidden])'));

/** An element between the pointer and the box that scrolls up and down
 *  itself, and can still go that way. */
function innerScroller(from, sc, dy) {
  for (let el = from; el && el !== sc; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && C.canScrollY(el, dy)) return el;
  }
  return null;
}

/** A fresh columns box lays every post out at its real size for its first
 *  frames (.columns--fresh, app.css), then posts out of sight skip their
 *  layout (content-visibility) and keep the size they had: what puts the
 *  box back in place (keepAnchor, revealPost, a switch from the list)
 *  measures real sizes, never the estimate. */
function layOutOnce(sc) {
  sc.classList.add('columns--fresh');
  let frames = 0;
  const step = () => {
    // drawn detached (browse.js threadView): two frames once it is shown
    if (!sc.isConnected && ++frames < 30) requestAnimationFrame(step);
    else requestAnimationFrame(() => requestAnimationFrame(() => sc.classList.remove('columns--fresh')));
  };
  requestAnimationFrame(step);
}

/**
 * Makes a thread's post list in columns read sideways: the mouse wheel's
 * up-down moves it left and right (not with Shift, not over something that
 * scrolls itself, not while a quote preview shows), the keys move it a
 * column (the arrows) or a page of columns (PageUp/PageDown, Space) or to
 * either end (Home/End), and its media keep to a column's height. Touch
 * pans it natively. Safe to call again on the same box.
 */
export function attachColumns(sc) {
  if (!sc || sc.dataset.columnsOn) return;
  sc.dataset.columnsOn = '';
  layOutOnce(sc);
  sc.addEventListener(
    'wheel',
    (e) => {
      if (e.defaultPrevented) return;
      const px = C.wheelPixels(e, sc.clientWidth);
      if (!px || previewOpen() || innerScroller(e.target, sc, e.deltaY)) return;
      const max = sc.scrollWidth - sc.clientWidth;
      // at either end already: the wheel has nothing to do here
      if ((px > 0 && heading(sc) >= max - 0.5) || (px < 0 && heading(sc) <= 0.5)) return;
      e.preventDefault();
      if (C.wheelGlides(px, e.deltaMode)) glideTo(sc, heading(sc) + px * C.WHEEL_GAIN);
      else {
        stopGlide(sc);
        sc.scrollLeft += px;
      }
    },
    { passive: false },
  );
  sc.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && e.key !== ' ') return;
    const t = e.target;
    if (t !== sc && t?.closest?.(TYPING)) return;
    if (e.key === ' ' && t !== sc && t?.closest?.(PRESSABLE)) return;
    const box = columnsOf(sc);
    const x = C.keyScroll(e, { pos: heading(sc), step: box.step, count: box.count, max: box.max });
    if (x === null) return;
    e.preventDefault();
    glideTo(sc, x);
  });
}
