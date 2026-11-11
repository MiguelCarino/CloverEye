// First-time setup: steps, defaults, validation, migration and board
// visibility (SCOPE §3.1b). No DOM here, so it runs under `node --test`.

import { normalizeFilters, normalizeHiddenPosts } from './filter-model.js';
import { QUOTE_LINK_MODES } from './quote-model.js';
import { normalizeLastRead } from './unread-model.js';
import { DEFAULT_SAUCE, normalizeSauce } from './sauce-model.js';
import { normalizeArchivePrefs, archivedBoards } from './archive-model.js';
import { EMBED_MODES } from './link-model.js';
import { displayDefaults, normalizeDisplay } from './display-model.js';
import { normalizeStatsSettings } from './stats-model.js';

/** 2: Your stats (opt-in, local only). */
export const SETUP_VERSION = 2;

/** Every step, with the setup version that introduced it. A later release
 *  that adds a step gives it `since: 2`; people who finished version 1 then
 *  see only that step and Done. */
export const STEPS = Object.freeze([
  { id: 'welcome', label: 'Welcome', since: 1 },
  { id: 'look', label: 'Look', since: 1 },
  { id: 'boards', label: 'Boards', since: 1 },
  { id: 'video', label: 'Video', since: 1 },
  { id: 'watching', label: 'Watching', since: 1 },
  { id: 'files', label: 'Files and privacy', short: 'Files', since: 1 },
  { id: 'stats', label: 'Your stats', short: 'Stats', since: 2 },
  { id: 'done', label: 'Done', since: 1 },
]);

/** Every theme, grouped for the picker. `swatch` is [page, card, accent,
 *  text] for the picker's thumbnail; the real colours live in
 *  ui/css/tokens.css under :root[data-theme='<id>']. Classic recreates the
 *  site's own board styles; Atrium carries the desktop themes of the Atrium
 *  setup. */
export const THEME_GROUPS = Object.freeze([
  {
    id: 'clovereye',
    label: 'CloverEye',
    themes: [
      { id: 'system', label: 'System', swatch: ['#0e0f14', '#f6f6f9', '#8f7dff', '#171923'] },
      { id: 'dark', label: 'Dark', swatch: ['#0e0f14', '#15171e', '#8f7dff', '#e9eaf0'] },
      { id: 'light', label: 'Light', swatch: ['#f6f6f9', '#ffffff', '#5b45e0', '#171923'] },
    ],
  },
  {
    id: 'classic',
    label: 'Classic',
    themes: [
      { id: 'yotsuba', label: 'Yotsuba', swatch: ['#ffffee', '#f0e0d6', '#cc1105', '#800000'] },
      { id: 'yotsuba-b', label: 'Yotsuba B', swatch: ['#eef2ff', '#d6daf0', '#0f0c5d', '#000000'] },
      { id: 'futaba', label: 'Futaba', swatch: ['#ffffee', '#f0e0d6', '#cc1105', '#800000'] },
      { id: 'burichan', label: 'Burichan', swatch: ['#eef2ff', '#d6daf0', '#34345c', '#000000'] },
      { id: 'tomorrow', label: 'Tomorrow', swatch: ['#1d1f21', '#282a2e', '#81a2be', '#c5c8c6'] },
      { id: 'photon', label: 'Photon', swatch: ['#eeeeee', '#dddddd', '#ff6600', '#333333'] },
    ],
  },
  {
    id: 'atrium',
    label: 'Atrium',
    themes: [
      { id: 'cyberpunk', label: 'Cyberpunk', swatch: ['#07090f', '#0d1220', '#00f0ff', '#e6fcff'] },
      { id: 'matrix', label: 'Matrix', swatch: ['#000000', '#000803', '#3ddc68', '#c8d4cb'] },
      { id: 'aero', label: 'Aero Glass', swatch: ['#06142a', '#0c2240', '#4aa3f0', '#f4f9ff'] },
      { id: 'win95', label: 'Windows 95', swatch: ['#a0a0a0', '#acacac', '#000080', '#000000'] },
      { id: 'lofi', label: 'Lo-fi', swatch: ['#1c1830', '#2a2342', '#f2a477', '#e8dccb'] },
      { id: 'luna', label: 'Luna', swatch: ['#c3bea7', '#d8d3bd', '#2459c8', '#1c1a14'] },
      { id: 'moe', label: 'Moe', swatch: ['#f6dce8', '#fbeaf1', '#8c2457', '#3d1f3b'] },
      { id: 'orbit', label: 'Orbit', swatch: ['#070b14', '#16223a', '#5cc8db', '#dbe4f0'] },
      { id: 'orchard', label: 'Orchard', swatch: ['#ececec', '#ffffff', '#007aff', '#1d1d1f'] },
      { id: 'orchard-dark', label: 'Orchard Dark', swatch: ['#1e1e1e', '#2c2c2e', '#0a84ff', '#ebebf0'] },
    ],
  },
]);

