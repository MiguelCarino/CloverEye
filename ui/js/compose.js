// The reply form (quick reply): floats over the window, outside the shell's
// redraws, so a thread updating itself never wipes what is being typed.
// The captcha is the site's own; the person solves it here. The post goes
// out through the bridge (the post helper in the desktop app).

import * as C from './compose-model.js';
import * as L from './library-model.js';
import { h, icon, toast } from './dom.js';
import { confirmDialog } from './offline.js';
import { putFile, getFile, delFile, moveFile, sweepFiles } from './reply-files.js';

/**
 * @param {object} o
 * @param {object} o.bridge
 * @param {() => object} o.getSettings
 * @param {(next: object) => void} o.saveSettings
 * @param {(board: string) => Promise<object|null>} o.getBoard   boards.json entry
 * @param {(p: {board: string, thread: number, no: number}) => void} o.onPosted
 * @param {(board: string, thread: number, quote: number) => void} [o.onSitePage]
 * @param {(e: object) => void} [o.onPending]   a reply going out, for the thread to show:
 *   { type: 'start', id, board, thread, post, from } (from: where the comment box was),
 *   { type: 'posted', id, no } or { type: 'failed', id, message }
 * @param {(board: string, thread: number) => Element|null} [o.paneFor]   the pane the
 *   form fills in its "Fill the pane" mode
 * @param {object} [o.library]   the library (library.js), for "From library"
 * @param {(anchor: Element, where: {board: string, thread: number}) => void} [o.onPastas]
 *   the form's "Pre-written posts" button: opens the pastas popup for this form
 */
const DRAFTS_KEY = 'clovereye-drafts';
const SAVED_KEY = 'clovereye-saved-replies';
const MODE_KEY = 'clovereye-composer-mode';
const SIZE_KEY = 'clovereye-composer-size';
const MIN_W = 300;
const MIN_H = 240;

/** Motion is off when the system asks for less of it. */
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The size the person gave the form, kept for next time ({ w, h } or null). */
function loadSize() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    return s && Number.isFinite(s.w) && Number.isFinite(s.h) ? { w: s.w, h: s.h } : null;
  } catch (_) {
    return null;
  }
}

function saveSize(size) {
  try {
    if (size) localStorage.setItem(SIZE_KEY, JSON.stringify(size));
    else localStorage.removeItem(SIZE_KEY);
  } catch (_) {
    /* no storage: the size lasts until the app closes */
  }
}

/** Keeps a size inside the window (the form sits 16 px from its corner). */
function fitSize(size) {
  if (!size) return null;
  const maxW = Math.max(MIN_W, innerWidth - 32);
  const maxH = Math.max(MIN_H, innerHeight - 80);
  return { w: Math.round(Math.min(maxW, Math.max(MIN_W, size.w))), h: Math.round(Math.min(maxH, Math.max(MIN_H, size.h))) };
}
const POSTING_ELSEWHERE = 'This reply is being posted in another window.';
// Windows tell each other which reply files they hold (the sweep: liveFiles).
const FILES_CHANNEL = 'clovereye-reply-files';

/** The captcha's time left, and how to use it. */
const expiresText = (s) => (s > 0 ? `Expires in ${s} s. Slide, drag or scroll over the picture, or use ←/→; Enter keeps a choice.` : 'Expired: get a new one.');

// Where the person moved the form: how far from its corner, as a translate
// ({ x, y }, negative = left / up), kept like the size.
const POS_KEY = 'clovereye-composer-pos';

function loadPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  } catch (_) {
    return null;
  }
}

function savePos(pos) {
  try {
    if (pos) localStorage.setItem(POS_KEY, JSON.stringify(pos));
    else localStorage.removeItem(POS_KEY);
  } catch (_) {
    /* no storage: the place lasts until the app closes */
  }
}

/** How the form sits: 'float' (its corner, moved and sized by hand),
 *  'pane' (over the thread's pane) or 'full' (the whole window). */
function loadMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === 'pane' || m === 'full' ? m : 'float';
  } catch (_) {
    return 'float';
  }
}

function saveMode(m) {
  try {
    if (m === 'float') localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, m);
  } catch (_) {
    /* no storage: the mode lasts until the app closes */
  }
}

