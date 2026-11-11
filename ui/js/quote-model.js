// Quote links inside a thread: what a click does, where an inline copy sits
// (a "path" from a post in the thread through the links opened inside it),
// the guard that keeps a post from opening inside itself, and where the
// hover preview goes. DOM-free (tested with node --test).

/** Settings → Look → Quote links. */
export const QUOTE_LINK_MODES = Object.freeze(['inline', 'jump']);

/** What a click on a quote link or backlink does: the setting, turned the
 *  other way round by Ctrl/⌘ (so jumping is always one modifier away). */
export function quoteClickAction(mode, { ctrlKey = false, metaKey = false } = {}) {
  const inline = mode !== 'jump';
  return ctrlKey || metaKey ? (inline ? 'jump' : 'inline') : inline ? 'inline' : 'jump';
}

const isNo = (n) => Number.isSafeInteger(n) && n > 0;

/**
 * Where a quote link points, seen from a thread.
 * @param {{target?: number, board?: string, thread?: number}} link
 * @param {{board: string, thread: number}} here
 * @returns {{kind: 'local', no: number} | {kind: 'cross', board: string, thread: number, no: number} | {kind: 'none'}}
 */
export function quoteTarget(link, here) {
  const no = Number(link?.target);
  if (!isNo(no)) return { kind: 'none' };
  const thread = Number(link?.thread);
  const board = link?.board || here?.board;
  if (isNo(thread) && (thread !== here?.thread || board !== here?.board)) return { kind: 'cross', board, thread, no };
  return { kind: 'local', no };
}

// A path names one opened copy: "123/q456/b789.1" is, in post 123, the quote
// link to 456 opened; inside that copy, the second backlink to 789 opened.
// q = a link in the comment, b = a backlink, x = a link to another
// thread's post (its copy opens nothing further inline); ".n" = the nth link
// of that kind to that post in the same post (left out for the first).

/** The path of the copy a link opens, from the path (or post No.) holding it. */
export function childPath(parent, kind, target, nth = 0) {
  return `${parent}/${kind === 'b' || kind === 'x' ? kind : 'q'}${target}${nth > 0 ? `.${nth}` : ''}`;
}

/** @returns {{root: number, steps: Array<{kind: 'q'|'b'|'x', target: number, nth: number}>} | null} */
export function parsePath(path) {
  const parts = String(path ?? '').split('/');
  const root = Number(parts[0]);
  if (!isNo(root)) return null;
  const steps = [];
  for (const p of parts.slice(1)) {
    const m = p.match(/^([qbx])(\d+)(?:\.(\d+))?$/);
    if (!m || !isNo(Number(m[2]))) return null;
    steps.push({ kind: m[1], target: Number(m[2]), nth: m[3] ? Number(m[3]) : 0 });
  }
  return { root, steps };
}

/** Post numbers from the thread's post down to the copy a path names
 *  (another thread's post is left out: its number is not this thread's). */
export function chainOf(path) {
  const p = parsePath(path);
  return p ? [p.root, ...p.steps.filter((s) => s.kind !== 'x').map((s) => s.target)] : [];
}

/** False when `target` is already open around the link (or is the post the
 *  link is in): a post never opens inside itself. */
export const canExpand = (path, target) => !chainOf(path).includes(Number(target));

/** True when `path` is `of` or a copy opened inside it. */
export const isWithin = (path, of) => path === of || String(path).startsWith(`${of}/`);

/** Closes a copy and every copy opened inside it. Returns a new Set. */
export function collapsePath(paths, path) {
  return new Set([...(paths || [])].filter((p) => !isWithin(p, path)));
}

/** Opens a copy (its parents must already be open). Returns a new Set. */
export function expandPath(paths, path) {
  const out = new Set(paths || []);
  if (parsePath(path)) out.add(path);
  return out;
}

/** Order to open copies again after a redraw: outer ones first. */
export function replayOrder(paths) {
  return [...(paths || [])]
    .filter((p) => parsePath(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0));
}

/** A path as a piece of an element id or data-key. */
export const pathSlug = (path) => String(path).replace(/[^a-z0-9]+/gi, '_');

const GAP = 6; // between the link and the preview
const MARGIN = 12; // from the window edges
const MAX_W = 640;

/** The widest a preview may be in a window `vw` wide. */
export const previewWidth = (vw) => Math.max(0, Math.min(MAX_W, vw - 2 * MARGIN));

/**
 * Where a quote preview goes: below the link, or above it when there is more
 * room there, never over it; as wide as it can be up to 640 px; its height
 * capped to the room on that side. `w`/`h` are the box's natural size.
 */
export function placeQuotePreview({ link, w, h, vw, vh }) {
  const width = Math.min(w || MAX_W, previewWidth(vw));
  const below = vh - link.bottom - GAP - MARGIN;
  const above = link.top - GAP - MARGIN;
  const down = below >= (h || 0) || below >= above;
  const maxHeight = Math.max(0, Math.floor(down ? below : above));
  const height = Math.min(h || maxHeight, maxHeight);
  const top = down ? link.bottom + GAP : link.top - GAP - height;
  const left = Math.min(Math.max(MARGIN, link.left), Math.max(MARGIN, vw - MARGIN - width));
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), maxHeight };
}

/** The cache key of another thread: "board/no". */
export const crossKey = (board, thread) => `${board}/${thread}`;

/**
 * What a copy of another thread's post shows, from that thread's cache
 * entry ({ status: 'loading'|'ok'|'gone'|'error', posts?: Map }):
 * 'loading' (nothing yet, or loading for the first time), 'post', 'missing'
 * (the thread is there, the post is not), 'gone' (404) or 'error'.
 */
export function crossState(entry, no) {
  if (!entry) return 'loading';
  if (entry.posts) return entry.posts.has(no) ? 'post' : entry.status === 'loading' ? 'loading' : 'missing';
  if (entry.status === 'gone') return 'gone';
  if (entry.status === 'error') return 'error';
  return 'loading';
}

/** Whether another thread's cached copy should be asked for again: never
 *  while loading or once gone; `retryMs` after a failure (so a failing
 *  thread is not asked for in a loop); when older than `maxAgeMs`. (The
 *  fetch queue still keeps its 10 s per thread on top of this.) */
export function crossStale(entry, now, maxAgeMs, retryMs = 10_000) {
  if (!entry) return true;
  if (entry.status === 'loading' || entry.status === 'gone') return false;
  const age = now - (entry.at || 0);
  if (entry.status === 'error') return !(age < retryMs);
  return !(age < maxAgeMs);
}
