// Posting from inside the app (SCOPE §3.3): checks before a post goes out,
// metadata cleaning, the captcha's state, and reading the site's answer.
// No DOM, so it runs under `node --test`.

import { decodeEntities } from './render.js';

// ------------------------------------------------------------ pre-flight

const VIDEO = /\.(webm|mp4)$/i;

/** Problems that would make the site refuse the post, found before it
 *  goes out. `board` is the boards.json entry (may be null: then only the
 *  generic checks run). Returns a list of { field, message }. */
export function preflight({ board = null, isThread = false, com = '', sub = '', file = null, captcha = null, now = Date.now(), cooldownUntil = 0 } = {}) {
  const out = [];
  const text = String(com || '');
  if (!text.trim() && !file) out.push({ field: 'com', message: 'Write a comment or attach a file.' });
  const maxChars = board?.max_comment_chars;
  if (maxChars && text.length > maxChars) out.push({ field: 'com', message: `The comment is ${text.length} characters; this board allows ${maxChars}.` });
  if (isThread && board?.require_subject && !String(sub || '').trim()) out.push({ field: 'sub', message: 'This board needs a subject for a new thread.' });
  if (isThread && !file) out.push({ field: 'file', message: 'A new thread needs a file.' });
  if (file) {
    const isVideo = VIDEO.test(file.name || '');
    const limit = isVideo ? board?.max_webm_filesize : board?.max_filesize;
    if (limit && file.size > limit) {
      out.push({ field: 'file', message: `${file.name} is ${fmtMB(file.size)}; this board allows ${fmtMB(limit)} for ${isVideo ? 'videos' : 'images'}.` });
    }
    if (board && !/\.(jpe?g|png|gif|webm|mp4|pdf)$/i.test(file.name || '')) {
      out.push({ field: 'file', message: 'The site takes JPG, PNG, GIF, WebM and MP4 files (PDF on some boards).' });
    }
  }
  if (captcha?.state === 'ready' && !captchaDone(captcha)) out.push({ field: 'captcha', message: 'Finish the captcha: pick an answer for every step.' });
  if (captcha && captcha.state !== 'ready' && captcha.state !== 'none') out.push({ field: 'captcha', message: 'Get and solve the captcha first.' });
  if (cooldownUntil > now) out.push({ field: 'submit', message: `Wait ${Math.ceil((cooldownUntil - now) / 1000)} s: the board's cooldown.` });
  return out;
}

const fmtMB = (n) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Seconds to wait after a post on this board (boards.json cooldowns). */
export function cooldownSeconds(board, { isThread = false, hasFile = false } = {}) {
  const c = board?.cooldowns || {};
  if (isThread) return c.threads || 0;
  return (hasFile ? c.images : c.replies) || c.replies || 0;
}

// -------------------------------------------------------------- captcha

/** Seconds before New captcha may ask again after the abuse check said no. */
export const ABUSE_CHECK_WAIT_S = 60;

/** Reads what the site's captcha frame sent (its own tcaptcha.js reads the
 *  same object) into a state the form draws:
 *  - { challenge, ttl, tasks: [{ str | img, items: [png…] }] }: a puzzle.
 *    For each task the person slides through `items`, picks the one that
 *    matches the prompt, and the answer is the picked positions joined.
 *  - { challenge } without tasks: no captcha needed this time.
 *  - { pcd, pcd_msg }: wait before a captcha may be asked for.
 *  - { mpcd, sitekey }: the site wants an hCaptcha first (not shown here).
 *  - { error, cd }: an error, often with a cooldown.
 *  While `until` is ahead, New captcha waits (as on the site's own form). */
