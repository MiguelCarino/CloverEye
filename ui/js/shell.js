// Minimal three-pane shell (SCOPE §3.1a) so setup can hand off. The catalog,
// thread and panels arrive in C1; nothing here makes a request.

import * as M from './setup-model.js';
import { h, clear, icon } from './dom.js';
import { renderSettings } from './settings-view.js';

export function openShell({ settings: initial, boards = null, onRunSetup, onSave = () => {}, setTitle = () => {} }) {
  let settings = initial;
  const root = document.getElementById('shell');
  const titleOf = (code) => boards?.find((b) => b.board === code)?.title || '';
  const st = { view: M.firstDestination(settings, boards), panel: false, rail: false };
  const ac = new AbortController();

  function tag(code) {
    return h('span', { class: 'board-tag', style: { '--hue': M.boardHue(code) }, text: `/${code}/` });
  }

  function railItem(content, { current = false, onclick, key }) {
    return h(
      'li',
      {},
      h('button', { type: 'button', class: 'rail__item', 'aria-current': current ? 'page' : null, 'data-key': key, onclick }, content),
    );
  }

  function goto(view) {
    st.view = view;
    st.rail = false;
    render();
  }

  function render() {
    const focusKey = document.activeElement?.dataset?.key;
    clear(root);
    const v = st.view;
    const favs = M.visibleFavourites(settings, boards);

    const rail = h(
      'nav',
      { class: 'rail', 'aria-label': 'Boards and watcher' },
      h(
        'div',
        { class: 'rail__scroll' },
        h(
          'section',
          {},
          h('h2', { class: 'rail__heading', text: 'Favourites' }),
          favs.length
            ? h(
                'ul',
                { class: 'rail__list' },
                favs.map((code) =>
                  railItem([tag(code), h('span', { text: titleOf(code) })], {
                    current: v.kind === 'board' && v.board === code,
                    key: `fav-${code}`,
                    onclick: () => goto({ kind: 'board', board: code }),
                  }),
                ),
              )
            : h('p', { class: 'rail__empty', text: 'No favourites yet.' }),
        ),
        h(
          'section',
          {},
          h('h2', { class: 'rail__heading', text: 'Browse' }),
          h(
            'ul',
            { class: 'rail__list' },
            railItem([icon('grid'), h('span', { text: 'All boards' })], {
              current: v.kind === 'boards',
              key: 'all-boards',
              onclick: () => goto({ kind: 'boards' }),
            }),
          ),
        ),
        h(
          'section',
          {},
          h('h2', { class: 'rail__heading', text: 'Watched threads' }),
          h('p', { class: 'rail__empty', text: 'Nothing watched yet.' }),
        ),
      ),
      h(
        'div',
        { class: 'rail__foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'rail__item',
            'aria-current': v.kind === 'settings' ? 'page' : null,
            'data-key': 'settings',
            onclick: () => goto({ kind: 'settings' }),
          },
          icon('settings'),
          h('span', { text: 'Settings' }),
        ),
      ),
    );

    const title =
      v.kind === 'settings'
        ? h('h1', { class: 'centre__title' }, h('span', { text: 'Settings' }))
        : v.kind === 'board'
        ? h('h1', { class: 'centre__title' }, tag(v.board), h('span', { text: titleOf(v.board) || 'Catalog' }))
        : h('h1', { class: 'centre__title' }, h('span', { text: 'All boards' }));

    const body = h('div', { class: 'centre__body' });
    if (v.kind === 'settings') {
      body.append(
        renderSettings({
          settings,
          boards,
          onRunSetup,
          onChange: (next, { redraw = true, focus = null } = {}) => {
            settings = next;
            onSave(next);
            if (!redraw) return;
            render();
            if (focus) root.querySelector(`[data-key="${CSS.escape(focus)}"]`)?.focus();
          },
        }),
      );
    } else if (v.kind === 'board') {
      body.append(
        h(
          'div',
          { class: 'callout' },
          icon('info'),
          h('div', {}, h('strong', { text: 'The catalog arrives in the next phase. ' }), `Nothing has been requested for /${v.board}/ yet.`),
        ),
        h(
          'div',
          { class: 'catalog-skeleton', 'aria-hidden': 'true' },
          Array.from({ length: 12 }, () =>
            h('div', { class: 'card' }, h('div', { class: 'skeleton thumb' }), h('div', { class: 'skeleton line' }), h('div', { class: 'skeleton line line--short' })),
          ),
        ),
      );
    } else if (boards) {
      const list = M.visibleBoards(boards, settings);
      body.append(
        h(
          'div',
          { class: 'board-list' },
          list.map((b) =>
            h(
              'button',
              { type: 'button', class: 'rail__item', 'data-key': `list-${b.board}`, onclick: () => goto({ kind: 'board', board: b.board }) },
              tag(b.board),
              h('span', { text: b.title }),
            ),
          ),
        ),
      );
    } else {
      body.append(
        h(
          'div',
          { class: 'callout' },
          icon('info'),
          h('div', { text: 'The board list loads when you open it. That arrives with the catalog in the next phase.' }),
        ),
      );
    }

    const centre = h(
      'main',
      { class: 'centre' },
      h(
        'div',
        { class: 'centre__head' },
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn only-narrow',
            'aria-label': 'Boards',
            'aria-expanded': String(st.rail),
            'data-key': 'rail-toggle',
            onclick: () => {
              st.rail = !st.rail;
              render();
            },
          },
          icon('menu'),
        ),
        title,
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': st.panel ? 'Hide side panel' : 'Show side panel',
            'aria-pressed': String(st.panel),
            'data-key': 'panel-toggle',
            onclick: () => {
              st.panel = !st.panel;
              render();
            },
          },
          icon('panel'),
        ),
      ),
      body,
    );

    const panel = st.panel
      ? h(
          'aside',
          { class: 'panel', 'aria-label': 'Side panel' },
          h(
            'div',
            { class: 'panel__head' },
            h('button', { type: 'button', class: 'icon-btn only-narrow', 'aria-label': 'Back', onclick: () => ((st.panel = false), render()) }, icon('arrowLeft')),
            h('span', { text: 'Panel' }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close panel', 'data-key': 'panel-close', onclick: () => ((st.panel = false), render()) }, icon('x')),
          ),
          h(
            'div',
            { class: 'panel__body' },
            h('p', { text: 'The media viewer, Clip and the reply form open here.' }),
            h('div', { class: 'skeleton', style: { height: '180px' } }),
          ),
        )
      : null;

    root.append(rail, centre);
    if (st.rail) root.append(h('div', { class: 'shell__scrim only-narrow', onclick: () => ((st.rail = false), render()) }));
    if (panel) root.append(panel);
    if (st.rail) root.dataset.railOpen = '';
    else delete root.dataset.railOpen;

    setTitle(v.kind === 'settings' ? 'Settings' : v.kind === 'board' ? `/${v.board}/${titleOf(v.board) ? ` · ${titleOf(v.board)}` : ''}` : 'All boards');
    if (focusKey) root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (st.rail || st.panel) {
        st.rail = false;
        st.panel = false;
        render();
      }
    },
    { signal: ac.signal },
  );

  root.hidden = false;
  render();
  return {
    close() {
      ac.abort();
      root.hidden = true;
      clear(root);
    },
  };
}