export const THEMES = Object.freeze(THEME_GROUPS.flatMap((g) => g.themes.map((t) => t.id)));

/** "Yotsuba B", "Orchard Dark"…; the id itself when unknown. */
export const themeLabel = (id) => THEME_GROUPS.flatMap((g) => g.themes).find((t) => t.id === id)?.label ?? String(id);
export const DENSITIES = Object.freeze(['comfortable', 'compact']);
export const TEXT_SCALES = Object.freeze([
  { value: 0.9, label: 'Small' },
  { value: 1, label: 'Default' },
  { value: 1.125, label: 'Large' },
  { value: 1.25, label: 'Larger' },
]);
/** The API rule: a thread is not updated more often than every 10 s. */
export const MIN_WATCH_INTERVAL = 10;
export const MAX_WATCH_INTERVAL = 3600;
export const WATCH_PRESETS = Object.freeze([10, 15, 30, 60, 120]);
export const CACHE_MODES = Object.freeze(['memory', 'temp']);
export const CACHE_CAPS_MB = Object.freeze([128, 256, 512, 1024]);
export const MAX_FAVOURITES = 30;
/** Cap on the remembered NSFW board codes (boards.json has about 25). */
export const MAX_NSFW_BOARDS = 200;

const BOARD_RE = /^[a-z0-9]{1,10}$/;
export const isBoardCode = (b) => typeof b === 'string' && BOARD_RE.test(b);

/** The language setting's values (ui/js/i18n.js has the names). */
export const LANG_SETTINGS = ['system', 'en', 'es', 'pt-BR', 'ja', 'ru'];

export function defaults() {
  return {
    schema: 1,
    setupVersion: 0,
    completedAt: null,
    skipped: false,
    theme: 'system',
    /** "system" (the desktop's language) or en, es, pt-BR, ja, ru. */
    lang: 'system',
    density: 'comfortable',
    textScale: 1,
    nsfw: { enabled: false, confirmedAdultAt: null },
    favourites: [],
    /** NSFW board codes from the last board list, so NSFW favourites stay
     *  hidden while the opt-in is off even before the list is loaded. */
    nsfwBoards: [],
    watch: { notifyReplies: false, keepInTray: false, intervalSec: MIN_WATCH_INTERVAL },
    /** savedDir: where Save offline keeps threads ('' = the download
     *  folder's CloverEye/Saved threads; offline-model.js). */
    files: { downloadDir: '', savedDir: '', stripMetadata: true, cache: 'memory', cacheCapMB: 256 },
    /** Layout choices made in the shell. */
    ui: { railHidden: false, splitWidth: 520, hoverPreview: true, rows: 1 },
    /** Posts made from CloverEye: [{ board, no }]. */
    yous: [],
    /** The reply form's remembered name, the deletion password the site
     *  keeps with each post (made once, kept on this computer), and whether
     *  attached files go out under a random name (compose-model.js). */
    post: { name: '', pwd: '', randomName: false },
    /** Watched threads: { board, no, title, seen (last post no read),
     *  dead (404), archived }. */
    watched: [],
    /** Filters (ui/js/filter-model.js): { id, field, pattern, regex,
     *  matchCase, boards ([] = every board), action, enabled }. */
    filters: [],
    /** Posts and threads hidden by hand: [{ board, no }]. */
    hiddenPosts: [],
    /** Hiding (ui/js/hide-model.js): also hide replies whose quotes are all
     *  hidden posts. */
    hide: { replies: true },
    /** Quote links in a thread: open the post below the link ('inline') or
     *  scroll to it ('jump'); preview the post on hover or keyboard focus. */
    quotes: { links: 'inline', preview: true },
    /** Poster IDs: each in a colour of its own (ui/js/ids-model.js). */
    ids: { colour: true },
    /** Reverse image search: the sites each file's Search menu offers
     *  (ui/js/sauce-model.js); none means no menu. */
    sauce: { engines: [...DEFAULT_SAUCE] },
    /** Archive links (ui/js/archive-model.js): on or off, and each board's
     *  archive ('off', or an archive id; no entry = the first that keeps it). */
    archives: { enabled: true, boards: {} },
    /** Links in posts (ui/js/link-model.js): YouTube, Vimeo, Streamable and
     *  SoundCloud links get an Embed button ('click') or stay links ('off').
     *  Nothing loads from those sites before the button is clicked. */
    embeds: { mode: 'click' },
    /** Display switches (ui/js/display-model.js, Settings → Posts): post
     *  times, spoilers, work mode, images expanded in threads, gallery
     *  preloading, anonymised names. */
    display: displayDefaults(),
    /** Where each thread was last read (ui/js/unread-model.js):
     *  "board/no" → the last post No. on screen, oldest first. */
    lastRead: {},
    /** Settings → Stats (stats-model.js): background sampling of board
     *  activity (`track`, off) for the favourites, every worksafe board or
     *  every visible board, each at most every `intervalMin` minutes; and
     *  counting your own activity on this computer (`mine`, off). The
     *  samples and counts live in files of their own, never here. */
    stats: normalizeStatsSettings(null),
  };
}

