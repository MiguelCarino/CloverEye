// Filters (SCOPE §3.2, C2): hide or highlight threads and posts whose
// comment, subject, name, tripcode, poster ID, file name or file MD5
// matches plain text or a regular expression, on some boards or all of them.
// Also posts hidden by hand and replies to (You). No DOM, so it runs under
// `node --test`. Nothing here ever throws on a bad pattern: a regular
// expression that does not compile is reported and skipped.

import { commentText, decodeEntities, quotedPosts } from './render.js';

/** What a filter can look at. `exact`: plain text must equal the whole
 *  value (names, IDs, hashes); otherwise it may appear anywhere. */
export const FILTER_FIELDS = Object.freeze([
  { value: 'com', label: 'Comment', exact: false },
  { value: 'sub', label: 'Subject', exact: false },
  { value: 'name', label: 'Name', exact: true },
  { value: 'trip', label: 'Tripcode', exact: true },
  { value: 'id', label: 'Poster ID', exact: true },
  { value: 'filename', label: 'File name', exact: false },
  { value: 'md5', label: 'File MD5', exact: true },
  // a country flag or a board's own flag: its code (NZ) or its name
  { value: 'flag', label: 'Flag', exact: true },
  { value: 'capcode', label: 'Capcode (mod, admin…)', exact: true },
  { value: 'ext', label: 'File type (webm, gif…)', exact: true },
  // only some boards send these
  { value: 'pass', label: '4chan Pass since (year)', exact: true },
  { value: 'ftag', label: '/f/ category (Loop, Game…)', exact: true },
]);

/** Hide leaves a line to show the post this time; Discard takes it away
 *  for good (nothing is drawn, nothing counted); Highlight marks it. */
export const FILTER_ACTIONS = Object.freeze([
  { value: 'hide', label: 'Hide' },
  { value: 'discard', label: 'Discard' },
  { value: 'highlight', label: 'Highlight' },
]);
const ACTIONS = new Set(FILTER_ACTIONS.map((a) => a.value));
const RANK = { discard: 3, hide: 2, highlight: 1 };

export const MAX_FILTERS = 500;
export const MAX_PATTERN = 500;
export const MAX_FILTER_BOARDS = 50;
export const MAX_HIDDEN_POSTS = 1000;
/** The filter list's share of the settings file (which the app refuses to
 *  store past 256 KiB): about this many bytes as saved, pretty-printed. */
export const MAX_FILTERS_BYTES = 96 * 1024;

const encoder = new TextEncoder();
/** Bytes one filter takes in the saved (pretty-printed) settings. */
export const filterBytes = (f) => encoder.encode(JSON.stringify(f, null, 2)).length + 2;
/** Bytes a filter list takes in the saved settings (about). */
export const filtersBytes = (list) => (Array.isArray(list) ? list.reduce((n, f) => n + filterBytes(f), 0) : 0);

const FIELDS = new Map(FILTER_FIELDS.map((f) => [f.value, f]));
const BOARD_RE = /^[a-z0-9]{1,10}$/;
const ID_RE = /^[a-z0-9]{1,24}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBoard = (b) => typeof b === 'string' && BOARD_RE.test(b);

export const fieldLabel = (field) => FIELDS.get(field)?.label ?? String(field);

let idSeq = 0;
/** A short id for a new filter. */
export function newFilterId(now = Date.now()) {
  idSeq = (idSeq + 1) % 1296;
  return `f${now.toString(36)}${idSeq.toString(36).padStart(2, '0')}`.slice(0, 24);
}

/** "g, /v/ diy" → ['g', 'v', 'diy']; `bad` lists what is not a board code. */
export function parseBoards(text) {
  const boards = [];
  const bad = [];
  for (const raw of String(text ?? '').split(/[\s,]+/)) {
    const code = raw.replace(/^\/+|\/+$/g, '').toLowerCase();
    if (!code) continue;
    if (!isBoard(code)) bad.push(raw);
    else if (!boards.includes(code)) boards.push(code);
  }
  return { boards: boards.slice(0, MAX_FILTER_BOARDS), bad };
}

/** One stored filter, or null if it is not one. Bad regexes are kept (so
 *  they can be fixed in Settings); they just never match. */
