// Thread stats for the thread toolbar: replies, files, posters and where
// the thread sits in the board's catalog. DOM-free, and made only from what
// the app already has (the thread and the cached catalog): no requests.

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * @param {object[]} posts            the thread's posts, OP first
 * @param {object[]|null} [catalog]   the board's cached catalog threads
 *   (browse-model.js catalogThreads: each with its `page`), if loaded
 * @returns {{replies: number, files: number, posters: number|null,
 *   page: number|null, pages: number|null, lastPage: boolean,
 *   bumpLimit: boolean, imageLimit: boolean, warn: boolean} | null}
 */
export function threadStats(posts, catalog = null) {
  const op = Array.isArray(posts) ? posts[0] : null;
  if (!op || typeof op !== 'object') return null;
  // The OP's counts are the site's own; counting is the fallback (the app
  // keeps deleted posts, so a count could be higher than the site's).
  const replies = count(op.replies) ?? posts.length - 1;
  const files = count(op.images) ?? posts.slice(1).filter((p) => p?.tim && !p.filedeleted).length;
  let posters = count(op.unique_ips);
  if (posters === null) {
    const ids = new Set(posts.map((p) => p?.id).filter((id) => typeof id === 'string' && id));
    posters = ids.size ? ids.size : null;
  }
  let page = null;
  let pages = null;
  if (Array.isArray(catalog) && catalog.length) {
    for (const t of catalog) {
      const p = count(t?.page);
      if (p && (pages === null || p > pages)) pages = p;
      if (t?.no === op.no && p) page = p;
    }
    if (page === null) pages = null;
  }
  const lastPage = page !== null && pages !== null && pages > 1 && page === pages;
  const bumpLimit = Boolean(op.bumplimit);
  const imageLimit = Boolean(op.imagelimit);
  return { replies, files, posters, page, pages, lastPage, bumpLimit, imageLimit, warn: lastPage || bumpLimit };
}

// ------------------------------------------------------------ board activity
//
// The Stats pane (like 4stats.io): how busy each board is, worked out from
// catalogs only. A board's post numbers are its own and go up one by one, so
// the rise in the highest number between two catalogs is the number of posts
// made in between. Samples are small: { at (ms), maxNo, threads (live
// threads), newOps (threads started since the previous snapshot, or null),
// since (that snapshot's time, or null), top (the thread that gained the most
// replies since then: { no, added, title? }, or null) }. Each board also keeps
// the reply counts of its last catalog (`snap`) to find the busiest thread.
// Kept in a file of their own (src-tauri/src/stats.rs), never in settings.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** A sample this close to the board's last one is not kept. */
export const MIN_SAMPLE_GAP_MS = 30_000;
/** "Now" needs two samples at least this far apart … */
export const NOW_MIN_SPAN_MS = MINUTE_MS;
/** … and the newest no older than this (else there is no "now"). */
export const NOW_MAX_AGE_MS = 2 * HOUR_MS;
/** New threads and the busiest thread are counted only against a snapshot
 *  at most this old: over a longer gap threads come and go unseen. */
export const PAIR_MAX_MS = 2 * HOUR_MS;
/** Samples dated further ahead than this (a clock that went back) are dropped. */
export const FUTURE_SLACK_MS = 10 * MINUTE_MS;
export const MAX_SAMPLES_PER_BOARD = 600;
/** The board stats file stays under this (the app refuses 4 MiB). */
export const MAX_STATS_BYTES = 3 * 1024 * 1024;
/** Active sampling: each board at most every … minutes (Settings → Stats). */
export const SAMPLE_INTERVALS = Object.freeze([5, 10, 15, 30]);
export const STATS_SCOPES = Object.freeze(['favourites', 'worksafe', 'visible']);
/** A manual refresh samples a board again only after this long. */
export const MANUAL_FLOOR_MS = MINUTE_MS;
const TITLE_MAX = 60;

const isNo = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isFinite(v) && v > 0;
const BOARD_RE = /^[a-z0-9]{1,10}$/;

