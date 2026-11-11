// Quote links and backlinks inside a thread: a click opens the quoted post
// right below the link (a nested copy) and a second click closes it; Ctrl/⌘
// or Settings → Look → Quote links jumps to the post instead. Resting the
// mouse on a link, or tabbing to it, shows a floating preview of the post
// (off when <html data-quote-preview="off">). A link to another thread's
// post (>>>/g/123, or >>123 whose address is another thread) does the same
// once that thread is loaded through the shell's fetch queue: "Loading…"
// first, then the post, or why it is not there and a link to an archive.
// Dead links (posts the site no longer has) get an archive button. The
// rules are in quote-model.js and archive-model.js; text only through
// textContent (renderPost builds nodes).

import { h, icon } from './dom.js';
import * as Q from './quote-model.js';
import { deadlinkRef } from './archive-model.js';

const opened = new Map(); // "pane prefix + board/thread" → Set of open paths
const contexts = new WeakMap(); // .thread element → its thread's quote context

const LINK = '.seg-quotelink[data-target]';
const postNo = (el) => Number(el?.dataset.no || el?.dataset.inlineNo) || 0;

function flash(el) {
  el.classList.remove('post--flash');
  void el.offsetWidth;
  el.classList.add('post--flash');
}

/** A post drawn again (an inline copy or a preview): no id or data-no, so
 *  nothing that looks for the thread's own posts finds it. */
function asCopy(card, extraClass) {
  card.removeAttribute('id');
  card.dataset.inlineNo = card.dataset.no;
  delete card.dataset.no;
  card.classList.add('post--copy', extraClass);
  return card;
}

/**
 * Quote links for one drawn thread.
 * @param {object} o
 * @param {string} o.key                 pane prefix + board/thread: which open copies to keep
 * @param {string} o.board
 * @param {number} o.thread
 * @param {Map<number, object>} o.posts  post No. → post
 * @param {(post: object, idPrefix: string) => HTMLElement} o.render  draws a post (renderPost)
 * @param {(no: number) => void} o.jump  scrolls to a post of the thread
 * @param {() => string} o.mode          'inline' | 'jump' (quote-model.js)
 * @param {string} [o.keyPrefix]
 * @param {((q: {board: string, thread: number, no: number}, e: Event) => void) | null} [o.onCross]
 *   jumping to another thread's post (opens that thread)
 * @param {CrossThreads | null} [o.cross]  other threads' posts and archive links; without it,
 *   links to other threads only jump and dead links get no archive button
 * @returns {{ onQuote: (target: number, e?: Event) => void, attach: (list: HTMLElement) => void }}
 *
 * @typedef {object} CrossThreads
 * @property {(board: string, thread: number) => object | undefined} entry  the cached thread
 *   ({ status, posts: Map, at }; quote-model.js crossState)
 * @property {(board: string, thread: number, force?: boolean) => Promise<void> | null} load
 *   asks for the thread through the queue; null when the cached copy is fresh enough
 * @property {(post: object, board: string, thread: number, idPrefix: string) => HTMLElement} render
 * @property {(ref: {board: string, thread?: number, post?: number}) => {host: string, url: string} | null} archive
 * @property {(url: string) => void} open  opens an address in the system browser
 */
