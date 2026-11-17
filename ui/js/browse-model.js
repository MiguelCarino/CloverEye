// Catalog and thread data shaping (SCOPE §3.2, C1). No DOM, so it runs
// under `node --test`.

import { backlinks, commentText, decodeEntities, parseComment } from './render.js';
import { decodePanes } from './tabs-model.js';

/** catalog.json's pages flattened into one list, in bump order. Each
 *  thread keeps the number of the page it was on as `page` (stats-model.js). */
export function catalogThreads(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((page) => {
    if (!Array.isArray(page?.threads)) return [];
    const n = Number.isSafeInteger(page.page) && page.page > 0 ? page.page : null;
    return n ? page.threads.map((t) => (t && typeof t === 'object' ? { ...t, page: n } : t)) : page.threads;
  });
}

/** What stands for spoiler text in a plain-text title (a window title, the
 *  watched list, a saved thread's name): the same in every language. */
export const SPOILER_MASK = '███';

/** A comment as runs of text, { text, spoiler }, one line after another
 *  (joined by a space), white space collapsed. `links`: keep quote, board
 *  and dead links. */
function commentRuns(com, links) {
  const runs = [];
  const add = (text, spoiler) => {
    const last = runs[runs.length - 1];
    if (last && last.spoiler === spoiler) last.text += text;
    else runs.push({ text, spoiler });
  };
  parseComment(com || '').forEach((line, i) => {
    if (i) add(' ', false);
    for (const s of line) {
      if (!links && (s.type === 'quotelink' || s.type === 'deadlink' || s.type === 'boardlink')) continue;
      add(s.text, s.type === 'spoiler' || Boolean(s.spoiler));
    }
  });
  return tidyRuns(runs);
}

/** Runs with white space collapsed across them, trimmed, none empty. */
function tidyRuns(runs) {
  const out = [];
  let space = true; // what came before ends in a space (or nothing came)
  for (const r of runs) {
    let text = r.text.replace(/\s+/g, ' ');
    if (space) text = text.replace(/^ /, '');
    if (!text) continue;
    space = text.endsWith(' ');
    const last = out[out.length - 1];
    if (last && last.spoiler === r.spoiler) last.text += text;
    else out.push({ text, spoiler: r.spoiler });
  }
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.trimEnd();
    if (last.text) break;
    out.pop();
  }
  return out;
}

/** Runs cut to `max` characters in all, with "…" when cut. */
function fitRuns(runs, max) {
  const total = runs.reduce((n, r) => n + r.text.length, 0);
  if (total <= max) return runs;
  const out = [];
  let left = max - 1;
  for (const r of runs) {
    if (left <= 0) break;
    out.push({ text: r.text.slice(0, left), spoiler: r.spoiler });
    left -= r.text.length;
  }
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.trimEnd();
    if (last.text) break;
    out.pop();
  }
  const last = out[out.length - 1];
  if (last && !last.spoiler) last.text += '…';
  else out.push({ text: '…', spoiler: false });
  return out;
}

/** Spoiler runs as SPOILER_MASK, as one string. */
const maskRuns = (runs) => runs.map((r) => (r.spoiler ? SPOILER_MASK : r.text)).join('');
const masked = (runs) => tidyRuns(runs.map((r) => (r.spoiler ? { text: SPOILER_MASK, spoiler: false } : r)));

/**
 * A thread's title as runs { text, spoiler }: its subject, else the start
 * of its comment (spoiler text marked, to be drawn hidden), else No.
 */
export function titleRuns(op, max = 80) {
  const sub = op?.sub ? decodeEntities(op.sub).trim() : '';
  if (sub) return [{ text: sub, spoiler: false }];
  const runs = commentRuns(op?.com, true);
  if (runs.length) return fitRuns(runs, max);
  return [{ text: `No. ${op?.no ?? ''}`.trim(), spoiler: false }];
}

/** A thread's title: its subject, else the start of its comment, else No.
 *  Plain text, so spoiler text never shows in it (SPOILER_MASK). */
export function threadTitle(op, max = 80) {
  const sub = op?.sub ? decodeEntities(op.sub).trim() : '';
  if (sub) return sub;
  const runs = masked(commentRuns(op?.com, true));
  if (runs.length) return maskRuns(fitRuns(runs, max));
  return `No. ${op?.no ?? ''}`.trim();
}

/** The OP comment for a catalog card as runs { text, spoiler }, without
 *  quote links (">>123" means nothing on a card). */
export function excerptRuns(op, max = 220) {
  return fitRuns(commentRuns(op?.com, false), max);
}

/** Plain-text excerpt of the OP comment, spoiler text masked. */
export function excerpt(op, max = 220) {
  return maskRuns(fitRuns(masked(commentRuns(op?.com, false)), max));
}

