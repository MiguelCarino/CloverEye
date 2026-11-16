// Tags for lurking: a named list of words that finds threads. A board's own
// tag looks in that board's catalog; a universal tag looks in every active
// board (the favourites, and boards open in a pane) at once. A tag can also
// look in the library (opt-in). No DOM.
//
// A tag: { id, name, terms: [string], board ('' = universal), library,
//   mode ('show': pressed, only its threads show; 'hide': while on, what it
//   finds is hidden, in catalogs and in threads), on (a hide tag at work),
//   whole (whole words only) }
// A term is a word or phrase (any of them matches), "-word" leaves out what
// has it, and /pattern/ is a regular expression.

export const MAX_TAGS = 100;
export const MAX_TERMS = 30;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Terms from what was typed: split at commas and new lines. */
export function parseTerms(text) {
  return [...new Set(String(text || '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean))]
    .map((t) => t.slice(0, 80))
    .slice(0, MAX_TERMS);
}

export function normalizeTag(raw) {
  if (!isObj(raw)) return null;
  const name = String(raw.name || '').trim().slice(0, 40);
  const terms = parseTerms(Array.isArray(raw.terms) ? raw.terms.join(',') : raw.terms);
  // flags it finds (a country's code, or a board flag's name): on /int/,
  // /pol/, /bant/... a tag can be only flags
  const flags = [...new Set((Array.isArray(raw.flags) ? raw.flags : []).filter((f) => typeof f === 'string').map((f) => f.trim().slice(0, 60)).filter(Boolean))].slice(0, 200);
  if (!name || (!terms.length && !flags.length)) return null;
  return {
    id: typeof raw.id === 'string' && /^[a-z0-9-]{1,40}$/.test(raw.id) && raw.id !== 'undefined' ? raw.id : `t${Math.abs(hash(name + terms.join() + flags.join())).toString(36)}`,
    name,
    terms,
    flags,
    board: typeof raw.board === 'string' && /^[a-z0-9]{1,10}$/.test(raw.board) ? raw.board : '',
    library: raw.library === true,
    mode: raw.mode === 'hide' ? 'hide' : 'show',
    on: raw.on !== false,
    whole: raw.whole === true,
  };
}

function hash(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return x;
}

export function normalizeTags(raw) {
  const out = [];
  const ids = new Set();
  for (const t of Array.isArray(raw) ? raw : []) {
    const n = normalizeTag(t);
    if (!n) continue;
    while (ids.has(n.id)) n.id = `${n.id}-2`.slice(0, 40);
    ids.add(n.id);
    out.push(n);
  }
  return out.slice(0, MAX_TAGS);
}

/** The tags that show on a board's catalog: its own, then the universal ones. */
export function tagsFor(tags, board) {
  return [...tags.filter((t) => t.board === board), ...tags.filter((t) => !t.board)];
}

const regexCache = new Map();
function regexOf(term) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(term);
  if (!m) return null;
  if (!regexCache.has(term)) {
    let re = false;
    try {
      re = new RegExp(m[1], m[2].replace(/[^imsu]/g, '') || 'i');
    } catch {
      re = false;
    }
    regexCache.set(term, re);
  }
  return regexCache.get(term);
}

/** Whether a text matches a tag: one of its words (or patterns) is in it,
 *  and none of its "-words" is. Case and accents do not matter. With
 *  `whole`, a word counts only on its own ("art" is not in "start"). */
export function matchesText(tag, text) {
  return textState(tag, text) === 'hit';
}

/** 'hit' (a word is in it), 'out' (a -word is: left out whatever else
 *  matches) or 'miss'. */
function textState(tag, text) {
  const hay = fold(text);
  const has = tag.whole ? (w) => wholeIn(hay, fold(w)) : (w) => hay.includes(fold(w));
  let hit = false;
  for (const term of tag.terms) {
    const re = regexOf(term);
    if (re === false) continue; // a broken pattern finds nothing
    if (re) {
      if (re.test(text)) hit = true;
      continue;
    }
    if (term.startsWith('-') && term.length > 1) {
      if (has(term.slice(1))) return 'out';
      continue;
    }
    if (has(term)) hit = true;
  }
  return hit ? 'hit' : 'miss';
}

/** A post's flag, every way it can be named: country code and name, board
 *  flag code and name (folded). */
export function postFlags(p) {
  return [p?.country, p?.country_name, p?.board_flag, p?.flag_name].filter(Boolean).map((f) => fold(String(f).replace(/&amp;/g, '&')));
}

/** Whether a post (or catalog thread) matches a tag: one of its words, or
 *  one of its flags, and none of its -words. */
export function matchesPost(tag, p, plain = (x) => x) {
  const state = textState(tag, threadText(p, plain));
  if (state === 'out') return false;
  if (state === 'hit') return true;
  if (!tag.flags?.length) return false;
  const have = postFlags(p);
  return tag.flags.some((f) => have.includes(fold(f)));
}

const isWordChar = (c) => Boolean(c) && /[\p{L}\p{N}_]/u.test(c);

/** `w` in `hay` with no letter or digit right before or after it. */
function wholeIn(hay, w) {
  if (!w) return false;
  for (let i = hay.indexOf(w); i >= 0; i = hay.indexOf(w, i + 1)) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + w.length])) return true;
  }
  return false;
}

