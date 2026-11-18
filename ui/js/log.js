// The UI's logger: every feature writes its diagnostics lines here, and
// they go to the app's log (src-tauri/src/diag.rs, Settings › Diagnostics)
// in batches.
//
//   import { log } from './log.js';
//   log.info('tabs', 'tab.opened', { kind: 'thread', board: 'g', tabs: 4 });
//   log.debug('thread', 'redraw', { posts: 312, ms: 4 });
//   const end = log.time('catalog', 'catalog.render');
//   ... end({ threads: 150 });            // adds ms, at debug
//
// Levels: error (something failed that the person will notice), warn
// (something went wrong and was handled), info (one line per thing the
// person did or a feature finished: rare, never per poll, frame or post),
// debug (step detail and timings: only made with Detailed logs on, and
// cheap to call when it is off).
//
// Messages are short event names ('post.sent', 'pasta.saved'), never
// sentences to translate. Fields are numbers, true/false and short words:
// counts, sizes, ids, board codes, thread and post numbers, durations,
// status codes, setting names. Never what people write or look for: post
// text, names, subjects, file names, tags and filter terms, pasta text,
// prompts and answers, captcha anything, cookies, passwords. Fields named
// like that (text, com, name, title, file, terms, query, prompt, answer...
// and names ending in them: replyText, fileName) are dropped here and again
// in the app; addresses lose their query and fragment.

/** The levels, most serious first. */
export const LEVELS = Object.freeze(['error', 'warn', 'info', 'debug']);

/** The areas in use (any short lower-case word works; these keep the log's
 *  filter tidy). */
export const AREAS = Object.freeze([
  'app', // start-up, windows, keyboard
  'net', // the request queue (Rust)
  'catalog',
  'thread',
  'tabs', // tabs, panes, columns
  'post', // compose, the post helper
  'captcha',
  'pasta',
  'library',
  'offline',
  'files', // saving and downloading files
  'gallery',
  'filters', // filters, hiding, tags
  'watch', // watched threads, unread
  'stats',
  'links',
  'settings',
  'ai', // Ask
  'ui', // anything else on the page
]);

/** Field names that carry what people write or look for. */
export const CONTENT_KEYS = Object.freeze([
  'text', 'com', 'comment', 'body', 'content', 'name', 'names', 'sub', 'subject', 'title', 'prompt', 'answer', 'reply', 'file', 'filename',
  'filenames', 'path', 'dir', 'folder', 'terms', 'term', 'query', 'q', 'search', 'pattern', 'patterns', 'tag', 'tags', 'email', 'options',
  'trip', 'tripcode', 'captcha', 'token', 'cookie', 'password', 'pass', 'pwd', 'pasta', 'message',
]);

const MAX_FIELDS = 16;
const MAX_VALUE = 120;
const MAX_MSG = 200;
const KEY_RE = /^[A-Za-z0-9_]{1,32}$/;
const AREA_RE = /^[a-z0-9-]{1,16}$/;

/** Whether a field name carries content: one of CONTENT_KEYS, or ending in
 *  one of the longer ones ("replyText", "fileName"). */
export function contentKey(k) {
  const low = String(k).toLowerCase();
  return CONTENT_KEYS.some((c) => low === c || (c.length >= 4 && low.endsWith(c)));
}

