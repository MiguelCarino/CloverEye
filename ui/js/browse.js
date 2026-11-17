// The catalog grid and the thread view. The shell owns the state and the
// loading; these only draw it. Text only through textContent.

import * as B from './browse-model.js';
import { isHiddenMark, isGoneMark } from './filter-model.js';
import { h, icon, cloverBusy, cloverClass } from './dom.js';
import * as K from './keys-model.js';
import { renderPost, backlinksRow } from './setup.js';
import { quoteLinks } from './quotes.js';
import { postSelection } from './compose.js';
import { idColour } from './ids-model.js';
import { threadStats } from './stats-model.js';
import { sauceLinks } from './sauce-model.js';
import { catalogThumbView } from './display-model.js';
import { saveControls, savedDate } from './offline.js';
import { cardLabels } from './tag-view.js';
import { threadDelta } from './redraw-model.js';
import { attachColumns, revealPost, COLUMNS_CLASS } from './columns.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** The layout toggle's picture: rows (a list) or two columns, in the
 *  stroke style of dom.js icons. */
function layoutIcon(columns) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const paths = columns ? ['M4 4h7v16H4z', 'M13 4h7v16h-7z'] : ['M4 4h16v7H4z', 'M4 13h16v7H4z'];
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** The thread's layout switch: a list, or columns read sideways. */
function layoutButton(o) {
  const columns = o.layout === 'columns';
  const label = columns ? 'Posts in a list' : 'Posts in columns, scroll sideways';
  return h(
    'button',
    {
      type: 'button',
      class: `btn btn--layout${columns ? ' btn--on' : ''}`,
      'data-key': `${o.keyPrefix}thread-layout`,
      'aria-pressed': String(columns),
      'aria-label': 'Posts in columns, scroll sideways',
      'aria-keyshortcuts': 'L',
      title: label,
      onclick: () => o.onLayout(),
    },
    layoutIcon(columns),
  );
}

const VIDEO = /^\.(webm|mp4)$/i;

/** Text runs (browse-model.js titleRuns) with spoilers drawn hidden. */
const runsEl = (runs) => runs.map((r) => (r.spoiler ? h('span', { class: 'seg-spoiler', text: r.text }) : r.text));

/** A catalog's or thread's status line (browse-model.js statusText), or
 *  null. `data-status` lets the shell swap it in place when a fetch
 *  changed nothing else. */
export function statusLine(entry, what) {
  const text = B.statusText(entry, what);
  if (text === null) return null;
  if (!entry || entry.status === 'loading') return h('p', { class: 'state-line', role: 'status', 'data-status': '' }, icon('refresh'), text);
  return h('p', { class: 'state-line browse__status', role: 'status', 'data-status': '', text });
}

/** "Open in archive (host)" for a thread the site no longer shows. */
function archiveLine(link, open, keyPrefix) {
  if (!link || !open) return null;
  return h(
    'button',
    { type: 'button', class: 'link-btn archive-link', 'data-key': `${keyPrefix}thread-archive`, onclick: () => open(link.url) },
    'Open in archive',
    ' ',
    h('span', { class: 'archive-link__host', translate: 'no', text: `(${link.host})` }),
  );
}

function errorBox(entry, what, onRetry, keyPrefix, extra = null) {
  return h(
    'div',
    { class: 'callout callout--danger', role: 'alert' },
    icon('wifiOff'),
    h(
      'div',
      {},
      h('strong', { text: `Couldn’t load the ${what}. ` }),
      B.loadErrorText(entry.error, what),
      ' ',
      entry.gone ? null : h('button', { type: 'button', class: 'link-btn', 'data-key': `${keyPrefix}retry-load`, onclick: onRetry, text: 'Try again' }),
      entry.gone && extra ? [' ', extra] : null,
    ),
  );
}

/** An Update / Refresh button: a clover that spins while an update asked
 *  for by hand runs (dom.js cloverBusy; polling never spins it). Drawn
 *  anew mid-update, it keeps spinning (cloverClass). `onRefresh` returns
 *  the fetch (a promise) to wait for. `run`: what it updates (a thread, a
 *  catalog), so the spin stays with that work: another tab or view of the
 *  pane draws its own button, with the same data-key, at rest.
 *  While it loads it is aria-disabled, not disabled, so it keeps the focus
 *  (a disabled button drops it to <body>); only a gone thread disables it. */
function cloverButton(key, run, label, onRefresh, { loading = false, gone = false } = {}) {
  const state = cloverClass(run);
  return h(
    'button',
    {
      type: 'button',
      class: `btn${state ? ` ${state}` : ''}`,
      'data-key': key,
      'data-clover': run,
      'aria-busy': state === 'clover-anim' ? 'true' : null,
      'aria-disabled': loading && !gone ? 'true' : null,
      title: B.refreshKeysLabel(),
      disabled: Boolean(gone),
      onclick: (e) => {
        if (isBusyRefresh(e.currentTarget)) return;
        cloverBusy(e.currentTarget, () => onRefresh(e));
      },
    },
    icon('clover'),
    label,
  );
}

/** Whether an Update / Refresh button is waiting for its fetch. */
export const isBusyRefresh = (btn) => Boolean(btn?.disabled) || btn?.getAttribute?.('aria-disabled') === 'true';

/** Marks an Update / Refresh button drawn earlier as loading or not (the
 *  shell's in-place patches), as cloverButton draws it. */
export function markRefresh(btn, { loading = false, gone = false } = {}) {
  if (!btn) return;
  btn.disabled = Boolean(gone);
  if (loading && !gone) btn.setAttribute('aria-disabled', 'true');
  else btn.removeAttribute('aria-disabled');
}

