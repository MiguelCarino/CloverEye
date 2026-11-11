// Web links in post text, and which of them can play in the app. Post text is
// untrusted: only http and https addresses become links (a bare "www.…" or
// "domain.tld/…" is taken as https), and they open in the system browser.
// An embed is a click-to-load frame on one of EMBED_HOSTS; nothing loads
// before the person asks for it. DOM-free, so it runs under `node --test`.

/** Settings → Content → Embeds. */
export const EMBED_MODES = Object.freeze(['off', 'click']);

/** The frame addresses an embed may load: tauri.conf.json and ui/index.html
 *  allow exactly these in `frame-src` (tests/link-model.test.mjs checks). */
export const EMBED_HOSTS = Object.freeze([
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://streamable.com',
  'https://w.soundcloud.com',
]);

export const MAX_URL = 2048;

// Stops: spaces, markup characters, and CJK / full-width punctuation.
const STOP = '<>"`\\s\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65';
const CANDIDATE = new RegExp(
  `(?:https?:\\/\\/|www\\.)[^${STOP}]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24}\\/[^${STOP}]*`,
  'gi',
);
// A link never starts in the middle of a word, an e-mail address or another
// address (a "javascript:" address that ends in a domain name does not make
// that domain a link).
const GLUED = /[\p{L}\p{N}_@.\/\\:%&=+~#$-]/u;
const TRAILING = /[.,;:!?\x27\x22*~_]/; // \x27 ' and \x22 " (tools/i18n-strings.mjs reads quotes as strings)
const PAIRS = { ')': '(', ']': '[', '}': '{' };
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const count = (s, c) => s.split(c).length - 1;

/** Drops the punctuation a sentence puts after an address: "(see
 *  a.org/x)." loses ")." but "a.org/wiki/Foo_(bar)" keeps its ")". */
export function trimTrailing(s) {
  let out = String(s);
  for (;;) {
    const c = out.at(-1);
    if (c === undefined) return out;
    if (TRAILING.test(c)) out = out.slice(0, -1);
    else if (PAIRS[c] && count(out, PAIRS[c]) < count(out, c)) out = out.slice(0, -1);
    else return out;
  }
}

/**
 * The address a piece of post text links to, or null when it is not a web
 * link. Only http and https; no "user:password@" (it disguises the host);
 * a host name with a real top-level domain (an IPv4 address only with the
 * scheme written out).
 */
export function linkHref(raw) {
  const text = String(raw ?? '');
  if (!text || text.length > MAX_URL || /[\u0000-\u001f\u007f\s]/.test(text)) return null;
  const explicit = /^https?:\/\//i.test(text);
  if (!explicit && /^[a-z][a-z0-9+.-]*:/i.test(text)) return null; // another scheme
  let u;
  try {
    u = new URL(explicit ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname;
  if (!(HOST.test(host) || (explicit && IPV4.test(host)))) return null;
  return u.href.length > MAX_URL ? null : u.href;
}

/**
 * Splits text into parts, in order, that together are the whole text:
 * { text } plain, or { text, href } a link (text as written, href as
 * opened). 4chan breaks long words with <wbr>; render.js drops those, so an
 * address comes here in one piece.
 */
export function findLinks(text) {
  const s = String(text ?? '');
  const parts = [];
  let last = 0;
  CANDIDATE.lastIndex = 0;
  let m;
  while ((m = CANDIDATE.exec(s)) !== null) {
    const start = m.index;
    if (start > 0 && GLUED.test(s[start - 1])) continue;
    const raw = trimTrailing(m[0]);
    const href = linkHref(raw);
    if (!href) continue;
    if (start > last) parts.push({ text: s.slice(last, start) });
    parts.push({ text: raw, href });
    last = start + raw.length;
    CANDIDATE.lastIndex = last;
  }
  if (last < s.length || !parts.length) parts.push({ text: s.slice(last) });
  return parts;
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds; 0 when it is none of those. */
export function parseStart(v) {
  const m = String(v ?? '').match(/^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  const n = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return n > 0 && n <= 86400 ? n : 0;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);

function youtube(u) {
  const path = u.pathname.split('/').filter(Boolean);
  let id = null;
  let shorts = false;
  if (u.hostname === 'youtu.be') id = path[0];
  else if (YT_HOSTS.has(u.hostname)) {
    if (path[0] === 'watch' && path.length === 1) id = u.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(path[0]) && path.length === 2) {
      id = path[1];
      shorts = path[0] === 'shorts';
    }
  } else return null;
  if (!id || !YT_ID.test(id)) return null;
  const start = parseStart(u.searchParams.get('t') || u.searchParams.get('start'));
  return {
    kind: 'youtube',
    label: 'YouTube',
    id,
    src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ''}`,
    ratio: shorts ? '9 / 16' : '16 / 9',
  };
}

function vimeo(u) {
  if (!['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(u.hostname)) return null;
  const path = u.pathname.split('/').filter(Boolean);
  let id = null;
  let hash = u.searchParams.get('h');
  if (u.hostname === 'player.vimeo.com') {
    if (path[0] === 'video' && path.length === 2) id = path[1];
  } else if (/^\d+$/.test(path[0] || '') && path.length <= 2) {
    id = path[0];
    hash = path[1] || hash;
  } else if (path[0] === 'channels' && path.length === 3) id = path[2];
  else if (path[0] === 'groups' && path[2] === 'videos' && path.length === 4) id = path[3];
  if (!id || !/^\d{1,12}$/.test(id)) return null;
  const h = hash && /^[0-9a-f]{6,20}$/i.test(hash) ? hash : null;
  return {
    kind: 'vimeo',
    label: 'Vimeo',
    id,
    src: `https://player.vimeo.com/video/${id}?dnt=1&autoplay=1${h ? `&h=${h}` : ''}`,
    ratio: '16 / 9',
  };
}

const STREAMABLE_PAGES = new Set(['login', 'signup', 'upload', 'pricing', 'about', 'terms', 'privacy', 'settings', 'clipper', 'documentation', 'blog', 'careers', 'community', 'tools', 'support', 'videos', 'help']);

function streamable(u) {
  if (!['streamable.com', 'www.streamable.com'].includes(u.hostname)) return null;
  const path = u.pathname.split('/').filter(Boolean);
  const code = path.length === 1 ? path[0] : path.length === 2 && ['e', 'o', 's'].includes(path[0]) ? path[1] : null;
  if (!code || !/^[a-z0-9]{3,12}$/i.test(code) || STREAMABLE_PAGES.has(code.toLowerCase())) return null;
  return { kind: 'streamable', label: 'Streamable', id: code, src: `https://streamable.com/e/${code}?autoplay=1`, ratio: '16 / 9' };
}

const SC_PAGES = new Set(['discover', 'stream', 'search', 'upload', 'you', 'charts', 'pages', 'settings', 'messages', 'notifications', 'terms-of-use', 'imprint', 'pro', 'mobile', 'people', 'tags', 'popular', 'jobs', 'signin', 'feed', 'home']);
const SC_TABS = new Set(['tracks', 'sets', 'likes', 'reposts', 'followers', 'following', 'albums', 'popular-tracks', 'comments', 'spotlight']);

function soundcloud(u) {
  if (!['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'].includes(u.hostname)) return null;
  const path = u.pathname.split('/').filter(Boolean);
  const seg = /^[A-Za-z0-9_-]{1,100}$/;
  if (!path.every((p) => seg.test(p)) || SC_PAGES.has(path[0])) return null;
  const set = path.length === 3 && path[1] === 'sets';
  if (!set && !(path.length === 2 && !SC_TABS.has(path[1]))) return null;
  const page = `https://soundcloud.com/${path.join('/')}`;
  return {
    kind: 'soundcloud',
    label: 'SoundCloud',
    id: path.join('/'),
    src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(page)}&auto_play=true&visual=false&show_comments=false`,
    height: set ? 360 : 166,
  };
}

/**
 * What a link can play in the app: { kind, label, id, src, ratio | height },
 * or null (Twitter/X and everything else stay plain links: their embeds
 * need the site's own scripts in the page). `src` is always on EMBED_HOSTS.
 */
export function embedFor(href) {
  let u;
  try {
    u = new URL(String(href ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return youtube(u) || vimeo(u) || streamable(u) || soundcloud(u);
}
