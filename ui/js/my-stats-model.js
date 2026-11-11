// Your own stats (Settings → Stats → Count my own activity; off by
// default). Counted per day on this computer only, kept 90 days, in a file
// of their own beside the board stats (src-tauri/src/stats.rs), never in
// settings and never sent anywhere. While the switch is off nothing is
// counted at all. DOM-free, so it runs under `node --test`.

export const MY_STATS_DAYS = 90;
/** Replies to you already counted ("board/no"), so none counts twice. */
export const MAX_COUNTED = 1000;
const MAX_BOARDS_PER_DAY = 60;
const BOARD_RE = /^[a-z0-9]{1,10}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What is counted each day:
 *   time     seconds with a CloverEye window focused and visible
 *   threads  threads opened
 *   read     posts read (newly marked read, as the "New posts" line uses)
 *   posts    posts made from CloverEye (each new (You))
 *   replies  replies to your posts, each once, when they first show up
 *   files    files viewed: shown in the gallery, opened in a thread with a
 *            click, or previewed on hover (an approximation)
 *   saved    threads saved offline
 * and, per board, time and threads opened.
 */
export const COUNTERS = Object.freeze(['time', 'threads', 'read', 'posts', 'replies', 'files', 'saved']);

const isCount = (v) => Number.isFinite(v) && v >= 0;
const two = (n) => String(n).padStart(2, '0');

/** "2026-11-11": the local day of a time in ms. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The local day keys of the last `n` days, oldest first, ending today. */
export function lastDays(now, n) {
  const out = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // midday: a daylight-saving change never skips a day
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setDate(d.getDate() - i);
    out.push(dayKey(x.getTime()));
  }
  return out;
}

export const emptyMine = () => ({ v: 1, rev: 0, since: null, days: {}, counted: [] });

function emptyDay() {
  const d = { boards: {} };
  for (const k of COUNTERS) d[k] = 0;
  return d;
}

function normalizeDay(raw) {
  const d = emptyDay();
  if (!raw || typeof raw !== 'object') return d;
  for (const k of COUNTERS) if (isCount(raw[k])) d[k] = k === 'time' ? Math.round(raw[k]) : Math.floor(raw[k]);
  for (const [b, v] of Object.entries(raw.boards && typeof raw.boards === 'object' ? raw.boards : {})) {
    if (!BOARD_RE.test(b) || !v || typeof v !== 'object') continue;
    const time = isCount(v.time) ? Math.round(v.time) : 0;
    const threads = isCount(v.threads) ? Math.floor(v.threads) : 0;
    if (time || threads) d.boards[b] = { time, threads };
  }
  return d;
}

/** Reads anything (the stored file, garbage) into valid stats. */
export function normalizeMine(raw) {
  const out = emptyMine();
  if (!raw || typeof raw !== 'object') return out;
  out.rev = Number.isSafeInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  out.since = Number.isFinite(raw.since) && raw.since > 0 ? raw.since : null;
  for (const [k, v] of Object.entries(raw.days && typeof raw.days === 'object' ? raw.days : {})) if (DAY_RE.test(k)) out.days[k] = normalizeDay(v);
  out.counted = (Array.isArray(raw.counted) ? raw.counted : []).filter((k) => typeof k === 'string' && /^[a-z0-9]{1,10}\/\d{1,16}$/.test(k)).slice(-MAX_COUNTED);
  return out;
}

/** Counts not yet stored: { days: { day: { counter: n, boards } }, counted: [] }. */
export const emptyDelta = () => ({ days: {}, counted: [], since: null });

export const deltaEmpty = (d) => !d || (!Object.keys(d.days).length && !d.counted.length && !d.since);

/** Adds `n` to a counter of `day` in a delta (and to the board's, for time
 *  and threads). Changes `delta` in place and returns it. */
export function bump(delta, day, key, n = 1, board = null) {
  if (!COUNTERS.includes(key) || !isCount(n) || n === 0 || !DAY_RE.test(day)) return delta;
  const d = (delta.days[day] ||= { boards: {} });
  d[key] = (d[key] || 0) + n;
  if (board && BOARD_RE.test(board) && (key === 'time' || key === 'threads')) {
    const b = (d.boards[board] ||= { time: 0, threads: 0 });
    b[key] += n;
  }
  return delta;
}