// Backlinks and the quote map, worked out once per posts list and kept
// while the same posts stay hidden: a thread redraws far more often than
// its posts change.
const reach = new WeakMap(); // posts → { key, refs, posts }

/**
 * The backlinks ("Replies") of a thread's posts, counting only the posts
 * drawn (a discarded post is not there; a hidden one is a stub line), and
 * the posts quote links can reach (every one but the discarded).
 * @returns {{refs: Map<number, number[]>, posts: Map<number, object>}}
 */
export function shownPosts(posts, hidden = new Map(), revealed = new Set()) {
  const gone = [];
  const stubbed = [];
  for (const [no, why] of hidden || []) {
    if (why?.reason === 'discard') gone.push(no);
    else if (!revealed.has(no)) stubbed.push(no);
  }
  const key = `${gone.join(',')}|${stubbed.join(',')}`;
  const hit = reach.get(posts);
  if (hit && hit.key === key) return hit;
  const out = new Set(gone);
  const quiet = new Set([...gone, ...stubbed]);
  const c = {
    key,
    refs: backlinks(quiet.size ? posts.filter((p) => !quiet.has(p.no)) : posts),
    posts: new Map(posts.filter((p) => !out.has(p.no)).map((p) => [p.no, p])),
  };
  reach.set(posts, c);
  return c;
}

export const CATALOG_SORTS = Object.freeze([
  { value: 'bump', label: 'Bump order' },
  { value: 'replies', label: 'Most replies' },
  { value: 'new', label: 'Newest' },
]);

/** Filter (subject and comment, case-insensitive) and sort. Stickies stay
 *  on top in bump order, as on the site. */
export function arrangeCatalog(threads, { query = '', sort = 'bump' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let list = threads.slice();
  if (q) {
    list = list.filter((t) => `${decodeEntities(t.sub || '')}\n${commentText(t.com || '')}`.toLowerCase().includes(q));
  }
  if (sort === 'replies') list.sort((a, b) => (b.replies || 0) - (a.replies || 0));
  else if (sort === 'new') list.sort((a, b) => (b.no || 0) - (a.no || 0));
  return list;
}

/** "3 min ago" style age from a unix time (seconds). */
export function ago(unix, now = Date.now()) {
  if (!Number.isFinite(unix)) return '';
  const s = Math.max(0, Math.round(now / 1000 - unix));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Posts in `next` that were not in `prev` (for "3 new replies"). */
export function newPosts(prev, next) {
  const seen = new Set((prev || []).map((p) => p.no));
  return (next || []).filter((p) => !seen.has(p.no));
}

/**
 * A catalog's or thread's status line: "Loading the thread…" while it
 * loads; when it is here, when it was updated and how ("no changes", "too
 * soon to ask again…", "3 new"); null after an error (the error box says
 * it) or when there is nothing to say. `what`: 'thread' or 'catalog'.
 * `time` turns a millisecond time into the clock time shown.
 */
export function statusText(entry, what, { time = (ms) => new Date(ms).toLocaleTimeString() } = {}) {
  if (!entry || entry.status === 'loading') return `Loading the ${what}…`;
  if (entry.status === 'error') return null;
  const parts = [];
  if (entry.at) parts.push(`Updated ${time(entry.at)}`);
  if (entry.freshness === 'not-modified') parts.push('no changes');
  if (entry.freshness === 'throttled') parts.push('too soon to ask again, showing the last copy');
  if (entry.fresh?.size) parts.push(`${entry.fresh.size} new`);
  return parts.length ? parts.join(' · ') : null;
}

/** The message to show for a failed load. */
export function loadErrorText(err, what = 'thread') {
  const msg = String(err?.message || err || '');
  if (msg === 'not-found') return what === 'thread' ? 'This thread is gone: it was archived or deleted.' : 'This board was not found.';
  return msg || 'Something went wrong.';
}

/** An extra window (opened from a pane) carries its panes in the address:
 *  #panes=<encoded JSON list>, of views or of panes with tabs (tabs-model.js
 *  decodePanes). Each pane's shown view; only known view shapes pass. */
export function panesFromHash(hash) {
  const groups = decodePanes(hash);
  return groups ? groups.map((g) => g.tabs[g.active]) : null;
}

/** The browser's reload keys: F5 and Ctrl+R (⌘R on a Mac), each also with
 *  Shift (the hard reload). In CloverEye they update the focused pane. */
export function isRefreshKey(e) {
  if (e.altKey) return false;
  if (e.key === 'F5') return !e.metaKey;
  return (e.key === 'r' || e.key === 'R') && (e.ctrlKey !== e.metaKey);
}

/** The refresh keys as shown in a button's tooltip on this platform. */
export function refreshKeysLabel(platform = globalThis.navigator?.platform || '') {
  return /Mac/.test(platform) ? '⌘R · F5' : 'Ctrl+R · F5';
}