export function quoteLinks({ key, board, thread, posts, render, jump, mode, keyPrefix = '', onCross = null, cross = null }) {
  const here = { board, thread };
  const boxes = new WeakMap(); // link → its open copy
  const state = () => opened.get(key) || new Set();
  const setState = (s) => (s.size ? opened.set(key, s) : opened.delete(key));

  const where = (btn) => Q.quoteTarget({ target: Number(btn.dataset.target), board: btn.dataset.board, thread: Number(btn.dataset.thread) || 0 }, here);

  /** Paths, keys and states for the links that belong to `card` itself. */
  function decorate(card, path) {
    const seen = new Map();
    armDeadlinks(card, board, cross);
    for (const btn of card.querySelectorAll(LINK)) {
      if (btn.closest('.post') !== card) continue;
      const t = where(btn);
      if (t.kind === 'cross' && cross) {
        const id = `x${t.no}`;
        const nth = seen.get(id) || 0;
        seen.set(id, nth + 1);
        const own = Q.childPath(path, 'x', t.no, nth);
        btn.dataset.quotePath = own;
        btn.dataset.key = `${keyPrefix}quote-${Q.pathSlug(own)}`;
        if (mode() !== 'jump') btn.setAttribute('aria-expanded', 'false');
        continue;
      }
      if (t.kind !== 'local') continue;
      const kind = btn.dataset.kind === 'b' ? 'b' : 'q';
      const id = `${kind}${t.no}`;
      const nth = seen.get(id) || 0;
      seen.set(id, nth + 1);
      const own = Q.childPath(path, kind, t.no, nth);
      btn.dataset.quotePath = own;
      btn.dataset.key = `${keyPrefix}quote-${Q.pathSlug(own)}`;
      if (!Q.canExpand(path, t.no)) btn.classList.add('seg-quotelink--loop');
      else if (mode() !== 'jump') btn.setAttribute('aria-expanded', 'false');
    }
  }

  function copyOf(no, path) {
    const box = h('div', { class: 'quote-inline', 'data-quote-path': path });
    const post = posts.get(no);
    if (!post) {
      box.classList.add('quote-inline--missing');
      box.append(h('p', { class: 'quote-inline__missing', text: 'Post not found' }));
      return box;
    }
    const card = asCopy(render(post, `${keyPrefix}q${Q.pathSlug(path)}-p`), 'post--inline');
    decorate(card, path);
    box.append(card);
    return box;
  }

  /** Another thread's post below its link: filled again when that thread
   *  arrives (the box may be gone by then: a redraw draws it anew). */
  function crossCopy(t, path) {
    const box = h('div', { class: 'quote-inline quote-inline--cross', 'data-quote-path': path });
    const fill = () => {
      if (!box.isConnected && box.childElementCount) return;
      box.replaceChildren(...crossBody(t, { cross, idPrefix: `${keyPrefix}q${Q.pathSlug(path)}-p`, inline: true, onRetry: () => watch(cross.load(t.board, t.thread, true)) }));
    };
    const watch = (p) => p?.then(fill, fill);
    fill();
    watch(cross.load(t.board, t.thread));
    return box;
  }

  /** Opens or closes the copy under a link. Returns false when it cannot. */
  function toggle(btn, { replay = false } = {}) {
    const path = btn.dataset.quotePath;
    if (!path) return false;
    const open = boxes.get(btn);
    if (open?.isConnected) {
      open.remove();
      boxes.delete(btn);
      btn.setAttribute('aria-expanded', 'false');
      setState(Q.collapsePath(state(), path));
      return true;
    }
    const target = Number(btn.dataset.target);
    const parent = path.slice(0, path.lastIndexOf('/'));
    const t = where(btn);
    if (t.kind !== 'cross' && !Q.canExpand(parent, target)) {
      // Already open around this link: point at it instead of opening it again.
      if (!replay) {
        for (let el = btn.closest('.post'); el; el = el.parentElement?.closest('.post')) {
          if (postNo(el) === target) {
            el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
            flash(el);
            break;
          }
        }
      }
      return false;
    }
    if (t.kind === 'cross' && !cross) return false;
    const box = t.kind === 'cross' ? crossCopy(t, path) : copyOf(target, path);
    if (btn.dataset.kind === 'b') {
      const card = btn.closest('.post');
      let shelf = [...card.children].find((c) => c.classList.contains('post__inlines'));
      if (!shelf) {
        shelf = h('div', { class: 'post__inlines' });
        card.append(shelf);
      }
      shelf.append(box);
    } else {
      btn.after(box);
    }
    boxes.set(btn, box);
    btn.setAttribute('aria-expanded', 'true');
    if (!replay) setState(Q.expandPath(state(), path));
    return true;
  }

  function onQuote(target, e) {
    const btn = e?.currentTarget;
    if (!btn?.dataset) return jump(target);
    const t = where(btn);
    if (t.kind === 'cross') {
      if (cross && btn.dataset.quotePath && Q.quoteClickAction(mode(), e) === 'inline') {
        preview.hide();
        toggle(btn);
      } else if (onCross) {
        onCross({ board: t.board, thread: t.thread, no: t.no }, e);
      }
      return;
    }
    if (t.kind !== 'local') return;
    if (Q.quoteClickAction(mode(), e) === 'jump' || !btn.dataset.quotePath) return jump(t.no);
    preview.hide();
    toggle(btn);
  }

  /** Called once the thread's posts are in `list`: wires the preview and
   *  opens again the copies that were open before the redraw. */
  function attach(list) {
    contexts.set(list, {
      here,
      onCross,
      preview: (btn) => {
        const t = where(btn);
        if (t.kind === 'cross' && cross) {
          cross.load(t.board, t.thread)?.then(
            () => preview.refresh(btn),
            () => preview.refresh(btn),
          );
          const [node] = crossBody(t, { cross, idPrefix: `${keyPrefix}qp-p`, inline: false });
          return node;
        }
        if (t.kind !== 'local') return null;
        const post = posts.get(t.no);
        if (!post) return h('p', { class: 'quote-preview__missing', text: 'Post not found' });
        return asCopy(render(post, `${keyPrefix}qp-p`), 'post--preview');
      },
    });
    const top = new Map();
    for (const card of list.children) {
      const no = postNo(card);
      if (!no || !card.classList.contains('post')) continue;
      top.set(no, card);
      decorate(card, String(no));
    }
    const keep = new Set();
    for (const path of Q.replayOrder(state())) {
      const btn = list.querySelector(`${LINK}[data-quote-path="${CSS.escape(path)}"]`);
      const parsed = Q.parsePath(path);
      if (!btn || !parsed || !top.has(parsed.root)) continue; // the link is gone (or its post is hidden)
      if (toggle(btn, { replay: true })) keep.add(path);
    }
    setState(keep);
  }

  return { onQuote, attach };
}