/** Settings → Stats, made valid. Everything is off by default. */
export function normalizeStatsSettings(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    track: r.track === true,
    scope: STATS_SCOPES.includes(r.scope) ? r.scope : 'favourites',
    intervalMin: SAMPLE_INTERVALS.includes(r.intervalMin) ? r.intervalMin : SAMPLE_INTERVALS[0],
    mine: r.mine === true,
  };
}

/** The highest post number in a catalog (OPs and their last replies). */
export function catalogMaxNo(threads) {
  let max = 0;
  for (const t of Array.isArray(threads) ? threads : []) {
    if (isNo(t?.no) && t.no > max) max = t.no;
    for (const r of Array.isArray(t?.last_replies) ? t.last_replies : []) if (isNo(r?.no) && r.no > max) max = r.no;
  }
  return max;
}

/**
 * One sample from a catalog (browse-model.js catalogThreads) and the
 * board's previous snapshot. Returns { sample, snap }, or null for an
 * empty catalog.
 * @param {(op: object) => string} [o.title]  a thread's title, for the busiest one
 */
export function catalogSample(threads, prevSnap, at, { title = () => '' } = {}) {
  const list = (Array.isArray(threads) ? threads : []).filter((t) => isNo(t?.no));
  const maxNo = catalogMaxNo(list);
  if (!maxNo || !isTime(at)) return null;
  const snap = { at, maxNo, r: list.map((t) => [t.no, Number.isSafeInteger(t.replies) && t.replies >= 0 ? t.replies : 0]) };
  const sample = { at, maxNo, threads: list.length, newOps: null, since: null, top: null };
  const prev = normalizeSnap(prevSnap);
  if (prev && prev.at < at && at - prev.at <= PAIR_MAX_MS && prev.maxNo <= maxNo) {
    const before = new Map(prev.r);
    let best = null;
    let fresh = 0;
    for (const [i, t] of list.entries()) {
      const replies = snap.r[i][1];
      let added;
      if (t.no > prev.maxNo) {
        fresh += 1;
        added = replies;
      } else if (before.has(t.no)) added = replies - before.get(t.no);
      else continue; // older than the snapshot but not in it: no baseline
      if (added > 0 && (!best || added > best.added)) best = { t, added };
    }
    sample.newOps = fresh;
    sample.since = prev.at;
    if (best) {
      const name = String(title(best.t) || '').slice(0, TITLE_MAX);
      sample.top = name ? { no: best.t.no, added: best.added, title: name } : { no: best.t.no, added: best.added };
    }
  }
  return { sample, snap };
}

function normalizeSnap(s) {
  if (!s || typeof s !== 'object' || !isTime(s.at) || !isNo(s.maxNo) || !Array.isArray(s.r)) return null;
  const r = s.r.filter((p) => Array.isArray(p) && isNo(p[0]) && Number.isSafeInteger(p[1]) && p[1] >= 0).map((p) => [p[0], p[1]]);
  return { at: s.at, maxNo: s.maxNo, r: r.slice(0, 400) };
}

function normalizeSample(s) {
  if (!s || typeof s !== 'object' || !isTime(s.at) || !isNo(s.maxNo)) return null;
  const out = {
    at: s.at,
    maxNo: s.maxNo,
    threads: Number.isSafeInteger(s.threads) && s.threads >= 0 ? s.threads : 0,
    newOps: null,
    since: null,
    top: null,
  };
  if (Number.isSafeInteger(s.newOps) && s.newOps >= 0 && isTime(s.since) && s.since < s.at) {
    out.newOps = s.newOps;
    out.since = s.since;
  }
  if (s.top && isNo(s.top.no) && Number.isSafeInteger(s.top.added) && s.top.added > 0) {
    out.top = { no: s.top.no, added: s.top.added };
    if (typeof s.top.title === 'string' && s.top.title) out.top.title = s.top.title.slice(0, TITLE_MAX);
  }
  return out;
}

export const emptyBoardStats = () => ({ v: 1, rev: 0, boards: {} });

