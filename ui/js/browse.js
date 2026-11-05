// The catalog grid and the thread view. The shell owns the state and the
// loading; these only draw it. Text only through textContent.

import * as B from './browse-model.js';
import { h, icon } from './dom.js';
import { renderPost } from './setup.js';
import { backlinks } from './render.js';

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

function errorBox(entry, what, onRetry, keyPrefix) {
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
 */
export function catalogView({ board, entry, view, bridge, keyPrefix = '', canSplit = false, onOpen, onRefresh, onNewThread = null, onView }) {
  const out = h('div', { class: 'browse' });
  const tools = h(
    'div',
    { class: 'browse__tools' },
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
    h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}catalog-refresh`, onclick: onRefresh, disabled: entry?.status === 'loading' }, icon('refresh'), 'Refresh'),
    onNewThread ? h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}new-thread`, onclick: onNewThread }, icon('plus'), 'New thread') : null,
  );
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

  const list = B.arrangeCatalog(entry.threads, view);
  if (!list.length) {
    out.append(h('p', { class: 'rail__empty', text: view.query ? 'No thread matches that search.' : 'This catalog is empty.' }));
    return out;
  }
  out.append(
    h(
      'ul',
      { class: 'catalog', 'aria-label': `/${board}/ catalog` },
      list.map((t) => {
        const thumb = t.filedeleted ? null : bridge.thumbUrl(board, t);
        const full = thumb ? bridge.mediaUrl(board, t) : null;
        const title = B.threadTitle(t);
        return h(
          'li',
          { class: 'catalog__item' },
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
              thumb ? h('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async', width: t.tn_w || 150, height: t.tn_h || 150 }) : h('span', { class: 'catalog-card__nofile', text: 'No file' }),
            ),
            h('span', { class: 'catalog-card__title', text: title }),
            t.sub ? h('span', { class: 'catalog-card__text', text: B.excerpt(t) }) : null,
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
  return out;
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
 * @param {(quote?: number) => void} [o.onReply]
 */
export function threadView({ board, no, entry, bridge, keyPrefix = '', watched = false, intervalSec, isYou = () => false, onRefresh, onWatch = null, onReply = null, onGallery = null }) {
  const out = h('div', { class: 'browse' });
  const first = entry?.posts?.[0];
  const frozen = entry?.gone || first?.closed || first?.archived;
  out.append(
    h(
      'div',
      { class: 'browse__tools browse__tools--thread', 'data-thread-tools': '' },
      h('button', { type: 'button', class: 'btn', 'data-key': `${keyPrefix}thread-refresh`, onclick: onRefresh, disabled: entry?.status === 'loading' || entry?.gone }, icon('refresh'), 'Update'),
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
      frozen ? null : h('span', { class: 'field__hint', text: `Updates by itself every ${intervalSec} s while open.` }),
    ),
  );
  const status = statusLine(entry, 'thread');
  if (status) out.append(status);
  if (entry?.status === 'error') out.append(errorBox(entry, 'thread', onRefresh, keyPrefix));
  if (!entry?.posts) {
    if (entry?.status !== 'error') for (let i = 0; i < 4; i++) out.append(h('div', { class: 'skeleton', style: { height: '96px' } }));
    return out;
  }
  const refs = backlinks(entry.posts);
  const list = h('div', { class: 'thread', 'aria-label': `Thread ${no}` });
  const jump = (target) => {
    const el = list.querySelector(`[data-no="${target}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
  };
  for (const p of entry.posts) {
    const card = renderPost(p, {
      backrefs: refs.get(p.no) || [],
      onQuote: jump,
      isYou,
      onReply: onReply && !frozen ? () => onReply(p.no) : null,
      thumb: bridge.thumbUrl(board, p),
      flag: bridge.flag ? bridge.flag(board, p) : null,
      full: bridge.mediaUrl(board, p),
      idPrefix: `${keyPrefix}p`,
    });
    if (entry.fresh?.has(p.no)) card.classList.add('post--new');
    list.append(card);
  }
  out.append(list);
  if (first?.closed || first?.archived) {
    out.append(h('p', { class: 'state-line', text: first.archived ? 'This thread is archived: no new replies.' : 'This thread is closed: no new replies.' }));
  }
  return out;
}