export function normalizeFilter(raw) {
  if (!isObj(raw) || !FIELDS.has(raw.field)) return null;
  const pattern = typeof raw.pattern === 'string' ? raw.pattern.slice(0, MAX_PATTERN) : '';
  if (!pattern.trim()) return null;
  let boards = [];
  if (Array.isArray(raw.boards)) boards = [...new Set(raw.boards.filter(isBoard))].slice(0, MAX_FILTER_BOARDS);
  else if (typeof raw.boards === 'string') boards = parseBoards(raw.boards).boards;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newFilterId(),
    field: raw.field,
    pattern,
    regex: raw.regex === true,
    matchCase: raw.matchCase === true,
    boards,
    action: ACTIONS.has(raw.action) ? raw.action : 'hide',
    enabled: raw.enabled !== false,
    // a flag filter made since board flags go by their name (a code always
    // means the country); older ones are fixed by fixBoardFlagFilters
    ...(raw.field === 'flag' && raw.byName === true ? { byName: true } : {}),
  };
}

/** A stored list: valid entries, unique ids, at most MAX_FILTERS and
 *  MAX_FILTERS_BYTES (the first ones are kept). */
export function normalizeFilters(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const ids = new Set();
  let bytes = 0;
  for (const item of list) {
    const f = normalizeFilter(item);
    if (!f) continue;
    while (ids.has(f.id)) f.id = newFilterId();
    bytes += filterBytes(f);
    if (bytes > MAX_FILTERS_BYTES) break;
    ids.add(f.id);
    out.push(f);
    if (out.length >= MAX_FILTERS) break;
  }
  return out;
}

/** The regular expression of a regex filter, or { error }. Never throws. */
export function compileRegex(pattern, matchCase = false) {
  try {
    return { re: new RegExp(String(pattern), matchCase ? '' : 'i') };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** Why a filter (or a draft of one) cannot be used, or '' when it can. */
export function filterProblem({ pattern = '', regex = false, matchCase = false } = {}) {
  const p = String(pattern ?? '');
  if (!p.trim()) return 'Write the text or pattern to match.';
  if (p.length > MAX_PATTERN) return `At most ${MAX_PATTERN} characters.`;
  if (!regex) return '';
  const { re, error } = compileRegex(p, matchCase);
  if (error) return `Not a valid regular expression: ${error}`;
  if (re.test('')) return 'This pattern matches empty text, so it would match every post.';
  return '';
}

/** The text a filter looks at in a post (or a catalog thread). */
export function fieldValue(post, field) {
  if (!post) return '';
  switch (field) {
    case 'com':
      return post.com ? commentText(post.com) : '';
    case 'sub':
      return post.sub ? decodeEntities(post.sub) : '';
    case 'name':
      return post.name ? decodeEntities(post.name) : '';
    case 'trip':
      return post.trip ? String(post.trip) : '';
    case 'id':
      return post.id ? String(post.id) : '';
    case 'filename':
      return post.filename ? `${decodeEntities(post.filename)}${post.ext || ''}` : '';
    case 'md5':
      return post.md5 ? String(post.md5) : '';
    case 'flag':
      // each on its own line; a filter matches any of them whole. A board
      // flag goes by its name only: its code (/pol/'s NZ or TR, /mlp/'s AU)
      // is often a country's too, and a code always means the country.
      return [post.country, post.country_name, post.flag_name].filter(Boolean).map((v) => decodeEntities(String(v))).join('\n');
    case 'capcode':
      return post.capcode ? String(post.capcode) : '';
    case 'ext':
      return post.ext ? String(post.ext).replace(/^\./, '') : '';
    case 'pass':
      return post.since4pass ? String(post.since4pass) : '';
    case 'ftag':
      return post.tag ? decodeEntities(String(post.tag)) : '';
    default:
      return '';
  }
}

function matcher(f) {
  if (f.regex) {
    if (filterProblem(f)) return null;
    const { re } = compileRegex(f.pattern, f.matchCase);
    return (v) => re.test(v);
  }
  const exact = FIELDS.get(f.field)?.exact;
  // MD5s are base64: their case always matters.
  const keepCase = f.matchCase || f.field === 'md5';
  let want = keepCase ? f.pattern.trim() : f.pattern.trim().toLowerCase();
  if (f.field === 'ext') want = want.replace(/^\./, '');
  if (!want) return null;
  return (v) => {
    const have = keepCase ? v.trim() : v.trim().toLowerCase();
    // a value of several lines (a flag's code and name): any line, whole
    return exact ? have.split('\n').some((x) => x.trim() === want) : have.includes(want);
  };
}

/** The filters that apply on `board`, ready to test (switched-off filters,
 *  other boards' filters and bad patterns are left out). */
export function compileFilters(filters, board) {
  const out = [];
  for (const f of Array.isArray(filters) ? filters : []) {
    if (!f || f.enabled === false || !FIELDS.has(f.field)) continue;
    if (f.boards?.length && !f.boards.includes(board)) continue;
    const test = matcher(f);
    if (test) out.push({ id: f.id, field: f.field, action: ACTIONS.has(f.action) ? f.action : 'hide', test });
  }
  return out;
}

/** 'discard', 'hide', 'highlight' or null for one post. Discard wins over
 *  hide, and hide over highlight. */
export function classifyPost(compiled, post) {
  return classifyPostBy(compiled, post).action;
}

/** classifyPost(), and the id of the filter that decided: { action, id }. */
export function classifyPostBy(compiled, post) {
  let result = null;
  let id = '';
  const values = new Map();
  for (const c of compiled) {
    if (result === 'discard' || (result && RANK[c.action] <= RANK[result])) continue;
    if (!values.has(c.field)) values.set(c.field, fieldValue(post, c.field));
    const v = values.get(c.field);
    if (v && c.test(v)) {
      result = c.action;
      id = c.id;
    }
  }
  return { action: result, id };
}

/**
 * Post (or catalog thread) number → 'hidden' (by hand), 'hide' (a filter)
 * or 'highlight'. Unmarked posts are left out.
 */
export function markPosts(posts, compiled, hidden = new Set(), by = null) {
  const marks = new Map();
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p) continue;
    if (hidden.has(p.no)) {
      marks.set(p.no, 'hidden');
      continue;
    }
    const m = compiled.length ? classifyPostBy(compiled, p) : null;
    if (m?.action) {
      marks.set(p.no, m.action);
      // `by`: post No. → the filter's id, to name it (and remove it) later
      if (by) by.set(p.no, m.id);
    }
  }
  return marks;
}

