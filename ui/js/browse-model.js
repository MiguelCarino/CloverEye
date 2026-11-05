// Catalog and thread data shaping (SCOPE §3.2, C1). No DOM, so it runs
// under `node --test`.

import { commentText, decodeEntities, parseComment } from './render.js';

/** catalog.json's pages flattened into one list, in bump order. */
export function catalogThreads(data) {
  if (!Array.isArray(data)) return [];
  return data.flatMap((page) => (Array.isArray(page?.threads) ? page.threads : []));
}

/** A thread's title: its subject, else the start of its comment, else No. */
export function threadTitle(op, max = 80) {
  const sub = op?.sub ? decodeEntities(op.sub).trim() : '';
  if (sub) return sub;
  const text = commentText(op?.com || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return `No. ${op?.no ?? ''}`.trim();
}

/** Plain-text excerpt of the OP comment for a catalog card, without quote
 *  links (">>123" means nothing on a card). */
export function excerpt(op, max = 220) {
  const text = parseComment(op?.com || '')
    .map((line) => line.filter((s) => s.type !== 'quotelink' && s.type !== 'deadlink').map((s) => s.text).join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
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

/** The message to show for a failed load. */
export function loadErrorText(err, what = 'thread') {
  const msg = String(err?.message || err || '');
  if (msg === 'not-found') return what === 'thread' ? 'This thread is gone: it was archived or deleted.' : 'This board was not found.';
  return msg || 'Something went wrong.';
}

/** An extra window (opened from a pane) carries its panes in the address:
 *  #panes=<encoded JSON list of views>. Only known view shapes pass. */
export function panesFromHash(hash) {
  const m = /^#panes=(.+)$/.exec(hash || '');
  if (!m) return null;
  let list;
  try {
    list = JSON.parse(decodeURIComponent(m[1]));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const ok = list.filter(
    (v) =>
      v &&
      (v.kind === 'boards' ||
        (v.kind === 'board' && /^[a-z0-9]{1,10}$/.test(v.board)) ||
        (v.kind === 'thread' && /^[a-z0-9]{1,10}$/.test(v.board) && Number.isSafeInteger(v.no) && v.no > 0)),
  );
  return ok.length ? ok.slice(0, 5).map((v) => (v.kind === 'thread' ? { kind: 'thread', board: v.board, no: v.no } : v.kind === 'board' ? { kind: 'board', board: v.board } : { kind: 'boards' })) : null;
}
