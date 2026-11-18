// Pre-written posts ("pastas"): the built-in list (ui/data/pastas.js) and
// the person's own, search, pins, and the text a pick puts in the reply
// form. No DOM here, so it runs under `node --test`; the popup is
// pasta-view.js.
//
// Settings: settings.pastas = { pinned: [ids, in order], own: [{ id, title,
// text, at }] }. Every change is a function of the settings (setPin,
// putOwn, removeOwn), so the shell can replay it on settings another
// window saved meanwhile (shell.js save(next, { op: [key, fn] })): that is
// how these lists merge across windows, like the shell's other grouped
// changes. pastaOp() names each change's key.

import BUILT_IN_RAW from '../data/pastas.js';

/** Own posts kept at most; each at most the reply form's limit. */
export const MAX_OWN = 200;
export const MAX_TEXT = 2000;
export const MAX_TITLE = 100;
/** Own posts together stay under this many bytes (UTF-8), counted as they
 *  sit in the saved settings file: pretty-printed, at their depth in
 *  settings.pastas.own (postBytes), like filter-model.js filterBytes. So
 *  they never take more of the file (setup-model.js SETTINGS_BUDGET) than
 *  this. */
export const OWN_BYTES = 80 * 1024;
/** Rows the popup draws at most; a count says how many more match. */
export const MAX_SHOWN = 200;
export const LENGTHS = Object.freeze(['short', 'medium', 'long']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const encoder = new TextEncoder();

/** 'short' (up to 40 characters), 'medium' (up to 300) or 'long'. */
export function lengthOf(text) {
  const n = String(text ?? '').length;
  return n <= 40 ? 'short' : n <= 300 ? 'medium' : 'long';
}

/** The built-in list, checked and frozen (a bad entry is left out). */
export const BUILT_IN = Object.freeze(
  (Array.isArray(BUILT_IN_RAW) ? BUILT_IN_RAW : [])
    .filter((p) => isObj(p) && ID_RE.test(p.id) && typeof p.title === 'string' && typeof p.text === 'string' && p.text.trim())
    .map((p) =>
      Object.freeze({
        id: p.id,
        title: p.title,
        text: p.text,
        tags: Object.freeze(Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string') : []),
        length: LENGTHS.includes(p.length) ? p.length : lengthOf(p.text),
        own: false,
      }),
    ),
);
const BUILT_IN_IDS = new Set(BUILT_IN.map((p) => p.id));

export const pastaDefaults = () => ({ pinned: ['bump'], own: [] });

/** Text as the form takes it: \r\n made \n, each line's trailing spaces
 *  and the trailing blank lines gone; leading spaces and the lines kept. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

/** A title for an own post: the one given, else its first line. */
function titleFor(title, text) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.slice(0, MAX_TITLE);
  const first = cleanText(text).split('\n').find((l) => l.trim()) || '';
  return first.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** One own post, checked, or null. */
export function normalizeOwn(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || BUILT_IN_IDS.has(raw.id)) return null;
  const text = cleanText(raw.text).slice(0, MAX_TEXT).trimEnd();
  if (!text.trim()) return null;
  const at = Number.isFinite(raw.at) && raw.at >= 0 ? Math.round(raw.at) : 0;
  return { id: raw.id, title: titleFor(raw.title, text), text, at };
}

/** Bytes one own post takes in the saved settings: pretty-printed as
 *  setup-model.js settingsBytes does (JSON.stringify(s, null, 2)), each
 *  line indented to settings.pastas.own[i] (three levels in, 6 spaces),
 *  plus the comma and newline after it. */
const OWN_INDENT = 6;
export function postBytes(p) {
  const lines = JSON.stringify(p, null, 2).split('\n');
  return encoder.encode(lines.join('\n')).length + lines.length * OWN_INDENT + 2;
}
const ownBytes = (own) => own.reduce((n, p) => n + postBytes(p), 0);

/** Reads anything into { pinned, own }: own posts checked, unique, at most
 *  MAX_OWN and OWN_BYTES (the first kept: newest first); pinned ids
 *  unique, and only ids that are built in or own. */
export function normalizePastas(raw) {
  const d = pastaDefaults();
  if (!isObj(raw)) return d;
  const own = [];
  const ids = new Set();
  let bytes = 0;
  for (const item of Array.isArray(raw.own) ? raw.own : []) {
    const p = normalizeOwn(item);
    if (!p || ids.has(p.id)) continue;
    const size = postBytes(p);
    if (own.length >= MAX_OWN || bytes + size > OWN_BYTES) break;
    bytes += size;
    ids.add(p.id);
    own.push(p);
  }
  let pinned = d.pinned;
  if (Array.isArray(raw.pinned)) {
    const seen = new Set();
    pinned = [];
    for (const id of raw.pinned) {
      if (typeof id !== 'string' || seen.has(id) || !(BUILT_IN_IDS.has(id) || ids.has(id))) continue;
      seen.add(id);
      pinned.push(id);
    }
  }
  return { pinned, own };
}

/** The settings' pastas, read safely (settings from before this key). */
export const pastasOf = (s) => (isObj(s?.pastas) && Array.isArray(s.pastas.pinned) && Array.isArray(s.pastas.own) ? s.pastas : normalizePastas(s?.pastas));

/** Every post: the person's own first (newest first), then the built-in. */
export function allPastas(s) {
  return [...pastasOf(s).own.map((p) => ({ ...p, tags: ['own'], length: lengthOf(p.text), own: true })), ...BUILT_IN];
}

// ------------------------------------------------------------------ search

/** Lower case, accents off: "Pokémon" → "pokemon". */
export const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** The words of a query, folded ('' → none). */
export const queryWords = (q) => fold(q).split(/\s+/).filter(Boolean);

/**
 * Posts matching `query` (every word somewhere in the title, text or tags;
 * case and accents ignored), in the order shown: the pinned ones first in
 * pinned order, then the rest, those with every word in the title before
 * the others, otherwise in `list` order. An empty query matches all.
 * @param {string} query
 * @param {object[]} list     allPastas(settings)
 * @param {string[]} [pinned] ids
 */
export function search(query, list, pinned = []) {
  const words = queryWords(query);
  const at = new Map((pinned || []).map((id, i) => [id, i]));
  const pins = [];
  const titled = [];
  const rest = [];
  for (const p of list || []) {
    let inTitle = true;
    if (words.length) {
      const title = fold(p.title);
      const hay = `${title}\n${fold(p.text)}\n${fold((p.tags || []).join(' '))}`;
      if (!words.every((w) => hay.includes(w))) continue;
      inTitle = words.every((w) => title.includes(w));
    }
    if (at.has(p.id)) pins.push(p);
    else if (inTitle && words.length) titled.push(p);
    else rest.push(p);
  }
  pins.sort((a, b) => at.get(a.id) - at.get(b.id));
  return [...pins, ...titled, ...rest];
}

/** The panel's tag filter chips, in order: 'all' (no filter), the built-in
 *  list's tags, and 'own' (the person's own posts: the Yours chip). */
export const TAGS = Object.freeze(['all', 'bump', 'reaction', 'classic', 'greentext', 'tech', 'own']);

/** Whether a post goes with the tag filter `tag` ('all' or unknown: every
 *  post; 'own': the person's own). */
export function hasTag(p, tag) {
  if (!tag || tag === 'all' || !TAGS.includes(tag)) return true;
  if (tag === 'own') return Boolean(p?.own);
  return Array.isArray(p?.tags) && p.tags.includes(tag);
}

/** What the panel draws: { pinned, own, builtIn, total, shown } — the
 *  matches (with the tag filter `tag`) split into its sections, `shown` of
 *  `total` at most MAX_SHOWN. */
export function sections(query, s, max = MAX_SHOWN, tag = 'all') {
  const pinned = pastasOf(s).pinned;
  const found = search(query, allPastas(s).filter((p) => hasTag(p, tag)), pinned);
  const pinSet = new Set(pinned);
  const list = found.slice(0, max);
  return {
    pinned: list.filter((p) => pinSet.has(p.id)),
    own: list.filter((p) => p.own && !pinSet.has(p.id)),
    builtIn: list.filter((p) => !p.own && !pinSet.has(p.id)),
    total: found.length,
    shown: list.length,
  };
}

// ------------------------------------------------------------------ changes

const withPastas = (s, pastas) => ({ ...s, pastas });
const known = (s, id) => BUILT_IN_IDS.has(id) || pastasOf(s).own.some((p) => p.id === id);
export const isPinned = (s, id) => pastasOf(s).pinned.includes(id);

/** Pins (at the end) or unpins one post. The same settings back when
 *  nothing changes (an unknown id, already so). */
export function setPin(s, id, on) {
  const cur = pastasOf(s);
  const has = cur.pinned.includes(id);
  if (on === has || (on && !known(s, id))) return s;
  return withPastas(s, { ...cur, pinned: on ? [...cur.pinned, id] : cur.pinned.filter((x) => x !== id) });
}

export const togglePin = (s, id) => setPin(s, id, !isPinned(s, id));

/** A new own post's id: "own-" and the time in base 36, plus a few random
 *  letters so two windows never make the same one. */
export function newOwnId(now = Date.now(), rnd = Math.random) {
  return `own-${Math.max(0, Math.round(now)).toString(36)}-${Math.floor(rnd() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`;
}

/** Why an own post cannot be kept: 'empty', 'full' (MAX_OWN posts, or no
 *  room left in OWN_BYTES), or '' when it can. Its own old copy, when
 *  editing, does not count. */
export function ownProblem(s, { id = '', title = '', text = '' } = {}) {
  const p = normalizeOwn({ id: id || 'own-check', title, text, at: 0 });
  if (!p) return 'empty';
  const others = pastasOf(s).own.filter((x) => x.id !== id);
  if (others.length >= MAX_OWN) return 'full';
  if (ownBytes([p, ...others]) > OWN_BYTES) return 'full';
  return '';
}

/** Adds or replaces an own post ({ id, title, text, at }): a new one goes
 *  first (newest first), an edit stays where it was. The same settings
 *  back when it cannot be kept (ownProblem). Replaying it is harmless, so
 *  it is the op for both adding and editing. */
export function putOwn(s, entry) {
  const p = normalizeOwn(entry);
  if (!p || ownProblem(s, p)) return s;
  const cur = pastasOf(s);
  const i = cur.own.findIndex((x) => x.id === p.id);
  if (i >= 0 && cur.own[i].title === p.title && cur.own[i].text === p.text && cur.own[i].at === p.at) return s;
  const own = i >= 0 ? cur.own.map((x, j) => (j === i ? p : x)) : [p, ...cur.own];
  return withPastas(s, { ...cur, own });
}

/** Adds an own post; `id` and `at` are made when not given. */
export function addOwn(s, { title = '', text = '', id = '', at = Date.now() } = {}) {
  return putOwn(s, { id: id || newOwnId(at), title, text, at });
}

/** Changes an own post's title and text (`at` becomes the time of the
 *  edit). The same settings back for an unknown id. */
export function editOwn(s, id, { title = '', text = '' } = {}, at = Date.now()) {
  if (!pastasOf(s).own.some((p) => p.id === id)) return s;
  return putOwn(s, { id, title, text, at });
}

/** Deletes an own post (and its pin). */
export function removeOwn(s, id) {
  const cur = pastasOf(s);
  if (!cur.own.some((p) => p.id === id)) return s;
  return withPastas(s, { pinned: cur.pinned.filter((x) => x !== id), own: cur.own.filter((p) => p.id !== id) });
}

/** A change as the shell's save() takes it: [key, (settings) => settings]
 *  ('pin', id, on), ('put', id, entry, { pinned }) or ('remove', id); null
 *  otherwise. One key per post, so a later change to the same post
 *  replaces an earlier one still waiting (putOwn after putOwn, removeOwn
 *  after putOwn). A put given `pinned: true` pins too: save() moves a
 *  replaced change to the end, so add, pin, edit replays as pin, put, and
 *  that pin, on settings without the new post yet, would do nothing. */
export function pastaOp(kind, id, ...args) {
  if (kind === 'pin') return [`pasta-pin:${id}`, (s) => setPin(s, id, args[0])];
  if (kind === 'put') {
    const pin = args[1]?.pinned === true;
    return [`pasta-own:${id}`, (s) => (pin ? setPin(putOwn(s, args[0]), id, true) : putOwn(s, args[0]))];
  }
  if (kind === 'remove') return [`pasta-own:${id}`, (s) => removeOwn(s, id)];
  return null;
}

/** True when `a` and `b` differ in nothing but their pastas (no pane needs
 *  drawing again for that: only an open popup, through its update()). */
export function onlyPastasDiffer(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('pastas');
  for (const k of keys) if (a[k] !== b[k] && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}

// ----------------------------------------------------------------- picking

/** The text a picked post puts in the reply form (cleanText). */
export const pastaText = (p) => cleanText(p?.text);

/** A one or two line preview of a post: its first lines, spaces run
 *  together, cut at `max` characters. */
export function preview(text, max = 140) {
  const lines = cleanText(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const out = lines.slice(0, 2).join(' · ');
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : lines.length > 2 ? `${out} …` : out;
}

/** A card's preview: its first `count` lines (blank ones left out, each
 *  cut at `max` characters) as [{ text, green }], `green` for a greentext
 *  line (">" but not a ">>123" quote link), as the post shows them. */
export function previewLines(text, count = 5, max = 160) {
  const out = [];
  for (const raw of cleanText(text).split('\n')) {
    if (out.length >= count) break;
    const line = raw.trim();
    if (!line) continue;
    out.push({ text: line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line, green: /^>(?!>\d)/.test(line) });
  }
  return out;
}

// ------------------------------------------------------------- saving one

/** A title for text about to be saved as an own post (the Save as pasta
 *  prompt's first value): its first line that is not only quote links
 *  (">>123"), spaces run together, trimmed, cut at `max` characters. */
export function titleFromText(text, max = 60) {
  const lines = cleanText(text)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const first = lines.find((l) => !/^(>>\d+\s*)+$/.test(l)) || lines[0] || '';
  return first.length > max ? first.slice(0, max).trimEnd() : first;
}

/** A post's comment as an own post's text: `plain` is its plain text
 *  (render.js commentText: the HTML gone, >>links and >greentext kept as
 *  typed), cleaned as the form takes it and cut at MAX_TEXT. '' when it
 *  has no text (a picture alone). */
export function postPastaText(plain) {
  return cleanText(plain).slice(0, MAX_TEXT).trimEnd();
}

/** What Save as pasta keeps from a post or a reply's comment: { title,
 *  text } (title from its first line), or null when there is no text. */
export function pastaFromText(plain) {
  const text = postPastaText(plain);
  return text.trim() ? { title: titleFromText(text), text } : null;
}

// ----------------------------------------------------------- grid keys

/**
 * Where an arrow key goes in the panel's grid of cards: `sizes` are the
 * sections' card counts in order (Pinned, Your own, Built-in; empty ones
 * may be 0), `index` the focused card among all of them, `cols` the grid's
 * column count. Left/Right go to the card before/after (across sections),
 * Up/Down one row (into the section above/below at the same column, or its
 * last card when that row is shorter), Home/End to the first/last card.
 * Returns the new index, -1 for Up from the first row (back to the search
 * box), or `index` when it stays.
 * @param {number[]} sizes
 * @param {number} index
 * @param {string} key   'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'
 * @param {number} cols
 */
export function gridStep(sizes, index, key, cols) {
  const list = (sizes || []).map((n) => Math.max(0, Math.floor(Number(n) || 0)));
  const total = list.reduce((a, b) => a + b, 0);
  if (!total) return -1;
  const c = Math.max(1, Math.floor(Number(cols) || 1));
  const i = Math.min(total - 1, Math.max(0, Math.floor(Number(index) || 0)));
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  if (key === 'ArrowLeft') return Math.max(0, i - 1);
  if (key === 'ArrowRight') return Math.min(total - 1, i + 1);
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return i;
  // the section, and the place in it
  let sec = 0;
  let start = 0;
  while (sec < list.length && i >= start + list[sec]) start += list[sec++];
  const at = i - start;
  const col = at % c;
  const row = Math.floor(at / c);
  if (key === 'ArrowDown') {
    if ((row + 1) * c < list[sec]) return start + Math.min(list[sec] - 1, at + c);
    // the next section with cards: its first row, the same column
    let s2 = sec + 1;
    let st2 = start + list[sec];
    while (s2 < list.length && !list[s2]) s2++;
    if (s2 >= list.length) return i;
    for (let k = sec + 1; k < s2; k++) st2 += list[k];
    return st2 + Math.min(list[s2] - 1, col);
  }
  if (row > 0) return start + at - c;
  let s2 = sec - 1;
  while (s2 >= 0 && !list[s2]) s2--;
  if (s2 < 0) return -1;
  let st2 = 0;
  for (let k = 0; k < s2; k++) st2 += list[k];
  const lastRow = Math.floor((list[s2] - 1) / c);
  return st2 + Math.min(list[s2] - 1, lastRow * c + col);
}

/** The column count of a CSS grid from its computed grid-template-columns
 *  ("200px 200px 200px" → 3; 'none' or '' → 1). */
export function columnCount(template) {
  const parts = String(template || '')
    .trim()
    .split(/\s+/)
    .filter((x) => x && x !== 'none');
  return Math.max(1, parts.length);
}