export const isHiddenMark = (m) => m === 'hide' || m === 'hidden' || m === 'discard';
/** Discarded: never drawn, not even as a line, and not counted. */
export const isGoneMark = (m) => m === 'discard';

// ------------------------------------------------------- settings changes

const sameFilter = (a, b) =>
  a.field === b.field &&
  a.pattern === b.pattern &&
  a.regex === b.regex &&
  a.matchCase === b.matchCase &&
  a.action === b.action &&
  [...a.boards].sort().join(' ') === [...b.boards].sort().join(' ');

/** Why a filter cannot be added: 'invalid', 'duplicate', 'count' (MAX_FILTERS
 *  already), 'size' (no room left in MAX_FILTERS_BYTES), or '' when it can. */
export function addProblem(s, raw) {
  const f = normalizeFilter(raw);
  const list = Array.isArray(s?.filters) ? s.filters : [];
  if (!f) return 'invalid';
  if (list.some((x) => sameFilter(x, f))) return 'duplicate';
  if (list.length >= MAX_FILTERS) return 'count';
  if (filtersBytes(list) + filterBytes(f) > MAX_FILTERS_BYTES) return 'size';
  return '';
}

/** What to tell the person when addProblem() refuses a filter. */
export function addProblemText(problem) {
  if (problem === 'count') return `At most ${MAX_FILTERS} filters.`;
  if (problem === 'size') return 'The filter list is full. Remove some filters first.';
  if (problem === 'duplicate') return 'That filter is already there.';
  return '';
}

/** Adds a filter. Returns `s` unchanged when it is not valid, already there
 *  or the list is full (compare with ===). */
export function addFilter(s, raw) {
  const f = normalizeFilter(raw);
  const list = Array.isArray(s?.filters) ? s.filters : [];
  if (!f || addProblem(s, f)) return s;
  while (list.some((x) => x.id === f.id)) f.id = newFilterId();
  return { ...s, filters: [...list, f] };
}

/** Changes one filter; an edit that makes it invalid, or that grows the
 *  list past MAX_FILTERS_BYTES, is refused. */
export function updateFilter(s, id, patch) {
  const list = Array.isArray(s?.filters) ? s.filters : [];
  const i = list.findIndex((f) => f.id === id);
  if (i < 0) return s;
  const f = normalizeFilter({ ...list[i], ...patch, id });
  if (!f) return s;
  const filters = list.slice();
  filters[i] = f;
  if (filterBytes(f) > filterBytes(list[i]) && filtersBytes(filters) > MAX_FILTERS_BYTES) return s;
  return { ...s, filters };
}

export function removeFilter(s, id) {
  const list = Array.isArray(s?.filters) ? s.filters : [];
  return list.some((f) => f.id === id) ? { ...s, filters: list.filter((f) => f.id !== id) } : s;
}

