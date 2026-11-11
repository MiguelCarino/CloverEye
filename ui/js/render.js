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

/**
 * @returns {Array<Array<{type: string, text: string, target?: number}>>}
 *   lines of segments. Types: text, greentext, quotelink, deadlink,
 *   spoiler, code. A quotelink to another thread also has board and thread.
 */
export function parseComment(html) {
  const lines = [[]];
  const stack = []; // open styled elements: 'greentext' | 'spoiler' | 'code' | 'deadlink' | 'other'
  let link = null; // current <a class="quotelink">
  const re = /<[^>]*>|[^<]+/g;
  let m;
  const push = (text) => {
    if (!text) return;
    const top = [...stack].reverse().find((t) => t !== 'other');
    let seg;
    if (link) {
      seg = { type: 'quotelink', text };
      if (link.target) seg.target = link.target;
      if (link.thread) {
        seg.board = link.board;
        seg.thread = link.thread;
      }
    } else {
      seg = { type: top || 'text', text };
    }
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    if (prev && prev.type === seg.type && prev.target === seg.target) prev.text += text;
    else line.push(seg);
  };
  while ((m = re.exec(String(html || ''))) !== null) {
    const tok = m[0];
    if (tok[0] !== '<') {
      const text = decodeEntities(tok);
      // Inside <pre> the API uses <br> for line breaks too, keep them as lines.
      push(text);
      continue;
    }
    const close = tok[1] === '/';
    const name = (tok.match(/^<\/?\s*([a-z0-9]+)/i) || [])[1]?.toLowerCase() || '';
    if (name === 'br') {
      lines.push([]);
      continue;
    }
    if (name === 'wbr') continue;
    if (name === 'a') {
      if (close) {
        link = null;
      } else {
        const cls = attr(tok, 'class');
        const href = attr(tok, 'href');
        if (/\bquotelink\b/.test(cls)) {
          const n = href.match(/#p(\d+)$/);
          link = { target: n ? Number(n[1]) : null };
          // Another thread's post: "/g/thread/999#p1000" (same-thread links are "#p1000").
          const x = href.match(/\/([a-z0-9]{1,10})\/thread\/(\d+)(?:\/[^#]*)?#p\d+$/i);
          if (x) {
            link.board = x[1].toLowerCase();
            link.thread = Number(x[2]);
          }
        } else {
          link = null;
        }
      }
      continue;
    }
    if (close) {
      if (stack.length) stack.pop();
      continue;
    }
    if (VOID.has(name) || /\/\s*>$/.test(tok)) continue; // nothing to close later
    const cls = attr(tok, 'class');
    let kind = 'other';
    if (name === 'span' && /\bquote\b/.test(cls)) kind = 'greentext';
    else if (name === 'span' && /\bdeadlink\b/.test(cls)) kind = 'deadlink';
    else if (name === 's') kind = 'spoiler';
    else if (name === 'pre') kind = 'code';
    stack.push(kind);
  }
  return lines;
}

/** Plain text of a comment (for search and previews). */
export function commentText(html) {
  return parseComment(html)
    .map((line) => line.map((s) => s.text).join(''))
    .join('\n');
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