/** Right-click, the ContextMenu key or Shift+F10 on a Reply or New thread
 *  button: the pre-written posts (the shell's pastas popup) next to it. */
function pastaEvents(onPastas) {
  if (!onPastas) return {};
  return {
    'aria-description': 'Right-click or Shift+F10: pre-written posts',
    oncontextmenu: (e) => {
      e.preventDefault();
      onPastas(e.currentTarget);
    },
    onkeydown: (e) => {
      if (!K.isMenuKey(e)) return;
      e.preventDefault();
      onPastas(e.currentTarget);
    },
  };
}

/**
 * @param {object} o
 * @param {string} o.board
 * @param {object|undefined} o.entry   { status, threads, error, at, freshness }
 * @param {{query: string, sort: string}} o.view
 * @param {object} o.bridge
 * @param {string} [o.keyPrefix]       data-key prefix for the second pane
 * @param {boolean} [o.canSplit]       offer "open beside" on each card
 * @param {(no: number, where?: 'split' | 'tab' | 'tab-front') => void} o.onOpen  where: beside, a new background tab, a new tab in front
 * @param {() => void} o.onRefresh
 * @param {() => void} [o.onNewThread]
 * @param {(anchor: Element) => void} [o.onPastas]   right-click on New thread
 * @param {(patch: object) => void} o.onView
 * @param {Map<number, string>} [o.marks]  thread No. → 'hidden' | 'hide' | 'highlight' (filter-model.js)
 * @param {(no: number) => void} [o.onHide]  hides a thread by hand, or shows it again
 */
// Things appear with a little motion the first time a pane shows them: a
// catalog's or a thread's opening batch floats in one after another (the
// first 16), and what comes later (new threads, a thread's new posts) pops
// in; your own reply pops with the accent. Redraws of what is already shown
// stay still. No motion with reduced motion (app.css).
const shownIn = new Map(); // pane key prefix + kind → { key, seen }
function appearing(slot, key) {
  let s = shownIn.get(slot);
  const opening = !s || s.key !== key;
  if (opening) {
    s = { key, seen: new Set() };
    shownIn.set(slot, s);
  }
  let n = 0;
  // `quiet`: shown without motion (your reply, which already flew in grey)
  return (el, id, you = false, quiet = false) => {
    if (s.seen.has(id)) return;
    s.seen.add(id);
    if (quiet) return;
    if (opening) {
      if (n < 16) {
        el.classList.add('appear');
        el.style.setProperty('--appear-delay', `${n * 30}ms`);
      }
      n++;
    } else el.classList.add(you ? 'appear--you' : 'appear--new');
  };
}

/** On a thread (or post) a filter or a hide tag hid: deletes what hid it,
 *  after asking. `src`: { kind: 'filter' | 'tag', name } or null. */
function hiderButton(src, title, onRemove, key) {
  if (!src || !onRemove) {
    return h('button', { type: 'button', class: 'icon-btn icon-btn--sm catalog-card__hide', title: 'Hidden by a filter. Change it in Settings → Filters.', 'aria-label': `“${title}” is hidden by a filter`, 'data-key': key, disabled: true }, icon('eyeOff'));
  }
  const label = src.kind === 'tag' ? `Hidden by the tag “${src.name}”: delete the tag` : `Hidden by the filter “${src.name}”: delete the filter`;
  return h(
    'button',
    { type: 'button', class: 'icon-btn icon-btn--sm catalog-card__hide', title: label, 'aria-label': label, 'data-key': key, onclick: (e) => onRemove(src, e.currentTarget) },
    icon('trash'),
  );
}