/** Two deltas as one (a new object): counts added, keys joined. */
export function mergeDeltas(a, b) {
  const out = emptyDelta();
  for (const x of [a, b]) {
    if (!x) continue;
    for (const [day, add] of Object.entries(x.days || {})) {
      for (const k of COUNTERS) if (add[k]) bump(out, day, k, add[k]);
      for (const [board, v] of Object.entries(add.boards || {})) {
        const d = (out.days[day] ||= { boards: {} });
        const cur = (d.boards[board] ||= { time: 0, threads: 0 });
        cur.time += v.time || 0;
        cur.threads += v.threads || 0;
      }
    }
    for (const k of x.counted || []) if (!out.counted.includes(k)) out.counted.push(k);
    out.since ||= x.since || null;
  }
  return out;
}

/** Applies a delta to stored stats (a new object), then keeps 90 days. */
export function applyDelta(mine, delta, now) {
  const out = { ...mine, days: { ...mine.days }, counted: mine.counted.slice() };
  if (!out.since && delta.since) out.since = delta.since;
  for (const [day, add] of Object.entries(delta.days)) {
    const d = normalizeDay(out.days[day]);
    for (const k of COUNTERS) if (add[k]) d[k] += k === 'time' ? Math.round(add[k]) : add[k];
    for (const [b, v] of Object.entries(add.boards || {})) {
      const cur = d.boards[b] || { time: 0, threads: 0 };
      d.boards[b] = { time: cur.time + Math.round(v.time || 0), threads: cur.threads + (v.threads || 0) };
    }
    out.days[day] = d;
  }
  const have = new Set(out.counted);
  for (const k of delta.counted) if (!have.has(k)) out.counted.push(k), have.add(k);
  return pruneMine(out, now);
}

/** Drops days older than 90 (and any dated after tomorrow: a clock that
 *  was wrong), keeps each day's busiest boards and the newest counted keys. */
export function pruneMine(mine, now) {
  const keep = new Set(lastDays(now + 86_400_000, MY_STATS_DAYS + 1));
  const days = {};
  for (const [k, d] of Object.entries(mine.days)) {
    if (!keep.has(k)) continue;
    const boards = Object.entries(d.boards || {})
      .sort((a, b) => b[1].time - a[1].time || b[1].threads - a[1].threads)
      .slice(0, MAX_BOARDS_PER_DAY);
    days[k] = { ...d, boards: Object.fromEntries(boards) };
  }
  return { ...mine, days, counted: mine.counted.slice(-MAX_COUNTED) };
}

/** Whether a reply to you should count: not counted before, and made after
 *  counting was turned on (`since`, ms; post times are in seconds). */
export function replyCounts(mine, delta, board, no, time, since) {
  const key = `${board}/${no}`;
  if (!since || !Number.isFinite(time) || time * 1000 < since) return false;
  return !mine.counted.includes(key) && !delta.counted.includes(key);
}

/** Totals of the last `days` days (today included). */
export function totals(mine, now, days) {
  const out = Object.fromEntries(COUNTERS.map((k) => [k, 0]));
  for (const day of lastDays(now, days)) {
    const d = mine.days[day];
    if (d) for (const k of COUNTERS) out[k] += d[k] || 0;
  }
  return out;
}

/** One counter per day over the last `days` days: [{ day, value }], oldest first. */
export const dailySeries = (mine, now, days, key) => lastDays(now, days).map((day) => ({ day, value: mine.days[day]?.[key] || 0 }));

/** The boards with the most time over the last `days` days. */
export function topBoards(mine, now, days, n = 5) {
  const sum = new Map();
  for (const day of lastDays(now, days)) {
    for (const [b, v] of Object.entries(mine.days[day]?.boards || {})) {
      const cur = sum.get(b) || { board: b, time: 0, threads: 0 };
      cur.time += v.time;
      cur.threads += v.threads;
      sum.set(b, cur);
    }
  }
  return [...sum.values()].sort((a, b) => b.time - a.time || b.threads - a.threads || (a.board < b.board ? -1 : 1)).slice(0, n);
}

/** Bars for a w×h chart of a daily series: [{ x, y, w, h, day, value }];
 *  a day with nothing still gets a 1px bar, so the days stay readable. */
export function bars(series, w, h, gap = 2) {
  const max = Math.max(1, ...series.map((s) => s.value));
  const bw = series.length ? (w - gap * (series.length - 1)) / series.length : 0;
  const r = (n) => Math.round(n * 10) / 10;
  return series.map((s, i) => {
    const bh = s.value > 0 ? Math.max(2, (s.value / max) * h) : 1;
    return { x: r(i * (bw + gap)), y: r(h - bh), w: r(Math.max(1, bw)), h: r(bh), day: s.day, value: s.value };
  });
}

/** "2 h 05 min", "12 min", "40 s". */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${two(m % 60)} min`;
}
