// First-time setup: steps, defaults, validation, migration and board
// visibility (SCOPE §3.1b). No DOM here, so it runs under `node --test`.

export const SETUP_VERSION = 1;

/** Every step, with the setup version that introduced it. A later release
 *  that adds a step gives it `since: 2`; people who finished version 1 then
 *  see only that step and Done. */
export const STEPS = Object.freeze([
  { id: 'welcome', label: 'Welcome', since: 1 },
  { id: 'look', label: 'Look', since: 1 },
  { id: 'content', label: 'Content', since: 1 },
  { id: 'boards', label: 'Boards', since: 1 },
  { id: 'video', label: 'Video', since: 1 },
  { id: 'watching', label: 'Watching', since: 1 },
  { id: 'files', label: 'Files and privacy', short: 'Files', since: 1 },
  { id: 'done', label: 'Done', since: 1 },
]);

export const THEMES = Object.freeze(['system', 'dark', 'light']);
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

export function defaults() {
  return {
    schema: 1,
    setupVersion: 0,
    completedAt: null,
    skipped: false,
    theme: 'system',
    density: 'comfortable',
    textScale: 1,
    nsfw: { enabled: false, confirmedAdultAt: null },
    favourites: [],
    /** NSFW board codes from the last board list, so NSFW favourites stay
     *  hidden while the opt-in is off even before the list is loaded. */
    nsfwBoards: [],
    watch: { notifyReplies: false, keepInTray: false, intervalSec: MIN_WATCH_INTERVAL },
    files: { downloadDir: '', stripMetadata: true, cache: 'memory', cacheCapMB: 256 },
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
      stripMetadata: bool(raw.files.stripMetadata, d.files.stripMetadata),
      cache: pick(raw.files.cache, CACHE_MODES, d.files.cache),
      cacheCapMB: pick(raw.files.cacheCapMB, CACHE_CAPS_MB, d.files.cacheCapMB),
    };
  }
  return out;
}

const clone = (s) => JSON.parse(JSON.stringify(s));

/** Checks one step's answers. `errors` maps a field name to a message. */
export function validateStep(id, s) {
  const errors = {};
  if (id === 'content') {
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
  return pruneFavourites({ ...s, nsfw: { enabled: false, confirmedAdultAt: null } }, boards);
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

/** The install command to copy for this OS. CloverEye never runs it. */
export function installHint({ os = 'linux', distro = '' } = {}) {
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
    return { command: 'sudo dnf install ffmpeg-free', note: "Fedora's ffmpeg-free has VP9, AV1, Opus, libass and libplacebo." };
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
    value: `${cap(s.theme)} theme · ${cap(s.density)} · ${scaleLabel(s.textScale)} text`,
  });
  rows.push({
    step: 'content',
    label: 'Content',
    value: nsfwVisible(s) ? 'All boards, NSFW included (18+ confirmed)' : 'Worksafe boards only',
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
  return rows;
}
