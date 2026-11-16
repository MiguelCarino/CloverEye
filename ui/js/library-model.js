// The library (meme gallery): what is kept about each file, and the
// searching, sorting, tagging and look-alike finding over it. No DOM.
//
// An entry: { id (MD5, hex), rel ("<board>/<name>" in the library folder),
//   name (the file's own name), ext, kind, size, w, h, board, thread, post,
//   sub (the thread's subject), text (the post's words), posted (ms),
//   added (ms), tags [], collections [], ai [] (tags the assistant suggested),
//   dhash (look-alike fingerprint, 16 hex digits) }

export const INDEX_VERSION = 1;
export const MAX_TAGS = 40;
/** Two pictures this close (bits of 64) look the same. */
export const LOOKALIKE_BITS = 6;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function emptyIndex() {
  return { version: INDEX_VERSION, items: [], collections: [], folders: {} };
}

/** A tag as kept: lower case, words joined by "-", no odd characters. */
export function normalizeTag(t) {
  return String(t ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[#,;"'`<>]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

const tagList = (v) => [...new Set((Array.isArray(v) ? v : []).map(normalizeTag).filter(Boolean))].slice(0, MAX_TAGS);
const nameList = (v) => [...new Set((Array.isArray(v) ? v : []).map((c) => str(c, 60).trim()).filter(Boolean))].slice(0, 200);

export function kindOf(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'gif') return 'gif';
  if (e === 'webm' || e === 'mp4') return 'video';
  if (e === 'pdf') return 'pdf';
  return 'image';
}

export function normalizeEntry(raw) {
  if (!isObj(raw) || !/^[0-9a-f]{32}$/.test(raw.id) || typeof raw.rel !== 'string' || !raw.rel.includes('/')) return null;
  const ext = str(raw.ext, 8).toLowerCase();
  return {
    id: raw.id,
    rel: str(raw.rel, 400),
    name: str(raw.name, 200) || raw.rel.split('/').pop(),
    ext,
    kind: kindOf(ext),
    size: num(raw.size),
    w: num(raw.w),
    h: num(raw.h),
    board: typeof raw.board === 'string' && /^[a-z0-9]{1,10}$/.test(raw.board) ? raw.board : '',
    thread: num(raw.thread),
    post: num(raw.post),
    sub: str(raw.sub, 200),
    text: str(raw.text, 500),
    posted: num(raw.posted),
    added: num(raw.added),
    tags: tagList(raw.tags),
    collections: nameList(raw.collections),
    ai: tagList(raw.ai),
    dhash: /^[0-9a-f]{16}$/.test(raw.dhash) ? raw.dhash : '',
    folder: str(raw.folder, 1000), // the folder it was imported from ('' = not a folder)
    from: str(raw.from, 1000), // its path inside that folder
  };
}

export function normalizeIndex(raw) {
  if (!isObj(raw)) return emptyIndex();
  const seen = new Set();
  const items = [];
  for (const e of Array.isArray(raw.items) ? raw.items : []) {
    const n = normalizeEntry(e);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      items.push(n);
    }
  }
  const collections = nameList([...(Array.isArray(raw.collections) ? raw.collections : []), ...items.flatMap((e) => e.collections)]);
  // folders imported: how (with sub-folders or not) and when last scanned
  const folders = {};
  for (const [path, f] of Object.entries(isObj(raw.folders) ? raw.folders : {})) {
    if (typeof path === 'string' && path && path.length <= 1000 && isObj(f)) {
      folders[path] = { deep: f.deep !== false, at: num(f.at), removed: (Array.isArray(f.removed) ? f.removed : []).filter((x) => typeof x === 'string').slice(-5000) };
    }
  }
  return { version: INDEX_VERSION, items, collections, folders };
}

// ------------------------------------------------------------------ hashes

/** The site's MD5 (base64, as in a post's `md5`) as hex; '' when not one. */
export function md5Hex(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(b64)) return '';
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

// MD5 (RFC 1321) over bytes, for files brought in from the disk: the same
// sum the site gives its files, so an import is known again in a thread.
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + M[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << S[i]) | (f >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((w) => Array.from({ length: 4 }, (_, i) => ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

/** The look-alike fingerprint (difference hash) from a 9×8 grey picture
 *  (72 values, row by row): each bit says whether a pixel is brighter than
 *  the one to its right. Resizing and re-saving barely change it. */
export function dhash(grey) {
  let hex = '';
  let nibble = 0;
  let n = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      // a step under 2 (of 255) is noise, a flat area's JPEG speckle: 0
      nibble = (nibble << 1) | (grey[y * 9 + x] - grey[y * 9 + x + 1] > 2 ? 1 : 0);
      if (++n % 4 === 0) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

/** Grey values, 9×8, from RGBA pixels of a w×h picture: the average of
 *  each block, so a small detail or a re-save hardly moves them. */
export function greyOf(rgba, w = 9, h = 8) {
  const out = new Array(72).fill(0);
  const n = new Array(72).fill(0);
  for (let y = 0; y < h; y++) {
    const by = Math.min(7, Math.floor((y * 8) / h));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const b = by * 9 + Math.min(8, Math.floor((x * 9) / w));
      out[b] += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      n[b] += 1;
    }
  }
  return out.map((v, i) => (n[i] ? v / n[i] : 0));
}

export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Groups of look-alikes (two or more each), the largest first; within a
 *  group, the biggest file first (the one to keep). */
export function lookalikeGroups(items, bits = LOOKALIKE_BITS) {
  const withHash = items.filter((e) => e.dhash && e.kind !== 'video');
  const parent = withHash.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < withHash.length; i++) {
    for (let j = i + 1; j < withHash.length; j++) {
      if (hamming(withHash[i].dhash, withHash[j].dhash) <= bits) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  withHash.forEach((e, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  });
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => b.w * b.h - a.w * a.h || b.size - a.size))
    .sort((a, b) => b.length - a.length);
}

// ----------------------------------------------------------------- entries

/** A file saved from a post. `post` is the API's post. */
export function entryFromPost({ board, thread, post, subject = '', text = '', rel, size = 0, now = Date.now() }) {
  return normalizeEntry({
    // the site's sum; a post without one (rare) gets one from its file's name
    id: md5Hex(post.md5) || md5(new TextEncoder().encode(`${board}/${post.tim}${post.ext}`)),
    rel,
    name: `${post.filename || post.tim}${post.ext}`,
    ext: String(post.ext || '').replace(/^\./, ''),
    size: size || post.fsize,
    w: post.w,
    h: post.h,
    board,
    thread,
    post: post.no,
    sub: subject,
    text,
    posted: num(post.time) * 1000,
    added: now,
    tags: [],
  });
}

/** When a name is the site's own (a 13-digit time in ms, maybe with three
 *  more digits), the time it was posted. */
export function timeFromName(name) {
  const m = /^(\d{13})(\d{3})?\.[a-z0-9]+$/i.exec(String(name || ''));
  if (!m) return 0;
  const t = Number(m[1]);
  return t > Date.UTC(2003, 0) && t < Date.UTC(2100, 0) ? t : 0;
}

/** A file brought in from the disk. `known` (MD5 hex → { board, thread,
 *  post, sub, text, posted, name }) is what the app has seen in threads:
 *  when the file is one of them, it gets its source back, offline. */
export function entryFromImport({ id, rel, name, size, w = 0, h = 0, known = null, folder = '', from = '', now = Date.now() }) {
  const ext = String(name).split('.').pop().toLowerCase();
  const src = known?.get?.(id) || null;
  return normalizeEntry({
    id,
    rel,
    name: src?.name || name,
    ext,
    size,
    w: w || src?.w || 0,
    h: h || src?.h || 0,
    board: src?.board || '',
    thread: src?.thread || 0,
    post: src?.post || 0,
    sub: src?.sub || '',
    text: src?.text || '',
    posted: src?.posted || timeFromName(name),
    added: now,
    tags: [],
    folder,
    from,
  });
}

/** The folders files were imported from: [[folder, count]], by name. */
export function foldersOf(items, known = []) {
  const m = new Map(known.map((f) => [f, 0]));
  for (const e of items) if (e.folder) m.set(e.folder, (m.get(e.folder) || 0) + 1);
  return [...m].sort((a, b) => folderName(a[0]).localeCompare(folderName(b[0])) || a[0].localeCompare(b[0]));
}

/** A folder's own name, the last part of its path. */
export const folderName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

/** A source filter's value: '' all, 'threads', 'files' (imported one by
 *  one), or 'dir:<path>'. */
function fromSource(e, source) {
  if (!source) return true;
  if (source === 'threads') return Boolean(e.board && e.post) && !e.folder;
  if (source === 'files') return !e.folder && !(e.board && e.post);
  return source.startsWith('dir:') && e.folder === source.slice(4);
}

/** What the app knows about files from the posts it holds: MD5 hex →
 *  source. `threads`: [{ board, posts }] (the opening post first). */
export function knownFiles(threads, plain = (s) => s) {
  const out = new Map();
  for (const t of threads || []) {
    const op = t.posts?.[0];
    const sub = op ? plain(op.sub || '') : '';
    for (const p of t.posts || []) {
      const id = md5Hex(p.md5);
      if (!id || out.has(id)) continue;
      out.set(id, { board: t.board, thread: op?.no || p.no, post: p.no, sub, text: plain(p.com || '').slice(0, 500), posted: num(p.time) * 1000, name: `${p.filename || p.tim}${p.ext}`, w: p.w, h: p.h });
    }
  }
  return out;
}

// --------------------------------------------------------- finding things

export const SORTS = ['added', 'posted', 'size', 'name'];
export const KINDS = ['all', 'image', 'gif', 'video'];

/** The entries a view shows: `q` searches names, tags, subjects and words;
 *  `tag` "untagged" finds those with none. */
export function filterItems(items, { q = '', kind = 'all', board = '', collection = '', tag = '', source = '', sort = 'added' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = items.filter((e) => {
    if (kind !== 'all' && e.kind !== kind) return false;
    if (board && e.board !== board) return false;
    if (collection && !e.collections.includes(collection)) return false;
    if (!fromSource(e, source)) return false;
    if (tag === 'untagged' ? e.tags.length : tag && !e.tags.includes(tag)) return false;
    if (!words.length) return true;
    const hay = `${e.name} ${e.tags.join(' ')} ${e.sub} ${e.text} /${e.board}/ ${e.collections.join(' ')} ${e.from}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const by = {
    added: (a, b) => b.added - a.added,
    posted: (a, b) => (b.posted || b.added) - (a.posted || a.added),
    size: (a, b) => b.size - a.size,
    name: (a, b) => a.name.localeCompare(b.name),
  }[sort] || ((a, b) => b.added - a.added);
  return out.sort(by);
}

/** Tags by how often they are used: [[tag, count]], most first. */
export function tagCounts(items) {
  const m = new Map();
  for (const e of items) for (const t of e.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function boardsOf(items) {
  return [...new Set(items.map((e) => e.board).filter(Boolean))].sort();
}

const STOP = new Set(
  'the and for are but not you all any can had her was one our out has have this that with what when your from they will just like more some than then them these into only also there their about would which been were could should over very much even most such here where while those other being does done dont doesnt didnt cant wont isnt arent anon anons thread threads post posts reply image file jpg png gif webm mp4 pdf general edition http https www com'.split(' '),
);

/** Tags to offer for an entry, from its subject, words and name: the
 *  longer words that come up most, minus those it has. */
export function suggestTags(e, max = 6) {
  const words = `${e.sub} ${e.sub} ${e.text} ${String(e.name).replace(/\.[a-z0-9]+$/i, '')}`
    .toLowerCase()
    .replace(/>>\d+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && w.length <= 30 && !/^\d+$/.test(w) && !STOP.has(w));
  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  const have = new Set(e.tags);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([w]) => normalizeTag(w))
    .filter((t) => t && !have.has(t))
    .slice(0, max);
}

// ------------------------------------------------------- the assistant

/** Models that can look at pictures, by name (the servers do not say). */
export function visionModels(models) {
  return (models || []).filter((m) => /llava|vision|moondream|bakllava|minicpm-v|qwen2\.5-?vl|qwen-?vl|qwen3-?vl|gemma3|pixtral|llama4|mistral-small3\.[12]/i.test(m));
}

export const AI_TAG_PROMPT =
  'Describe this picture as tags for finding it again in a meme collection: who or what is in it (name the meme, character or format if you know it), the mood, and any words written on it. Answer only with 3 to 8 short lowercase tags, separated by commas.';

/** The chat messages that ask a model for tags; `jpeg` is base64. Ollama
 *  takes pictures in `images`; the others, as a data URL. */
export function aiTagMessages(kind, jpeg) {
  if (kind === 'ollama') return [{ role: 'user', content: AI_TAG_PROMPT, images: [jpeg] }];
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: AI_TAG_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
      ],
    },
  ];
}

/** Tags out of a model's answer. */
export function parseAiTags(text, max = 8) {
  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[^:\n]{0,40}:\s*/, '');
  return [...new Set(cleaned.split(/[,\n;]+/).map((t) => normalizeTag(t.replace(/^[\s\-*\d.)]+/, ''))).filter((t) => t && t.length >= 2))].slice(0, max);
}