export function captchaState(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return { state: 'error', message: 'The captcha did not load.' };
  const text = (v) => decodeEntities(String(v || '')).replace(/<[^>]+>/g, '').trim();
  if (data.mpcd) {
    return { state: 'blocked', message: 'The site wants an extra check (hCaptcha) before this captcha. Post on the site’s page this time.' };
  }
  if (data.pcd) {
    return { state: 'wait', message: text(data.pcd_msg) || 'The site asks you to wait before the next captcha.', until: now + Number(data.pcd) * 1000 };
  }
  if (data.error) {
    const cd = Number(data.cd || 0);
    const said = text(data.error);
    // The site's abuse check (spur.us, mcl.io) turned this connection away.
    // Asking again at once only adds to what it counts: New captcha waits a
    // minute, and the message says what helps.
    if (/spur\.us|mcl\.io/i.test(said) && !cd) {
      return {
        state: 'error',
        message: `The site’s abuse check (spur.us) turned this connection away (it says: “${said}”). It usually clears after a few minutes; it happens more often through a VPN or a Tailscale exit node, and after many captchas in a row. New captcha unlocks when the wait is over.`,
        until: now + ABUSE_CHECK_WAIT_S * 1000,
      };
    }
    const message = said || 'The captcha did not load.';
    return { state: cd ? 'wait' : 'error', message, until: cd ? now + cd * 1000 : 0 };
  }
  if (!data.challenge) return { state: 'error', message: 'The captcha came back in a shape CloverEye does not know.' };
  if (!Array.isArray(data.tasks) || !data.tasks.length) return { state: 'none', challenge: String(data.challenge) };
  const tasks = data.tasks.map((t) => ({
    prompt: t && t.str ? text(t.str) : '',
    // The thing to find: the site puts its picture inside the question's
    // markup (an <img> floated right). Only an inline picture is taken.
    target: t && t.str ? targetImg(t.str) : null,
    promptImg: t && t.img ? dataUrl(t.img) : null,
    items: Array.isArray(t?.items) ? t.items.map(dataUrl) : [],
  }));
  if (tasks.some((t) => !t.items.length)) return { state: 'error', message: 'The captcha came back in a shape CloverEye does not know.' };
  return {
    state: 'ready',
    challenge: String(data.challenge),
    tasks,
    step: 0, // which task
    current: firstView(tasks[0]), // 0 = the prompt; 1..n = items[n-1]
    picks: [],
    expires: now + (Number(data.ttl) || 120) * 1000,
  };
}

// Where a task opens. A question that is a picture opens on it; a question
// in words opens on the first choice: the site's choices carry the picture
// the words point at ("the object on the right"), so an empty view would
// show nothing to compare. Nothing is kept until the person says so.
const firstView = (task) => (task && !task.promptImg && task.items.length ? 1 : 0);

const targetImg = (html) => {
  const m = /<img\b[^>]*\bsrc\s*=\s*["'](data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)["']/i.exec(String(html));
  return m ? m[1] : null;
};

const dataUrl = (b64) => (String(b64).startsWith('data:') ? String(b64) : `data:image/png;base64,${b64}`);

/** The captcha is answered: one pick per task. */
export const captchaDone = (c) => c?.state === 'none' || (c?.state === 'ready' && c.picks.length === c.tasks.length);

/** Shows item `n` (0 = the prompt) of the current task. */
export function captchaShow(c, n) {
  if (c?.state !== 'ready' || c.step >= c.tasks.length) return c;
  const max = c.tasks[c.step].items.length;
  return { ...c, current: Math.max(0, Math.min(max, Math.round(Number(n) || 0))) };
}

/** Keeps the shown item as this task's answer and moves on. */
export function captchaNext(c) {
  if (c?.state !== 'ready' || c.current < 1 || c.step >= c.tasks.length) return c;
  const step = c.step + 1;
  return { ...c, picks: [...c.picks, c.current - 1], step, current: step < c.tasks.length ? firstView(c.tasks[step]) : 0 };
}

/** The answer the post form sends: the picks, joined. */
export const captchaAnswer = (c) => (c?.state === 'ready' ? c.picks.join('') : '');

// ------------------------------------------------------- the site's answer

/** The post endpoint answers with HTML. Success carries a comment
 *  `<!-- thread:T,no:N -->` (T = 0 for a new thread, then N is the thread);
 *  an error carries `<span id="errmsg" ...>message</span>`. */
export function parsePostResponse(html, status = 200) {
  const s = String(html || '');
  const ok = s.match(/<!--\s*thread:(\d+),no:(\d+)\s*-->/);
  if (ok) {
    const thread = Number(ok[1]);
    const no = Number(ok[2]);
    return { ok: true, thread: thread || no, no };
  }
  const err = s.match(/id="errmsg"[^>]*>([\s\S]*?)<\/span>/i);
  if (err) return { ok: false, message: decodeEntities(err[1].replace(/<[^>]+>/g, '')).trim() };
  if (status === 403 || /cloudflare|cf-chl|challenge-platform/i.test(s)) {
    return { ok: false, message: 'The site asked for a browser check. Complete it in the window that opened, then post again.', check: true };
  }
  return { ok: false, message: `The site answered without saying whether the post went through (HTTP ${status}).` };
}

// ------------------------------------------------------- metadata cleaning

/** Strips location and camera data before upload: JPEG APP1 (EXIF/XMP),
 *  APP13 (IPTC) and COM segments; PNG tEXt, iTXt, zTXt and eXIf chunks.
 *  Anything else is returned unchanged. Returns { bytes, removed }. */
export function stripMetadata(bytes, name = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8) return stripJpeg(u8);
  if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return stripPng(u8);
  void name;
  return { bytes: u8, removed: 0 };
}

function stripJpeg(u8) {
  const parts = [u8.subarray(0, 2)];
  let i = 2;
  let removed = 0;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xff) break; // not a marker: leave the rest as it is
    const marker = u8[i + 1];
    if (marker === 0xda) break; // start of scan: image data follows
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(u8.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2 || i + 2 + len > u8.length) break;
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (drop) removed += 1;
    else parts.push(u8.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(u8.subarray(i));
  return { bytes: concat(parts), removed };
}

