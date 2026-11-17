// What a data change needs redrawn (shell.js): whether a thread's posts
// changed at all, and how; which panes show what. No DOM, so it runs under
// `node --test`.

/** Fields of a thread's first post that count up with every reply: they
 *  change while the posts drawn stay the same. */
const OP_COUNTERS = ['replies', 'images', 'unique_ips', 'bumplimit', 'imagelimit', 'last_modified'];

const sameJson = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function withoutCounters(op) {
  if (!op || typeof op !== 'object') return op;
  const out = { ...op };
  for (const k of OP_COUNTERS) delete out[k];
  return out;
}

/**
 * True when two post lists hold the same posts with the same content (the
 * site's JSON keeps its key order, so comparing each post's JSON is enough).
 * A fetch that brought nothing new (304, too soon, or an unchanged 200)
 * gives the same posts in a new array.
 */
export function samePosts(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
  return true;
}

/**
 * How a thread's posts changed from `prev` to `next`:
 * - { kind: 'same' }: nothing at all;
 * - { kind: 'appended', added }: new posts at the end, the old ones as they
 *   were (the first post's reply and image counters may have moved);
 * - { kind: 'changed' }: anything else (a post deleted or edited, a file
 *   deleted, the thread closed, archived or made sticky).
 */
export function threadDelta(prev, next) {
  if (samePosts(prev, next)) return { kind: 'same' };
  if (!Array.isArray(prev) || !Array.isArray(next) || !prev.length || next.length <= prev.length) return { kind: 'changed' };
  if (!sameJson(withoutCounters(prev[0]), withoutCounters(next[0]))) return { kind: 'changed' };
  for (let i = 1; i < prev.length; i++) if (!sameJson(prev[i], next[i])) return { kind: 'changed' };
  return { kind: 'appended', added: next.slice(prev.length) };
}

/** The indexes of the panes whose view matches `pred(view, index)`. */
export function paneIndexes(views, pred) {
  const out = [];
  (views || []).forEach((v, i) => {
    if (v && pred(v, i)) out.push(i);
  });
  return out;
}

/** A pane showing the live thread board/no. */
export const showsThread = (board, no) => (v) => v.kind === 'thread' && v.board === board && v.no === no;
/** A pane showing the saved copy of board/no. */
export const showsSaved = (board, no) => (v) => v.kind === 'offline' && v.board === board && v.no === no;
/** A pane that draws from a board's catalog: the catalog itself, or one of
 *  its threads (the page in the thread's toolbar, the title while it loads). */
export const usesCatalog = (board) => (v) => (v.kind === 'board' || v.kind === 'thread') && v.board === board;

/** What an Ask pane's "This thread" stands for, as one string: an Ask pane
 *  needs redrawing only when it changes. */
export function askKey(target) {
  if (!target) return '';
  return [target.kind, target.board, target.no, target.title || ''].join('|');
}

/**
 * Whether a thread fetch that just ended changed nothing that a pane draws
 * besides its status line: the posts are the same and the thread was
 * already shown without an error.
 * @param {{status?: string, posts?: object[], gone?: boolean}|undefined} prev  the entry before the fetch
 * @param {object[]} posts  what the fetch brought
 */
export function quietUpdate(prev, posts) {
  return Boolean(prev?.posts) && prev.status === 'ok' && !prev.gone && samePosts(prev.posts, posts);
}

/** The indexes of a pane's background tabs (every tab but the active one)
 *  whose view matches `pred(view)`: a fetch for one of them changes only
 *  the pane's tab strip (its title), never what the pane shows. */
export function backgroundTabs(tabs, active, pred) {
  const out = [];
  (tabs || []).forEach((t, i) => {
    if (i !== active && t?.view && pred(t.view)) out.push(i);
  });
  return out;
}