/** Reads anything (the stored file, garbage) into a valid board stats store. */
export function normalizeBoardStats(raw) {
  const out = emptyBoardStats();
  if (!raw || typeof raw !== 'object') return out;
  out.rev = Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  const boards = raw.boards && typeof raw.boards === 'object' ? raw.boards : {};
  for (const [b, e] of Object.entries(boards)) {
    if (!BOARD_RE.test(b) || !e || typeof e !== 'object') continue;
    const samples = (Array.isArray(e.samples) ? e.samples : []).map(normalizeSample).filter(Boolean);
    const snap = normalizeSnap(e.snap);
    if (samples.length || snap) out.boards[b] = { samples: sortSamples(samples), snap };
  }
  return out;
}

function sortSamples(list) {
  const out = list.slice().sort((a, b) => a.at - b.at);
  // one sample per moment: the first kept
  return out.filter((s, i) => i === 0 || s.at !== out[i - 1].at);
}

/** The time of a board's newest sample, or null. */
export function lastSampleAt(store, board) {
  const s = store?.boards?.[board]?.samples;
  return s?.length ? s[s.length - 1].at : null;
}

/**
 * Adds a catalog to the store as a sample of `board`. Returns
 * { store, sample } (a new store), or { store, sample: null } unchanged when
 * the catalog is empty or the board's last sample is under 30 s old.
 */
export function addSample(store, board, threads, at, o = {}) {
  const entry = store?.boards?.[board];
  const last = lastSampleAt(store, board);
  if (last !== null && Math.abs(at - last) < MIN_SAMPLE_GAP_MS) return { store, sample: null };
  const made = catalogSample(threads, entry?.snap, at, o);
  if (!made) return { store, sample: null };
  return { store: insertSamples(store, [{ board, sample: made.sample, snap: made.snap }]), sample: made.sample };
}

/**
 * Puts samples (from this window, or kept while a write was refused) into
 * a store: one per moment, the newer snapshot kept. Returns a new store.
 * @param {{board: string, sample: object, snap?: object}[]} items
 */
export function insertSamples(store, items) {
  const out = { ...(store || emptyBoardStats()), boards: { ...(store?.boards || {}) } };
  for (const { board, sample, snap } of items) {
    if (!BOARD_RE.test(board)) continue;
    const s = normalizeSample(sample);
    const e = out.boards[board] || { samples: [], snap: null };
    const samples = s && !e.samples.some((x) => x.at === s.at) ? sortSamples([...e.samples, s]) : e.samples;
    const sn = normalizeSnap(snap);
    out.boards[board] = { samples, snap: sn && (!e.snap || sn.at >= e.snap.at) ? sn : e.snap };
  }
  return out;
}

const storeBytes = (s) => JSON.stringify(s).length;

/**
 * Keeps 24 hours per board and drops what is older, dated in the future
 * (the clock went back), or past the per-board and total caps (the oldest
 * first). Only each board's newest sample keeps its busiest thread's title.
 */
export function pruneBoardStats(store, now, { maxBytes = MAX_STATS_BYTES, perBoard = MAX_SAMPLES_PER_BOARD } = {}) {
  const out = { ...(store || emptyBoardStats()), boards: {} };
  for (const [b, e] of Object.entries(store?.boards || {})) {
    let samples = e.samples.filter((s) => s.at >= now - DAY_MS && s.at <= now + FUTURE_SLACK_MS);
    if (samples.length > perBoard) samples = samples.slice(-perBoard);
    samples = samples.map((s, i) => (s.top?.title && i < samples.length - 1 ? { ...s, top: { no: s.top.no, added: s.top.added } } : s));
    const snap = e.snap && e.snap.at >= now - DAY_MS && e.snap.at <= now + FUTURE_SLACK_MS ? e.snap : null;
    if (samples.length || snap) out.boards[b] = { samples, snap };
  }
  while (storeBytes(out) > maxBytes) {
    const names = Object.keys(out.boards);
    if (!names.length) break;
    for (const b of names) {
      const e = out.boards[b];
      const samples = e.samples.slice(Math.max(1, Math.ceil(e.samples.length / 8)));
      if (samples.length) out.boards[b] = { ...e, samples };
      else delete out.boards[b];
    }
  }
  return out;
}

// --------------------------------------------------------------- the maths

