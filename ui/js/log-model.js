// What the features put in their diagnostics lines (log.js writes them):
// short kinds and counts worked out from errors, views, post results and
// settings, never what anyone wrote. Pure, so tests/log-model.test.mjs
// checks it without a page.

/** Error codes the bridge and the app use as messages ('not-found'...). */
const CODE_RE = /^[a-z][a-z0-9-]{1,31}$/;
/** Error names worth keeping (the generic Error and TypeError say little). */
const NAMED = new Set(['AbortError', 'QuotaExceededError', 'NotAllowedError', 'SecurityError', 'NotFoundError', 'TimeoutError', 'NetworkError', 'DataError', 'InvalidStateError', 'NotReadableError', 'EncodingError', 'SyntaxError']);

/**
 * A short kind for an error, safe to log: the app's own codes as they are
 * ('not-found', 'check-needed'), a few DOM error names, 'http-404' for an
 * HTTP status, else a word for what the text is about. Never the text
 * itself (a system error can name a file or a folder).
 */
export function errorKind(e) {
  if (e === null || e === undefined) return 'none';
  const name = typeof e === 'object' ? String(e.name || '') : '';
  if (NAMED.has(name)) return name;
  const msg = String(typeof e === 'object' ? (e.message ?? '') : e).trim();
  if (CODE_RE.test(msg)) return msg;
  if (/\bnext try in \d+ s\b/.test(msg)) return 'waiting';
  const http = /\bHTTP\s*(\d{3})\b/i.exec(msg) || /\bstatus\s*(\d{3})\b/i.exec(msg);
  if (http) return `http-${http[1]}`;
  if (/timed?\s*out|timeout/i.test(msg)) return 'timeout';
  if (/refused|unreachable|network|connect|dns|resolve|offline|fetch/i.test(msg)) return 'network';
  if (/quota|too (large|big)|full|limit/i.test(msg)) return 'too-large';
  if (/permission|denied|not allowed|forbidden/i.test(msg)) return 'denied';
  if (/json|parse|unexpected (token|end)|shape|malformed/i.test(msg)) return 'parse';
  if (/empty/i.test(msg)) return 'empty';
  if (/not found|no such|missing|does not exist|isn.t there/i.test(msg)) return 'not-found';
  if (/cancel|abort|stopp/i.test(msg)) return 'cancelled';
  if (name === 'TypeError' || name === 'RangeError' || name === 'ReferenceError') return name;
  return 'other';
}

/** A view as log fields: its kind, and its board and thread when it has
 *  them (never a catalog search or a tag's terms). */
export function viewFields(v) {
  if (!v || typeof v !== 'object') return { view: 'none' };
  const out = { view: String(v.kind || 'none') };
  if (typeof v.board === 'string' && /^[a-z0-9]{1,10}$/.test(v.board)) out.board = v.board;
  if ((v.kind === 'thread' || v.kind === 'offline') && Number.isFinite(Number(v.no))) out.thread = Number(v.no);
  if (v.layout === 'columns' || v.layout === 'list') out.layout = v.layout;
  return out;
}

/**
 * What became of a post (compose-model.js parsePostResponse): 'posted',
 * 'check' (the site's browser check), or a kind for the site's error
 * message: captcha, cooldown, duplicate, banned, file, too-long, closed,
 * http (no answer said either way), else site-error. Never the message.
 */
export function postResultKind(r) {
  if (!r || typeof r !== 'object') return 'none';
  if (r.ok) return 'posted';
  if (r.check) return 'check';
  const m = String(r.message || '');
  if (/browser check/i.test(m)) return 'check';
  if (/captcha|verification/i.test(m)) return 'captcha';
  if (/flood|wait|too (fast|soon)|cooldown|seconds? before/i.test(m)) return 'cooldown';
  if (/duplicate|already (been )?posted/i.test(m)) return 'duplicate';
  if (/\bbann?ed\b|\bban\b|warned/i.test(m)) return 'banned';
  if (/\b(file|image|upload|md5|dimensions?|resolution|filesize)\b/i.test(m)) return 'file';
  if (/too long|characters|max(imum)? (length|lines)/i.test(m)) return 'too-long';
  if (/closed|archived|locked|thread.*(not|no longer) (exist|found)/i.test(m)) return 'closed';
  if (/without saying whether|\(HTTP \d{3}\)/i.test(m)) return 'http';
  return 'site-error';
}