const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

function stripPng(u8) {
  const parts = [u8.subarray(0, 8)];
  let i = 8;
  let removed = 0;
  while (i + 12 <= u8.length) {
    const len = ((u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3]) >>> 0;
    const type = String.fromCharCode(u8[i + 4], u8[i + 5], u8[i + 6], u8[i + 7]);
    const end = i + 12 + len;
    if (end > u8.length) break;
    if (PNG_DROP.has(type)) removed += 1;
    else parts.push(u8.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  if (i < u8.length) parts.push(u8.subarray(i));
  return { bytes: concat(parts), removed };
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Base64 of bytes, in chunks (files run to several MB). */
export function toBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

/** The fields the site's post form sends. `pwd` is the deletion password. */
export function postFields({ isThread, thread, name = '', email = '', sub = '', com = '', spoiler = false, challenge = '', response = '', pwd = '' }) {
  const f = { mode: 'regist', name, email, com, pwd };
  if (!isThread) f.resto = String(thread);
  if (sub) f.sub = sub;
  if (spoiler) f.spoiler = 'on';
  if (challenge) f['t-challenge'] = challenge;
  if (challenge && challenge !== 'noop') f['t-response'] = String(response || '').trim();
  return f;
}

// ------------------------------------------------------------- quoting

/** The lines a reply starts with when it quotes post `no`: ">>N", then the
 *  text selected in that post as greentext ("> line"). Blank lines at the
 *  ends are dropped, ones inside kept as ">"; ends with a line break. */
export function quoteText(no, selection = '') {
  const lines = String(selection || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const out = [];
  if (Number.isSafeInteger(no) && no > 0) out.push(`>>${no}`);
  for (const l of lines) out.push(l.trim() ? `> ${l}` : '>');
  return out.length ? `${out.join('\n')}\n` : '';
}

/** The app's own controls inside a post's comment (quoted copies opened
 *  in it, Embed buttons after links, archive links after dead quotes):
 *  never part of what the poster wrote, so never quoted. */
export const UI_ONLY_IN_COMMENT = '.quote-inline, .seg-embed, .archive-link';

/** The text of a cloned piece of a comment (`box`, a DOM element), one
 *  line per .post__line, without the app's own controls. */
export function selectionText(box) {
  if (!box) return '';
  box.querySelectorAll(UI_ONLY_IN_COMMENT).forEach((n) => n.remove());
  const lines = [...box.querySelectorAll('.post__line')];
  return lines.length ? lines.map((l) => l.textContent).join('\n') : box.textContent;
}

/** Puts `snippet` into `text` at `pos` (the caret; past the end or not a
 *  number: the end), on lines of its own. Returns { text, caret }, the
 *  caret just after what went in. */
export function insertAtCaret(text, pos, snippet) {
  const t = String(text || '');
  const s = String(snippet || '');
  const at = Number.isFinite(pos) ? Math.max(0, Math.min(t.length, Math.round(pos))) : t.length;
  if (!s) return { text: t, caret: at };
  const before = t.slice(0, at);
  const after = t.slice(at);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const tail = s.endsWith('\n') || !after || after.startsWith('\n') ? '' : '\n';
  const add = `${lead}${s}${tail}`;
  return { text: before + add + after, caret: before.length + add.length };
}

// ------------------------------------------------------- random file name

const YEAR_MS = 365 * 24 * 3600 * 1000;

/** A random-looking name for an upload, as 4chan X makes one: a time in
 *  milliseconds (13 digits, up to a year back) plus the original extension
 *  ("1731312345678.png"). `rand` returns [0, 1). */
export function randomFileName(name, now = Date.now(), rand = Math.random) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ''));
  const back = Math.floor(Math.min(0.999999, Math.max(0, Number(rand()) || 0)) * YEAR_MS);
  const ms = Math.max(1e12, Math.floor(Number(now) || 0) - back);
  return `${String(ms).padStart(13, '0').slice(-13)}${m ? `.${m[1]}` : ''}`;
}

/** The name an attached file goes out under: the random one when asked. */
export const uploadName = (file, random) => (random && file?.randomName ? file.randomName : file?.name || '');

// ----------------------------------------------------------------- (You)

export const MAX_YOUS = 1000;

/** Remembers a post made from CloverEye. */
export function addYou(s, board, no) {
  const list = Array.isArray(s?.yous) ? s.yous : [];
  if (list.some((y) => y.board === board && y.no === no)) return s;
  return { ...s, yous: [...list, { board, no }].slice(-MAX_YOUS) };
}

export const isYou = (s, board, no) => (s?.yous || []).some((y) => y.board === board && y.no === no);