const fold = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** A catalog thread's words: subject, comment (plain) and file name. */
export function threadText(t, plain = (s) => s) {
  return `${plain(t.sub || '')}\n${plain(t.com || '')}\n${t.filename || ''}`;
}

export const threadMatches = (tag, t, plain) => matchesPost(tag, t, plain);

/** A library file's words (library-model entry). */
export const libraryMatches = (tag, e) => matchesText(tag, `${e.name}\n${e.tags.join(' ')}\n${e.sub}\n${e.text}\n${e.from || ''}`);

/** The tags matching each thread: Map no → [tag], for the labels. */
export function labelThreads(tags, threads, plain) {
  const out = new Map();
  for (const t of threads || []) {
    const hits = tags.filter((g) => threadMatches(g, t, plain));
    if (hits.length) out.set(t.no, hits);
  }
  return out;
}

/** The hide tags at work on a board: its own and the universal ones, on. */
export const hidingOn = (tags, board) => tagsFor(tags || [], board).filter((t) => t.mode === 'hide' && t.on);

/** The posts (or catalog threads) the board's hide tags hide: a Set of No. */
export function hiddenByTags(tags, board, posts, plain) {
  return new Set(hiddenByTagsBy(tags, board, posts, plain).keys());
}

/** hiddenByTags(), with the tag that hides each: Map No. → tag id. */
export function hiddenByTagsBy(tags, board, posts, plain) {
  const on = hidingOn(tags, board);
  const out = new Map();
  if (!on.length) return out;
  for (const p of posts || []) {
    const t = on.find((x) => matchesPost(x, p, plain));
    if (t) out.set(p.no, t.id);
  }
  return out;
}

/** The boards a universal tag looks in: favourites, then boards open in a
 *  pane, each once. */
export function activeBoards(favourites, open) {
  return [...new Set([...(favourites || []), ...(open || [])])].filter((b) => /^[a-z0-9]{1,10}$/.test(b));
}

/** A universal tag's finds over several catalogs: [{ board, thread }],
 *  the most replied first. */
export function findAcross(tag, catalogs, plain) {
  const out = [];
  for (const [board, threads] of catalogs) for (const t of threads || []) if (threadMatches(tag, t, plain)) out.push({ board, thread: t });
  return out.sort((a, b) => (b.thread.replies || 0) - (a.thread.replies || 0));
}

// ------------------------------------------------------------- stats

// What each tag found, day by day: { [tagId]: { [day 'YYYY-MM-DD']:
// ['board/no', ...] } }, kept 30 days, recorded as catalogs load
// (shell.js), so the Stats page can say how often a tag finds something.

export const HISTORY_DAYS = 30;
const MAX_PER_DAY = 2000;

/** The local day of a time: 'YYYY-MM-DD'. */
export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeHistory(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [id, days] of Object.entries(raw)) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !isObj(days)) continue;
    const keep = {};
    for (const [day, list] of Object.entries(days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Array.isArray(list)) keep[day] = list.filter((x) => typeof x === 'string' && /^[a-z0-9]{1,10}\/\d{1,12}$/.test(x)).slice(0, MAX_PER_DAY);
    }
    out[id] = keep;
  }
  return out;
}

/** Adds what tags found in a board's catalog today; old days drop off and
 *  tags no longer there go. Returns a new history. */
export function recordFinds(history, tags, board, threads, plain, now = Date.now()) {
  const today = dayKey(now);
  const oldest = dayKey(now - (HISTORY_DAYS - 1) * 86400000);
  const ids = new Set(tags.map((t) => t.id));
  const out = {};
  for (const [id, days] of Object.entries(history || {})) {
    if (!ids.has(id)) continue;
    out[id] = Object.fromEntries(Object.entries(days).filter(([d]) => d >= oldest));
  }
  for (const t of tagsFor(tags, board)) {
    const found = (threads || []).filter((th) => matchesPost(t, th, plain)).map((th) => `${board}/${th.no}`);
    if (!found.length) continue;
    const days = (out[t.id] ||= {});
    days[today] = [...new Set([...(days[today] || []), ...found])].slice(0, MAX_PER_DAY);
  }
  return out;
}

/** A tag's threads found per day, the last `n` days, oldest first:
 *  [{ day, n }], and how many different threads in all of them. */
export function dailyFinds(history, id, n = 14, now = Date.now()) {
  const days = history?.[id] || {};
  const out = [];
  const all = new Set();
  for (let i = n - 1; i >= 0; i--) {
    const day = dayKey(now - i * 86400000);
    const list = days[day] || [];
    list.forEach((x) => all.add(x));
    out.push({ day, n: list.length });
  }
  return { days: out, total: all.size };
}