/** A file's kind for the log: the part of its type after the slash, or
 *  its extension (never its name). */
export function fileKind(file) {
  const type = String(file?.type || '');
  const m = /^[a-z]+\/([a-z0-9.+-]{1,20})$/i.exec(type);
  if (m) return m[1].toLowerCase();
  const ext = /\.([a-z0-9]{1,5})$/i.exec(String(file?.name || ''));
  return ext ? ext[1].toLowerCase() : 'unknown';
}

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const IDENT = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** JSON with sorted keys: what tells two values apart. */
function sig(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : sig(x))).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${sig(v[k])}`)
    .join(',')}}`;
}

/**
 * The setting names that differ between two settings objects, sorted: a
 * top-level name, or "display.workMode" for a plain object whose own keys
 * are names (one keyed by threads, "g/123", stays its top-level name).
 * Names only, never values.
 */
export function changedKeys(a, b) {
  const x = plain(a) ? a : {};
  const y = plain(b) ? b : {};
  const out = [];
  for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
    if (x[k] === y[k]) continue;
    const p = x[k];
    const q = y[k];
    if (plain(p) && plain(q)) {
      const subs = [...new Set([...Object.keys(p), ...Object.keys(q)])];
      if (subs.length <= 40 && subs.every((s) => IDENT.test(s))) {
        const diff = subs.filter((s) => p[s] !== q[s] && sig(p[s]) !== sig(q[s])).sort();
        for (const s of diff) out.push(`${k}.${s}`);
        continue;
      }
    }
    if (sig(p) !== sig(q)) out.push(k);
  }
  return out;
}

/** Whether two settings objects differ only in `diagnostics` (the Detailed
 *  logs switch): nothing on screen depends on it, so another window's
 *  change redraws nothing (log.js takes it through the bridge). */
export function onlyDiagnosticsDiffer(a, b) {
  return changedKeys(a, b).every((k) => k === 'diagnostics' || k.startsWith('diagnostics.'));
}

/** changedKeys as log fields: { keys: "a,b.c", changed: n }. */
export function keysFields(list) {
  const keys = list.join(',');
  return { keys: keys.length > 118 ? `${keys.slice(0, 117)}…` : keys, changed: list.length };
}

/**
 * Counts that add up between lines: redraws, polls. `add(name, n)` counts;
 * `take()` gives the counts and starts again once `everyMs` has passed
 * since the last take (null before then, or when nothing was counted).
 */
export function createTally({ now = () => Date.now(), everyMs = 60_000 } = {}) {
  let counts = {};
  let any = false;
  let since = now();
  return {
    add(name, n = 1) {
      counts[name] = (counts[name] || 0) + n;
      any = true;
    },
    take(force = false) {
      const t = now();
      if (!any || (!force && t - since < everyMs)) return null;
      const out = { ...counts, span_s: Math.round((t - since) / 1000) };
      counts = {};
      any = false;
      since = t;
      return out;
    },
    peek: () => ({ ...counts }),
  };
}

/**
 * A gate for the page errors app.js sends to the report (bridge.noteError):
 * the same line once a minute, and at most `perMin` lines a minute, so an
 * error thrown on every frame never fills the log. Returns the line to
 * send, or null.
 */
export function createErrorGate({ perMin = 20, now = () => Date.now() } = {}) {
  let start = -Infinity;
  let n = 0;
  const seen = new Set();
  return (line) => {
    const t = now();
    if (t - start >= 60_000) {
      start = t;
      n = 0;
      seen.clear();
    }
    const l = String(line).slice(0, 400);
    if (seen.has(l) || n >= perMin) return null;
    seen.add(l);
    n += 1;
    return l;
  };
}