/** Replies kept for later (compose-model.js saveReply). */
function loadSaved() {
  try {
    return C.normalizeSaved(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'));
  } catch (_) {
    return [];
  }
}

/** Drafts as stored, by an earlier run or another window (see persistDrafts).
 *  Replies being written are never dropped to make room: C.MAX_DRAFTS is a
 *  high cap only against a runaway store. */
function loadDrafts() {
  try {
    return C.adoptDrafts(new Map(), C.parseDrafts(localStorage.getItem(DRAFTS_KEY))); // replies, not deletes
  } catch (_) {
    return new Map(); // no storage
  }
}

/** "1 min 05 s", "42 s". */
function formatLeft(s) {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** The text selected inside one post card's own comment (not in quoted
 *  copies opened inside it), one line per line of the post; '' when the
 *  selection is elsewhere or empty. Read as the post's No. is pressed. */
export function postSelection(post) {
  const sel = globalThis.getSelection?.();
  if (!post || !sel || sel.isCollapsed || !sel.rangeCount) return '';
  const com = [...post.querySelectorAll('.post__com')].find((c) => c.closest('.post') === post);
  if (!com) return '';
  try {
    const r = sel.getRangeAt(0);
    const part = document.createRange();
    part.selectNodeContents(com);
    const a = part.comparePoint(r.startContainer, r.startOffset);
    const b = part.comparePoint(r.endContainer, r.endOffset);
    if (a > 0 || b < 0) return ''; // wholly before or after the comment
    if (a === 0) part.setStart(r.startContainer, r.startOffset);
    if (b === 0) part.setEnd(r.endContainer, r.endOffset);
    const box = document.createElement('div');
    box.append(part.cloneContents());
    return C.selectionText(box);
  } catch (_) {
    return ''; // a selection in another document (a frame): nothing to quote
  }
}

export function createComposer({ bridge, getSettings, saveSettings, getBoard, onPosted, onSitePage = null, onPending = null, paneFor = null, library = null, onPastas = null }) {
  const drafts = loadDrafts(); // "board/thread" → { com, sub, email, at }
  // What this window changed in `drafts` and has not stored yet (key →
  // entry; an empty entry is a delete): only these are written, so another
  // window's replies are never written over (persistDrafts).
  const dirty = new Map();
  // Replies going out now: key → their form. Never a pill, never a second
  // form: Reply in that thread brings this one back.
  const posting = new Map();
  // Window listeners end with the composer (the shell is made again after
  // setup): an old one never draws a tray or writes its drafts again.
  const ac = new AbortController();
  const bound = { signal: ac.signal };
  let closed = false;
  let saved = loadSaved(); // replies kept for later, several per thread
  let mode = loadMode();
  let pendingSeq = 0;
  const cooldowns = new Map(); // board → time the next post may go
  let st = null; // the open form
  let el = null;
  let openedFrom = null; // what had the focus when a form opened: it gets it back when the form goes
  let tick = null;
  let saveTimer = 0;
  let size = loadSize(); // set by dragging the corner grip

  function applySize(node) {
    const s = fitSize(size);
    if (!node || !s || st?.min || mode !== 'float') return;
    node.style.width = `${s.w}px`;
    node.style.height = `${s.h}px`;
    node.style.maxHeight = 'none';
  }

  let pos = loadPos(); // set by dragging the title bar

  /** Moves the form to `pos`, kept inside the window (8 px clear; where the
   *  form spans the width, on a narrow window, only up and down). */
  function applyPos(node) {
    if (!node) return;
    node.style.translate = '';
    if (!pos || mode !== 'float' || st?.min) return;
    const base = node.getBoundingClientRect(); // where its corner puts it
    const wide = base.width < innerWidth - 24;
    const x = wide ? Math.min(innerWidth - 8 - base.right, Math.max(8 - base.left, pos.x)) : 0;
    const y = Math.min(innerHeight - 8 - base.bottom, Math.max(8 - base.top, pos.y));
    node.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
  }

  // Drag the title bar to move the form (a click on its buttons still
  // clicks); arrow keys on the title move it too; double-click: back to
  // the corner.
  function startMove(e) {
    // folded, the form is a pill in the tray's place: it does not move
    if (e.button !== 0 || !el || st?.min || mode !== 'float') return;
    if (e.target.closest('button, input, textarea, select, a, .composer__grip')) return;
    const from = pos || { x: 0, y: 0 };
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      if (!moved) el?.classList.add('composer--moving');
      moved = true;
      pos = { x: from.x + dx, y: from.y + dy };
      applyPos(el);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!moved) return;
      el?.classList.remove('composer--moving');
      pos = currentPos();
      savePos(pos);
      // the press that moved the form is not also a click on its title
      // (released elsewhere, no click comes: the next one is not eaten)
      const swallow = (ev) => ev.stopPropagation();
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, { capture: true }), 0);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** The translate actually applied (after keeping it inside the window). */
  function currentPos() {
    const [x = '0', y = '0'] = (el?.style.translate || '').split(' ');
    return { x: parseFloat(x) || 0, y: parseFloat(y) || 0 };
  }

  function moveKeys(e) {
    if (mode !== 'float') return;
    const step = e.shiftKey ? 60 : 20;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const from = pos || { x: 0, y: 0 };
    pos = { x: from.x + d[0], y: from.y + d[1] };
    applyPos(el);
    pos = currentPos();
    savePos(pos);
  }

  function resetPos(e) {
    if (mode !== 'float' || st?.min) return;
    if (e.target.closest('button, input, .composer__grip')) return;
    pos = null;
    savePos(null);
    applyPos(el);
  }

  addEventListener(
    'resize',
    () => {
      applyPos(el);
      placeOver();
    },
    bound,
  );

  // "Fill the pane": the form lies over the pane showing its thread (the
  // focused one when none does), kept there as the panes change (checked
  // with the form's clock); "Full window": below the title bar, all of it.
  let paneBox = '';
  function placeOver() {
    if (!el || !st || mode !== 'pane' || st.min) return;
    const pane = paneFor?.(st.board, st.thread);
    const r = pane?.getBoundingClientRect();
    const box = r && r.width > 200 && r.height > 160 ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}` : 'full';
    if (box === paneBox && el.dataset.placed) return;
    paneBox = box;
    el.dataset.placed = '1';
    el.classList.toggle('composer--full', box === 'full');
    if (box === 'full') {
      for (const k of ['left', 'top', 'width', 'height']) el.style.removeProperty(k);
      return;
    }
    const [x, y, w, hh] = box.split(',');
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
  }

  function setMode(next) {
    if (!st) return;
    const from = el?.getBoundingClientRect();
    mode = mode === next ? 'float' : next;
    saveMode(mode);
    paneBox = '';
    draw('keep');
    morph(el, from);
  }

  // The grip in the top-left corner (the form is anchored bottom-right):
  // drag it, or use the arrow keys on it; double-click puts the size back.
  function grip() {
    const start = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const move = (ev) => {
        size = fitSize({ w: box.width - (ev.clientX - x0), h: box.height - (ev.clientY - y0) });
        applySize(el);
        applyPos(el);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        el?.classList.remove('composer--resizing');
        saveSize(size);
      };
      el.classList.add('composer--resizing');
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    };
    const keys = (e) => {
      const step = e.shiftKey ? 60 : 20;
      const box = el.getBoundingClientRect();
      const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (!d) return;
      e.preventDefault();
      size = fitSize({ w: box.width + d[0], h: box.height + d[1] });
      applySize(el);
      applyPos(el);
      saveSize(size);
    };
    const reset = () => {
      size = null;
      saveSize(null);
      draw('keep');
    };
    return h('button', {
      type: 'button',
      class: 'composer__grip',
      'aria-label': 'Resize the reply form: drag, or arrow keys (double-click: default size)',
      title: 'Drag to resize · double-click: default size',
      'data-key': 'compose-grip',
      onpointerdown: start,
      onkeydown: keys,
      ondblclick: reset,
    });
  }

  const key = (board, thread) => `${board}/${thread || 0}`;

  // Replies being written outlive the app: their text in this app's own
  // storage as it is typed, an attached file in reply-files.js (key
  // "a:<board>/<thread>"), so closing CloverEye (or a crash) loses nothing.
  // One with anything in it stays, as a pill in the tray when its form is
  // not open, until it is posted, saved for later or deleted by hand.
  const fileKey = (k) => `a:${k}`;

  // Every window has its own copy of the drafts and they all share one
  // store: a window writes only its own changes into what is stored now
  // (the newer write of a reply wins), then takes in the others' replies.
  const keepKeys = () => new Set([...dirty.keys(), ...posting.keys(), ...(st ? [key(st.board, st.thread)] : [])]);

  /** Writes this window's changes; the stored drafts after (null: no
   *  storage, or nothing to write). */
  function persistDrafts() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty.size) return null;
    const changes = new Map(dirty);
    let merged = null;
    try {
      merged = C.mergeDrafts(C.parseDrafts(localStorage.getItem(DRAFTS_KEY)), changes);
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(merged)));
      dirty.clear();
      C.adoptDrafts(drafts, merged, keepKeys());
    } catch (_) {
      merged = null; // no storage: drafts last until the app closes
    }
    // A delete that went in takes the reply's file too; one that did not
    // (another window wrote that reply since) leaves it to that reply.
    for (const [k, d] of changes) if (!C.hasContent(d) && !C.hasContent(merged?.get(k))) delFile(fileKey(k));
    return merged;
  }

  /** Another window changed the drafts (or opening a form): take them in.
   *  The stored drafts (null: no storage). */
  function reloadDrafts() {
    try {
      const stored = C.parseDrafts(localStorage.getItem(DRAFTS_KEY));
      C.adoptDrafts(drafts, stored, keepKeys());
      return stored;
    } catch (_) {
      return null; // no storage: this window's drafts are all there is
    }
  }

  // A change to write: `base` (the copy this window had) makes it go in only
  // when no other window changed that reply since; without, the newer wins.
  function setDraft(k, d, base = 0) {
    if (C.hasContent(d)) drafts.set(k, d);
    else drafts.delete(k);
    dirty.set(k, base ? { ...d, base } : d);
  }
  const dropDraft = (k, base) => setDraft(k, C.goneDraft(Date.now(), base), base);

  const draftOf = (s, at = Date.now()) => ({ com: s.com, sub: s.sub, email: s.email, file: C.fileMeta(s.file), at });

  // Each form keeps `base`: when the copy it shows was written (by this
  // window or another), so only what the person changed here is written.
  function typed() {
    // a reply going out stays as it was when Post was pressed
    if (!st || st.busy) return;
    const d = draftOf(st);
    const was = st.base;
    const k = key(st.board, st.thread);
    // Another window is posting this reply: nothing is written and base
    // stays, so when that post lands followStored empties this form (a
    // keystroke here must not drop the stored marker: no second post).
    if (!posting.has(k) && C.postingNow(reloadDrafts()?.get(k))) {
      if (!st.problems.some((p) => p.message === POSTING_ELSEWHERE)) {
        st.problems = [{ field: 'submit', message: POSTING_ELSEWHERE }];
        draw('keep');
      }
      return;
    }
    if (C.hasContent(d)) {
      st.base = d.at;
      setDraft(k, d);
    } else if (was) {
      // emptied by hand: a delete of the copy it had (never of a newer one)
      st.base = d.at;
      setDraft(k, C.goneDraft(d.at, was), was);
    } else return; // nothing written yet, nothing to write
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistDrafts, 400);
  }

  addEventListener(
    'pagehide',
    () => {
      stash();
      persistDrafts(); // writes only when this window changed something
    },
    bound,
  );

  function pwd(settings) {
    if (settings.post?.pwd) return settings.post.pwd;
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const made = Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
    saveSettings({ ...settings, post: { ...(settings.post || {}), pwd: made } });
    return made;
  }

  /** Keeps the open form's reply: what the person changed in it here is
   *  written now (every change went through typed()). A form left as it
   *  was writes nothing, so an older copy never comes back over a reply
   *  posted or deleted in another window, and an empty one never deletes
   *  another window's reply. A reply going out was stored when Post was
   *  pressed, so a crash meanwhile still has it. */
  function stash() {
    if (!st) return;
    persistDrafts();
  }

  /** Forgets a reply being written, file and all: the copy written at
   *  `base` (a newer one from another window stays, with its file). */
  function forget(k, base) {
    dropDraft(k, base || Date.now());
    persistDrafts();
  }

  // ------------------------------------------------------ saved replies

  // Another window may have changed the list: it is read again before each
  // change, so one window's list is never written over another's.
  function persistSaved() {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
    } catch (_) {
      /* no storage: saved replies last until the app closes */
    }
  }

  const focusComment = () => el?.querySelector('[data-key="compose-com"]')?.focus({ preventScroll: true });


  /** Takes the form down without a trace (no draft kept: the caller did). */
  function dropForm() {
    clearInterval(tick);
    tick = null;
    const node = el;
    el = null;
    st = null;
    return node;
  }

  /** Keeps what is in the form for later: the form folds into a pill
   *  under the tray's Later, file and all, and the next Reply starts empty. */
  function saveForLater() {
    if (!st || st.busy) return;
    const reply = { board: st.board, thread: st.thread, com: st.com, sub: st.sub, email: st.email, file: st.file };
    const before = (saved = loadSaved());
    if (C.hasContent(st) && C.savedFull(before, reply)) {
      toast('Later is full: delete a saved reply first.');
      return;
    }
    saved = C.saveReply(before, reply);
    if (saved === before) {
      toast('Nothing to save yet: write something first.');
      return;
    }
    persistSaved();
    for (const id of C.droppedIds(before, saved)) delFile(`s:${id}`); // a list stored over the limit
    const k = key(st.board, st.thread);
    if (st.file) putFile(`s:${saved[0].id}`, st.file);
    forget(k, st.base);
    const node = dropForm();
    laterOpen = true;
    drawTray(`s:${saved[0].id}`);
    const pill = tray?.querySelector(`[data-saved-id="${CSS.escape(saved[0].id)}"]`);
    leave(node, tray?.hidden ? null : pill?.getBoundingClientRect());
    toast('Reply saved for later.');
  }

  /** A pill under Later opens as the form. A reply already being written
   *  for that thread goes under Later in its place, so the two never mix;
   *  the open form (another thread) stays as a pill of its own. */
  let openingSaved = false; // a double press moves the files once
  async function openSaved(id, pill) {
    if (st?.busy || openingSaved || closed) return;
    saved = loadSaved(); // another window may have opened or deleted it
    let { entry, list } = C.takeSaved(saved, id);
    if (!entry) {
      drawTray();
      return;
    }
    const from = pill?.getBoundingClientRect();
    const k = key(entry.board, entry.thread);
    // that thread's reply is going out: its form comes back, this one stays saved
    if (posting.has(k)) return open({ board: entry.board, thread: entry.thread, from });
    // (as stored: this window's copy of the open form's reply is its own)
    if (C.postingNow(reloadDrafts()?.get(k))) {
      toast(POSTING_ELSEWHERE); // its reply there would be written over
      return;
    }
    const form = st && key(st.board, st.thread) === k ? st : null;
    const cur = form || drafts.get(k);
    openingSaved = true;
    // held while the files move: not stashed or typed into meanwhile
    if (form) form.busy = true;
    try {
      const before = list;
      if (C.hasContent(cur)) {
        list = C.saveReply(list, { board: entry.board, thread: entry.thread, com: cur.com, sub: cur.sub, email: cur.email, file: cur.file });
        if (form?.file) {
          await putFile(`s:${list[0].id}`, form.file);
          await delFile(fileKey(k));
        } else if (cur.file) await moveFile(fileKey(k), `s:${list[0].id}`);
      }
      for (const gone of C.droppedIds(before, list)) delFile(`s:${gone}`);
      if (entry.file) await moveFile(`s:${entry.id}`, fileKey(k));
      else await delFile(fileKey(k));
      const at = Date.now();
      setDraft(k, { com: entry.com, sub: entry.sub, email: entry.email || '', file: entry.file, at });
      if (form) form.base = at;
      // Read again: another window may have saved or deleted one while the
      // files moved. Only this change goes in: the entry taken out, and the
      // reply put in its place (saveReply puts it first; its file is s:<id>).
      const added = list !== before ? list[0] : null;
      let fresh = C.takeSaved(loadSaved(), entry.id).list;
      if (added) {
        const next = [added, ...fresh.filter((e) => e.id !== added.id)].slice(0, C.MAX_SAVED_REPLIES);
        for (const gone of C.droppedIds(fresh, next)) if (gone !== added.id) delFile(`s:${gone}`);
        fresh = next;
      }
      saved = fresh;
      persistSaved();
      persistDrafts();
      if (form && st === form) {
        // the same thread: the captcha already there stays
        const f = entry.file ? await getFile(fileKey(k)) : null;
        if (st === form) {
          form.busy = false;
          Object.assign(form, { com: entry.com, sub: entry.sub, email: entry.email || form.email, file: f, caret: entry.com.length, problems: [], message: '', min: false });
          draw('none');
          morph(el, from);
          focusComment();
          drawTray();
          return;
        }
      }
    } finally {
      if (form) form.busy = false;
      openingSaved = false;
    }
    // another thread, or the form went meanwhile: opened from the draft
    await open({ board: entry.board, thread: entry.thread, from });
  }

  /** A pill of a reply being written opens as the form (the open one
   *  becomes a pill). */
  function openActive(k, pill) {
    if (st?.busy || closed) return;
    const [board, thread] = k.split('/');
    open({ board, thread: Number(thread), from: pill?.getBoundingClientRect() });
  }

  /** Deletes a reply being written: only ever by hand, after asking. */
  async function dropActive(k, opener) {
    const d = drafts.get(k);
    if (!d) return;
    const ok = await confirmDialog({ title: 'Delete this reply?', text: `“${C.savedLabel(d, 80)}” is deleted for good.`, confirm: 'Delete', opener });
    if (!ok) return;
    const item = tray?.querySelector(`[data-active-key="${CSS.escape(k)}"]`);
    forget(k, d.at); // the reply shown (one written since in another window stays)
    fadeOut(item);
  }

  /** A pill leaving the tray, then the tray drawn again. */
  function fadeOut(item) {
    let finished = false;
    const once = () => {
      if (finished) return;
      finished = true;
      drawTray();
      (tray?.querySelector('.reply-pill__open') || el?.querySelector('[data-key="compose-com"]'))?.focus({ preventScroll: true });
    };
    if (item && !still() && item.animate) {
      const r = item.getBoundingClientRect();
      item.animate(
        [
          { opacity: 1, transform: 'none', maxHeight: `${r.height}px` },
          { opacity: 0, transform: 'translateX(24px) scale(0.96)', maxHeight: '0px', marginTop: `${-8}px` },
        ],
        { duration: 220, easing: 'ease-in', fill: 'forwards' },
      ).onfinish = once;
      setTimeout(once, 400); // a window in the background may hold the animation back
    } else once();
  }

  async function dropSaved(entry, opener) {
    const ok = await confirmDialog({ title: 'Delete this saved reply?', text: `“${C.savedLabel(entry, 80)}” is deleted for good.`, confirm: 'Delete', opener });
    if (!ok) return;
    const item = tray?.querySelector(`[data-saved-id="${CSS.escape(entry.id)}"]`);
    saved = C.takeSaved(loadSaved(), entry.id).list;
    persistSaved();
    delFile(`s:${entry.id}`);
    fadeOut(item);
  }

  // ------------------------------------------------------------- the tray

  // Replies wait as pills at the bottom right, like a folded form:
  // "Reply to /g/ No. 12  Captcha to solve  ×". At the bottom, the replies
  // being written (each stays until posted or deleted by hand); above them,
  // a Later header that opens the replies saved for later. A press opens a
  // pill as the form; × deletes it, after asking. Above a folded form,
  // beside an open one.
  const ACTIVE_SHOWN = 5;
  const PEEK = 7; // px of each card behind showing above the one in front
  let tray = null;
  let trayAll = false; // "+N more" pressed
  let laterOpen = false; // the Later header pressed
  let trayIds = new Set();
  let stackOpen = false; // the pile fanned out (pointed at, or focus inside)
  let fanTimer = 0;
  let trayPress = false; // a press began in the tray
  let trayStale = false; // another window changed a pill meanwhile
  let postingTimer = 0; // a pill hidden while posted elsewhere comes back

  // The replies being written lie in a pile, one on another, the newest
  // (or the folded form) in front and the edges of the others showing
  // above it; pointing at the pile, or tabbing into it, fans it out.
  function fan(open) {
    clearTimeout(fanTimer);
    if (open === stackOpen) return;
    // closing waits a moment: the pile moves under the pointer as it folds
    fanTimer = setTimeout(
      () => {
        stackOpen = open;
        tray?.classList.toggle('reply-tray--open', open);
        placeTray();
      },
      open ? 0 : 280,
    );
  }

  function pillTitle(e) {
    return e.thread ? `Reply to /${e.board}/ No. ${e.thread}` : `New thread on /${e.board}/`;
  }

  /** The replies being written whose form is not the open one, newest first. */
  function activeList() {
    const open = st ? key(st.board, st.thread) : '';
    return [...drafts.entries()]
      // one going out (here or in another window) is no pill
      .filter(([k, d]) => k !== open && !posting.has(k) && !C.postingNow(d) && C.hasContent(d))
      .map(([k, d]) => {
        const [board, thread] = k.split('/');
        return { k, board, thread: Number(thread), ...d };
      })
      .sort((a, b) => b.at - a.at);
  }

  function pill({ e, id, attr, later, fresh, onOpen, onDelete }) {
    return h(
      'li',
      { class: `reply-pill${later ? ' reply-pill--later' : ''}${trayIds.has(id) && id !== fresh ? '' : ' reply-pill--new'}`, ...attr },
      h(
        'button',
        { type: 'button', class: 'reply-pill__open', title: C.savedLabel(e, 80), 'data-key': `tray-open-${id}`, onclick: (ev) => onOpen(ev.currentTarget.closest('.reply-pill')) },
        later ? icon('bookmark') : null,
        h('span', { class: 'reply-pill__title', text: pillTitle(e) }),
        e.file ? h('span', { class: 'reply-pill__file', title: e.file.name, 'aria-label': `File: ${e.file.name}` }, icon('folder')) : null,
        h('span', { class: 'reply-pill__note', text: 'Captcha to solve' }),
      ),
      h(
        'button',
        { type: 'button', class: 'reply-pill__x', 'aria-label': `Delete the reply “${C.savedLabel(e)}”`, title: 'Delete this reply', 'data-key': `tray-del-${id}`, onclick: (ev) => onDelete(ev.currentTarget) },
        icon('x'),
      ),
    );
  }

  function drawTray(fresh = '') {
    if (closed) return; // something that finished after the shell closed
    trayStale = false;
    // one hidden while another window posts it is a pill again if that
    // window never says how it went (it crashed)
    clearTimeout(postingTimer);
    const now = Date.now();
    const back = Math.min(...[...drafts.values()].filter((d) => C.postingNow(d, now)).map((d) => d.posting + C.POSTING_MS));
    postingTimer = Number.isFinite(back) ? setTimeout(() => drawTray(), back - now + 50) : 0;
    const active = activeList();
    const later = saved;
    if (!active.length && !later.length) {
      tray?.remove();
      tray = null;
      trayIds = new Set();
      return;
    }
    const shown = trayAll || active.length <= ACTIVE_SHOWN + 1 ? active : active.slice(0, ACTIVE_SHOWN);
    const more = active.length - shown.length;
    const next = h(
      'div',
      {
        class: `reply-tray${stackOpen ? ' reply-tray--open' : ''}`,
        'data-key': 'reply-tray',
        onpointerenter: () => fan(true),
        onpointerleave: () => fan(false),
        onfocusin: () => fan(true),
        onfocusout: (e) => !next.contains(e.relatedTarget) && fan(false),
      },
      later.length
        ? h(
            'button',
            {
              type: 'button',
              class: `reply-tray__later${laterOpen ? ' reply-tray__later--open' : ''}`,
              'aria-expanded': String(laterOpen),
              title: laterOpen ? 'Hide the replies saved for later' : 'Show the replies saved for later',
              'data-key': 'reply-tray-later',
              onclick: () => ((laterOpen = !laterOpen), drawTray()),
            },
            icon('bookmark'),
            h('span', { text: `Later (${later.length})` }),
            icon(laterOpen ? 'collapse' : 'expand'),
          )
        : null,
      later.length && laterOpen
        ? h(
            'ul',
            { class: 'reply-tray__list reply-tray__list--later', 'aria-label': 'Replies saved for later' },
            [...later].reverse().map((e) =>
              pill({ e, id: `s:${e.id}`, attr: { 'data-saved-id': e.id }, later: true, fresh, onOpen: (p) => openSaved(e.id, p), onDelete: (b) => dropSaved(e, b) }),
            ),
          )
        : null,
      active.length > ACTIVE_SHOWN + 1
        ? h('button', {
            type: 'button',
            class: 'reply-tray__more',
            'data-key': 'reply-tray-more',
            'aria-expanded': String(trayAll),
            onclick: () => ((trayAll = !trayAll), drawTray()),
            text: more ? `+${more} more` : 'Show fewer',
          })
        : null,
      active.length
        ? h(
            'ul',
            { class: 'reply-tray__list reply-tray__list--stack', 'aria-label': 'Replies being written' },
            // newest at the bottom, nearest the form, and on top of the pile
            [...shown].reverse().map((e, i) =>
              pill({ e, id: `a:${e.k}`, attr: { 'data-active-key': e.k, style: { 'z-index': String(i + 1) } }, fresh, onOpen: (p) => openActive(e.k, p), onDelete: (b) => dropActive(e.k, b) }),
            ),
          )
        : null,
    );
    trayIds = new Set([...active.map((e) => `a:${e.k}`), ...later.map((e) => `s:${e.id}`)]);
    // the focus stays on the same pill or button in the new tray
    const had = tray?.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
    if (tray) tray.replaceWith(next);
    else document.body.append(next);
    tray = next;
    if (had) next.querySelector(`[data-key="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
    placeTray();
  }

  // What the tray shows: drawn again only when that changed.
  const traySig = () =>
    JSON.stringify([activeList().map((e) => [e.k, e.com, e.sub, e.file?.name || '']), saved.map((e) => [e.id, e.com, e.sub, e.file?.name || ''])]);

  /** The open form's copy was posted or deleted in another window (and
   *  nothing was changed in it here since): it empties, so it is not posted
   *  again. */
  function followStored(stored) {
    if (!st || st.busy || !stored) return;
    const k = key(st.board, st.thread);
    if (dirty.has(k) || !C.hasContent(st) || !C.deletedSince(stored, k, st.base)) return;
    Object.assign(st, { com: '', sub: '', file: null, caret: 0, problems: [], message: '', base: stored.get(k).at || 0 });
    drafts.delete(k); // no pill of it either once the form closes
    draw('keep');
    if (st.min) drawHeadNote();
    toast('This reply was posted or deleted in another window.');
  }

  /** Above a folded form, to the left of an open floating one; out of the
   *  way while the form fills a pane or the window. */
  function placeTray() {
    if (!tray) return;
    let right = 16;
    let bottom = 16;
    let hide = false;
    const r = el?.isConnected ? el.getBoundingClientRect() : null;
    if (st && r) {
      if (st.min) {
        right = innerWidth - r.right;
        // the folded form is the pile's front card: the last pill tucks
        // behind it, its top edge showing; fanned out, they sit above it
        const pillH = tray.querySelector('.reply-tray__list--stack > .reply-pill')?.offsetHeight || r.height;
        bottom = stackOpen || !tray.querySelector('.reply-tray__list--stack') ? innerHeight - r.top + 8 : innerHeight - r.top + PEEK - pillH - 2;
      } else if (mode === 'float' && r.left > 320) {
        right = innerWidth - r.left + 12;
        bottom = innerHeight - r.bottom;
      } else hide = true;
    }
    tray.hidden = hide;
    tray.classList.toggle('reply-tray--behind', Boolean(st?.min && el));
    const front = tray.querySelector('.reply-tray__list--stack > .reply-pill:last-child');
    if (front?.offsetHeight) tray.style.setProperty('--pill-h', `${front.offsetHeight}px`);
    const b = Math.max(8, Math.round(bottom));
    tray.style.right = `${Math.max(8, Math.round(right))}px`;
    tray.style.bottom = `${b}px`;
    // never past the title bar: the lists scroll instead
    const top = document.querySelector('.titlebar')?.getBoundingClientRect().bottom || 40;
    tray.style.maxHeight = `${Math.max(120, innerHeight - b - top - 8)}px`;
  }

  addEventListener('resize', placeTray, bound);
  // Another window saved, used or wrote one (null: its storage was cleared).
  // It writes as it is typed into: the tray is drawn again only when a pill
  // changed, and not under a press (the click would land on a pill gone).
  addEventListener(
    'storage',
    (e) => {
      if (e.key !== SAVED_KEY && e.key !== DRAFTS_KEY && e.key !== null) return;
      const before = traySig();
      if (e.key !== DRAFTS_KEY) saved = loadSaved();
      if (e.key !== SAVED_KEY) followStored(reloadDrafts());
      if (traySig() === before) return;
      if (trayPress) trayStale = true;
      else drawTray();
    },
    bound,
  );
  addEventListener('pointerdown', (e) => (trayPress = Boolean(tray?.contains(e.target))), { ...bound, capture: true });
  const pressEnd = () => {
    trayPress = false;
    // after the click that ends the press
    if (trayStale) setTimeout(() => trayStale && drawTray(), 0);
  };
  addEventListener('pointerup', pressEnd, bound);
  addEventListener('pointercancel', pressEnd, bound);
  if (document.body) drawTray();
  else addEventListener('DOMContentLoaded', () => drawTray(), { once: true, signal: ac.signal });

  // Files no reply points at any more (one cut off a list, or left by an
  // older version) are deleted a while after the start: see sweepFiles.
  // A reply another window could not write to storage (full) lives only in
  // that window: before the sweep every window is asked what it holds, and
  // the answers come in during sweepFiles' wait, before its second look.
  const ownFiles = () => {
    const s = new Set();
    for (const k of [...drafts.keys(), ...keepKeys()]) s.add(fileKey(k));
    for (const e of saved) s.add(`s:${e.id}`);
    return s;
  };
  const othersFiles = new Set();
  let filesChan = null;
  try {
    filesChan = new BroadcastChannel(FILES_CHANNEL);
  } catch (_) {
    filesChan = null; // no way to ask the other windows: nothing is swept
  }
  filesChan?.addEventListener('message', (e) => {
    if (closed) return;
    if (e.data?.ask) filesChan.postMessage({ keys: [...ownFiles()] });
    else if (Array.isArray(e.data?.keys)) for (const k of e.data.keys) othersFiles.add(String(k));
  });
  ac.signal.addEventListener('abort', () => filesChan?.close());
  const liveFiles = () => {
    if (!filesChan) return null;
    try {
      const live = new Set();
      for (const [k, d] of C.parseDrafts(localStorage.getItem(DRAFTS_KEY))) if (C.hasContent(d)) live.add(fileKey(k));
      for (const e of C.normalizeSaved(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'))) live.add(`s:${e.id}`);
      for (const k of ownFiles()) live.add(k);
      for (const k of othersFiles) live.add(k);
      return live;
    } catch (_) {
      return null; // no storage to tell by: nothing is deleted
    }
  };
  const sweepTimer = setTimeout(() => {
    if (closed) return;
    filesChan?.postMessage({ ask: true });
    sweepFiles(liveFiles).catch(() => {});
  }, 10_000);

  // ------------------------------------------------------------ motion

  /** FLIP: the form (or a pill) grows from where it was (`from`, a rect)
   *  into where it is now. */
  function morph(node, from, ms = 260) {
    if (!node || !from || still() || !node.animate) return;
    const to = node.getBoundingClientRect();
    if (!to.width || !to.height || !from.width || !from.height) return;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    node.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ],
      { duration: ms, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
    // the inside fades in, so the text is not seen squeezed
    for (const part of node.querySelectorAll(':scope > .composer__body, :scope > .composer__foot')) {
      part.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: ms + 60, easing: 'ease-out' });
    }
  }

  /** A form that has just appeared rises into place. */
  function rise(node) {
    if (!node || still() || !node.animate) return;
    node.animate(
      [
        { opacity: 0, transform: 'translateY(16px) scale(0.98)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );
  }

  /** The focus back where it was when the form opened (the thread's Reply
   *  button, a post's No.): the same control drawn anew since is found by
   *  its data-key. Else it just leaves the form. */
  function focusBack() {
    let to = openedFrom;
    openedFrom = null;
    const k = to?.dataset?.key;
    if (to && !to.isConnected && k) to = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
    if (to?.isConnected && !to.closest('[inert], .composer') && typeof to.focus === 'function') to.focus({ preventScroll: true });
    if (document.activeElement?.closest?.('.composer')) document.activeElement.blur();
  }

  /** A form going away: into `to` (a rect: the pill it became), else down
   *  and out. The node is removed at the end. */
  function leave(node, to) {
    if (!node) return;
    // The focus never stays in a form that is going: the shell ignores keys
    // (Esc back to the catalog, G, U) while the focus is in a .composer.
    if (node.contains(document.activeElement)) focusBack();
    if (still() || !node.animate || !node.isConnected) {
      node.remove();
      return;
    }
    // a ghost from here on: not the form any more for anything that looks
    node.inert = true;
    node.style.pointerEvents = 'none';
    node.removeAttribute('data-key');
    for (const n of node.querySelectorAll('[data-key], [id]')) {
      n.removeAttribute('data-key');
      n.removeAttribute('id');
    }
    node.removeAttribute('role');
    node.setAttribute('aria-hidden', 'true');
    // a window in the background may hold the animation back: gone anyway
    const gone = setTimeout(() => node.remove(), 600);
    const r = node.getBoundingClientRect();
    const end = to && to.width && r.width
      ? { transformOrigin: '0 0', transform: `translate(${to.left - r.left}px, ${to.top - r.top}px) scale(${to.width / r.width}, ${to.height / r.height})`, opacity: 0.2 }
      : { transformOrigin: '50% 100%', transform: 'translateY(16px) scale(0.97)', opacity: 0 };
    for (const part of node.querySelectorAll(':scope > .composer__body, :scope > .composer__foot')) {
      part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
    }
    node.animate([{ transformOrigin: end.transformOrigin, transform: 'none', opacity: 1 }, end], { duration: to ? 300 : 200, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' }).onfinish = () => {
      clearTimeout(gone);
      node.remove();
    };
  }

  function setMin(on) {
    if (!st) return;
    const from = el?.getBoundingClientRect();
    // folding: a copy of the open form shrinks into the pill and fades,
    // while the pill fades in (scaling the pill itself up would stretch it)
    const ghost = on && el && !still() ? el.cloneNode(true) : null;
    st.min = on;
    draw('none');
    if (ghost && from) {
      Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, right: 'auto', bottom: 'auto', transform: 'none', margin: '0' });
      document.body.append(ghost);
      leave(ghost, el.getBoundingClientRect());
      el.animate?.([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    } else if (!on) morph(el, from, 240);
    if (!on) el?.querySelector('[data-key="compose-com"]')?.focus({ preventScroll: true });
    else el?.querySelector('[data-key="compose-restore"]')?.focus({ preventScroll: true });
  }

  /** The app closing: the reply is kept as it is. */
  function close() {
    stash();
    persistDrafts(); // the last keystrokes too (a write still waiting)
    dropForm()?.remove();
    clearTimeout(fanTimer);
    fanTimer = 0;
    clearTimeout(sweepTimer);
    clearTimeout(postingTimer);
    tray?.remove();
    tray = null;
    closed = true;
    ac.abort();
  }

  /** The form's ×: an empty form just closes; a reply with something in
   *  it is deleted, after asking (minimise keeps it instead). */
  async function closeAsked(opener) {
    if (!st || st.busy) return;
    if (C.hasContent(st)) {
      const mine = st;
      const ok = await confirmDialog({ title: 'Delete this reply?', text: `“${C.savedLabel(mine, 80)}” is deleted for good. To keep it, minimise it or save it for later.`, confirm: 'Delete', opener });
      if (!ok || st !== mine) return;
      forget(key(mine.board, mine.thread), mine.base);
    } else stash();
    leave(dropForm(), null);
    drawTray();
  }

  async function open({ board, thread = 0, quote = 0, selection = '', from = null }) {
    if (closed) return;
    const before = document.activeElement;
    if (before && before !== document.body && !before.closest?.('.composer, .reply-tray')) openedFrom = before;
    let same = st && st.board === board && st.thread === thread;
    // An open form takes the quote at its caret; a form opened now, at the end.
    const ta0 = same ? el?.querySelector('[data-key="compose-com"]') : null;
    const caret = ta0 && document.activeElement === ta0 ? ta0.selectionStart : same ? st.caret : null;
    const flying = same ? null : posting.get(key(board, thread));
    if (flying) {
      // that thread's reply is going out: its form comes back (never a
      // second one from the draft, which could post it twice)
      stash();
      st = flying;
      same = true;
      reloadDrafts();
      drawTray();
    } else if (!same) {
      // another window may have posted, deleted or written one
      if (C.postingNow(reloadDrafts()?.get(key(board, thread)))) {
        // another window is posting that thread's reply: a second form
        // could post it twice
        toast(POSTING_ELSEWHERE);
        return;
      }
      stash(); // the form open now stays, as a pill
      saved = loadSaved(); // another window may have saved some
      const d = drafts.get(key(board, thread)) || {};
      const s = getSettings();
      st = {
        board,
        thread,
        base: d.at || 0, // when the copy shown was written (see typed)
        com: d.com || '',
        sub: d.sub || '',
        email: d.email || '',
        name: s.post?.name || '',
        file: null, // { name, size, type, bytes, randomName }
        spoiler: false,
        randomName: s.post?.randomName === true, // send the file under its random name
        caret: null, // where the comment's caret was when it lost the focus
        strip: s.files?.stripMetadata !== false,
        captcha: { state: 'idle' },
        busy: false,
        problems: [],
        message: '',
        info: null,
        min: false, // folded down to its title bar
      };
      reloadDrafts(); // the form left is a pill of what is stored for it now
    }
    if (!same) {
      drawTray(); // this thread's pill is the form now
      if (drafts.get(key(board, thread))?.file) {
        const mine = st;
        getFile(fileKey(key(board, thread))).then((f) => {
          if (f && st === mine && !st.file) {
            st.file = f;
            draw('keep');
          }
        });
      }
    }
    const wasMin = Boolean(st.min);
    const minBox = wasMin ? el?.getBoundingClientRect() : null;
    st.min = false;
    const picked = String(selection || '').trim() ? String(selection) : '';
    // The selection comes in as greentext under the >>N; a bare >>N only
    // when the comment does not quote that post yet. Not into a reply going
    // out: it would not be in what is sent.
    if (st.busy) {
      /* the quote is left out */
    } else if (picked || (quote && !st.com.includes(`>>${quote}`))) {
      const r = C.insertAtCaret(st.com, Number.isFinite(caret) ? caret : st.com.length, C.quoteText(quote, picked));
      st.com = r.text;
      st.caret = r.caret;
      typed(); // a change like any typed one: kept
    } else if (Number.isFinite(caret)) st.caret = caret;
    const fresh = !el;
    draw();
    if (from || minBox) morph(el, from || minBox);
    else if (fresh) rise(el);
    const ta = el.querySelector('[data-key="compose-com"]');
    ta?.focus();
    if (ta) ta.selectionStart = ta.selectionEnd = Number.isFinite(st.caret) ? Math.min(st.caret, ta.value.length) : ta.value.length;
    if (!same) {
      st.info = await getBoard(board).catch(() => null);
      if (st && st.board === board) draw('keep');
      loadCaptcha();
    }
  }

  async function loadCaptcha() {
    if (!st) return;
    const mine = st;
    const seq = (mine.captchaSeq = (mine.captchaSeq || 0) + 1);
    const stale = () => st !== mine || mine.captchaSeq !== seq; // a newer request took over
    st.captcha = { state: 'loading' };
    draw('keep');
    let data;
    try {
      data = await bridge.captcha(mine.board, mine.thread);
    } catch (e) {
      const msg = String(e?.message || e);
      data = null;
      if (stale()) return;
      st.captcha =
        msg === 'check-needed'
          ? { state: 'error', message: 'The site wants a quick browser check. A CloverEye window with the site opened: complete it there, then press New captcha.' }
          : { state: 'error', message: msg };
      draw('keep');
      return;
    }
    if (stale()) return;
    st.captcha = C.captchaState(data);
    draw('keep');
    // The slider takes the keys at once, unless something is being typed.
    if (st.captcha.state === 'ready' && !typing()) focusSlider();
  }

  const typing = () => {
    const a = document.activeElement;
    return Boolean(a && el?.contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(range|checkbox|file)$/.test(a.type))));
  };
  const focusSlider = () => el?.querySelector('[data-key="compose-slider"]')?.focus({ preventScroll: true });

  // ------------------------------------------------- "From library"

  /** A picker over the library: search, press a picture, it is attached. */
  async function fromLibrary(opener) {
    if (!library?.available()) return;
    await library.load();
    let q = '';
    const grid = h('ul', { class: 'library__grid library-pick__grid', 'aria-label': 'Library files' });
    const fill = () => {
      const list = L.filterItems(library.items(), { q, sort: 'added' }).slice(0, 120);
      grid.replaceChildren(
        ...list.map((e) =>
          h(
            'li',
            { class: 'library__tile' },
            h(
              'button',
              {
                type: 'button',
                class: 'library__thumb',
                title: e.tags.length ? `${e.name} · ${e.tags.join(', ')}` : e.name,
                'aria-label': e.tags.length ? `${e.name} · ${e.tags.join(', ')}` : e.name,
                'data-key': `compose-lib-${e.id}`,
                onclick: async () => {
                  try {
                    const file = await library.asFile(e);
                    // closed while the file was read: the pick was cancelled
                    // (and the form open now may be another thread's)
                    if (!d.isConnected) return;
                    finish();
                    await pickFile(file);
                    el?.querySelector('[data-key="compose-com"]')?.focus({ preventScroll: true });
                  } catch (err) {
                    toast(`Couldn’t attach it: ${err?.message || err}`);
                  }
                },
              },
              e.kind === 'video'
                ? h('video', { src: library.fileUrl(e), muted: true, preload: 'metadata', 'aria-hidden': 'true' })
                : h('img', { src: library.fileUrl(e), alt: '', loading: 'lazy' }),
            ),
          ),
        ),
      );
      if (!list.length) grid.append(h('li', { class: 'state-line', text: library.items().length ? 'Nothing matches.' : 'The library is empty.' }));
    };
    const d = h(
      'dialog',
      { class: 'library-pick', 'aria-label': 'Attach from the library' },
      h(
        'div',
        { class: 'library-pick__head' },
        h('strong', { text: 'Attach from the library' }),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close', 'data-key': 'compose-lib-close', onclick: () => finish() }, icon('x')),
      ),
      h('input', {
        type: 'search',
        class: 'input',
        placeholder: 'Search names, tags, threads',
        'aria-label': 'Search the library',
        'data-key': 'compose-lib-search',
        autofocus: true,
        oninput: (e) => ((q = e.target.value), fill()),
      }),
      grid,
    );
    function finish() {
      if (!d.isConnected) return;
      d.close();
      d.remove();
      opener?.isConnected && opener.focus({ preventScroll: true });
    }
    d.addEventListener('close', () => d.remove());
    fill();
    document.body.append(d);
    d.showModal();
  }

  async function pickFile(file) {
    const mine = st;
    if (!mine || !file || mine.busy) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // another form opened (or this one went out) while a big file was read:
    // it is not attached to that one
    if (st !== mine || mine.busy) return;
    const name = file.name || 'pasted.png';
    mine.file = { name, size: bytes.length, type: file.type || '', bytes, randomName: C.randomFileName(name) };
    putFile(fileKey(key(mine.board, mine.thread)), mine.file); // kept with the reply
    typed();
    draw('keep');
  }

  async function submit() {
    if (!st || st.busy) return;
    const s = getSettings();
    const isThread = !st.thread;
    st.problems = C.preflight({
      board: st.info,
      isThread,
      com: st.com,
      sub: st.sub,
      file: st.file,
      captcha: st.captcha,
      cooldownUntil: cooldowns.get(st.board) || 0,
    });
    if (st.problems.length) {
      draw('keep');
      // only the captcha left: straight to its slider, for the arrow keys
      // (expired: to New captcha; the site would refuse it)
      const onlyCaptcha = st.problems.every((p) => p.field === 'captcha') && st.captcha.state === 'ready';
      if (onlyCaptcha && C.captchaExpired(st.captcha)) el?.querySelector('[data-key="compose-captcha-new"]')?.focus({ preventScroll: true });
      else if (onlyCaptcha) focusSlider();
      else el?.querySelector('.composer__problems')?.focus?.();
      return;
    }
    const mine = st;
    const k = key(mine.board, mine.thread);
    if (C.postingNow(reloadDrafts()?.get(k))) {
      // the same reply open in two windows, Post pressed in the other one
      st.problems = [{ field: 'submit', message: POSTING_ELSEWHERE }];
      draw('keep');
      return;
    }
    // Stored as going out, so other windows show no pill and open no second
    // form for it (and a crash meanwhile still has it). Only over the copy
    // this form has: a newer one from another window is left as it is.
    const pressed = Date.now();
    setDraft(k, { ...draftOf(mine, pressed), posting: pressed }, mine.base || pressed);
    if (persistDrafts()?.get(k)?.posting === pressed) mine.base = pressed;
    st.busy = true;
    posting.set(k, mine);
    st.message = 'Posting…';
    // A reply goes into its thread at once, grey until the site says it is
    // posted; the form folds down meanwhile so it can be seen arriving.
    const pid = !isThread && onPending ? `p${++pendingSeq}` : null;
    if (pid) {
      const box = el?.querySelector('[data-key="compose-com"]')?.getBoundingClientRect();
      mine.wasMin = mine.min;
      mine.min = true;
      onPending({
        type: 'start',
        id: pid,
        board: mine.board,
        thread: mine.thread,
        post: C.pendingPost({ thread: mine.thread, name: mine.name, sub: mine.sub, com: mine.com }),
        file: mine.file ? C.uploadName(mine.file, mine.randomName) : '',
        from: box && box.width ? { left: box.left, top: box.top, width: box.width, height: box.height } : null,
      });
    }
    draw('keep');
    let file = null;
    let cleaned = 0;
    if (mine.file) {
      let bytes = mine.file.bytes;
      if (mine.strip) {
        const r = C.stripMetadata(bytes, mine.file.name);
        bytes = r.bytes;
        cleaned = r.removed;
      }
      file = { name: C.uploadName(mine.file, mine.randomName), type: mine.file.type, b64: C.toBase64(bytes) };
    }
    const fields = C.postFields({
      isThread,
      thread: mine.thread,
      name: mine.name,
      email: mine.email,
      sub: mine.sub,
      com: mine.com,
      spoiler: mine.spoiler,
      challenge: mine.captcha.challenge || '',
      response: C.captchaAnswer(mine.captcha),
      pwd: pwd(s),
    });
    let result;
    try {
      const res = await bridge.submitPost(mine.board, fields, file);
      result = C.parsePostResponse(res?.text, res?.status);
    } catch (e) {
      const msg = String(e?.message || e);
      result = { ok: false, message: msg === 'check-needed' ? 'The site wants a quick browser check: complete it in the window that opened, then post again.' : msg };
    }
    if (pid) onPending(result.ok ? { type: 'posted', id: pid, no: result.no } : { type: 'failed', id: pid, message: result.message });
    mine.busy = false;
    posting.delete(k);
    if (!result.ok) {
      // a reply again, not one going out (unless another window wrote it since)
      const at = Date.now();
      setDraft(k, draftOf(mine, at), mine.base);
      if (persistDrafts()?.get(k)?.at === at) mine.base = at;
      if (st !== mine) {
        toast(`Not posted: ${result.message}`); // the form was closed meanwhile; the draft is kept
        drawTray(); // and is a pill again
        return;
      }
      mine.message = result.message;
      if (pid) mine.min = Boolean(mine.wasMin);
      // A used captcha is gone either way: fetch the next one.
      if (mine.captcha.state === 'ready') loadCaptcha();
      else draw('keep');
      if (!mine.min) focusComment();
      return;
    }
    const wait = C.cooldownSeconds(mine.info, { isThread, hasFile: Boolean(file) });
    if (wait) cooldowns.set(mine.board, Date.now() + wait * 1000);
    const next = C.addYou({ ...getSettings(), post: { ...(getSettings().post || {}), name: mine.name } }, mine.board, result.no);
    saveSettings(next);
    forget(k, mine.base); // the copy sent (one written since in another window stays)
    const left = C.savedFor(saved, mine.board, mine.thread).length;
    const leftNote = left === 1 ? ' · 1 saved reply left for this thread' : left ? ` · ${left} saved replies left for this thread` : '';
    toast(`Posted: No. ${result.no}${cleaned ? ' · location and camera data removed' : ''}${leftNote}`);
    if (st === mine) leave(dropForm(), null);
    drawTray();
    onPosted({ board: mine.board, thread: result.thread, no: result.no });
  }

  // ------------------------------------------------------------------ draw

  function field(label, input) {
    return h('label', { class: 'composer__field' }, h('span', { class: 'composer__label', text: label }), input);
  }

  function captchaBlock() {
    const c = st.captcha;
    if (c.state === 'loading' || c.state === 'idle') {
      return h(
        'div',
        { class: 'state-line composer__loading', role: 'status' },
        icon('refresh'),
        h(
          'div',
          {},
          'Loading the site’s captcha… If the site wants its human check, a CloverEye “Site check” window comes forward: complete it there; this form continues by itself. ',
          bridge.showSiteWindow
            ? h(
                'button',
                { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-site-window', onclick: () => bridge.showSiteWindow().catch(() => {}) },
                icon('external'),
                'Show the site window',
              )
            : null,
        ),
      );
    }
    if (c.state === 'none') return h('p', { class: 'state-line', role: 'status' }, icon('check'), 'No captcha needed this time.');
    const again = h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-captcha-new', onclick: loadCaptcha }, icon('refresh'), 'New captcha');
    if (c.state !== 'ready') {
      const left = c.until ? Math.max(0, Math.ceil((c.until - Date.now()) / 1000)) : 0;
      // The site's wait, or the abuse check's: asking now only counts against you.
      again.disabled = left > 0;
      return h(
        'div',
        { class: `callout ${c.state === 'wait' ? 'callout--warn' : 'callout--danger'}`, role: 'status' },
        icon('info'),
        h(
          'div',
          {},
          c.message,
          c.until ? h('span', { class: 'composer__wait', 'data-captcha-wait': '', text: waitText(left, c.state) }) : null,
          ' ',
          again,
        ),
      );
    }
    const left = Math.max(0, Math.ceil((c.expires - Date.now()) / 1000));
    const progress = h(
      'ol',
      { class: 'captcha__steps', 'aria-label': 'Captcha steps' },
      c.tasks.map((_, i) => h('li', { class: i < c.picks.length ? 'done' : i === c.step ? 'now' : '', text: String(i + 1) })),
    );
    if (C.captchaDone(c)) {
      const expired = C.captchaExpired(c);
      return h(
        'div',
        { class: 'captcha' },
        progress,
        expired
          ? h('p', { class: 'state-line', role: 'status' }, icon('info'), expiresText(0))
          : h('p', { class: 'state-line', role: 'status' }, icon('check'), 'Captcha answered. Post when ready.'),
        h('div', { class: 'captcha__row' }, again),
      );
    }
    const task = c.tasks[c.step];
    const count = task.items.length;
    const picture = (n) => {
      const src = n === 0 ? task.promptImg : task.items[n - 1];
      return src
        ? h('img', { class: 'captcha__img', src, draggable: 'false', alt: n === 0 ? 'The captcha’s question' : `Choice ${n} of ${count}` })
        : h('span', { class: 'field__hint', text: 'Slide to see the choices.' });
    };
    const valueText = (n) => (n === 0 ? 'the question' : `choice ${n} of ${count}`);
    // Sliding redraws nothing: the picture, the slider's words and Next
    // change in place, so a drag under way is never cut off (a redraw
    // replaced the slider under the pointer, which ended the drag).
    const show = (n) => {
      if (!st || st.captcha.state !== 'ready') return;
      st.captcha = C.captchaShow(st.captcha, n);
      const cur = st.captcha.current;
      const stage = el?.querySelector('[data-captcha-stage]');
      if (stage && stage.dataset.shown !== String(cur)) {
        stage.dataset.shown = String(cur);
        stage.replaceChildren(picture(cur));
      }
      const sl = el?.querySelector('[data-key="compose-slider"]');
      if (sl) {
        if (sl.value !== String(cur)) sl.value = String(cur);
        sl.setAttribute('aria-valuetext', valueText(cur));
      }
      const nx = el?.querySelector('[data-key="compose-captcha-next"]');
      if (nx) nx.disabled = cur < 1;
    };
    const step = (d) => show(st.captcha.current + d);
    const next = () => {
      st.captcha = C.captchaNext(st.captcha);
      draw('none');
      (el.querySelector('[data-key="compose-slider"]') || el.querySelector('[data-key="compose-submit"]'))?.focus();
    };
    // The picture itself scrubs too: drag across it (a choice per 24 px),
    // or the wheel / a two-finger swipe over it.
    let wheel = 0;
    const scrub = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      focusSlider();
      const x0 = e.clientX;
      const from = st.captcha.current;
      const stage = e.currentTarget;
      stage.setPointerCapture?.(e.pointerId);
      stage.classList.add('captcha__stage--drag');
      const move = (ev) => show(from + Math.round((ev.clientX - x0) / 24));
      const up = () => {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        stage.removeEventListener('pointercancel', up);
        stage.classList.remove('captcha__stage--drag');
      };
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    };
    const onWheel = (e) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      wheel += e.deltaMode === 1 ? d * 40 : d;
      if (Math.abs(wheel) < 40) return;
      step(Math.sign(wheel));
      wheel = 0;
    };
    return h(
      'div',
      {
        class: 'captcha',
        // ←/→ work wherever the focus is in the captcha (the picture, Next),
        // not only on the slider
        onkeydown: (e) => {
          if (e.target.matches?.('input[type="range"]')) return;
          const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: 1, ArrowDown: -1 }[e.key];
          if (!d) return;
          e.preventDefault();
          step(d);
          focusSlider();
        },
      },
      progress,
      task.prompt ? h('p', { class: 'captcha__prompt', text: task.prompt }) : null,
      h(
        'div',
        { class: 'captcha__view' },
        h(
          'div',
          {
            class: 'captcha__stage',
            'data-captcha-stage': '',
            'data-shown': String(c.current),
            title: 'Drag across the picture, or scroll over it, to see the choices',
            onpointerdown: scrub,
            onwheel: onWheel,
          },
          picture(c.current),
        ),
        task.target
          ? h(
              'figure',
              { class: 'captcha__target', 'data-key': 'compose-target' },
              h('img', { src: task.target, alt: 'The object to find' }),
              h('figcaption', { text: 'Find this' }),
            )
          : null,
      ),
      h('input', {
        type: 'range',
        min: '0',
        max: String(count),
        step: '1',
        value: String(c.current),
        class: 'captcha__slider',
        'aria-label': `Step ${c.step + 1} of ${c.tasks.length}: slide through the ${count} choices`,
        'aria-valuetext': valueText(c.current),
        'data-key': 'compose-slider',
        // WebKit does not focus a range input that is clicked: it is given
        // the focus here, so the arrow keys work right after a slide.
        onpointerdown: (e) => e.currentTarget.focus({ preventScroll: true }),
        oninput: (e) => {
          show(e.target.value);
          if (document.activeElement !== e.target) e.target.focus({ preventScroll: true });
        },
        onchange: (e) => {
          if (document.activeElement !== e.target) e.target.focus({ preventScroll: true });
        },
        onwheel: onWheel,
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && st.captcha.current > 0) {
            e.preventDefault();
            next();
          }
        },
      }),
      h(
        'div',
        { class: 'captcha__row' },
        h(
          'button',
          { type: 'button', class: 'btn btn--sm btn--primary', 'data-key': 'compose-captcha-next', disabled: c.current < 1, onclick: next },
          c.step + 1 < c.tasks.length ? `This one · next (${c.step + 1}/${c.tasks.length})` : 'This one · done',
        ),
        again,
      ),
      h('p', { class: 'field__hint', 'data-captcha-left': '', text: expiresText(left) }),
    );
  }

  function modeButton(which, iconName, label) {
    const on = mode === which;
    return h(
      'button',
      {
        type: 'button',
        class: `icon-btn icon-btn--sm composer__mode${on ? ' composer__mode--on' : ''}`,
        'aria-pressed': String(on),
        'aria-label': label,
        title: on ? `${label} (on: press for a floating form)` : label,
        'data-key': `compose-${which}`,
        onclick: () => setMode(which),
      },
      icon(iconName),
    );
  }

  /** Draws the form. 'keep' keeps focus and caret where they were. */
  function draw(focus = 'none') {
    if (!st) return;
    const active = document.activeElement;
    const focusKey = el && el.contains(active) ? active?.dataset?.key : null;
    const caret = focusKey && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const info = st.info;
    const isThread = !st.thread;
    const max = info?.max_comment_chars || 2000;
    const fileLimit = st.file && /\.(webm|mp4)$/i.test(st.file.name) ? info?.max_webm_filesize : info?.max_filesize;
    const next = h(
      'section',
      {
        class: `composer${st.min ? ' composer--min' : mode === 'full' ? ' composer--full' : mode === 'pane' ? ' composer--pane' : ''}`,
        role: 'dialog',
        'aria-label': isThread ? `New thread on /${st.board}/` : `Reply to No. ${st.thread}`,
        'data-key': 'composer',
        // folded, it is the pile's front card: pointing at it fans the pile
        onpointerenter: st.min ? () => fan(true) : null,
        onpointerleave: st.min ? () => fan(false) : null,
      },
      h(
        'div',
        { class: 'composer__head', onpointerdown: startMove, ondblclick: resetPos },
        st.min || mode !== 'float' ? null : grip(),
        st.min
          ? h(
              'button',
              { type: 'button', class: 'composer__title composer__title--btn', 'data-key': 'compose-restore', 'aria-expanded': 'false', onclick: () => setMin(false) },
              h('strong', { text: isThread ? `New thread on /${st.board}/` : `Reply to /${st.board}/ No. ${st.thread}` }),
            )
          : h('strong', {
              class: 'composer__title',
              tabindex: '0',
              title: mode === 'float' ? 'Drag to move · arrow keys · double-click: back to the corner' : null,
              'aria-description': mode === 'float' ? 'Move the reply form: drag, or arrow keys (double-click: back to the corner)' : null,
              'data-key': 'compose-move',
              onkeydown: moveKeys,
              text: isThread ? `New thread on /${st.board}/` : `Reply to /${st.board}/ No. ${st.thread}`,
            }),
        st.min ? h('span', { class: 'composer__note', 'data-compose-note': '', text: headNote() }) : null,
        st.min ? null : modeButton('pane', 'panel', 'Fill the thread’s pane'),
        st.min ? null : modeButton('full', mode === 'full' ? 'collapse' : 'expand', 'Fill the window'),
        // folded, the title opens it again (the bar is a pill, like a saved reply's)
        st.min
          ? null
          : h(
              'button',
              {
                type: 'button',
                class: 'icon-btn icon-btn--sm composer__fold',
                'aria-label': 'Minimise the reply form (it keeps everything)',
                'aria-expanded': 'true',
                'data-key': 'compose-min',
                onclick: () => setMin(true),
              },
              icon('minus'),
            ),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Delete this reply (asks first; minimise keeps it)', title: 'Delete this reply (asks first; minimise keeps it)', 'data-key': 'compose-close', onclick: (e) => closeAsked(e.currentTarget) }, icon('x')),
      ),
      h(
        'div',
        {
          class: 'composer__body',
          ondragover: (e) => e.preventDefault(),
          ondrop: (e) => {
            e.preventDefault();
            const f = e.dataTransfer?.files?.[0];
            if (f) pickFile(f);
          },
        },
        h(
          'div',
          { class: 'composer__row' },
          field('Name', h('input', { class: 'input', value: st.name, placeholder: 'Anonymous', maxlength: '100', 'data-key': 'compose-name', oninput: (e) => (st.name = e.target.value) })),
          field('Options', h('input', { class: 'input', value: st.email, placeholder: 'sage', maxlength: '100', 'data-key': 'compose-email', oninput: (e) => ((st.email = e.target.value), typed()) })),
        ),
        isThread || info?.require_subject
          ? field('Subject', h('input', { class: 'input', value: st.sub, maxlength: '100', 'data-key': 'compose-sub', oninput: (e) => ((st.sub = e.target.value), typed()) }))
          : null,
        field(
          'Comment',
          h('textarea', {
            class: 'input composer__com',
            rows: '6',
            'data-key': 'compose-com',
            onblur: (e) => st && (st.caret = e.target.selectionStart),
            oninput: (e) => {
              st.com = e.target.value;
              st.caret = e.target.selectionStart;
              typed();
              const n = el.querySelector('[data-com-count]');
              if (n) {
                n.textContent = `${st.com.length} / ${max}`;
                n.classList.toggle('over', st.com.length > max);
              }
            },
            onpaste: (e) => {
              const f = [...(e.clipboardData?.files || [])][0];
              if (f) {
                e.preventDefault();
                pickFile(f);
              }
            },
            onkeydown: (e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
              } else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                saveForLater();
              }
            },
          }),
        ),
        h('div', { class: 'composer__count', 'data-com-count': '', text: `${st.com.length} / ${max}` }),
        h(
          'div',
          { class: 'composer__file' },
          h(
            'label',
            { class: 'btn btn--sm' },
            icon('folder'),
            st.file ? 'Change file' : 'Attach file',
            h('input', {
              type: 'file',
              class: 'visually-hidden',
              accept: 'image/jpeg,image/png,image/gif,video/webm,video/mp4,application/pdf,.jpg,.jpeg,.png,.gif,.webm,.mp4,.pdf',
              'data-key': 'compose-file',
              onchange: (e) => pickFile(e.target.files?.[0]),
            }),
          ),
          st.file
            ? h(
                'span',
                { class: 'composer__filename' },
                `${C.uploadName(st.file, st.randomName)} · ${(st.file.size / 1024 / 1024).toFixed(2)} MB${fileLimit ? ` of ${(fileLimit / 1024 / 1024).toFixed(0)} MB` : ''}`,
                st.randomName ? h('span', { class: 'composer__origname', translate: 'no', title: 'The file’s own name, not sent', text: st.file.name }) : null,
                h('button', { type: 'button', class: 'link-btn', 'data-key': 'compose-file-remove', onclick: () => ((st.file = null), delFile(fileKey(key(st.board, st.thread))), typed(), draw('keep')), text: 'Remove' }),
              )
            : h('span', { class: 'field__hint', text: 'or drop / paste one here' }),
          !st.file && library?.available()
            ? h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'compose-library', onclick: (e) => fromLibrary(e.currentTarget) }, icon('images'), 'From library')
            : null,
          st.file
            ? h(
                'label',
                { class: 'checkline composer__random' },
                h('input', { type: 'checkbox', checked: st.randomName, 'data-key': 'compose-random', onchange: (e) => ((st.randomName = e.target.checked), draw('keep')) }),
                h('span', { text: 'Random name' }),
              )
            : null,
        ),
        h(
          'div',
          { class: 'composer__checks' },
          h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: st.strip, 'data-key': 'compose-strip', onchange: (e) => (st.strip = e.target.checked) }), h('span', { text: 'Remove location and camera data from images' })),
          info?.spoilers
            ? h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: st.spoiler, 'data-key': 'compose-spoiler', onchange: (e) => (st.spoiler = e.target.checked) }), h('span', { text: 'Spoiler the image' }))
            : null,
        ),
        h('div', { class: 'composer__captcha' }, captchaBlock()),
        st.problems.length
          ? h('ul', { class: 'composer__problems', role: 'alert', tabindex: '-1' }, st.problems.map((p) => h('li', { text: p.message })))
          : null,
        st.message ? h('p', { class: `state-line${st.busy ? '' : ' composer__msg'}`, role: 'status', text: st.message }) : null,
      ),
      h(
        'div',
        { class: 'composer__foot' },
        onSitePage
          ? h('button', { type: 'button', class: 'link-btn', 'data-key': 'compose-site', onclick: () => onSitePage(st.board, st.thread, 0), text: 'Post on the site’s page instead' })
          : null,
        h(
          'span',
          { class: 'composer__actions' },
          // the pre-written posts (the shell's pastas popup) for this form
          onPastas
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn composer__pastas',
                  'aria-label': 'Pre-written posts',
                  title: 'Pre-written posts',
                  'aria-haspopup': 'dialog',
                  'aria-expanded': 'false',
                  'data-key': 'compose-pastas',
                  disabled: st.busy,
                  onclick: (e) => onPastas(e.currentTarget, { board: st.board, thread: st.thread }),
                },
                icon('copy'),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              'data-key': 'compose-save',
              title: 'Keep this reply for later, in the tray at the bottom (Ctrl+S)',
              disabled: st.busy,
              onclick: saveForLater,
            },
            icon('bookmark'),
            'Save for later',
          ),
          h('button', { type: 'button', class: 'btn btn--primary', 'data-key': 'compose-submit', disabled: st.busy, onclick: submit }, icon('reply'), st.busy ? 'Posting…' : 'Post'),
        ),
      ),
    );
    applySize(next);
    if (el) el.replaceWith(next);
    else document.body.append(next);
    el = next;
    applyPos(el);
    paneBox = '';
    placeOver();
    const ta = el.querySelector('[data-key="compose-com"]');
    if (ta) {
      ta.value = st.com;
      // the caret stays where it was, for a quote added while the form is open
      if (Number.isFinite(st.caret)) ta.setSelectionRange(Math.min(st.caret, ta.value.length), Math.min(st.caret, ta.value.length));
    }
    if (focus === 'keep' && focusKey) {
      const f = el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      f?.focus({ preventScroll: true });
      if (f && caret && typeof f.setSelectionRange === 'function') f.setSelectionRange(caret[0], caret[1]);
    }
    if (!tick) tick = setInterval(onTick, 250);
    placeTray();
  }

  // Four times a second, so each second turns on time: the captcha's time
  // left, and a wait the site asked for, counted down live. When the wait is
  // over, the next captcha is fetched.
  function onTick() {
    placeOver();
    placeTray();
    const c = st?.captcha;
    if (!c || !el) return;
    if (c.state === 'ready') {
      const left = el.querySelector('[data-captcha-left]');
      const s = Math.max(0, Math.ceil((c.expires - Date.now()) / 1000));
      if (left) left.textContent = expiresText(s);
      // it just ran out: an answered one says so, and so does the folded title
      if (!st.busy && !c.expiredDrawn && C.captchaExpired(c)) {
        c.expiredDrawn = true;
        if (C.captchaDone(c)) draw('keep');
        if (st.min) drawHeadNote();
      }
      return;
    }
    if (!c.until) return;
    const s = Math.max(0, Math.ceil((c.until - Date.now()) / 1000));
    const span = el.querySelector('[data-captcha-wait]');
    if (span) span.textContent = waitText(s, c.state);
    const again = el.querySelector('[data-key="compose-captcha-new"]');
    if (again && again.disabled && s === 0) again.disabled = false;
    if (st.min) drawHeadNote();
    if (s === 0 && c.state === 'wait' && !c.retried) {
      c.retried = true;
      loadCaptcha();
    }
  }

  function waitText(s, state) {
    if (s > 0) return ` ${formatLeft(s)} left.`;
    return state === 'wait' ? ' Getting a new captcha…' : '';
  }

  // The title bar of a folded form says what is going on underneath.
  function headNote() {
    const c = st.captcha;
    if (st.busy) return 'Posting…';
    if (c.state === 'loading' || c.state === 'idle') return 'Loading captcha…';
    if (c.state === 'wait' && c.until) return `Wait ${formatLeft(Math.max(0, Math.ceil((c.until - Date.now()) / 1000)))}`;
    if (C.captchaExpired(c)) return 'Captcha expired';
    if (C.captchaDone(c)) return 'Ready to post';
    if (c.state === 'ready') return 'Captcha to solve';
    return c.state === 'error' || c.state === 'blocked' ? 'Captcha problem' : '';
  }

  function drawHeadNote() {
    const n = el?.querySelector('[data-compose-note]');
    if (n) n.textContent = headNote();
  }

  /**
   * Puts `text` (a pre-written post: pasta-view.js) into the open form's
   * comment at its caret, as if it were typed there: on a line of its own
   * (a new line before it unless the caret is at a line start, one after
   * it when text follows), a selection replaced, the draft kept and merged
   * across windows like any keystroke (the input event: typed()), the
   * count updated (past the board's limit it turns red, as when typing,
   * and a toast says by how much), the comment focused; Ctrl+Z takes it
   * out again where the webview keeps an undo step for it.
   *
   * It opens nothing: open the form first, then insert, passing `where`
   * so the text never lands in another thread's form (open() leaves the
   * form that was up when another window is posting that reply):
   *   composer.open({ board, thread });   // thread 0: a new thread on board
   *   composer.insertText(text, { board, thread });
   * open() sets the form up before its first wait, so the insert can
   * follow it at once (or after awaiting it).
   *
   * Returns false when nothing went in: no form, another thread's form,
   * empty text, the reply going out (Post was pressed), or that reply
   * being posted in another window (shown in the form, as a keystroke
   * there shows it: POSTING_ELSEWHERE).
   */
  function insertText(text, where = null) {
    if (closed || !st || !el) return false;
    if (where && (st.board !== where.board || Number(st.thread || 0) !== Number(where.thread || 0))) return false;
    const snippet = String(text ?? '').replace(/\r\n?/g, '\n');
    if (!snippet.trim() || st.busy) return false;
    const k = key(st.board, st.thread);
    if (!posting.has(k) && C.postingNow(reloadDrafts()?.get(k))) {
      if (!st.problems.some((p) => p.message === POSTING_ELSEWHERE)) {
        st.problems = [{ field: 'submit', message: POSTING_ELSEWHERE }];
        draw('keep');
      }
      return false;
    }
    if (st.min) {
      // folded: it opens, as Reply opens it
      const box = el.getBoundingClientRect();
      st.min = false;
      draw();
      morph(el, box);
    }
    const ta = el.querySelector('[data-key="compose-com"]');
    if (!ta) return false;
    const focused = document.activeElement === ta;
    const start = focused ? ta.selectionStart : Number.isFinite(st.caret) ? Math.min(st.caret, ta.value.length) : ta.value.length;
    const end = focused ? Math.max(start, ta.selectionEnd) : start;
    const r = C.insertAtCaret(ta.value.slice(0, start) + ta.value.slice(end), start, snippet);
    const add = r.text.slice(start, r.caret); // the new line(s) around it too
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(start, end);
    // as an edit of the field (an undo step, the input event); by hand
    // where the webview does not take it
    let done = false;
    try {
      done = document.execCommand('insertText', false, add) && ta.value === r.text;
    } catch (_) {
      done = false;
    }
    if (!done) {
      ta.value = r.text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ta.setSelectionRange(r.caret, r.caret);
    if (st) st.caret = r.caret;
    const max = st?.info?.max_comment_chars || 2000;
    if (st && st.com.length > max) toast(`The comment is ${st.com.length - max} characters over the limit.`);
    return true;
  }

  return {
    open,
    close,
    insertText,
    isOpen: () => Boolean(st),
    state: () => st,
  };
}
