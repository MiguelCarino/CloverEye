// Unread posts: where the person stopped reading each thread, the "New
// posts" line, and the count shown in the window title. DOM-free (tested
// with node --test).
//
// Two marks per thread:
// - read: the highest post No. that has been on screen (kept in settings,
//   settings.lastRead, "board/no" → No.; only ever goes up). Unread posts
//   are the ones after it.
// - line: where the "New posts" line goes (this session only): what was
//   read when the thread was opened, moved down to the last update's new
//   posts once everything before them was read.

/** How many threads keep a read mark (the oldest are dropped first). */
export const MAX_LAST_READ = 500;

const KEY_RE = /^[a-z0-9]{1,10}\/[1-9]\d{0,15}$/;
const isNo = (n) => Number.isSafeInteger(n) && n > 0;

export const readKey = (board, no) => `${board}/${no}`;

/** Cleans the stored marks: valid keys and post numbers, the newest
 *  MAX_LAST_READ (object order is oldest first). */
export function normalizeLastRead(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw).filter(([k, v]) => KEY_RE.test(k) && isNo(v));
  const out = {};
  for (const [k, v] of entries.slice(-MAX_LAST_READ)) out[k] = v;
  return out;
}

/**
 * What has been read of a thread: its own mark, or the watcher's `seen`
 * when that is further (watching a thread marks what it had as read).
 */
export function readOf(settings, board, no) {
  const own = settings?.lastRead?.[readKey(board, no)] || 0;
  const w = (settings?.watched || []).find((x) => x.board === board && x.no === no);
  return Math.max(own, w?.seen || 0);
}

/**
 * Moves a thread's read mark up to `read` (never down). The thread becomes
 * the newest entry; past MAX_LAST_READ the oldest go. A watched thread's
 * `seen` follows. Returns the same object when nothing changes.
 */
export function markRead(settings, board, no, read) {
  if (!isNo(read) || read <= readOf(settings, board, no)) return settings;
  const key = readKey(board, no);
  const lastRead = { ...(settings.lastRead || {}) };
  delete lastRead[key];
  lastRead[key] = read;
  const keys = Object.keys(lastRead);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LAST_READ))) delete lastRead[k];
  const watched = (settings.watched || []).map((w) => (w.board === board && w.no === no && (w.seen || 0) < read ? { ...w, seen: read } : w));
  return { ...settings, lastRead, watched };
}

/** Settings without their read marks (lastRead, each watched thread's
 *  `seen`), as JSON: two settings that give the same string differ in read
 *  marks at most. */
function withoutReadMarks(s) {
  if (!s || typeof s !== 'object') return JSON.stringify(s);
  const watched = Array.isArray(s.watched) ? s.watched.map((w) => (w && typeof w === 'object' ? { ...w, seen: 0 } : w)) : s.watched;
  return JSON.stringify({ ...s, lastRead: null, watched });
}

/** True when `a` and `b` differ only in read marks (or not at all): saved
 *  while someone reads, so another window need not redraw for them. */
export const onlyReadMarksDiffer = (a, b) => withoutReadMarks(a) === withoutReadMarks(b);

/**
 * `incoming` settings (saved by another window) with no read mark lower
 * than in `local`: each thread's lastRead and each watched thread's `seen`
 * take the higher of the two. Threads `incoming` no longer has are left
 * out (dropped there as the oldest, or unwatched). Returns `incoming`
 * itself when it is already as far everywhere.
 */
export function keepReadMarks(local, incoming) {
  if (!incoming || typeof incoming !== 'object' || !local || typeof local !== 'object') return incoming;
  const mine = local.lastRead || {};
  let lastRead = null;
  for (const [k, v] of Object.entries(incoming.lastRead || {})) {
    if (isNo(mine[k]) && mine[k] > v) {
      if (!lastRead) lastRead = { ...incoming.lastRead };
      lastRead[k] = mine[k];
    }
  }
  const seenOf = new Map((Array.isArray(local.watched) ? local.watched : []).map((w) => [readKey(w?.board, w?.no), w?.seen || 0]));
  let raised = false;
  const watched = Array.isArray(incoming.watched)
    ? incoming.watched.map((w) => {
        const s = seenOf.get(readKey(w?.board, w?.no)) || 0;
        if (!w || s <= (w.seen || 0)) return w;
        raised = true;
        return { ...w, seen: s };
      })
    : incoming.watched;
  if (!lastRead && !raised) return incoming;
  return { ...incoming, ...(lastRead ? { lastRead } : {}), ...(raised ? { watched } : {}) };
}

/** True when two settings hold the same read marks (lastRead in any order,
 *  and each watched thread's `seen`). */
export function sameReadMarks(a, b) {
  const ra = a?.lastRead || {};
  const rb = b?.lastRead || {};
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length || ka.some((k) => ra[k] !== rb[k])) return false;
  const wa = Array.isArray(a?.watched) ? a.watched : [];
  const wb = Array.isArray(b?.watched) ? b.watched : [];
  return wa.length === wb.length && wa.every((w, i) => (w?.seen || 0) === (wb[i]?.seen || 0));
}

/**
 * The posts after `read` that count as unread: not hidden (`skip`) and not
 * the person's own.
 * @param {Array<{no: number}>} posts
 * @param {number} read
 * @param {{skip?: Set<number>, isYou?: (no: number) => boolean}} [o]
 */
export function unreadPosts(posts, read, { skip = new Set(), isYou = () => false } = {}) {
  if (!Array.isArray(posts)) return [];
  return posts.filter((p) => p.no > (read || 0) && !skip.has(p.no) && !isYou(p.no)).map((p) => p.no);
}

/** The first unread post's No., or null. */
export function firstUnread(posts, read, o) {
  return unreadPosts(posts, read, o)[0] ?? null;
}

/**
 * Where the "New posts" line starts when a thread is opened: after what was
 * read. A thread never read before has no line (null): everything in it is
 * new, and the line would only sit under the opening post.
 */
export const lineOnOpen = (read) => (isNo(read) ? read : null);

/**
 * Where the line goes after an update that brought new posts. When the
 * thread was opened unread (no line yet), or everything up to the previous
 * last post had been read, the line moves to just above the new posts;
 * otherwise it stays where it is, above the posts still unread.
 * @param {number|null} line      the line before the update
 * @param {number} read           what had been read when the update came
 * @param {number} prevLast       the last post No. before the update
 */
export function lineAfterUpdate(line, read, prevLast) {
  if (!isNo(prevLast)) return line;
  if (line == null || (read || 0) >= prevLast) return prevLast;
  return line;
}

/** The No. of the post the "New posts" line is drawn above, or null when
 *  no post comes after it. */
export function lineBefore(posts, line) {
  if (!isNo(line) || !Array.isArray(posts)) return null;
  return posts.find((p) => p.no > line)?.no ?? null;
}

/**
 * The last post read on screen: the highest No. whose bottom edge is inside
 * (or above) the bottom of the view. `items` are in thread order, so their
 * bottoms only grow; found by halving.
 * @param {Array<{no: number, bottom: number}>} items
 * @param {number} viewBottom
 * @param {number} [slack]   pixels a post may still stick out
 * @returns {number} 0 when none
 */
export function lastOnScreen(items, viewBottom, slack = 8) {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].bottom <= viewBottom + slack) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? 0 : items[found].no;
}

/** A window title with the unread count in front: "(3) /g/ · title". */
export const titleWithCount = (title, count) => (count > 0 ? `(${count}) ${title}` : title);