export function catalogView({ board, entry, view, bridge, keyPrefix = '', canSplit = false, onOpen, onRefresh, onNewThread = null, onPastas = null, onView, marks = new Map(), onHide = null, display = null, tagBar = null, labels = new Map(), activeTag = '', hiderOf = null, onRemoveHider = null }) {
  const out = h('div', { class: 'browse' });
  const tools = h(
    'div',
    { class: 'browse__tools browse__tools--sticky browse__tools--catalog' },
    h('input', {
      type: 'search',
      class: 'input',
      placeholder: 'Search this catalog',
      'aria-label': 'Search this catalog',
      value: view.query,
      'data-key': `${keyPrefix}catalog-search`,
      // while an input method composes a word (Japanese, Chinese...), a
      // redraw would break it: the search follows once the word is done
      oninput: (e) => {
        if (e.isComposing) return;
        onView({ query: e.target.value });
      },
      oncompositionend: (e) => onView({ query: e.target.value }),
    }),
    h(
      'select',
      { class: 'input browse__sort', 'aria-label': 'Sort threads', 'data-key': `${keyPrefix}catalog-sort`, onchange: (e) => onView({ sort: e.target.value }) },
      B.CATALOG_SORTS.map((s) => h('option', { value: s.value, selected: s.value === view.sort, text: s.label })),
    ),
    cloverButton(`${keyPrefix}catalog-refresh`, `${keyPrefix}catalog-refresh|${board}`, 'Refresh', onRefresh, { loading: entry?.status === 'loading' }),
    onNewThread
      ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}new-thread`, title: 'New thread (R)', 'aria-keyshortcuts': 'R', onclick: onNewThread, ...pastaEvents(onPastas) }, icon('plus'), 'New thread')
      : null,
  );
  // the tags (tag-view.js tagChips) sit right after the search box, in the
  // same bar, always in sight
  if (tagBar) tools.firstElementChild.after(tagBar);
  out.append(tools);
  const status = statusLine(entry, 'catalog');
  if (status) out.append(status);
  if (entry?.status === 'error') out.append(errorBox(entry, 'catalog', onRefresh, keyPrefix));

  if (!entry?.threads) {
    if (entry?.status !== 'error') {
      out.append(
        h(
          'div',
          { class: 'catalog-skeleton', 'aria-hidden': 'true' },
          Array.from({ length: 12 }, () =>
            h('div', { class: 'card' }, h('div', { class: 'skeleton thumb' }), h('div', { class: 'skeleton line' }), h('div', { class: 'skeleton line line--short' })),
          ),
        ),
      );
    }
    return out;
  }

  // a tag pressed: only the threads it finds
  // discarded threads are gone: not shown, not even with "Show them"
  const arranged = B.arrangeCatalog(entry.threads, view).filter((t) => !isGoneMark(marks.get(t.no)) && (!activeTag || labels.get(t.no)?.some((g) => g.id === activeTag)));
  const hiddenCount = arranged.filter((t) => isHiddenMark(marks.get(t.no))).length;
  const list = view.showHidden ? arranged : arranged.filter((t) => !isHiddenMark(marks.get(t.no)));
  if (hiddenCount) {
    out.append(
      h(
        'p',
        { class: 'state-line browse__hidden' },
        icon('eyeOff'),
        h('span', { text: hiddenCount === 1 ? '1 thread hidden by filters or by you.' : `${hiddenCount} threads hidden by filters or by you.` }),
        h('button', {
          type: 'button',
          class: 'link-btn',
          'aria-pressed': String(Boolean(view.showHidden)),
          'data-key': `${keyPrefix}catalog-show-hidden`,
          onclick: () => onView({ showHidden: !view.showHidden }),
          text: view.showHidden ? 'Hide them' : 'Show them',
        }),
      ),
    );
  }
  if (!list.length) {
    out.append(h('p', { class: 'rail__empty', text: hiddenCount ? 'Every thread here is hidden.' : activeTag ? 'No thread here matches this tag.' : view.query ? 'No thread matches that search.' : 'This catalog is empty.' }));
    return out;
  }
  const appear = appearing(`${keyPrefix}catalog`, board);
  out.append(
    h(
      'ul',
      { class: 'catalog', 'aria-label': `/${board}/ catalog` },
      list.map((t) => {
        // work mode and spoilers (Settings → Posts): a placeholder, no preview
        const pic = catalogThumbView(t, display || undefined);
        const thumb = pic === 'thumb' ? bridge.thumbUrl(board, t) : null;
        const full = thumb ? bridge.mediaUrl(board, t) : null;
        const title = B.threadTitle(t);
        const mark = marks.get(t.no);
        return h(
          'li',
          { class: `catalog__item${isHiddenMark(mark) ? ' catalog__item--hidden' : mark === 'highlight' ? ' catalog__item--highlight' : ''}` },
          h(
            'button',
            {
              type: 'button',
              class: 'catalog-card',
              'data-key': `${keyPrefix}thread-${t.no}`,
              // Ctrl/⌘+click or a middle click: a new background tab of the
              // pane (with Shift, in front); "Open beside" makes a pane
              onclick: (e) => onOpen(t.no, canSplit && (e.ctrlKey || e.metaKey) ? (e.shiftKey ? 'tab-front' : 'tab') : undefined),
              onmousedown: (e) => {
                if (canSplit && e.button === 1) e.preventDefault(); // no autoscroll
              },
              onauxclick: (e) => {
                if (canSplit && e.button === 1) {
                  e.preventDefault();
                  onOpen(t.no, e.shiftKey ? 'tab-front' : 'tab');
                }
              },
            },
            h(
              'span',
              {
                class: 'catalog-card__thumb',
                'data-preview': full,
                'data-preview-w': t.w || null,
                'data-preview-h': t.h || null,
                'data-preview-video': full && VIDEO.test(t.ext || '') ? 'true' : null,
              },
              thumb
                ? h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async', width: t.tn_w || 150, height: t.tn_h || 150 })
                : pic === 'hidden'
                  ? h('span', { class: 'catalog-card__nofile catalog-card__nofile--hidden', text: 'File hidden' })
                  : pic === 'spoiler'
                    ? h('span', { class: 'catalog-card__nofile catalog-card__nofile--spoiler', text: 'Spoiler' })
                    : h('span', { class: 'catalog-card__nofile', text: 'No file' }),
            ),
            // spoiler text stays hidden as in the thread (app.css .seg-spoiler)
            h('span', { class: 'catalog-card__title', translate: 'no' }, runsEl(B.titleRuns(t))),
            t.sub ? h('span', { class: 'catalog-card__text', translate: 'no' }, runsEl(B.excerptRuns(t))) : null,
          ),
          h(
            'div',
            { class: 'catalog-card__foot' },
            h(
              'span',
              { class: 'catalog-card__counts' },
              t.sticky ? h('span', { class: 'pill', text: 'Sticky' }) : null,
              t.closed ? h('span', { class: 'pill', text: 'Closed' }) : null,
              h('span', { text: `R ${t.replies ?? 0}` }),
              h('span', { text: `I ${t.images ?? 0}` }),
            ),
            cardLabels(labels.get(t.no)),
            onHide && (mark === 'hide' || mark === 'discard')
              ? // Hidden by a filter or a hide tag: hiding it by hand would
                // change nothing; deleting what hid it shows it again.
                hiderButton(hiderOf?.(t.no), title, onRemoveHider, `${keyPrefix}hide-${t.no}`)
              : onHide
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'icon-btn icon-btn--sm catalog-card__hide',
                      title: mark === 'hidden' ? 'Unhide this thread' : 'Hide this thread',
                      'aria-label': mark === 'hidden' ? `Unhide “${title}”` : `Hide “${title}”`,
                      'data-key': `${keyPrefix}hide-${t.no}`,
                      onclick: () => onHide(t.no),
                    },
                    icon(mark === 'hidden' ? 'eye' : 'eyeOff'),
                  )
                : null,
            canSplit
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn icon-btn--sm catalog-card__beside',
                    title: 'Open beside',
                    'aria-label': `Open “${title}” beside this one`,
                    'data-key': `${keyPrefix}beside-${t.no}`,
                    onclick: () => onOpen(t.no, 'split'),
                  },
                  icon('splitOpen'),
                )
              : null,
          ),
        );
      }),
    ),
  );
  const items = out.querySelectorAll('.catalog > .catalog__item');
  list.forEach((t, i) => items[i] && appear(items[i], t.no));
  return out;
}

/** Replies, files, posters and the catalog page, in the thread's toolbar:
 *  only from the thread and the cached catalog (stats-model.js). */
export function statsLine(posts, catalog, keyPrefix) {
  const s = threadStats(posts, catalog?.threads || null);
  if (!s) return null;
  const at = catalog?.at ? new Date(catalog.at).toLocaleTimeString() : '';
  const warnings = [];
  if (s.lastPage) warnings.push('On the last page: the thread will soon fall off the board.');
  if (s.bumpLimit) warnings.push('Past the bump limit: new replies no longer bump the thread.');
  if (s.imageLimit) warnings.push('Image limit reached: no more files in this thread.');
  return h(
    'span',
    { class: 'thread-stats', 'data-key': `${keyPrefix}thread-stats` },
    h('span', { title: 'Replies', text: s.replies === 1 ? '1 reply' : `${s.replies} replies` }),
    h('span', { title: 'Files in the replies', text: s.files === 1 ? '1 file' : `${s.files} files` }),
    s.posters !== null ? h('span', { title: 'Different posters', text: s.posters === 1 ? '1 poster' : `${s.posters} posters` }) : null,
    s.page !== null
      ? h('span', {
          class: s.lastPage ? 'thread-stats__warn' : null,
          title: at ? `Its page in the catalog loaded at ${at}` : 'Its page in the catalog',
          text: `Page ${s.page} of ${s.pages}`,
        })
      : null,
    s.bumpLimit ? h('span', { class: 'thread-stats__warn', title: 'Past the bump limit: new replies no longer bump the thread.', text: 'Bump limit' }) : null,
    s.imageLimit ? h('span', { class: 'thread-stats__warn', title: 'Image limit reached: no more files in this thread.', text: 'Image limit' }) : null,
    // the warnings in words, for screen readers (titles are not read out everywhere)
    warnings.map((w) => h('span', { class: 'visually-hidden', text: w })),
  );
}

/** A file's reverse image search menu, or null when it has no file or no
 *  site is chosen. Each opens in the system browser. */
function sauceMenu(board, post, engines, bridge) {
  if (!engines?.length || !bridge.openExternal) return null;
  const links = sauceLinks(board, post, engines);
  if (!links.length) return null;
  return () => links.map((l) => ({ label: l.label, onSelect: () => bridge.openExternal(l.url) }));
}

/** The one-line stand-in for a hidden post: the line itself shows the post
 *  this time (click, Enter or Space); a post hidden by hand also gets Unhide. */
function stubText(no, why, by) {
  return why.reason === 'hidden'
    ? `Hidden post No. ${no} · hidden by you`
    : why.reason === 'reply'
      ? `Hidden post No. ${no} · reply to hidden No. ${why.via}`
      : by?.kind === 'tag'
        ? `Hidden post No. ${no} · hidden by the tag “${by.name}”`
        : by
          ? `Hidden post No. ${no} · filtered by “${by.name}”`
          : `Hidden post No. ${no} · filtered`;
}

/** A hidden post where a quote link would show it (a preview, an inline
 *  copy): the same line as in the thread, nothing of the post itself. */
function hiddenCopy(no, why, src) {
  const by = why.reason === 'filter' && src ? src : null;
  return h('div', { class: 'post-stub post-stub--copy', 'data-no': no }, h('span', { class: 'post-stub__show' }, icon('eyeOff'), h('span', { text: stubText(no, why, by) })));
}

function postStub(no, why, { keyPrefix, onReveal, onUnhide, src = null, onRemoveHider = null }) {
  // a filter or hide tag that hid it is named, and can be deleted from here
  const by = why.reason === 'filter' && src ? src : null;
  const text = stubText(no, why, by);
  return h(
    'div',
    { class: 'post-stub', 'data-no': no },
    h(
      'button',
      {
        type: 'button',
        class: 'post-stub__show',
        title: 'Show this post this time',
        'data-key': `${keyPrefix}reveal-${no}`,
        onclick: () => onReveal(no),
      },
      icon('eyeOff'),
      h('span', { text }),
    ),
    why.reason === 'hidden'
      ? h('button', {
          type: 'button',
          class: 'link-btn',
          title: 'Stop hiding this post',
          'data-key': `${keyPrefix}unhide-${no}`,
          onclick: () => onUnhide(no),
          text: 'Unhide',
        })
      : by && onRemoveHider
        ? h('button', {
            type: 'button',
            class: 'link-btn',
            title: 'Delete it: what it hid shows again',
            'data-key': `${keyPrefix}unfilter-${no}`,
            onclick: (e) => onRemoveHider(by, e.currentTarget),
            text: by.kind === 'tag' ? 'Delete tag' : 'Delete filter',
          })
        : null,
  );
}

/**
 * @param {object} o
 * @param {string} o.board
 * @param {number} o.no
 * @param {object|undefined} o.entry   { status, posts, error, at, freshness, gone, fresh: Set<no> }
 * @param {object} o.bridge
 * @param {string} [o.keyPrefix]
 * @param {boolean} [o.watched]
 * @param {number} o.intervalSec
 * @param {() => void} o.onRefresh
 * @param {() => void} [o.onWatch]
 * @param {(quote?: number, selection?: string) => void} [o.onReply]  selection: text picked in that post (quoted as greentext)
 * @param {(anchor: Element) => void} [o.onPastas]   right-click on Reply: the pre-written posts
 * @param {Map<number, string>} [o.marks]   post No. → 'hidden' | 'hide' | 'highlight' (filter-model.js)
 * @param {Set<number>} [o.youReplies]      posts that quote one of yours
 * @param {Map<number, {reason: string, via?: number}>} [o.hidden]  hidden posts and why (hide-model.js)
 * @param {Set<number>} [o.revealed]        hidden posts shown anyway this session
 * @param {(no: number) => void} [o.onReveal]  shows one hidden post, this time only
 * @param {(no: number) => void} [o.onUnhide]  shows a post hidden by hand again
 * @param {(post: object) => Array} [o.menuFor]  a post's "…" menu
 * @param {(post: object) => boolean} [o.inLibrary]  the post's file is in the library
 * @param {() => string} [o.quoteMode]    'inline' (default) or 'jump': what a quote link does (quote-model.js)
 * @param {((q: {board: string, thread: number, no: number}, e: Event) => void) | null} [o.onCrossQuote]
 *   jumping to another thread's post (a quote link to it, clicked to jump)
 * @param {((q: {board: string, search: string}, e: Event) => void) | null} [o.onBoardLink]
 *   a board link (>>>/g/, >>>/g/search/) clicked: that board's catalog, searched
 * @param {object|null} [o.cross]  other threads' posts for quote links, and archive links
 *   (quotes.js CrossThreads, without `render`: drawn here)
 * @param {{host: string, url: string}|null} [o.archive]  this thread on its board's archive
 *   (archive-model.js), offered once the thread is gone or archived
 * @param {{counts: Map<string, number>, colour: boolean, active: string|null, onClick: (id: string) => void}|null} [o.ids]
 *   poster IDs (ids-model.js): posts per ID, coloured or not, the one highlighted
 * @param {{line: number|null, count: number, onJump: () => void}|null} [o.unread]
 *   the "New posts" line (drawn above post No. `line`) and the unread count (unread-model.js)
 * @param {{threads: object[], at?: number}|null} [o.catalog]  the board's cached catalog, for
 *   the thread's page (stats-model.js); never fetched for this
 * @param {string[]} [o.sauce]  reverse image search sites for each file (sauce-model.js)
 * @param {object|null} [o.display]  Settings → Posts (display-model.js): times, spoilers, work mode, names
 */
/** A reply of yours going out (shell.js pendingEvent), drawn like a post:
 *  grey while it is sent, in colour once the site has posted it, marked
 *  when it did not go out. */
function pendingCard(p, { keyPrefix, isYou, onQuote, onBoardLink, links, display }) {
  const sent = p.state === 'sent';
  const card = renderPost(p.post, {
    isYou: (n) => (sent && n === p.no) || isYou(n),
    onQuote,
    onBoardLink,
    idPrefix: `${keyPrefix}pending-${p.id}-`,
    links,
    display,
  });
  card.removeAttribute('data-no'); // not a post of the thread (yet)
  card.dataset.pending = p.id;
  card.classList.add('post--pending');
  if (sent) card.classList.add('post--sent');
  if (p.state === 'failed') card.classList.add('post--failed');
  const no = card.querySelector('.post__no');
  if (no) no.textContent = sent ? `No. ${p.no}` : p.state === 'failed' ? 'Not posted' : 'Sending…';
  card.setAttribute('role', 'status');
  card.setAttribute('aria-label', sent ? `Your reply, posted as No. ${p.no}` : p.state === 'failed' ? 'Your reply was not posted' : 'Your reply, being sent');
  const main = card.querySelector('.post__main');
  if (p.file) main?.prepend(h('div', { class: 'post__pending-file' }, icon('folder'), h('span', { translate: 'no', text: p.file })));
  if (p.state === 'failed' && p.message) card.append(h('p', { class: 'post__pending-file', text: p.message }));
  return card;
}

const THREAD_DEFAULTS = {
  keyPrefix: '',
  watched: false,
  isYou: () => false,
  onWatch: null,
  onReply: null,
  onPastas: null,
  onGallery: null,
  marks: new Map(),
  hidden: new Map(),
  youReplies: new Set(),
  revealed: new Set(),
  onReveal: () => {},
  onUnhide: () => {},
  menuFor: null,
  inLibrary: null,
  hiderOf: null,
  onRemoveHider: null,
  quoteMode: () => 'inline',
  onCrossQuote: null,
  onBoardLink: null,
  cross: null,
  archive: null,
  ids: null,
  unread: null,
  catalog: null,
  sauce: [],
  links: null,
  display: null,
  offline: null,
  save: null,
  pending: [],
  landed: null,
  /** 'list' or 'columns' (columns-model.js layoutOf) */
  layout: 'list',
  /** switches the layout (the thread tools' toggle) */
  onLayout: null,
};

/** The options with their defaults (an option passed as null or undefined
 *  takes its default, as destructuring did). */
function threadOptions(raw) {
  const o = { ...raw };
  for (const [k, v] of Object.entries(THREAD_DEFAULTS)) if (o[k] === undefined || (o[k] === null && v !== null)) o[k] = v;
  return o;
}

/** A thread's control bar: Update, Watch, Reply, Gallery, Save, the unread
 *  jump, the highlighted ID, replies to you, the stats line. */
function threadTools(o, frozen) {
  const { entry, keyPrefix, offline, unread, ids, youReplies, watched } = o;
  return h(
    'div',
    { class: 'browse__tools browse__tools--thread', 'data-thread-tools': '' },
    offline
      ? // a saved copy, read from disk: no updates; the live thread is one click away
        h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-live`, title: 'Read the live thread in this pane', onclick: offline.onLive }, icon('refresh'), 'Open live thread')
      : cloverButton(`${keyPrefix}thread-refresh`, `${keyPrefix}thread-refresh|${o.board}/${o.no}`, 'Update', o.onRefresh, { loading: entry?.status === 'loading', gone: Boolean(entry?.gone) }),
    o.onWatch
      ? h(
          'button',
          { type: 'button', class: `btn${watched ? ' btn--on' : ''}`, 'aria-pressed': String(watched), 'data-key': `${keyPrefix}thread-watch`, onclick: o.onWatch },
          icon('bell'),
          watched ? 'Watching' : 'Watch',
        )
      : null,
    o.onReply && !frozen
      ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-reply`, title: 'Reply (R)', 'aria-keyshortcuts': 'R', onclick: () => o.onReply(), ...pastaEvents(o.onPastas) }, icon('reply'), 'Reply')
      : null,
    o.onGallery ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-gallery`, title: 'Gallery (G)', onclick: o.onGallery }, icon('grid'), 'Gallery') : null,
    o.onLayout ? layoutButton(o) : null,
    o.save ? saveControls({ ...o.save, keyPrefix }) : null,
    offline ? h('span', { class: 'pill pill--saved', text: offline.savedAt ? `Saved copy · ${savedDate(offline.savedAt)}` : 'Saved copy' }) : null,
    unread
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn',
            'data-key': `${keyPrefix}thread-unread`,
            'data-unread-jump': '',
            title: 'Jump to the first unread post (U)',
            disabled: !unread.count,
            onclick: unread.onJump,
          },
          icon('arrowDown'),
          'First unread',
          h('span', { class: 'badge thread-unread__count', 'data-unread-count': '', hidden: !unread.count, text: String(unread.count || 0) }),
        )
      : null,
    ids?.active
      ? h(
          'button',
          {
            type: 'button',
            class: 'pill pill--id-hl',
            'data-key': `${keyPrefix}thread-id-clear`,
            title: 'Stop highlighting this poster’s posts (Esc)',
            onclick: () => ids.onClick(ids.active),
          },
          h('span', { text: 'Highlighting ID' }),
          ' ',
          h('span', { translate: 'no', text: ids.active }),
          icon('x'),
        )
      : null,
    youReplies.size
      ? h('span', {
          class: 'pill pill--you',
          'data-key': `${keyPrefix}thread-you-count`,
          title: 'Posts in this thread that quote one of yours',
          text: `Replies to you: ${youReplies.size}`,
        })
      : null,
    statsLine(entry?.posts, o.catalog, keyPrefix),
    frozen || offline ? null : h('span', { class: 'field__hint', text: `Updates by itself every ${o.intervalSec} s while open.` }),
  );
}

