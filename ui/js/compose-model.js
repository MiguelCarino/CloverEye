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

/** Reads what the site's captcha frame sent (its own tcaptcha.js reads the
 *  same object) into a state the form draws:
 *  - { challenge, ttl, tasks: [{ str | img, items: [png…] }] }: a puzzle.
 *    For each task the person slides through `items`, picks the one that
 *    matches the prompt, and the answer is the picked positions joined.
 *  - { challenge } without tasks: no captcha needed this time.
 *  - { pcd, pcd_msg }: wait before a captcha may be asked for.
 *  - { mpcd, sitekey }: the site wants an hCaptcha first (not shown here).
 *  - { error, cd }: an error, often with a cooldown. */
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
    return { state: cd ? 'wait' : 'error', message: text(data.error) || 'The captcha did not load.', until: cd ? now + cd * 1000 : 0 };
  }
  if (!data.challenge) return { state: 'error', message: 'The captcha came back in a shape CloverEye does not know.' };
  if (!Array.isArray(data.tasks) || !data.tasks.length) return { state: 'none', challenge: String(data.challenge) };
  const tasks = data.tasks.map((t) => ({
    prompt: t && t.str ? text(t.str) : '',
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

// ----------------------------------------------------------------- (You)

export const MAX_YOUS = 1000;

/** Remembers a post made from CloverEye. */
export function addYou(s, board, no) {
  const list = Array.isArray(s?.yous) ? s.yous : [];
  if (list.some((y) => y.board === board && y.no === no)) return s;
  return { ...s, yous: [...list, { board, no }].slice(-MAX_YOUS) };
}

export const isYou = (s, board, no) => (s?.yous || []).some((y) => y.board === board && y.no === no);
