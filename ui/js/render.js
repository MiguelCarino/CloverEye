// Reads a post's `com` (the API's HTML) into plain segments, so the UI builds
// DOM with textContent only and never inserts the site's HTML. DOM-free.

const VOID = new Set(['img', 'hr', 'input', 'meta', 'link', 'source', 'col', 'area', 'embed', 'track']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? decodeEntities(m[1]) : '';
};

// A board link: the site's "/g/" or "/g/catalog#s=term", with or without its host.
const BOARD_HREF = /^(?:(?:https?:)?\/\/boards\.4chan(?:nel)?\.org)?\/([a-z0-9]{1,10})\/(?:catalog(?:#s=([^#]*))?)?$/i;

function searchTerm(raw) {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
  } catch {
    return raw.replace(/\+/g, ' ').trim();
  }
}

/** What an <a class="quotelink"> points at, or null for an address that is
 *  neither a post nor a board (its text then reads as plain text). */
function linkOf(href) {
  const n = href.match(/#p(\d+)$/);
  if (n) {
    const link = { target: Number(n[1]) };
    // Another thread's post: "/g/thread/999#p1000" (same-thread links are "#p1000").
    const x = href.match(/\/([a-z0-9]{1,10})\/thread\/(\d+)(?:\/[^#]*)?#p\d+$/i);
    if (x) {
      link.board = x[1].toLowerCase();
      link.thread = Number(x[2]);
    }
    return link;
  }
  const b = href.match(BOARD_HREF);
  if (b) return { boardlink: true, board: b[1].toLowerCase(), search: searchTerm(b[2]) };
  return null;
}

function parse(html) {
  const lines = [[]];
  const stack = []; // open styled elements: 'greentext' | 'spoiler' | 'code' | 'deadlink' | 'other'
  let link = null; // current <a class="quotelink">
  // A link, a dead link or a <pre> just opened or closed: the next text
  // starts its own segment, so two of them side by side stay two. Text split
  // by <wbr> or entities inside one element still joins.
  let fresh = false;
  const re = /<[^>]*>|[^<]+/g;
  let m;
  const push = (text) => {
    if (!text) return;
    let top;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] !== 'other') {
        top = stack[i];
        break;
      }
    }
    let seg;
    if (link?.boardlink) {
      seg = { type: 'boardlink', text, board: link.board };
      if (link.search) seg.search = link.search;
    } else if (link) {
      seg = { type: 'quotelink', text };
      if (link.target) seg.target = link.target;
      if (link.thread) {
        seg.board = link.board;
        seg.thread = link.thread;
      }
    } else {
      seg = { type: top || 'text', text };
    }
    // greentext, a link or code inside a spoiler stays hidden with it
    if (seg.type !== 'spoiler' && stack.includes('spoiler')) seg.spoiler = true;
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    if (
      prev &&
      !fresh &&
      prev.type === seg.type &&
      prev.target === seg.target &&
      prev.board === seg.board &&
      prev.thread === seg.thread &&
      prev.search === seg.search &&
      prev.spoiler === seg.spoiler
    )
      prev.text += text;
    else line.push(seg);
    fresh = false;
  };
  while ((m = re.exec(html)) !== null) {
    const tok = m[0];
    if (tok[0] !== '<') {
      push(decodeEntities(tok));
      continue;
    }
    const close = tok[1] === '/';
    const name = (tok.match(/^<\/?\s*([a-z0-9]+)/i) || [])[1]?.toLowerCase() || '';
    if (name === 'br') {
      // inside <pre> a <br> is a line of the code: one block, not one per line
      if (stack.includes('code') && !link) push('\n');
      else lines.push([]);
      continue;
    }
    if (name === 'wbr') continue;
    if (name === 'a') {
      if (link) fresh = true; // a link closes (or a new one opens over it)
      link = close ? null : /\bquotelink\b/.test(attr(tok, 'class')) ? linkOf(attr(tok, 'href')) : null;
      if (link) fresh = true;
      continue;
    }
    if (close) {
      const kind = stack.pop();
      if (kind === 'code') {
        // a <br> right before </pre> is not a blank last line
        const line = lines[lines.length - 1];
        const last = line[line.length - 1];
        if (last?.type === 'code' && last.text.endsWith('\n')) {
          last.text = last.text.slice(0, -1);
          if (!last.text) line.pop();
        }
      }
      if (kind === 'deadlink' || kind === 'code') fresh = true;
      continue;
    }
    if (VOID.has(name) || /\/\s*>$/.test(tok)) continue; // nothing to close later
    const cls = attr(tok, 'class');
    let kind = 'other';
    if (name === 'span' && /\bquote\b/.test(cls)) kind = 'greentext';
    else if (name === 'span' && /\bdeadlink\b/.test(cls)) kind = 'deadlink';
    else if (name === 's') kind = 'spoiler';
    else if (name === 'pre') kind = 'code';
    if (kind === 'deadlink' || kind === 'code') fresh = true;
    stack.push(kind);
  }
  return lines;
}

// Parsed comments by their HTML. A redraw reads every comment several times
// (the post, backlinks, filters, tags, search), and the same comments again
// on the next redraw. Two generations: once the newer one is full it becomes
// the older one, so a walk over more comments than one generation holds
// still finds the ones it read last time.
const CACHE_SIZE = 4000;
const memo = () => ({ now: new Map(), old: new Map() });
const parsed = memo();
const texts = memo();

function cacheGet(c, key) {
  let v = c.now.get(key);
  if (v !== undefined) return v;
  v = c.old.get(key);
  if (v !== undefined) cacheSet(c, key, v);
  return v;
}

function cacheSet(c, key, v) {
  if (c.now.size >= CACHE_SIZE) {
    c.old = c.now;
    c.now = new Map();
  }
  c.now.set(key, v);
  return v;
}

function freezeLines(lines) {
  for (const line of lines) {
    for (const seg of line) Object.freeze(seg);
    Object.freeze(line);
  }
  return Object.freeze(lines);
}

/**
 * @returns {ReadonlyArray<ReadonlyArray<{type: string, text: string, target?: number}>>}
 *   lines of segments. Types: text, greentext, quotelink, deadlink,
 *   spoiler, code, boardlink. A quotelink to another thread also has board
 *   and thread. A boardlink (">>>/g/", ">>>/g/catalog#s=term") has board
 *   and, for a catalog search, search. A segment inside a spoiler that is
 *   not a 'spoiler' segment itself (greentext, a link, code) has
 *   spoiler: true. A <pre> is one code segment with its lines joined by
 *   "\n". Results are shared between callers and frozen: read only.
 */
export function parseComment(html) {
  const key = String(html || '');
  return cacheGet(parsed, key) || cacheSet(parsed, key, freezeLines(parse(key)));
}

/** Text made safe to put in HTML. */
export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A comment as typed, in the site's HTML (what parseComment reads): >>N
 *  as a quote link, a line starting with ">" as greentext, line breaks as
 *  <br>. */
export function commentHtml(com) {
  return String(com || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const html = escapeHtml(line).replace(/&gt;&gt;(\d{1,12})/g, '<a href="#p$1" class="quotelink">&gt;&gt;$1</a>');
      return /^>(?!>\d)/.test(line) ? `<span class="quote">${html}</span>` : html;
    })
    .join('<br>');
}

/** Plain text of a comment (for search and previews). */
export function commentText(html) {
  const key = String(html || '');
  const hit = cacheGet(texts, key);
  if (hit !== undefined) return hit;
  const text = parseComment(key)
    .map((line) => line.map((s) => s.text).join(''))
    .join('\n');
  return cacheSet(texts, key, text);
}

/** Post numbers a comment quotes (for backlinks). */
export function quotedPosts(html) {
  const out = [];
  for (const line of parseComment(html)) {
    for (const s of line) if (s.type === 'quotelink' && s.target && !out.includes(s.target)) out.push(s.target);
  }
  return out;
}

/** Map of post number → numbers of the posts that quote it. */
export function backlinks(posts) {
  const map = new Map();
  for (const p of posts || []) {
    for (const q of quotedPosts(p.com)) {
      if (!map.has(q)) map.set(q, []);
      map.get(q).push(p.no);
    }
  }
  return map;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** A post's file name as the poster gave it (the API escapes it as HTML),
 *  with its extension; the post's tim when it has no name. For showing and
 *  as the name to save under (saveName / safe_name still clean it). */
export function postFileName(p) {
  return `${p?.filename ? decodeEntities(p.filename) : (p?.tim ?? 'file')}${p?.ext || ''}`;
}