/** Consecutive samples as { from, to, posts }. A pair whose highest number
 *  went down (the board's numbers were reset) or whose times do not move
 *  forward is left out. */
export function ratePairs(samples) {
  const list = sortSamples((samples || []).filter((s) => isTime(s?.at) && isNo(s?.maxNo)));
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (b.at > a.at && b.maxNo >= a.maxNo) out.push({ from: a.at, to: b.at, posts: b.maxNo - a.maxNo });
  }
  return out;
}

/**
 * Posts per minute now: from the newest sample back to the samples before
 * it, until they span a minute (never across a reset). Null with fewer than
 * two samples, or when the newest is over two hours old.
 */
export function ppmNow(samples, now) {
  const list = sortSamples((samples || []).filter((s) => isTime(s?.at) && isNo(s?.maxNo) && s.at <= now + FUTURE_SLACK_MS));
  if (list.length < 2) return null;
  const last = list[list.length - 1];
  if (now - last.at > NOW_MAX_AGE_MS) return null;
  for (let i = list.length - 2; i >= 0; i--) {
    const a = list[i];
    const b = list[i + 1];
    if (!(b.at > a.at && b.maxNo >= a.maxNo)) return null; // a reset: no rate across it
    const span = last.at - a.at;
    if (span > NOW_MAX_AGE_MS) return null;
    if (span >= NOW_MIN_SPAN_MS) return ((last.maxNo - a.maxNo) * MINUTE_MS) / span;
  }
  return null;
}

/** The part of the pairs inside [start, end]: posts (shared out evenly
 *  over each pair) and the time they cover. */
function inside(pairs, start, end) {
  let posts = 0;
  let covered = 0;
  for (const p of pairs) {
    const lo = Math.max(p.from, start);
    const hi = Math.min(p.to, end);
    if (hi <= lo) continue;
    const share = (hi - lo) / (p.to - p.from);
    posts += p.posts * share;
    covered += hi - lo;
  }
  return { posts, covered };
}

/** Average posts per minute over the last `windowMs`, or null when the
 *  samples cover less than `minCover` of it. */
export function averagePpm(samples, now, windowMs, minCover = 0.5) {
  const { posts, covered } = inside(ratePairs(samples), now - windowMs, now);
  if (covered <= 0 || covered < windowMs * minCover) return null;
  return (posts * MINUTE_MS) / covered;
}

/** New threads an hour over the last `windowMs`, from the samples that
 *  counted them; null when they cover under half an hour. */
export function threadsPerHour(samples, now, windowMs = 6 * HOUR_MS, minCoverMs = 30 * MINUTE_MS) {
  let ops = 0;
  let covered = 0;
  for (const s of samples || []) {
    if (!Number.isSafeInteger(s?.newOps) || !isTime(s?.since) || !(s.at > s.since)) continue;
    if (s.at < now - windowMs || s.at > now + FUTURE_SLACK_MS) continue;
    ops += s.newOps;
    covered += s.at - s.since;
  }
  if (covered < minCoverMs) return null;
  return (ops * HOUR_MS) / covered;
}

/** The busiest thread now: the newest sample's, if it is recent. */
export function busiestThread(samples, now) {
  const list = sortSamples((samples || []).filter((s) => isTime(s?.at)));
  const last = list[list.length - 1];
  if (!last?.top || now - last.at > NOW_MAX_AGE_MS) return null;
  return { no: last.top.no, added: last.top.added, title: last.top.title || '', at: last.at };
}

/** The sparkline leaves out pairs of samples further apart than this, so a
 *  gap in sampling shows as a gap in the line (averages still use them). */
export const SPARK_MAX_PAIR_MS = 90 * MINUTE_MS;

/** Posts per minute in each of `buckets` equal slices of the last `span`
 *  (oldest first); null where no samples cover a slice. */
export function sparkValues(samples, now, { buckets = 24, span = DAY_MS } = {}) {
  const pairs = ratePairs(samples).filter((p) => p.to - p.from <= SPARK_MAX_PAIR_MS);
  const size = span / buckets;
  const out = [];
  for (let i = 0; i < buckets; i++) {
    const start = now - span + i * size;
    const { posts, covered } = inside(pairs, start, start + size);
    out.push(covered > 0 ? (posts * MINUTE_MS) / covered : null);
  }
  return out;
}