// ------------------------------------------------ other threads, dead links

const CROSS_TEXT = {
  loading: 'Loading…',
  missing: 'Post not found',
  gone: 'This thread is gone (404).',
  error: 'Couldn’t load that thread.',
};

/** "Open in archive (host)", or just the icon beside a dead link. */
function archiveButton(link, open, { compact = false } = {}) {
  const onclick = (e) => {
    e.stopPropagation();
    open(link.url);
  };
  if (compact) {
    return h('button', { type: 'button', class: 'archive-link archive-link--icon', 'aria-label': 'Open in archive', title: 'Open in archive', onclick }, icon('external'));
  }
  return h(
    'button',
    { type: 'button', class: 'link-btn archive-link', onclick },
    'Open in archive',
    ' ',
    h('span', { class: 'archive-link__host', translate: 'no', text: `(${link.host})` }),
  );
}

/** Dead quote links in a post (not in copies inside it) get an archive
 *  button, when the board has an archive. */
function armDeadlinks(card, board, cross) {
  if (!cross?.archive) return;
  for (const el of card.querySelectorAll('.seg-deadlink')) {
    if (el.closest('.post') !== card || el.nextElementSibling?.classList.contains('archive-link')) continue;
    const ref = deadlinkRef(el.textContent, board);
    const link = ref && cross.archive(ref);
    if (link) el.after(archiveButton(link, cross.open, { compact: true }));
  }
}

/** Links in another thread's post: those without a thread point into that
 *  thread, so they are given its board and number. */
function rebase(card, board, thread) {
  for (const b of card.querySelectorAll(LINK)) {
    if (b.dataset.thread) continue;
    b.dataset.board = board;
    b.dataset.thread = String(thread);
  }
}

/** What stands for another thread's post: the post, or a line saying why
 *  not (with the archive link and Try again, below a link). */