/** The filters as a JSON document to copy or keep. Ids are left out. */
export function exportFilters(filters) {
  const list = normalizeFilters(filters).map((f) => {
    const out = { ...f };
    delete out.id;
    return out;
  });
  return JSON.stringify({ clovereye: 'filters', version: 1, filters: list }, null, 2);
}

/**
 * Reads pasted JSON: an export, or a bare list of filters.
 * @returns {{ filters: object[], skipped: number, error: string }}
 */
export function parseFilterImport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    return { filters: [], skipped: 0, error: 'That is not valid JSON.' };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.filters) ? data.filters : null;
  if (!list) return { filters: [], skipped: 0, error: 'No list of filters was found in that JSON.' };
  const filters = [];
  let skipped = 0;
  for (const item of list) {
    const f = normalizeFilter(isObj(item) ? { ...item, id: undefined } : item);
    if (f) filters.push(f);
    else skipped += 1;
  }
  return { filters, skipped, error: '' };
}

/** Adds imported filters, leaving out ones already there.
 *  @returns {{ settings: object, added: number }} */
export function mergeFilters(s, incoming) {
  let next = s;
  let added = 0;
  for (const f of incoming || []) {
    const after = addFilter(next, f);
    if (after !== next) {
      added += 1;
      next = after;
    }
  }
  return { settings: next, added };
}

/** The "Filter this …" choices a post offers: [{ field, value, label }]. */
export function quickFilters(post) {
  const out = [];
  const name = fieldValue(post, 'name').trim();
  if (name && name !== 'Anonymous') out.push({ field: 'name', value: name, label: 'Filter this name' });
  const trip = fieldValue(post, 'trip').trim();
  if (trip) out.push({ field: 'trip', value: trip, label: 'Filter this tripcode' });
  const id = fieldValue(post, 'id').trim();
  if (id) out.push({ field: 'id', value: id, label: 'Filter this ID' });
  // a country by its code, a board's own flag by its name (see fieldValue)
  const flag = (post?.country ? String(post.country) : decodeEntities(String(post?.flag_name || ''))).trim();
  if (flag) out.push({ field: 'flag', value: flag, label: `Filter this flag (${post.country ? decodeEntities(String(post.country_name || flag)) : flag})` });
  const ftag = fieldValue(post, 'ftag').trim();
  if (ftag) out.push({ field: 'ftag', value: ftag, label: `Filter this /f/ category (${ftag})` });
  const md5 = fieldValue(post, 'md5').trim();
  if (md5 && !post.filedeleted) out.push({ field: 'md5', value: md5, label: 'Filter this file (MD5)' });
  return out;
}

/** The filter a "Filter this …" choice adds: hide, plain text, this board. */
export const quickFilter = (board, { field, value }) => ({ field, pattern: value, regex: false, matchCase: field === 'md5', boards: isBoard(board) ? [board] : [], action: 'hide', enabled: true, ...(field === 'flag' ? { byName: true } : {}) });

// ------------------------------------------------------------- flags

let countryCache = null;
/** Every country flag a post can carry: [{ code, name }], by name. The names
 *  come from the system (Intl), in `locale`; 4chan's own extra codes too. */
export function countryFlags(locale = 'en') {
  if (countryCache?.locale === locale) return countryCache.list;
  let names = null;
  try {
    names = new Intl.DisplayNames([locale, 'en'], { type: 'region' });
  } catch {
    names = null;
  }
  const out = [];
  const A = 65;
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      let name = '';
      try {
        name = names?.of(code) || '';
      } catch {
        name = '';
      }
      if (name && name !== code && !/^Unknown/i.test(name)) out.push({ code, name });
    }
  }
  // the site's own: unknown or hidden locations, and the EU flag
  for (const [code, name] of [['XX', 'Unknown'], ['EU', 'Europe']]) if (!out.some((c) => c.code === code)) out.push({ code, name });
  out.sort((a, b) => a.name.localeCompare(b.name, locale));
  countryCache = { locale, list: out };
  return out;
}

/** The flags to pick from for the chosen boards (none chosen: all boards):
 *  country flags where a board has them, then each board's own flags.
 *  [{ kind: 'country' | 'board', board, code, name }] */
export function flagChoices(boardList, chosen = [], locale = 'en') {
  const list = (boardList || []).filter((b) => !chosen.length || chosen.includes(b.board));
  const out = [];
  if (!chosen.length || list.some((b) => b.country_flags)) for (const c of countryFlags(locale)) out.push({ kind: 'country', board: '', ...c });
  for (const b of list) {
    for (const [code, name] of Object.entries(b.board_flags || {})) out.push({ kind: 'board', board: b.board, code, name: decodeEntities(String(name)) });
  }
  return out;
}