/** An address without its query and fragment. */
const cutQuery = (s) => s.replace(/([?#]).*$/s, (_, c) => (c === '?' ? '?…' : ''));

/**
 * The fields as they may be logged: plain names that are not content
 * names, numbers, true/false and short strings (cut; addresses lose their
 * query). Anything else is left out. Null when nothing is left.
 */
export function sanitizeFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (n >= MAX_FIELDS) break;
    if (!KEY_RE.test(k) || contentKey(k) || k === 'win') continue;
    let val;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      val = Math.round(v * 1000) / 1000;
    } else if (typeof v === 'boolean') val = v;
    else if (typeof v === 'string' || v instanceof Error) {
      let s = (v instanceof Error ? v.message : v).replace(/[\u0000-\u001f\u007f]+/g, ' ');
      if (k === 'url' || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\?[^\s]*=/.test(s)) s = cutQuery(s);
      val = s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE - 1)}…` : s;
    } else continue;
    out[k] = val;
    n += 1;
  }
  return n ? out : null;
}

const monoNow = () => globalThis.performance?.now?.() ?? Date.now();

/**
 * A logger. The app has one (`log` below); tests make their own with a
 * fake clock and timers.
 * @param {object} [o]
 * @param {() => number} [o.now]         wall clock in ms (the rate cap)
 * @param {() => number} [o.mono]        monotonic ms (log.time)
 * @param {Function} [o.setTimer]       setTimeout
 * @param {Function} [o.clearTimer]     clearTimeout
 * @param {number} [o.flushMs]          batch window (500 ms)
 * @param {number} [o.maxBatch]         lines that send a batch at once (50)
 * @param {number} [o.perAreaPerMin]   debug and info lines one area may log a minute (200)
 * @param {number} [o.perAreaWarnPerMin] warnings and errors one area may log a minute (60):
 *   a budget of their own, so a busy minute of debug lines never drops them
 */
export function createLogger({
  now = () => Date.now(),
  mono = monoNow,
  setTimer = (f, ms) => globalThis.setTimeout(f, ms),
  clearTimer = (t) => globalThis.clearTimeout(t),
  flushMs = 500,
  maxBatch = 50,
  perAreaPerMin = 200,
  perAreaWarnPerMin = 60,
} = {}) {
  let sink = null;
  // Detailed logs: the setting (Settings › Diagnostics, settings.json), or
  // the app's environment switch (CLOVEREYE_LOG_DETAIL=1), learnt from its
  // answer to a batch while the setting is off. Settings saves change only
  // the first, so they never turn the second off.
  let settingOn = false;
  let envOn = false;
  let detailed = false;
  const sync = () => (detailed = settingOn || envOn);
  let queue = [];
  let timer = null;
  const recent = []; // the last lines, for tests and the preview
  const rates = new Map(); // area → { start, n, dropped }

  function flush() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    for (const [area, r] of rates) if (r.dropped && now() - r.start >= 60_000) noteDropped(area, r);
    if (!queue.length || !sink?.logBatch) return;
    const lines = queue;
    queue = [];
    try {
      Promise.resolve(sink.logBatch(lines))
        .then((on) => {
          // with the setting on the answer says nothing about the
          // environment (and may predate the setting reaching the app)
          if (typeof on === 'boolean' && !settingOn) {
            envOn = on;
            sync();
          }
        })
        .catch(() => {});
    } catch {
      /* the log never breaks the page */
    }
  }

  function noteDropped(area, r) {
    const n = r.dropped;
    r.dropped = 0;
    r.start = now();
    r.n = 0;
    r.w = 1;
    push({ level: 'warn', area, msg: 'log.dropped', fields: { n, perMin: perAreaPerMin } });
  }

  function push(line) {
    recent.push(line);
    if (recent.length > 1000) recent.splice(0, recent.length - 1000);
    queue.push(line);
    // before a bridge is there, keep the newest 500
    if (!sink && queue.length > 500) queue.splice(0, queue.length - 500);
    if (sink && queue.length >= maxBatch) flush();
    else if (sink && timer === null) timer = setTimer(flush, flushMs);
  }

  function write(level, area, msg, fields) {
    if (level === 'debug' && !detailed) return;
    const a = typeof area === 'string' && AREA_RE.test(area) ? area : 'ui';
    let r = rates.get(a);
    const t = now();
    if (!r) rates.set(a, (r = { start: t, n: 0, w: 0, dropped: 0 }));
    if (t - r.start >= 60_000) {
      if (r.dropped) noteDropped(a, r);
      else Object.assign(r, { start: t, n: 0, w: 0 });
    }
    const serious = level === 'error' || level === 'warn';
    if (serious ? r.w >= perAreaWarnPerMin : r.n >= perAreaPerMin) {
      r.dropped += 1;
      return;
    }
    if (serious) r.w += 1;
    else r.n += 1;
    const m = String(msg ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_MSG) || 'event';
    const line = { level, area: a, msg: m };
    const f = sanitizeFields(fields);
    if (f) line.fields = f;
    push(line);
  }

  const logger = {
    error: (area, msg, fields) => write('error', area, msg, fields),
    warn: (area, msg, fields) => write('warn', area, msg, fields),
    info: (area, msg, fields) => write('info', area, msg, fields),
    debug: (area, msg, fields) => {
      if (detailed) write('debug', area, msg, fields);
    },
    /** Starts a timer: the function it returns logs `msg` with `ms` (and
     *  any fields) at `level` (debug unless named). */
    time(area, msg, level = 'debug') {
      if (level === 'debug' && !detailed) return () => 0;
      const t0 = mono();
      return (fields = {}, lv = level) => {
        const ms = Math.round(mono() - t0);
        write(lv, area, msg, { ...fields, ms });
        return ms;
      };
    },
    /** Whether a level is written now (debug only with Detailed logs). */
    enabled: (level) => level !== 'debug' || detailed,
    isDetailed: () => detailed,
    /** The Detailed logs setting: debug lines on or off (unless the app's
     *  environment switch keeps them on); with `tell`, the app too
     *  (Settings › Diagnostics' switch; settings.json carries it to the
     *  other windows). */
    setDetailed(on, { tell = false } = {}) {
      settingOn = Boolean(on);
      sync();
      if (tell) {
        try {
          Promise.resolve(sink?.setLogDetail?.(detailed)).catch(() => {});
        } catch {
          /* the log never breaks the page */
        }
      }
    },
    /** Where batches go: { logBatch(lines) → Promise<detailed?>, setLogDetail(on) }. */
    setSink(s) {
      sink = s || null;
      if (sink && queue.length) timer ??= setTimer(flush, flushMs);
    },
    flush,
    /** The lines not sent yet. */
    pending: () => queue.slice(),
    /** The last lines logged (at most 1000), newest last. */
    recent: () => recent.slice(),
  };
  return logger;
}

/** The app's logger. */
export const log = createLogger();

let hooked = false;

/** Hands the app's logger the bridge (bridge.js does this). Lines logged
 *  before go out with the first batch; the page sends what is left when it
 *  is hidden or closed. */
export function connectLog(bridge) {
  log.setSink(bridge);
  if (!hooked && typeof globalThis.addEventListener === 'function') {
    hooked = true;
    globalThis.addEventListener('pagehide', () => log.flush());
  }
}

/** The Detailed logs switch for this page (and, with tell, the app). */
export function setDetailed(on, opts) {
  log.setDetailed(on, opts);
}

/** Reads Detailed logs from a settings object (bridge.js, on load, save and
 *  another window's save). */
export function detailFromSettings(s) {
  if (s && typeof s === 'object') log.setDetailed(s.diagnostics?.detailed === true);
}

/** A line as the app writes it, for the browser preview's report. */
export function formatLine(line, at = new Date()) {
  const stamp = at.toISOString().replace('T', ' ').replace('Z', '');
  const level = line.level.toUpperCase().padEnd(5);
  const fields = Object.entries(line.fields || {})
    .map(([k, v]) => {
      const s = String(v);
      return `${k}=${/^[^\s\x22\\=]+$/.test(s) ? s : JSON.stringify(s)}`;
    })
    .join(' ');
  return `${stamp} ${level} ${line.area}: ${line.msg}${fields ? ` ${fields}` : ''}`;
}
