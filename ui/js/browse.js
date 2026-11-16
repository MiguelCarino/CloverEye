// The catalog grid and the thread view. The shell owns the state and the
// loading; these only draw it. Text only through textContent.

import * as B from './browse-model.js';
import { isHiddenMark, isGoneMark } from './filter-model.js';
import { h, icon } from './dom.js';
import { renderPost } from './setup.js';
import { backlinks } from './render.js';
import { quoteLinks } from './quotes.js';
import { postSelection } from './compose.js';
import { idColour } from './ids-model.js';
import { threadStats } from './stats-model.js';
import { sauceLinks } from './sauce-model.js';
import { catalogThumbView } from './display-model.js';
import { saveControls, savedDate } from './offline.js';
import { cardLabels } from './tag-view.js';

const VIDEO = /^\.(webm|mp4)$/i;

function statusLine(entry, what) {
  if (!entry || entry.status === 'loading') {
    return h('p', { class: 'state-line', role: 'status' }, icon('refresh'), `Loading the ${what}…`);
  }
  if (entry.status === 'error') return null;
  const parts = [];
  if (entry.at) parts.push(`Updated ${new Date(entry.at).toLocaleTimeString()}`);
  if (entry.freshness === 'not-modified') parts.push('no changes');
  if (entry.freshness === 'throttled') parts.push('too soon to ask again, showing the last copy');
  if (entry.fresh?.size) parts.push(`${entry.fresh.size} new`);
  return parts.length ? h('p', { class: 'state-line browse__status', role: 'status', text: parts.join(' · ') }) : null;
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

/**
 * @param {object} o
 * @param {string} o.board
 * @param {object|undefined} o.entry   { status, threads, error, at, freshness }
 * @param {{query: string, sort: string}} o.view
 * @param {object} o.bridge
 * @param {string} [o.keyPrefix]       data-key prefix for the second pane
 * @param {boolean} [o.canSplit]       offer "open beside" on each card
 * @param {(no: number, pane?: string) => void} o.onOpen
 * @param {() => void} o.onRefresh
 * @param {() => void} [o.onNewThread]
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

export function catalogView({ board, entry, view, bridge, keyPrefix = '', canSplit = false, onOpen, onRefresh, onNewThread = null, onView, marks = new Map(), onHide = null, display = null, tagBar = null, labels = new Map(), activeTag = '', hiderOf = null, onRemoveHider = null }) {
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
      oninput: (e) => onView({ query: e.target.value }),
    }),
    h(
      'select',
      { class: 'input browse__sort', 'aria-label': 'Sort threads', 'data-key': `${keyPrefix}catalog-sort`, onchange: (e) => onView({ sort: e.target.value }) },
      B.CATALOG_SORTS.map((s) => h('option', { value: s.value, selected: s.value === view.sort, text: s.label })),
    ),
    h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}catalog-refresh`, onclick: onRefresh, title: B.refreshKeysLabel(), disabled: entry?.status === 'loading' }, icon('refresh'), 'Refresh'),
    onNewThread ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}new-thread`, onclick: onNewThread }, icon('plus'), 'New thread') : null,
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
              onclick: (e) => onOpen(t.no, canSplit && (e.ctrlKey || e.metaKey) ? 'split' : undefined),
              onauxclick: (e) => {
                if (canSplit && e.button === 1) {
                  e.preventDefault();
                  onOpen(t.no, 'split');
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
            h('span', { class: 'catalog-card__title', translate: 'no', text: title }),
            t.sub ? h('span', { class: 'catalog-card__text', translate: 'no', text: B.excerpt(t) }) : null,
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
function statsLine(posts, catalog, keyPrefix) {
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
function postStub(no, why, { keyPrefix, onReveal, onUnhide, src = null, onRemoveHider = null }) {
  // a filter or hide tag that hid it is named, and can be deleted from here
  const by = why.reason === 'filter' && src ? src : null;
  const text =
    why.reason === 'hidden'
      ? `Hidden post No. ${no} · hidden by you`
      : why.reason === 'reply'
        ? `Hidden post No. ${no} · reply to hidden No. ${why.via}`
        : by?.kind === 'tag'
          ? `Hidden post No. ${no} · hidden by the tag “${by.name}”`
          : by
            ? `Hidden post No. ${no} · filtered by “${by.name}”`
            : `Hidden post No. ${no} · filtered`;
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
function pendingCard(p, { keyPrefix, isYou, onQuote, links, display }) {
  const sent = p.state === 'sent';
  const card = renderPost(p.post, {
    isYou: (n) => (sent && n === p.no) || isYou(n),
    onQuote,
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

export function threadView({
  board,
  no,
  entry,
  bridge,
  keyPrefix = '',
  watched = false,
  intervalSec,
  isYou = () => false,
  onRefresh,
  onWatch = null,
  onReply = null,
  onGallery = null,
  marks = new Map(),
  hidden = new Map(),
  youReplies = new Set(),
  revealed = new Set(),
  onReveal = () => {},
  onUnhide = () => {},
  menuFor = null,
  inLibrary = null,
  hiderOf = null,
  onRemoveHider = null,
  quoteMode = () => 'inline',
  onCrossQuote = null,
  cross = null,
  archive = null,
  ids = null,
  unread = null,
  catalog = null,
  sauce = [],
  links = null,
  display = null,
  offline = null,
  save = null,
  pending = [],
  landed = null,
}) {
  const out = h('div', { class: 'browse' });
  const first = entry?.posts?.[0];
  const frozen = entry?.gone || first?.closed || first?.archived;
  out.append(
    h(
      'div',
      { class: 'browse__tools browse__tools--thread', 'data-thread-tools': '' },
      offline
        ? // a saved copy, read from disk: no updates; the live thread is one click away
          h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-live`, title: 'Read the live thread in this pane', onclick: offline.onLive }, icon('refresh'), 'Open live thread')
        : h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-refresh`, onclick: onRefresh, title: B.refreshKeysLabel(), disabled: entry?.status === 'loading' || entry?.gone }, icon('refresh'), 'Update'),
      onWatch
        ? h(
            'button',
            { type: 'button', class: `btn${watched ? ' btn--on' : ''}`, 'aria-pressed': String(watched), 'data-key': `${keyPrefix}thread-watch`, onclick: onWatch },
            icon('bell'),
            watched ? 'Watching' : 'Watch',
          )
        : null,
      onReply && !frozen ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-reply`, onclick: () => onReply() }, icon('reply'), 'Reply') : null,
      onGallery ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-gallery`, title: 'Gallery (G)', onclick: onGallery }, icon('grid'), 'Gallery') : null,
      save ? saveControls({ ...save, keyPrefix }) : null,
      offline
        ? h('span', { class: 'pill pill--saved', text: offline.savedAt ? `Saved copy · ${savedDate(offline.savedAt)}` : 'Saved copy' })
        : null,
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
      statsLine(entry?.posts, catalog, keyPrefix),
      frozen || offline ? null : h('span', { class: 'field__hint', text: `Updates by itself every ${intervalSec} s while open.` }),
    ),
  );
  const status = statusLine(entry, 'thread');
  if (status) out.append(status);
  const openArchive = cross?.open || null;
  if (entry?.status === 'error') out.append(errorBox(entry, 'thread', onRefresh, keyPrefix, archiveLine(archive, openArchive, keyPrefix)));
  if (!entry?.posts) {
    if (entry?.status !== 'error') for (let i = 0; i < 4; i++) out.append(h('div', { class: 'skeleton', style: { height: '96px' } }));
    return out;
  }
  const refs = backlinks(entry.posts);
  const appear = appearing(`${keyPrefix}thread`, `${board}/${no}`);
  const list = h('div', { class: 'thread', 'aria-label': `Thread ${no}` });
  const jump = (target) => {
    const el = list.querySelector(`[data-no="${target}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
  };
  const draw = (p, idPrefix) => markKept(p, drawPost(p, idPrefix));
  // a file already in the library says so on its line
  const markKept = (p, el) => {
    if (inLibrary && p.tim && inLibrary(p)) {
      const at = el.querySelector?.('.post__file');
      at?.append(h('span', { class: 'post__kept', title: 'This file is in your library' }, icon('images'), h('span', { text: 'In library' })));
    }
    return el;
  };
  const drawPost = (p, idPrefix) =>
    renderPost(p, {
      backrefs: refs.get(p.no) || [],
      onQuote: quotes.onQuote,
      isYou,
      onReply: onReply && !frozen ? (e) => onReply(p.no, postSelection(e?.currentTarget?.closest?.('.post'))) : null,
      thumb: bridge.thumbUrl(board, p),
      flag: bridge.flag ? bridge.flag(board, p) : null,
      full: bridge.mediaUrl(board, p),
      idPrefix,
      menu: menuFor ? () => menuFor(p) : null,
      sauce: sauceMenu(board, p, sauce, bridge),
      links,
      display,
      posterId: ids && p.id
        ? { count: ids.counts.get(p.id) || 0, colour: ids.colour ? idColour(p.id) : null, active: ids.active === p.id, onClick: ids.onClick }
        : null,
    });
  const quotes = quoteLinks({
    key: `${keyPrefix}${board}/${no}`,
    board,
    thread: no,
    posts: new Map(entry.posts.map((p) => [p.no, p])),
    render: draw,
    jump,
    mode: quoteMode,
    keyPrefix,
    onCross: onCrossQuote,
    cross: cross
      ? {
          ...cross,
          // another board's post: its files, flag and search menu from that board
          render: (p, xb, _xt, idPrefix) =>
            renderPost(p, {
              onQuote: quotes.onQuote,
              thumb: bridge.thumbUrl(xb, p),
              flag: bridge.flag ? bridge.flag(xb, p) : null,
              full: bridge.mediaUrl(xb, p),
              idPrefix,
              sauce: sauceMenu(xb, p, sauce, bridge),
              links,
              display,
            }),
        }
      : null,
  });
  for (const p of entry.posts) {
    const mark = marks.get(p.no);
    const why = hidden.get(p.no);
    if (unread?.line && p.no === unread.line) {
      list.append(h('div', { class: 'unread-line', role: 'separator', 'aria-label': 'New posts', 'data-unread-line': '' }, h('span', { text: 'New posts' })));
    }
    // discarded: nothing at all, not even the line
    if (why?.reason === 'discard') continue;
    if (why && !revealed.has(p.no)) {
      list.append(postStub(p.no, why, { keyPrefix, onReveal, onUnhide, src: why.reason === 'filter' ? hiderOf?.(p.no) : null, onRemoveHider }));
      continue;
    }
    const card = draw(p, `${keyPrefix}p`);
    appear(card, p.no, isYou(p.no), Boolean(landed?.has(`${board}/${p.no}`)));
    if (entry.fresh?.has(p.no)) card.classList.add('post--new');
    if (mark === 'highlight') card.classList.add('post--highlight');
    if (why) card.classList.add('post--revealed');
    if (youReplies.has(p.no)) card.classList.add('post--reply-you');
    if (ids?.active && p.id === ids.active) card.classList.add('post--id-hl');
    list.append(card);
  }
  for (const p of pending) list.append(pendingCard(p, { keyPrefix, isYou, onQuote: quotes.onQuote, links, display }));
  quotes.attach(list);
  out.append(list);
  if (first?.closed || first?.archived) {
    out.append(
      h(
        'p',
        { class: 'state-line' },
        h('span', { text: first.archived ? 'This thread is archived: no new replies.' : 'This thread is closed: no new replies.' }),
        first.archived ? archiveLine(archive, openArchive, keyPrefix) : null,
      ),
    );
  }
  return out;
}