const unreadLine = () => h('div', { class: 'unread-line', role: 'separator', 'aria-label': 'New posts', 'data-unread-line': '' }, h('span', { text: 'New posts' }));
const whyKey = (why) => (why ? JSON.stringify(why) : '');
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// a drawn thread view (its .browse node) → its update(next)
const updaters = new WeakMap();

/**
 * Brings a drawn thread view up to `next` (the same options threadView
 * takes) in place, when all that changed is new posts at the end: they are
 * added (popping in), the posts they quote get their new reply links, the
 * ID counts, the "new" marks and the "New posts" line move, the control
 * bar and the status line are drawn again. Everything else stays: the
 * scroll, open files, open quote copies. Returns false, having changed
 * nothing, on anything else (a post deleted or edited, other marks, other
 * settings, replies being sent): then the caller draws the view anew.
 */
export function updateThreadView(node, next) {
  const update = node && updaters.get(node);
  return update ? update(threadOptions(next)) : false;
}

export function threadView(raw) {
  let o = threadOptions(raw);
  const { board, no, entry, keyPrefix } = o;
  const columns = o.layout === 'columns';
  const out = h('div', { class: columns ? 'browse browse--columns' : 'browse' });
  const first = entry?.posts?.[0];
  const frozen = entry?.gone || first?.closed || first?.archived;
  out.append(threadTools(o, frozen));
  const status = statusLine(entry, 'thread');
  if (status) out.append(status);
  const openArchive = o.cross?.open || null;
  if (entry?.status === 'error') out.append(errorBox(entry, 'thread', o.onRefresh, keyPrefix, archiveLine(o.archive, openArchive, keyPrefix)));
  if (!entry?.posts) {
    if (entry?.status !== 'error') for (let i = 0; i < 4; i++) out.append(h('div', { class: 'skeleton', style: { height: '96px' } }));
    return out;
  }
  // what quote links can reach: never a discarded post; a hidden one shows
  // as its stub line (draw). (A copy of the Map: an update adds to it.)
  const shown = B.shownPosts(entry.posts, o.hidden, o.revealed);
  let refs = shown.refs;
  const reachable = new Map(shown.posts);
  // In columns the list itself scrolls (sideways), and takes the focus for
  // its keys (columns.js attachColumns).
  // (a region in columns: a keyboard stop of its own, which says what it is)
  const list = h('div', { class: columns ? `thread ${COLUMNS_CLASS}` : 'thread', role: columns ? 'region' : null, 'aria-label': `Thread ${no}`, tabindex: columns ? '0' : null });
  if (columns) attachColumns(list);
  const jump = (target) => {
    const el = list.querySelector(`[data-no="${target}"]`);
    if (!el) return;
    revealPost(el, { align: 'center', smooth: true });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
  };
  const draw = (p, idPrefix) => {
    const why = o.hidden.get(p.no);
    if (why && !o.revealed.has(p.no)) return hiddenCopy(p.no, why, why.reason === 'filter' ? o.hiderOf?.(p.no) : null);
    return markKept(p, drawPost(p, idPrefix));
  };
  // a file already in the library says so on its line
  const markKept = (p, el) => {
    if (o.inLibrary && p.tim && o.inLibrary(p)) {
      const at = el.querySelector?.('.post__file');
      at?.append(h('span', { class: 'post__kept', title: 'This file is in your library' }, icon('images'), h('span', { text: 'In library' })));
    }
    return el;
  };
  const drawPost = (p, idPrefix) => {
    const { bridge, ids, onReply, menuFor } = o;
    return renderPost(p, {
      backrefs: refs.get(p.no) || [],
      onQuote: quotes.onQuote,
      onBoardLink: o.onBoardLink,
      isYou: o.isYou,
      onReply: onReply && !frozen ? (e) => onReply(p.no, postSelection(e?.currentTarget?.closest?.('.post'))) : null,
      thumb: bridge.thumbUrl(board, p),
      flag: bridge.flag ? bridge.flag(board, p) : null,
      full: bridge.mediaUrl(board, p),
      idPrefix,
      menu: menuFor ? () => menuFor(p) : null,
      sauce: sauceMenu(board, p, o.sauce, bridge),
      links: o.links,
      display: o.display,
      posterId: ids && p.id
        ? { count: ids.counts.get(p.id) || 0, colour: ids.colour ? idColour(p.id) : null, active: ids.active === p.id, onClick: ids.onClick }
        : null,
    });
  };
  const quotes = quoteLinks({
    key: `${keyPrefix}${board}/${no}`,
    board,
    thread: no,
    posts: reachable,
    render: draw,
    jump,
    mode: o.quoteMode,
    keyPrefix,
    onCross: o.onCrossQuote,
    cross: o.cross
      ? {
          ...o.cross,
          // another board's post: its files, flag and search menu from that board
          render: (p, xb, _xt, idPrefix) =>
            renderPost(p, {
              onQuote: quotes.onQuote,
              onBoardLink: o.onBoardLink,
              thumb: o.bridge.thumbUrl(xb, p),
              flag: o.bridge.flag ? o.bridge.flag(xb, p) : null,
              full: o.bridge.mediaUrl(xb, p),
              idPrefix,
              sauce: sauceMenu(xb, p, o.sauce, o.bridge),
              links: o.links,
              display: o.display,
            }),
        }
      : null,
  });
  /** One post of the thread as the list shows it: its card, its stub line,
   *  or nothing (discarded). */
  const item = (p, appear) => {
    const mark = o.marks.get(p.no);
    const why = o.hidden.get(p.no);
    // discarded: nothing at all, not even the line
    if (why?.reason === 'discard') return null;
    if (why && !o.revealed.has(p.no)) {
      return postStub(p.no, why, { keyPrefix, onReveal: o.onReveal, onUnhide: o.onUnhide, src: why.reason === 'filter' ? o.hiderOf?.(p.no) : null, onRemoveHider: o.onRemoveHider });
    }
    const card = draw(p, `${keyPrefix}p`);
    appear(card, p.no, o.isYou(p.no), Boolean(o.landed?.has(`${board}/${p.no}`)));
    if (o.entry.fresh?.has(p.no)) card.classList.add('post--new');
    if (mark === 'highlight') card.classList.add('post--highlight');
    if (why) card.classList.add('post--revealed');
    if (o.youReplies.has(p.no)) card.classList.add('post--reply-you');
    if (o.ids?.active && p.id === o.ids.active) card.classList.add('post--id-hl');
    return card;
  };
  const appear = appearing(`${keyPrefix}thread`, `${board}/${no}`);
  for (const p of entry.posts) {
    if (o.unread?.line && p.no === o.unread.line) list.append(unreadLine());
    const el = item(p, appear);
    if (el) list.append(el);
  }
  for (const p of o.pending) list.append(pendingCard(p, { keyPrefix, isYou: o.isYou, onQuote: quotes.onQuote, onBoardLink: o.onBoardLink, links: o.links, display: o.display }));
  quotes.attach(list);
  out.append(list);
  if (first?.closed || first?.archived) {
    out.append(
      h(
        'p',
        { class: 'state-line' },
        h('span', { text: first.archived ? 'This thread is archived: no new replies.' : 'This thread is closed: no new replies.' }),
        first.archived ? archiveLine(o.archive, openArchive, keyPrefix) : null,
      ),
    );
  }

  // What the old posts were drawn with, for update() to tell whether they
  // would be drawn the same now.
  const drawnFor = (opts, posts) => ({
    you: new Set(posts.filter((p) => opts.isYou(p.no)).map((p) => p.no)),
    kept: opts.inLibrary ? new Set(posts.filter((p) => p.tim && opts.inLibrary(p)).map((p) => p.no)) : null,
  });
  let drawn = drawnFor(o, entry.posts);

  /** Whether the posts already drawn would be drawn the same with `n`. */
  const sameOld = (n) => {
    if (n.board !== o.board || n.no !== o.no || n.keyPrefix !== o.keyPrefix || n.bridge !== o.bridge || n.layout !== o.layout) return false;
    if (n.offline || o.offline || o.pending.length || n.pending.length) return false;
    if (JSON.stringify(n.display) !== JSON.stringify(o.display) || JSON.stringify(n.sauce) !== JSON.stringify(o.sauce)) return false;
    if (Boolean(n.links) !== Boolean(o.links) || n.links?.embeds !== o.links?.embeds) return false;
    if (Boolean(n.onReply) !== Boolean(o.onReply) || Boolean(n.menuFor) !== Boolean(o.menuFor) || Boolean(n.inLibrary) !== Boolean(o.inLibrary)) return false;
    if (Boolean(n.ids) !== Boolean(o.ids) || n.ids?.active !== o.ids?.active || n.ids?.colour !== o.ids?.colour) return false;
    if (Boolean(n.cross) !== Boolean(o.cross) || n.quoteMode() !== o.quoteMode()) return false;
    if (Boolean(n.onBoardLink) !== Boolean(o.onBoardLink)) return false;
    if (!sameSet(n.revealed, o.revealed)) return false;
    const now = drawnFor(n, o.entry.posts);
    if (!sameSet(now.you, drawn.you) || (now.kept && !sameSet(now.kept, drawn.kept))) return false;
    for (const p of o.entry.posts) {
      if (n.marks.get(p.no) !== o.marks.get(p.no) || whyKey(n.hidden.get(p.no)) !== whyKey(o.hidden.get(p.no))) return false;
      if (n.youReplies.has(p.no) !== o.youReplies.has(p.no)) return false;
    }
    return true;
  };

  const update = (n) => {
    if (!list.isConnected || !n.entry?.posts || n.entry.status !== 'ok' || n.entry.gone || o.entry.status === 'error') return false;
    const d = threadDelta(o.entry.posts, n.entry.posts);
    if (d.kind !== 'appended' || !sameOld(n)) return false;
    // a reply link or a control in a quote copy that had the focus gets it back
    const listKey = list.contains(document.activeElement) ? document.activeElement.dataset.key || null : null;
    const top = new Map();
    for (const el of list.children) if (el.dataset.no) top.set(Number(el.dataset.no), el);
    // Open quote copies stay as they are (a video in one keeps playing):
    // only the cards drawn or changed here go through quotes.add().
    const prev = o;
    o = n;
    const next = B.shownPosts(n.entry.posts, n.hidden, n.revealed);
    // the posts the new ones quote: their reply links (renderPost's row)
    const changed = prev.entry.posts.filter((p) => (refs.get(p.no) || []).join(',') !== (next.refs.get(p.no) || []).join(',')).map((p) => p.no);
    // what copies drawn from here on show (quotes.add() opens some again)
    refs = next.refs;
    for (const p of d.added) if (next.posts.has(p.no)) reachable.set(p.no, p);
    const roots = new Set(); // cards whose open copies are drawn again
    for (const no of changed) {
      const card = top.get(no);
      if (card?.classList.contains('post')) {
        const row = backlinksRow(refs.get(no) || [], (t, e) => quotes.onQuote(t, e));
        const old = card.querySelector(':scope > .post__backlinks');
        if (old && row) old.replaceWith(row);
        else if (old) old.remove();
        else if (row) card.querySelector(':scope > .post__main')?.after(row);
        roots.add(card);
      }
      // an open copy of that post: its box goes, and quotes.add() opens it
      // again from the card it hangs on, with the new reply links
      for (const copy of list.querySelectorAll(`.post--copy[data-inline-no="${no}"]`)) {
        const box = copy.closest('.quote-inline');
        const root = box?.closest('.post:not(.post--copy)');
        if (!box || !root || root.parentElement !== list) continue; // gone with an outer box
        box.remove();
        roots.add(root);
      }
    }
    for (const card of roots) quotes.add(card);
    // the counts after each poster ID that posted again (in open copies too)
    if (n.ids) {
      for (const id of new Set(d.added.map((p) => p.id).filter(Boolean))) {
        const count = n.ids.counts.get(id) || 0;
        if (count === (prev.ids.counts.get(id) || 0)) continue;
        for (const el of list.querySelectorAll(`.post__meta [data-id="${CSS.escape(id)}"] .post__id-count`)) el.textContent = ` (${count})`;
      }
    }
    // only the latest posts are "new"
    for (const el of list.querySelectorAll(':scope > .post--new')) if (!n.entry.fresh?.has(Number(el.dataset.no))) el.classList.remove('post--new');
    const pop = appearing(`${keyPrefix}thread`, `${board}/${no}`);
    for (const p of d.added) {
      const el = item(p, pop);
      if (!el) continue;
      list.append(el);
      quotes.add(el);
    }
    // the "New posts" line, before the first post at or after it
    if ((prev.unread?.line || 0) !== (n.unread?.line || 0)) {
      list.querySelector(':scope > [data-unread-line]')?.remove();
      if (n.unread?.line) {
        const at = [...list.children].find((el) => el.dataset.no && Number(el.dataset.no) >= n.unread.line);
        if (at) at.before(unreadLine());
        else list.append(unreadLine());
      }
    }
    if (listKey && !list.contains(document.activeElement)) list.querySelector(`[data-key="${CSS.escape(listKey)}"]`)?.focus({ preventScroll: true });
    drawn = drawnFor(n, n.entry.posts);
    // the control bar keeps its element (it is watched for tucking away)
    const bar = out.querySelector(':scope > [data-thread-tools]');
    const focusKey = bar?.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    bar?.replaceChildren(...threadTools(n, frozen).childNodes);
    if (focusKey) bar.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    const oldStatus = out.querySelector(':scope > [data-status]');
    const nextStatus = statusLine(n.entry, 'thread');
    if (oldStatus && nextStatus) oldStatus.replaceWith(nextStatus);
    else if (oldStatus) oldStatus.remove();
    else if (nextStatus) bar?.after(nextStatus);
    return true;
  };
  updaters.set(out, update);
  return out;
}