/**
 * An SVG path for a sparkline of `values` in a w×h box: a line through the
 * known values, broken where one is missing (a lone value is a dot).
 * Returns { d, low, high } (low/high null when there is nothing to draw).
 */
export function sparkPath(values, w = 96, h = 24, pad = 2) {
  const known = values.filter((v) => Number.isFinite(v));
  if (!known.length) return { d: '', low: null, high: null };
  const low = Math.min(...known);
  const high = Math.max(...known);
  const top = Math.max(high, 1e-9);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const r = (n) => Math.round(n * 10) / 10;
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      open = false;
      return;
    }
    const x = r(pad + i * step);
    const y = r(h - pad - (v / top) * (h - pad * 2));
    const next = values[i + 1];
    if (!open) {
      d += `M${x} ${y}`;
      if (!Number.isFinite(next)) d += 'h0.01'; // a lone value: drawn as a dot (round caps)
    } else d += `L${x} ${y}`;
    open = true;
  });
  return { d, low, high };
}

/** Everything the Stats pane shows for one board. */
export function boardRow(board, entry, now) {
  const samples = entry?.samples || [];
  const last = samples.length ? samples[samples.length - 1] : null;
  return {
    board,
    count: samples.length,
    last: last ? last.at : null,
    ppm: ppmNow(samples, now),
    hour: averagePpm(samples, now, HOUR_MS, 0.5),
    day: averagePpm(samples, now, DAY_MS, 0.25),
    tph: threadsPerHour(samples, now),
    threads: last && now - last.at <= NOW_MAX_AGE_MS ? last.threads : null,
    busiest: busiestThread(samples, now),
    spark: sparkValues(samples, now),
  };
}

export const SORT_KEYS = Object.freeze(['board', 'ppm', 'tph']);

/** Rows sorted by board, posts a minute or threads an hour. Unknown values
 *  go last either way; ties go by board. */
export function sortRows(rows, key = 'ppm', dir = key === 'board' ? 'asc' : 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  const byBoard = (a, b) => (a.board < b.board ? -1 : a.board > b.board ? 1 : 0);
  return rows.slice().sort((a, b) => {
    if (key === 'board') return sign * byBoard(a, b);
    const x = a[key];
    const y = b[key];
    const xn = Number.isFinite(x);
    const yn = Number.isFinite(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x !== y) return sign * (x - y);
    return byBoard(a, b);
  });
}

/** The boards the sampler follows: favourites (default), every worksafe
 *  board, or every board the person can see (NSFW ones only when those are
 *  on; the caller passes the lists already filtered). */
export function trackedBoards(scope, { favourites = [], worksafe = [], visible = [] } = {}) {
  const list = scope === 'worksafe' ? worksafe : scope === 'visible' ? visible : favourites;
  return [...new Set(list.filter((b) => BOARD_RE.test(b)))];
}

/**
 * The next board to sample: the one never sampled, else the one sampled
 * longest ago, once its last sample is `intervalMs` old. Returns
 * { board, wait: 0 }, or { board: <the next one>, wait: ms until it is due },
 * or { board: null } with no boards.
 * @param {(board: string) => number|null} lastAt
 */
export function pickDue(boards, lastAt, now, intervalMs) {
  let best = null;
  for (const b of boards) {
    const at = lastAt(b);
    // a sample "from the future" (the clock went back) counts as just now
    const due = at === null ? -Infinity : Math.min(at, now) + intervalMs;
    if (!best || due < best.due) best = { board: b, due };
  }
  if (!best) return { board: null, wait: 0 };
  return { board: best.board, wait: Math.max(0, best.due - now) };
}

/** A manual refresh: the boards whose last sample is over a minute old. */
export const manualDue = (boards, lastAt, now, floorMs = MANUAL_FLOOR_MS) =>
  boards.filter((b) => {
    const at = lastAt(b);
    return at === null || now - at >= floorMs || at > now + FUTURE_SLACK_MS;
  });
