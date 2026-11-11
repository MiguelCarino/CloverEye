// The embed player: one video or track at a time, in a frame docked in the
// window's lower-left corner. A frame that leaves the page is torn down, and
// the panes are redrawn on every thread update, so the player lives outside
// them: a playing video keeps playing while the thread updates, scrolls or
// changes. Nothing loads from the embed site before the person clicks Embed
// (link-model.js builds the frame address; the CSP allows only those hosts).

import { h, icon } from './dom.js';
import { tr } from './i18n.js';

/** The Embed button's tooltip. The button sits inside a post, which the
 *  page translator skips, so it is translated here. */
export const embedTitle = (playing, label) => (playing ? tr('Close the player') : tr(`Play it here. Nothing loads from ${label} until you click.`));

/**
 * @param {object} o
 * @param {(href: string) => void} o.openLink   opens the page in the system browser
 * @param {HTMLElement} [o.host]                where the player goes (document.body)
 */
export function createEmbedPlayer({ openLink, host = document.body }) {
  let cur = null; // { emb, href, el }

  /** Every Embed button on the page shows whether its embed is playing. */
  function sync() {
    for (const b of document.querySelectorAll('button[data-embed-src]')) {
      const on = cur?.emb.src === b.dataset.embedSrc;
      b.setAttribute('aria-pressed', String(on));
      b.title = embedTitle(on, b.dataset.embedLabel || '');
    }
  }

  function close() {
    if (!cur) return;
    const { el, emb } = cur;
    const hadFocus = el.contains(document.activeElement);
    cur = null;
    el.remove();
    sync();
    if (hadFocus) document.querySelector(`button[data-embed-src="${CSS.escape(emb.src)}"]`)?.focus();
  }

  /** Plays an embed; the one already playing closes instead (a toggle). */
  function open(emb, href) {
    if (cur?.emb.src === emb.src) return close();
    if (cur) {
      cur.el.remove();
      cur = null;
    }
    const frame = h('iframe', {
      class: 'embed-player__frame',
      src: emb.src,
      title: `Embedded player from ${emb.label}`,
      allow: ['autoplay', 'encrypted-media', 'fullscreen', 'picture-in-picture'].join('; '),
      allowfullscreen: true,
      referrerpolicy: 'strict-origin-when-cross-origin',
      // no popups, no navigating the app window
      sandbox: 'allow-scripts allow-same-origin allow-presentation',
      style: emb.height ? { height: `${emb.height}px` } : { 'aspect-ratio': emb.ratio || '16 / 9' },
    });
    const el = h(
      'section',
      {
        class: `embed-player${emb.ratio === '9 / 16' ? ' embed-player--tall' : ''}${emb.height ? ' embed-player--audio' : ''}`,
        'aria-label': 'Embedded player',
        onkeydown: (e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        },
      },
      h(
        'div',
        { class: 'embed-player__bar' },
        icon('play'),
        h('span', { class: 'embed-player__label', translate: 'no', text: emb.label }),
        h('span', { class: 'embed-player__url', translate: 'no', title: href, text: href }),
        h(
          'button',
          { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Open in browser', title: 'Open in browser', 'data-key': 'embed-open', onclick: () => openLink(href) },
          icon('external'),
        ),
        h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close the player', title: 'Close the player (Esc)', 'data-key': 'embed-close', onclick: close }, icon('x')),
      ),
      frame,
    );
    host.append(el);
    cur = { emb, href, el };
    sync();
  }

  return {
    open,
    close,
    sync,
    isPlaying: (src) => Boolean(cur) && cur.emb.src === src,
    isOpen: () => Boolean(cur),
  };
}