const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Older flag filters (without `byName`) matched a code on a country flag
 *  and on a board's own flag alike: "TR" hid Turkey and /pol/'s Tree
 *  Hugger. Now a code means the country only, so each older plain filter
 *  scoped to boards is made to mean what it meant, once the board list is
 *  known: the flag's name where the code can only be a board flag (no
 *  country flags on its boards, one name), else a regular expression that
 *  matches the code or the flag's name, whole. Filters with boards missing
 *  from `boardList` wait for a list that has them. Every one done is
 *  marked `byName`, so running this again changes nothing. Returns the
 *  same list when nothing changed. */
export function fixBoardFlagFilters(filters, boardList) {
  const byBoard = new Map((boardList || []).map((b) => [b.board, b]));
  let changed = false;
  const out = (Array.isArray(filters) ? filters : []).map((f) => {
    if (f?.field !== 'flag' || f.byName) return f;
    const code = String(f.pattern || '').trim();
    const boards = f.boards || [];
    // regex filters, and ones for every board, are kept as they are
    if (f.regex || !boards.length || !code) {
      changed = true;
      return { ...f, byName: true };
    }
    const list = boards.map((b) => byBoard.get(b));
    if (list.some((b) => !b)) return f;
    const flagName = (b) => {
      const name = Object.entries(b.board_flags || {}).find(([k]) => (f.matchCase ? k === code : k.toLowerCase() === code.toLowerCase()))?.[1];
      return name ? decodeEntities(String(name)).trim() : '';
    };
    const names = [...new Set(list.map(flagName).filter(Boolean))];
    changed = true;
    if (!names.length) return { ...f, byName: true };
    if (names.length === 1 && list.every((b) => !b.country_flags && flagName(b))) return { ...f, pattern: names[0], byName: true };
    // the value is one line per code or name (see fieldValue)
    const pattern = `(?:^|\\n)(?:${[code, ...names].map(escapeRegex).join('|')})(?:\\n|$)`;
    if (filterProblem({ pattern, regex: true, matchCase: f.matchCase })) return { ...f, byName: true };
    return { ...f, pattern, regex: true, byName: true };
  });
  return changed ? out : filters;
}

/** The boards with something of their own to filter on, and what. */
export function boardFeatures(boardList) {
  return (boardList || [])
    .map((b) => ({
      board: b.board,
      countryFlags: Boolean(b.country_flags),
      boardFlags: Object.keys(b.board_flags || {}).length,
      ids: Boolean(b.user_ids),
    }))
    .filter((f) => f.countryFlags || f.boardFlags || f.ids);
}

// ----------------------------------------------------------- hidden by hand

export function normalizeHiddenPosts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!isObj(x) || !isBoard(x.board) || !Number.isSafeInteger(x.no) || x.no <= 0) continue;
    const k = `${x.board}/${x.no}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ board: x.board, no: x.no });
  }
  return out.slice(-MAX_HIDDEN_POSTS);
}

/** Numbers of the posts hidden by hand on one board. */
export const hiddenSet = (list, board) => new Set((Array.isArray(list) ? list : []).filter((x) => x?.board === board).map((x) => x.no));

export const isHidden = (s, board, no) => (s?.hiddenPosts || []).some((x) => x.board === board && x.no === no);

/** Hides a post (or a thread, by its first post) or shows it again. The
 *  oldest entries go first when the list is full. */
export function toggleHidden(s, board, no) {
  const list = Array.isArray(s?.hiddenPosts) ? s.hiddenPosts : [];
  if (isHidden(s, board, no)) return { ...s, hiddenPosts: list.filter((x) => !(x.board === board && x.no === no)) };
  if (!isBoard(board) || !Number.isSafeInteger(no) || no <= 0) return s;
  return { ...s, hiddenPosts: [...list, { board, no }].slice(-MAX_HIDDEN_POSTS) };
}

// ------------------------------------------------------------------ (You)

/** Numbers of the posts made from CloverEye on one board. */
export const youSet = (yous, board) => new Set((Array.isArray(yous) ? yous : []).filter((y) => y?.board === board).map((y) => y.no));

/** The posts that quote one of yours (not counting your own posts). */
export function repliesToYou(posts, you) {
  const out = new Set();
  if (!you?.size) return out;
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p?.com || you.has(p.no)) continue;
    if (quotedPosts(p.com).some((n) => you.has(n))) out.add(p.no);
  }
  return out;
}
