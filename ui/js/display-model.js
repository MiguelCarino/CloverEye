// Display switches (Settings → Posts): how post times read, spoilers, work
// mode (files hidden), images expanded in threads, the gallery's preloading
// and anonymised names. No DOM, so it runs under `node --test`.

import { ago } from './browse-model.js';

/** How a post's time reads: in the person's own time and language, as an
 *  age ("3 min ago", the full time on hover), or as the site wrote it. */
export const TIME_MODES = Object.freeze(['local', 'relative', 'board']);

export function displayDefaults() {
  return {
    time: 'local',
    /** Spoilered images show their real thumbnail; spoiler text is shown
     *  (still marked). */
    revealSpoilers: false,
    /** Work mode: every file is a one-line link until clicked; the catalog
     *  shows placeholders. */
    hideImages: false,
    /** Images (never videos) open in place in threads. */
    autoExpand: false,
    /** The gallery starts loading the next and previous images. */
    galleryPreload: true,
    /** Every name and tripcode reads "Anonymous" (IDs and flags stay). */
    anonymize: false,
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/** Any stored value to complete display settings. */
export function normalizeDisplay(raw) {
  const d = displayDefaults();
  if (!isObj(raw)) return d;
  return {
    time: TIME_MODES.includes(raw.time) ? raw.time : d.time,
    revealSpoilers: bool(raw.revealSpoilers, d.revealSpoilers),
    hideImages: bool(raw.hideImages, d.hideImages),
    autoExpand: bool(raw.autoExpand, d.autoExpand),
    galleryPreload: bool(raw.galleryPreload, d.galleryPreload),
    anonymize: bool(raw.anonymize, d.anonymize),
  };
}

/** A unix time (seconds) as a full date and time in `locale` (the UI's
 *  language); '' when there is none. */
export function localTime(unix, locale = undefined, timeZone = undefined) {
  if (!Number.isFinite(unix) || unix <= 0) return '';
  const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  try {
    return new Date(unix * 1000).toLocaleString(locale || undefined, opts);
  } catch {
    return new Date(unix * 1000).toLocaleString(undefined, opts);
  }
}

/**
 * What a post's time shows. `relative` marks text that ages (redrawn every
 * minute by the page, without redrawing the thread); `title` is the full
 * time for the tooltip. Falls back to the site's own text when the post has
 * no usable `time`, and to the local time when the site sent no `now`.
 * @returns {{text: string, title: string, relative: boolean, unix: number|null}}
 */
export function postTime(post, mode = 'local', { now = Date.now(), locale, timeZone } = {}) {
  const unix = Number.isFinite(post?.time) && post.time > 0 ? post.time : null;
  const board = typeof post?.now === 'string' ? post.now : '';
  const local = unix ? localTime(unix, locale, timeZone) : '';
  if (mode === 'relative' && unix) return { text: ago(unix, now), title: local, relative: true, unix };
  if (mode === 'board' && board) return { text: board, title: local, relative: false, unix };
  if (local) return { text: local, title: mode === 'local' && board ? board : '', relative: false, unix };
  return { text: board, title: '', relative: false, unix };
}

/** The name and tripcode a post shows: its own, or "Anonymous" and none.
 *  Only what is drawn changes: filters still read the post itself. */
export function posterName(post, anonymize = false) {
  if (anonymize) return { name: 'Anonymous', trip: '' };
  return { name: post?.name || 'Anonymous', trip: post?.trip || '' };
}

const IMAGE = /^\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const VIDEO = /^\.(webm|mp4)$/i;
export const isImageFile = (post) => IMAGE.test(post?.ext || '');
export const isVideoFile = (post) => VIDEO.test(post?.ext || '');

/**
 * How a post's file is drawn: 'none' (no file), 'gone' (deleted), 'line'
 * (work mode: a one-line link that shows it; `shown` = clicked this
 * session), 'spoiler' (a blank "Spoiler" box until it is opened) or
 * 'thumb'. `hasFile`: the post has a file to show (by default, a `tim`).
 */
export function fileView(post, display = displayDefaults(), { shown = false, hasFile = Boolean(post?.tim) } = {}) {
  if (post?.filedeleted) return 'gone';
  if (!hasFile) return 'none';
  if (display?.hideImages && !shown) return 'line';
  if (post.spoiler && !display?.revealSpoilers) return 'spoiler';
  return 'thumb';
}

/** A catalog card's picture: 'none', 'hidden' (work mode), 'spoiler' or
 *  'thumb'. */
export function catalogThumbView(thread, display = displayDefaults()) {
  if (!thread?.tim || thread.filedeleted) return 'none';
  if (display?.hideImages) return 'hidden';
  if (thread.spoiler && !display?.revealSpoilers) return 'spoiler';
  return 'thumb';
}

/** Whether a post's file opens in place when the thread is drawn: images
 *  only (never videos or other files), not in work mode, never a spoiler
 *  that is not revealed, and not one the person closed this session. */
export function autoExpands(post, display = displayDefaults(), { closed = false } = {}) {
  if (!display?.autoExpand || closed) return false;
  if (fileView(post, display) !== 'thumb') return false;
  return isImageFile(post);
}

/** Gallery indices to start loading next to `index`: the next and the
 *  previous file (wrapping round), images only, never the one shown. */
export function preloadIndices(items, index, on = true) {
  const n = Array.isArray(items) ? items.length : 0;
  if (!on || n < 2) return [];
  const out = [];
  for (const d of [1, -1]) {
    const i = (((index + d) % n) + n) % n;
    if (i !== index && !out.includes(i) && items[i] && !items[i].video && IMAGE.test(items[i].ext || '')) out.push(i);
  }
  return out;
}