function crossBody(t, { cross, idPrefix, inline, onRetry = null }) {
  const entry = cross.entry(t.board, t.thread);
  const state = Q.crossState(entry, t.no);
  if (state === 'post') {
    const card = asCopy(cross.render(entry.posts.get(t.no), t.board, t.thread, idPrefix), inline ? 'post--inline' : 'post--preview');
    card.classList.add('post--cross');
    rebase(card, t.board, t.thread);
    if (inline) armDeadlinks(card, t.board, cross);
    return [card];
  }
  const line = h('p', { class: inline ? 'quote-inline__missing' : 'quote-preview__missing', role: state === 'loading' ? 'status' : null }, h('span', { text: CROSS_TEXT[state] }));
  if (inline && state !== 'loading') {
    const link = cross.archive({ board: t.board, thread: t.thread, post: t.no });
    if (link) line.append(' ', archiveButton(link, cross.open));
    if (state === 'error' && onRetry) line.append(' ', h('button', { type: 'button', class: 'link-btn', onclick: onRetry, text: 'Try again' }));
  }
  return [line];
}

// ------------------------------------------------------------- the preview

const DELAY_MS = 250;
let preview = { hide() {}, refresh() {} };

/** The floating preview of a quoted post, for every thread on the page. */
export function installQuotePreview(doc = document) {
  const box = doc.createElement('div');
  box.className = 'quote-preview';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  box.inert = true;
  doc.body.append(box);
  let target = null;
  let timer = null;
  let byMouse = false;

  function show() {
    timer = null;
    if (!target?.isConnected || doc.documentElement.dataset.quotePreview === 'off') return hide();
    if (target.getAttribute('aria-expanded') === 'true') return; // already open below the link
    const ctx = contexts.get(target.closest('.thread'));
    const content = ctx?.preview(target);
    if (!content) return;
    box.replaceChildren(content);
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    Object.assign(box.style, { left: '0px', top: '0px', width: `${Q.previewWidth(vw)}px`, maxHeight: '', visibility: 'hidden' });
    box.hidden = false;
    const p = Q.placeQuotePreview({ link: target.getBoundingClientRect(), w: box.offsetWidth, h: box.offsetHeight, vw, vh });
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, maxHeight: `${p.maxHeight}px`, visibility: '' });
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    target = null;
    if (!box.hidden) {
      box.hidden = true;
      box.replaceChildren(); // stops a video and drops the files
    }
  }
  /** Another thread arrived: the preview waiting for it is drawn again. */
  function refresh(t) {
    if (t !== target || timer) return;
    show();
  }
  preview = { hide, refresh };

  function begin(t, mouse) {
    if (t === target) return;
    hide();
    target = t;
    byMouse = mouse;
    timer = setTimeout(show, DELAY_MS);
  }

  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target.closest?.(LINK);
    if (t && t.closest('.thread')) begin(t, true);
  });
  doc.addEventListener('pointerout', (e) => {
    if (!target || !byMouse) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    hide();
  });
  doc.addEventListener('focusin', (e) => {
    const t = e.target.closest?.(LINK);
    let keyboard = false;
    try {
      keyboard = Boolean(t?.matches(':focus-visible'));
    } catch {
      keyboard = false;
    }
    if (t && keyboard && t.closest('.thread')) begin(t, false);
    else if (target && !byMouse) hide();
  });
  doc.addEventListener('focusout', (e) => {
    if (target && !byMouse && e.target === target) hide();
  });
  // Esc hides a preview (on screen or still waiting) and does nothing else:
  // caught first, so the shell's Esc (back to the catalog) never sees it.
  doc.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !target) return;
      hide();
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  // Scrolling hides a preview on screen; one still waiting for a link that
  // focus has just scrolled into view is placed when it shows.
  doc.addEventListener(
    'scroll',
    () => {
      if (!box.hidden || byMouse) hide();
    },
    true,
  );
  doc.addEventListener('pointerdown', hide, true);
  window.addEventListener('blur', hide);
  return { hide };
}