export const MAX_WATCHED = 100;
export const SPLIT_MIN = 320;
export const SPLIT_MAX = 1400;

/** One watched-thread record, or null if it is not one. */
export function normalizeWatched(w) {
  if (!isObj(w) || !isBoardCode(w.board) || !Number.isSafeInteger(w.no) || w.no <= 0) return null;
  const seen = Number.isSafeInteger(w.seen) && w.seen >= 0 ? w.seen : 0;
  return {
    board: w.board,
    no: w.no,
    title: typeof w.title === 'string' ? w.title.slice(0, 200) : '',
    seen,
    dead: w.dead === true,
    archived: w.archived === true,
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

function nearestScale(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  let best = TEXT_SCALES[0].value;
  for (const s of TEXT_SCALES) if (Math.abs(s.value - v) < Math.abs(best - v)) best = s.value;
  return best;
}

export function clampInterval(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return MIN_WATCH_INTERVAL;
  return Math.min(MAX_WATCH_INTERVAL, Math.max(MIN_WATCH_INTERVAL, n));
}

/** A folder setting: a full path (/… , or C:\… or \\server\… on
 *  Windows), at most 1024 characters, or '' (the default folder). */
export function normalizeFolder(raw) {
  if (typeof raw !== 'string') return '';
  const dir = raw.trim();
  if (!dir || dir.length > 1024 || /[\u0000-\u001f]/.test(dir)) return '';
  return dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\') ? dir : '';
}

/** Reads anything (stored JSON, an older schema, garbage) into a complete,
 *  valid settings object. Unknown keys are dropped. */
export function normalizeSettings(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;
  const out = d;
  out.setupVersion = Number.isInteger(raw.setupVersion) && raw.setupVersion >= 0 ? raw.setupVersion : 0;
  out.completedAt = typeof raw.completedAt === 'string' ? raw.completedAt : null;
  out.skipped = bool(raw.skipped, false);
  out.theme = pick(raw.theme, THEMES, d.theme);
  out.lang = pick(raw.lang, LANG_SETTINGS, d.lang);
  out.density = pick(raw.density, DENSITIES, d.density);
  out.textScale = nearestScale(raw.textScale);
  if (isObj(raw.nsfw)) {
    const at = typeof raw.nsfw.confirmedAdultAt === 'string' && raw.nsfw.confirmedAdultAt ? raw.nsfw.confirmedAdultAt : null;
    out.nsfw = { enabled: raw.nsfw.enabled === true && at !== null, confirmedAdultAt: at };
  }
  if (Array.isArray(raw.nsfwBoards)) {
    out.nsfwBoards = [...new Set(raw.nsfwBoards.filter(isBoardCode))].slice(0, MAX_NSFW_BOARDS);
  }
  if (Array.isArray(raw.favourites)) {
    out.favourites = [...new Set(raw.favourites.filter(isBoardCode))].slice(0, MAX_FAVOURITES);
  }
  // Off means NSFW boards never appear: not even as a stored favourite.
  if (!nsfwVisible(out) && out.nsfwBoards.length) {
    const nsfw = new Set(out.nsfwBoards);
    out.favourites = out.favourites.filter((b) => !nsfw.has(b));
  }
  if (isObj(raw.watch)) {
    out.watch = {
      notifyReplies: bool(raw.watch.notifyReplies, d.watch.notifyReplies),
      keepInTray: bool(raw.watch.keepInTray, d.watch.keepInTray),
      intervalSec: clampInterval(raw.watch.intervalSec ?? d.watch.intervalSec),
    };
  }
  if (isObj(raw.files)) {
    const dir = typeof raw.files.downloadDir === 'string' ? raw.files.downloadDir : '';
    out.files = {
      downloadDir: dir.length <= 1024 && !dir.includes('\0') ? dir.trim() : '',
      savedDir: normalizeFolder(raw.files.savedDir),
      stripMetadata: bool(raw.files.stripMetadata, d.files.stripMetadata),
      cache: pick(raw.files.cache, CACHE_MODES, d.files.cache),
      cacheCapMB: pick(raw.files.cacheCapMB, CACHE_CAPS_MB, d.files.cacheCapMB),
    };
  }
  if (isObj(raw.ui)) {
    const w = Math.round(Number(raw.ui.splitWidth));
    out.ui = {
      railHidden: bool(raw.ui.railHidden, d.ui.railHidden),
      splitWidth: Number.isFinite(w) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, w)) : d.ui.splitWidth,
      hoverPreview: bool(raw.ui.hoverPreview, d.ui.hoverPreview),
      rows: [1, 2, 3].includes(raw.ui.rows) ? raw.ui.rows : d.ui.rows,
    };
  }
  out.filters = normalizeFilters(raw.filters);
  out.hiddenPosts = normalizeHiddenPosts(raw.hiddenPosts);
  if (isObj(raw.hide)) out.hide = { replies: bool(raw.hide.replies, d.hide.replies) };
  if (isObj(raw.quotes)) {
    out.quotes = {
      links: pick(raw.quotes.links, QUOTE_LINK_MODES, d.quotes.links),
      preview: bool(raw.quotes.preview, d.quotes.preview),
    };
  }
  if (isObj(raw.ids)) out.ids = { colour: bool(raw.ids.colour, d.ids.colour) };
  if (isObj(raw.sauce)) out.sauce = { engines: normalizeSauce(raw.sauce.engines) };
  if (isObj(raw.archives)) out.archives = normalizeArchivePrefs(raw.archives);
  if (isObj(raw.embeds)) out.embeds = { mode: pick(raw.embeds.mode, EMBED_MODES, d.embeds.mode) };
  out.display = normalizeDisplay(raw.display);
  out.stats = normalizeStatsSettings(raw.stats);
  out.lastRead = normalizeLastRead(raw.lastRead);
  if (Array.isArray(raw.yous)) {
    out.yous = raw.yous
      .filter((y) => isObj(y) && isBoardCode(y.board) && Number.isSafeInteger(y.no) && y.no > 0)
      .map((y) => ({ board: y.board, no: y.no }))
      .slice(-1000);
  }
  if (isObj(raw.post)) {
    out.post = {
      name: typeof raw.post.name === 'string' ? raw.post.name.slice(0, 100) : '',
      pwd: typeof raw.post.pwd === 'string' && /^[A-Za-z0-9]{8,32}$/.test(raw.post.pwd) ? raw.post.pwd : '',
      randomName: bool(raw.post.randomName, d.post.randomName),
    };
  }
  if (Array.isArray(raw.watched)) {
    const seenKeys = new Set();
    out.watched = [];
    for (const item of raw.watched) {
      const w = normalizeWatched(item);
      if (!w) continue;
      const key = `${w.board}/${w.no}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.watched.push(w);
      if (out.watched.length >= MAX_WATCHED) break;
    }
  }
  // NSFW off: watched threads on NSFW boards are dropped too.
  if (!nsfwVisible(out) && out.nsfwBoards.length) {
    const nsfw = new Set(out.nsfwBoards);
    out.watched = out.watched.filter((w) => !nsfw.has(w.board));
    for (const k of Object.keys(out.lastRead)) if (nsfw.has(k.split('/')[0])) delete out.lastRead[k];
    for (const b of Object.keys(out.archives?.boards || {})) if (nsfw.has(b)) delete out.archives.boards[b];
  }
  return fitSettings(out);
}

/** The app refuses to store a settings file over 256 KiB (src-tauri
 *  main.rs MAX_SETTINGS_BYTES); this leaves room to spare. */
export const SETTINGS_BUDGET = 224 * 1024;

const encoder = new TextEncoder();
/** The settings' size as the app saves them (pretty-printed JSON). */
export const settingsBytes = (s) => encoder.encode(JSON.stringify(s, null, 2)).length;

/** Settings that fit in `budget` bytes: past it, the oldest read marks go
 *  first, then the oldest posts hidden by hand, then the oldest (You)s.
 *  Filters and watched threads are never dropped here (their own caps keep
 *  them well inside). Returns `s` itself when it already fits. */
export function fitSettings(s, budget = SETTINGS_BUDGET) {
  if (!isObj(s) || settingsBytes(s) <= budget) return s;
  const out = { ...s };
  const trims = [
    ['lastRead', (v, n) => Object.fromEntries(Object.entries(v).slice(n)), (v) => Object.keys(v).length],
    ['hiddenPosts', (v, n) => v.slice(n), (v) => v.length],
    ['yous', (v, n) => v.slice(n), (v) => v.length],
  ];
  for (const [key, drop, size] of trims) {
    if (out[key] === null || typeof out[key] !== 'object') continue;
    while (size(out[key]) > 0 && settingsBytes(out) > budget) {
      out[key] = drop(out[key], Math.max(1, Math.ceil(size(out[key]) / 8)));
    }
    if (settingsBytes(out) <= budget) break;
  }
  return out;
}

const keyOf = (board, no) => `${board}/${no}`;

export const isWatched = (s, board, no) => (s?.watched || []).some((w) => w.board === board && w.no === no);

/** Watches or unwatches a thread. `seen` = the last post number read. */
export function toggleWatch(s, { board, no, title = '', seen = 0 }) {
  const list = Array.isArray(s?.watched) ? s.watched : [];
  if (isWatched(s, board, no)) return { ...s, watched: list.filter((w) => keyOf(w.board, w.no) !== keyOf(board, no)) };
  const w = normalizeWatched({ board, no, title, seen });
  if (!w || list.length >= MAX_WATCHED) return s;
  return { ...s, watched: [...list, w] };
}

/** Applies a patch to one watched thread (seen, dead, archived, title).
 *  Returns `s` itself when nothing changes. */
export function updateWatched(s, board, no, patch) {
  let changed = false;
  const watched = (s?.watched || []).map((w) => {
    if (w.board !== board || w.no !== no) return w;
    const next = normalizeWatched({ ...w, ...patch });
    if (next && JSON.stringify(next) !== JSON.stringify(w)) {
      changed = true;
      return next;
    }
    return w;
  });
  return changed ? { ...s, watched } : s;
}

/** Unread posts in a thread for a watch record: posts newer than `seen`. */
export const unreadCount = (posts, seen) => (Array.isArray(posts) ? posts.filter((p) => p.no > (seen || 0)).length : 0);

const clone = (s) => JSON.parse(JSON.stringify(s));

/** Checks one step's answers. `errors` maps a field name to a message. */
export function validateStep(id, s) {
  const errors = {};
  if (id === 'content') {
    // Settings → Content (NSFW is never asked during setup).
    if (s.nsfw?.enabled && !s.nsfw?.confirmedAdultAt) {
      errors.nsfw = 'Showing NSFW boards needs the 18+ confirmation.';
    }
  } else if (id === 'boards') {
    const bad = (s.favourites || []).filter((b) => !isBoardCode(b));
    if (bad.length) errors.favourites = `Not board codes: ${bad.join(', ')}`;
    else if ((s.favourites || []).length > MAX_FAVOURITES) errors.favourites = `At most ${MAX_FAVOURITES} favourites.`;
  } else if (id === 'watching') {
    const v = s.watch?.intervalSec;
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      errors.intervalSec = 'Enter a whole number of seconds.';
    } else if (v < MIN_WATCH_INTERVAL) {
      errors.intervalSec = `The minimum is ${MIN_WATCH_INTERVAL} seconds (the site's API rule).`;
    } else if (v > MAX_WATCH_INTERVAL) {
      errors.intervalSec = `The maximum is ${MAX_WATCH_INTERVAL} seconds (one hour).`;
    }
  } else if (id === 'files') {
    const dir = s.files?.downloadDir ?? '';
    if (typeof dir !== 'string' || dir.includes('\0') || dir.length > 1024) {
      errors.downloadDir = 'That folder path is not valid.';
    }
    if (s.files?.cache === 'temp' && !CACHE_CAPS_MB.includes(s.files?.cacheCapMB)) {
      errors.cacheCapMB = 'Pick a cache size.';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// ------------------------------------------------------------------ boards

const isWorksafe = (b) => b.ws_board === 1 || b.ws_board === true;

/** NSFW boards count as visible only with both the switch and the 18+ date. */
export const nsfwVisible = (s) => Boolean(s?.nsfw?.enabled && s?.nsfw?.confirmedAdultAt);

/** The boards a person may see. Off (the default) = worksafe only. */
export function visibleBoards(boards, s) {
  const all = Array.isArray(boards) ? boards : [];
  return nsfwVisible(s) ? all.slice() : all.filter(isWorksafe);
}

/** The NSFW board codes known: remembered ones, and those of `boards`. */
function nsfwCodes(s, boards = null) {
  return new Set([
    ...(Array.isArray(s?.nsfwBoards) ? s.nsfwBoards : []),
    ...(Array.isArray(boards) ? boards.filter((b) => !isWorksafe(b)).map((b) => b.board) : []),
  ]);
}

/** Settings → Archives' boards: every archived board, less the NSFW ones
 *  while NSFW boards are off. */
export function visibleArchivedBoards(s, boards = null) {
  const all = archivedBoards();
  if (nsfwVisible(s)) return all;
  const nsfw = nsfwCodes(s, boards);
  return all.filter((b) => !nsfw.has(b));
}

/** Whether board `code` is hidden: an NSFW board while NSFW boards are off. */
export const boardHidden = (s, code, boards = null) => !nsfwVisible(s) && nsfwCodes(s, boards).has(code);

export const hiddenBoardCount = (boards, s) => (Array.isArray(boards) ? boards.length : 0) - visibleBoards(boards, s).length;

/** Records which boards of a loaded list are NSFW (see `nsfwBoards`). */
export function rememberNsfwBoards(s, boards) {
  if (!Array.isArray(boards) || boards.length === 0) return s;
  const codes = boards.filter((b) => !isWorksafe(b) && isBoardCode(b.board)).map((b) => b.board);
  return { ...s, nsfwBoards: [...new Set(codes)].slice(0, MAX_NSFW_BOARDS) };
}

/** Drops favourites the person may not see. With a board list: everything
 *  not on its visible part (and the list's NSFW codes are remembered).
 *  Without one: while NSFW is off, the remembered NSFW codes. Returns `s`
 *  itself when nothing changes. */
export function pruneFavourites(s, boards) {
  const favs = Array.isArray(s?.favourites) ? s.favourites : [];
  if (Array.isArray(boards) && boards.length > 0) {
    const ok = new Set(visibleBoards(boards, s).map((b) => b.board));
    return { ...rememberNsfwBoards(s, boards), favourites: favs.filter((b) => ok.has(b)) };
  }
  if (nsfwVisible(s)) return s;
  const nsfw = new Set(Array.isArray(s?.nsfwBoards) ? s.nsfwBoards : []);
  if (!favs.some((b) => nsfw.has(b))) return s;
  return { ...s, favourites: favs.filter((b) => !nsfw.has(b)) };
}

/** The favourites to draw (rail, Done summary, start destination). */
export const visibleFavourites = (s, boards = null) => pruneFavourites(s, boards)?.favourites ?? [];

/** Switches NSFW boards on or off. On needs `confirmedAdult: true`; without
 *  it nothing changes. Off forgets the confirmation (it's asked again next
 *  time) and drops NSFW favourites. */
export function setNsfw(s, enabled, { confirmedAdult = false, now = new Date(), boards = null } = {}) {
  if (enabled) {
    if (!confirmedAdult) return s;
    return { ...s, nsfw: { enabled: true, confirmedAdultAt: now.toISOString() } };
  }
  let off = pruneFavourites({ ...s, nsfw: { enabled: false, confirmedAdultAt: null } }, boards);
  const nsfw = nsfwCodes(off, boards);
  if (Array.isArray(off.watched) && off.watched.some((w) => nsfw.has(w.board))) off = { ...off, watched: off.watched.filter((w) => !nsfw.has(w.board)) };
  const picks = off.archives?.boards;
  if (picks && Object.keys(picks).some((b) => nsfw.has(b))) {
    off = { ...off, archives: { ...off.archives, boards: Object.fromEntries(Object.entries(picks).filter(([b]) => !nsfw.has(b))) } };
  }
  return off;
}

export function toggleFavourite(s, code) {
  if (!isBoardCode(code)) return s;
  const has = s.favourites.includes(code);
  if (!has && s.favourites.length >= MAX_FAVOURITES) return s;
  return { ...s, favourites: has ? s.favourites.filter((b) => b !== code) : [...s.favourites, code] };
}

/** Case-insensitive match on code (with or without slashes) and title. */
export function filterBoards(boards, query) {
  const q = String(query || '').trim().toLowerCase().replace(/^\/|\/$/g, '');
  if (!q) return boards.slice();
  return boards.filter((b) => b.board.includes(q) || String(b.title || '').toLowerCase().includes(q));
}

/** A stable hue for a board's small identity tag. Skips 85-165° so no
 *  board tag reads as the site's green. */
export function boardHue(code) {
  let h = 2166136261;
  for (const ch of String(code)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const span = 360 - 80;
  const v = h % span;
  return v < 85 ? v : v + 80;
}

// --------------------------------------------------------- steps / versions

export const needsSetup = (s, version = SETUP_VERSION) => !s || !(s.setupVersion >= version);

/** Which steps to show. First run (or rerun) = all; after an upgrade = only
 *  steps newer than the version finished, plus Done. Up to date = none. */
export function stepsToShow(s, { steps = STEPS, version = SETUP_VERSION, rerun = false } = {}) {
  const done = s?.setupVersion ?? 0;
  if (rerun || done <= 0) return steps.slice();
  if (done >= version) return [];
  const fresh = steps.filter((st) => st.since > done && st.id !== 'done');
  const end = steps.find((st) => st.id === 'done');
  return end ? [...fresh, end] : fresh;
}

/** Final settings when setup ends (Done or Skip): normalised, stamped. */
export function completeSetup(draft, { skipped = false, now = new Date(), version = SETUP_VERSION } = {}) {
  const s = normalizeSettings(clone(draft));
  s.setupVersion = version;
  s.completedAt = now.toISOString();
  s.skipped = skipped;
  return s;
}

/** Where Done goes: the first favourite the person may see, or the board
 *  list. */
export function firstDestination(s, boards = null) {
  const b = s ? visibleFavourites(s, boards).find(isBoardCode) : undefined;
  return b ? { kind: 'board', board: b } : { kind: 'boards' };
}

// ---------------------------------------------------------------- keyboard

/** Maps a key press to a wizard action. `target` describes the focused
 *  element: 'text' | 'textarea' | 'select' | 'range' | 'radio' | 'grid' |
 *  'button' | 'link' | 'toggle' | 'other'. */
export function keyAction({ key, target = 'other', dialogOpen = false, mods = false, composing = false } = {}) {
  if (composing || mods) return null;
  if (dialogOpen) return key === 'Escape' ? 'close-dialog' : null;
  if (key === 'Escape') return 'skip';
  if (key === 'Enter') {
    // Buttons and links act on their own; a textarea needs Enter for lines.
    if (target === 'button' || target === 'link' || target === 'textarea' || target === 'grid') return null;
    return 'next';
  }
  if (key === 'ArrowRight' || key === 'ArrowLeft') {
    // Fields, sliders, radio groups and the board grid use arrows themselves.
    if (['text', 'textarea', 'select', 'range', 'radio', 'grid'].includes(target)) return null;
    return key === 'ArrowRight' ? 'next' : 'back';
  }
  return null;
}

// ------------------------------------------------------------- video check

export const FFMPEG_ROWS = Object.freeze([
  { id: 'ffmpeg', label: 'ffmpeg', detail: 'runs Clip as a separate process', required: true },
  { id: 'libvpx_vp9', label: 'VP9 encoder', detail: 'libvpx-vp9', required: true },
  { id: 'libopus', label: 'Opus audio', detail: 'libopus', required: true },
  { id: 'libsvtav1', label: 'AV1 encoder', detail: 'libsvtav1 (optional)', required: false },
  { id: 'libass', label: 'Subtitles', detail: 'libass: ass / subtitles filters (optional)', required: false },
  { id: 'libplacebo', label: 'HDR to SDR', detail: 'libplacebo (optional)', required: false },
]);

/** Turns a check_ffmpeg result into ✓/✗ rows and Clip's state. Clip needs
 *  ffmpeg, VP9 and Opus; the rest only enable extras. */
export function clipReadiness(check) {
  const c = check || {};
  const enc = c.encoders || {};
  const fil = c.filters || {};
  const have = {
    ffmpeg: Boolean(c.found),
    libvpx_vp9: Boolean(c.found && enc.libvpx_vp9),
    libopus: Boolean(c.found && enc.libopus),
    libsvtav1: Boolean(c.found && enc.libsvtav1),
    libass: Boolean(c.found && (fil.ass || fil.subtitles)),
    libplacebo: Boolean(c.found && fil.libplacebo),
  };
  const rows = FFMPEG_ROWS.map((r) => ({ ...r, ok: have[r.id] }));
  const missingRequired = rows.filter((r) => r.required && !r.ok).map((r) => r.id);
  const missingOptional = rows.filter((r) => !r.required && !r.ok).map((r) => r.id);
  let reason = '';
  if (!c.found) reason = 'Clip is off: ffmpeg was not found. Everything else works.';
  else if (missingRequired.length) {
    const names = rows.filter((r) => missingRequired.includes(r.id)).map((r) => r.detail).join(' and ');
    reason = `Clip is off: this ffmpeg lacks ${names}. Everything else works.`;
  }
  return { ready: missingRequired.length === 0, rows, missingRequired, missingOptional, reason, version: c.version || null };
}

/** "ffmpeg-free (Fedora)", "ffmpeg (RPM Fusion)"…, from check_ffmpeg's
 *  `package` (RPM-based Linux only); '' when unknown. */
export function packageLabel(pkg) {
  if (!pkg || typeof pkg.name !== 'string' || !pkg.name) return '';
  const from = pkg.source === 'fedora' ? 'Fedora' : pkg.source === 'rpmfusion' ? 'RPM Fusion' : String(pkg.vendor || '').trim();
  return from ? `${pkg.name} (${from})` : pkg.name;
}

const RPMFUSION_NOTE = 'RPM Fusion’s ffmpeg works too: with the RPM Fusion repositories enabled, `sudo dnf install ffmpeg`.';

/** The install command to copy for this OS. CloverEye never runs it.
 *  On Fedora it looks at which package is installed: Fedora's ffmpeg-free
 *  first, then RPM Fusion's ffmpeg. */
export function installHint({ os = 'linux', distro = '', package: pkg = null } = {}) {
  const d = String(distro || '').toLowerCase();
  if (os === 'windows') {
    return {
      command: 'winget install --id Gyan.FFmpeg -e',
      note: "CloverEye for Windows ships its own ffmpeg; use this only if that copy is missing.",
    };
  }
  if (os === 'macos') {
    return {
      command: 'brew install ffmpeg',
      note: "CloverEye for macOS ships its own ffmpeg; use this only if that copy is missing (needs Homebrew).",
    };
  }
  if (/fedora|rhel|centos|rocky|alma|nobara/.test(d)) {
    if (pkg?.name === 'ffmpeg-free') {
      return {
        command: 'sudo dnf swap ffmpeg-free ffmpeg --allowerasing',
        note: 'Installed now: Fedora’s ffmpeg-free. RPM Fusion’s ffmpeg is the fuller build; this swaps to it (the RPM Fusion repositories must be enabled).',
      };
    }
    if (pkg?.name === 'ffmpeg') {
      return {
        command: 'sudo dnf upgrade --refresh ffmpeg ffmpeg-libs',
        note: `Installed now: ${packageLabel(pkg)}. An update may bring the missing parts.`,
      };
    }
    return { command: 'sudo dnf install ffmpeg-free', note: `Fedora’s ffmpeg-free has VP9, AV1, Opus, libass and libplacebo. ${RPMFUSION_NOTE}` };
  }
  if (/ubuntu|debian|mint|pop|elementary|zorin/.test(d)) return { command: 'sudo apt install ffmpeg', note: '' };
  if (/arch|manjaro|endeavour|cachy/.test(d)) return { command: 'sudo pacman -S ffmpeg', note: '' };
  if (/opensuse|suse/.test(d)) return { command: 'sudo zypper install ffmpeg', note: '' };
  return { command: '', note: "Install ffmpeg with your distribution's package manager." };
}

// ----------------------------------------------------------------- summary

const scaleLabel = (v) => (TEXT_SCALES.find((s) => s.value === v) || TEXT_SCALES[1]).label;
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** Done-step summary: one row per step that has answers. */
export function summary(s, { clip = null } = {}) {
  const rows = [];
  rows.push({
    step: 'look',
    label: 'Look',
    value: `${themeLabel(s.theme)} theme · ${cap(s.density)} · ${scaleLabel(s.textScale)} text`,
  });
  rows.push({
    step: 'boards',
    label: 'Favourites',
    value: s.favourites.length ? s.favourites.map((b) => `/${b}/`).join(' ') : 'None yet: you can pick them later',
  });
  rows.push({
    step: 'video',
    label: 'Video (Clip)',
    value: clip ? (clip.ready ? 'Ready' : clip.reason) : 'Not checked',
  });
  rows.push({
    step: 'watching',
    label: 'Watching',
    value: [
      `every ${s.watch.intervalSec} s`,
      s.watch.notifyReplies ? 'reply notifications on' : 'notifications off',
      s.watch.keepInTray ? 'stays in the tray' : 'quits on close',
    ].join(' · '),
  });
  rows.push({
    step: 'files',
    label: 'Files and privacy',
    value: [
      s.files.downloadDir ? s.files.downloadDir : 'Downloads/CloverEye',
      s.files.stripMetadata ? 'location and camera data stripped' : 'images posted as they are',
      s.files.cache === 'memory' ? 'media cache in memory only' : `temp cache up to ${s.files.cacheCapMB} MB`,
    ].join(' · '),
  });
  rows.push({
    step: 'stats',
    label: 'Your stats',
    value: s.stats?.mine ? 'Counted on this computer only' : 'Off',
  });
  return rows;
}
