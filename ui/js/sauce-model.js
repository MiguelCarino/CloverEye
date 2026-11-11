// Reverse image search ("sauce"): the links each file in a thread offers.
// DOM-free. A link only carries the file's address on the image host; the
// site picked fetches it from there. Nothing is sent until one is opened,
// and it opens in the system browser (bridge.openExternal).

const MEDIA_BASE = 'https://i.4cdn.org';

/** The sites, in the order the menu and Settings list them. `url` builds
 *  the search address from the file's (https) address. */
export const SAUCE_ENGINES = Object.freeze([
  { id: 'saucenao', label: 'SauceNAO', url: (u) => `https://saucenao.com/search.php?url=${encodeURIComponent(u)}` },
  { id: 'lens', label: 'Google Lens', url: (u) => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}` },
  { id: 'yandex', label: 'Yandex', url: (u) => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}` },
  { id: 'iqdb', label: 'IQDB', url: (u) => `https://iqdb.org/?url=${encodeURIComponent(u)}` },
  { id: 'tineye', label: 'TinEye', url: (u) => `https://tineye.com/search?url=${encodeURIComponent(u)}` },
  { id: 'tracemoe', label: 'trace.moe', url: (u) => `https://trace.moe/?url=${encodeURIComponent(u)}` },
]);

export const SAUCE_IDS = Object.freeze(SAUCE_ENGINES.map((e) => e.id));
export const DEFAULT_SAUCE = Object.freeze(['saucenao', 'lens', 'yandex', 'iqdb']);

/** Files the search sites can read as they are. Anything
 *  else (video, PDF, Flash) is searched by its thumbnail. */
const PICTURE = /^\.(jpe?g|png|gif|webp)$/i;

/** Stored engine choices → known ids, once each, in the menu's order.
 *  Not an array → the default; an empty array stays empty (no button). */
export function normalizeSauce(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_SAUCE];
  const set = new Set(raw);
  return SAUCE_IDS.filter((id) => set.has(id));
}

/** The address searched for a post's file: the file itself for a picture,
 *  the thumbnail for a video or anything else. null when there is no file
 *  (or it was deleted) or the parts don't look like the site's own. */
export function sauceSource(board, post) {
  if (!post || post.filedeleted) return null;
  if (!/^[a-z0-9]{1,10}$/.test(String(board || ''))) return null;
  const tim = post.tim;
  if (!(Number.isSafeInteger(tim) && tim > 0) && !(typeof tim === 'string' && /^\d{1,20}$/.test(tim))) return null;
  const ext = typeof post.ext === 'string' ? post.ext : '';
  if (PICTURE.test(ext)) return `${MEDIA_BASE}/${board}/${tim}${ext.toLowerCase()}`;
  return `${MEDIA_BASE}/${board}/${tim}s.jpg`;
}

/** One engine's search address for a source address, or null when the
 *  engine is unknown or the source is not an http(s) address. */
export function sauceUrl(engine, source) {
  const e = SAUCE_ENGINES.find((x) => x.id === engine);
  if (!e || typeof source !== 'string') return null;
  let u;
  try {
    u = new URL(source);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return e.url(u.href);
}

/** The menu for a post's file: [{ id, label, url }] for each chosen engine,
 *  [] when the post has no searchable file or none is chosen. */
export function sauceLinks(board, post, engines = DEFAULT_SAUCE) {
  const src = sauceSource(board, post);
  if (!src) return [];
  return normalizeSauce(engines)
    .map((id) => ({ id, label: SAUCE_ENGINES.find((e) => e.id === id).label, url: sauceUrl(id, src) }))
    .filter((l) => l.url);
}
