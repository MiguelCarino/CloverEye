// The three-pane shell (SCOPE §3.1a): rail, centre (board list, catalog,
// thread, settings) and side panel. Every request goes through the bridge,
// and from there through the Rust core's single rate-limited queue.

import * as M from './setup-model.js';
import * as B from './browse-model.js';
import { h, clear, icon } from './dom.js';
import { renderSettings } from './settings-view.js';
import { catalogView, threadView } from './browse.js';

/** A catalog is fetched again on its own after this long (manual Refresh
 *  any time; the queue still keeps ≤ 1 request/s). */
const CATALOG_MAX_AGE_MS = 60_000;

export function openShell({ settings: initial, boards: initialBoards = null, bridge = null, onBoards = () => {}, onRunSetup, onSave = () => {}, setTitle = () => {} }) {
  let settings = initial;
  let boards = initialBoards;
  const root = document.getElementById('shell');
  const titleOf = (code) => boards?.find((b) => b.board === code)?.title || '';
  const st = {
    view: M.firstDestination(settings, boards),
    panel: false,
    rail: false,
    boardList: boards ? 'ok' : 'idle', // idle | loading | ok | error
    boardError: '',
    cats: {}, // board → { status, threads, error, at, freshness }
    catView: { query: '', sort: 'bump' },
    threads: {}, // "board/no" → { status, posts, error, at, freshness, gone, fresh }
    timer: null,
    scroll: {}, // view key → scrollTop
  };
  const ac = new AbortController();
  let closed = false;
  const viewKey = (v) => (v.kind === 'board' ? `b:${v.board}` : v.kind === 'thread' ? `t:${v.board}/${v.no}` : v.kind);
  const isView = (v) => viewKey(st.view) === viewKey(v);

  // ----------------------------------------------------------------- loading

  async function loadBoardList() {
    if (!bridge || st.boardList === 'loading') return;
    st.boardList = 'loading';
    render();
    try {
      const res = await bridge.fetchBoards();
      const list = Array.isArray(res?.boards) ? res.boards : [];
      if (!list.length) throw new Error('The board list came back empty.');
      boards = list;
      settings = M.rememberNsfwBoards(settings, list);
      onBoards(list);
      st.boardList = 'ok';
    } catch (e) {
      st.boardList = 'error';
      st.boardError = String(e?.message || e);
    }
    if (!closed) render();
  }

  async function loadCatalog(board, force = false) {
    if (!bridge) return;
    const prev = st.cats[board];
    if (prev?.status === 'loading') return;
    if (!force && prev?.status === 'ok' && Date.now() - prev.at < CATALOG_MAX_AGE_MS) return;
    st.cats[board] = { ...prev, status: 'loading' };
    if (isView({ kind: 'board', board })) render();
    try {
      const res = await bridge.fetchCatalog(board);
      st.cats[board] = { status: 'ok', threads: B.catalogThreads(res?.data), at: Date.now(), freshness: res?.freshness, error: null };
    } catch (e) {
      st.cats[board] = { ...prev, status: 'error', error: e };
    }
    if (!closed && isView({ kind: 'board', board })) render();
  }

  function clearTimer() {
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
  }

  async function loadThread(board, no) {
    if (!bridge) return;
    const key = `${board}/${no}`;
    const prev = st.threads[key];
    if (prev?.status === 'loading' || prev?.gone) return;
    clearTimer();
    st.threads[key] = { ...prev, status: 'loading' };
    const here = () => !closed && isView({ kind: 'thread', board, no });
    if (here()) render();
    try {
      const res = await bridge.fetchThread(board, no);
      const posts = Array.isArray(res?.data?.posts) ? res.data.posts : [];
      if (!posts.length) throw new Error('The thread came back empty.');
      const fresh = prev?.posts ? new Set(B.newPosts(prev.posts, posts).map((p) => p.no)) : new Set();
      st.threads[key] = { status: 'ok', posts, at: Date.now(), freshness: res?.freshness, error: null, gone: false, fresh };
    } catch (e) {
      const gone = String(e?.message || e) === 'not-found';
      st.threads[key] = { ...prev, status: 'error', error: e, gone };
    }
    if (!here()) return;
    render();
    const t = st.threads[key];
    const op = t.posts?.[0];
    if (!t.gone && !op?.archived && !op?.closed) {
      st.timer = setTimeout(() => loadThread(board, no), Math.max(M.MIN_WATCH_INTERVAL, settings.watch?.intervalSec || M.MIN_WATCH_INTERVAL) * 1000);
    }
  }

  /** Starts what a view needs: the board list, a catalog or a thread. */
  function enter(v) {
    clearTimer();
    if (v.kind === 'board') loadCatalog(v.board);
    else if (v.kind === 'thread') loadThread(v.board, v.no);
    else if (v.kind === 'boards' && st.boardList === 'idle') loadBoardList();
  }

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
    root.querySelector('.centre__body')?.scrollTo(0, st.scroll[viewKey(view)] || 0);
    enter(view);
  }

  function render() {
    const active = document.activeElement;
    const focusKey = active?.dataset?.key;
    const caret = active?.tagName === 'INPUT' && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const oldBody = root.querySelector('.centre__body');
    if (oldBody && root.dataset.view) st.scroll[root.dataset.view] = oldBody.scrollTop;
    clear(root);
    const v = st.view;
    root.dataset.view = viewKey(v);
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
                    current: (v.kind === 'board' || v.kind === 'thread') && v.board === code,
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

    const threadEntry = v.kind === 'thread' ? st.threads[`${v.board}/${v.no}`] : null;
    const threadName = () => {
      const op = threadEntry?.posts?.[0] || st.cats[v.board]?.threads?.find((t) => t.no === v.no);
      return op ? B.threadTitle(op, 70) : `No. ${v.no}`;
    };
    const title =
      v.kind === 'settings'
        ? h('h1', { class: 'centre__title' }, h('span', { text: 'Settings' }))
        : v.kind === 'board'
          ? h('h1', { class: 'centre__title' }, tag(v.board), h('span', { text: titleOf(v.board) || 'Catalog' }))
          : v.kind === 'thread'
            ? h(
                'h1',
                { class: 'centre__title' },
                h(
                  'button',
                  { type: 'button', class: 'icon-btn', 'aria-label': `Back to the /${v.board}/ catalog`, 'data-key': 'back-catalog', onclick: () => goto({ kind: 'board', board: v.board }) },
                  icon('arrowLeft'),
                ),
                tag(v.board),
                h('span', { class: 'centre__title-text', text: threadName() }),
              )
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
        catalogView({
          board: v.board,
          entry: st.cats[v.board],
          view: st.catView,
          bridge,
          onOpen: (no) => goto({ kind: 'thread', board: v.board, no }),
          onRefresh: () => loadCatalog(v.board, true),
          onView: (patch) => {
            Object.assign(st.catView, patch);
            render();
          },
        }),
      );
    } else if (v.kind === 'thread') {
      body.append(
        threadView({
          board: v.board,
          no: v.no,
          entry: threadEntry,
          bridge,
          intervalSec: Math.max(M.MIN_WATCH_INTERVAL, settings.watch?.intervalSec || M.MIN_WATCH_INTERVAL),
          onRefresh: () => loadThread(v.board, v.no),
        }),
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
    } else if (st.boardList === 'error') {
      body.append(
        h(
          'div',
          { class: 'callout callout--danger', role: 'alert' },
          icon('wifiOff'),
          h(
            'div',
            {},
            h('strong', { text: 'Couldn’t load the board list. ' }),
            st.boardError,
            ' ',
            h('button', { type: 'button', class: 'link-btn', 'data-key': 'retry-boards', onclick: () => ((st.boardList = 'idle'), loadBoardList()), text: 'Try again' }),
          ),
        ),
      );
    } else {
      body.append(h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Loading the board list…'));
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

    setTitle(
      v.kind === 'settings'
        ? 'Settings'
        : v.kind === 'board'
          ? `/${v.board}/${titleOf(v.board) ? ` · ${titleOf(v.board)}` : ''}`
          : v.kind === 'thread'
            ? `/${v.board}/ · ${threadName()}`
            : 'All boards',
    );
    const newBody = root.querySelector('.centre__body');
    if (newBody && st.scroll[root.dataset.view]) newBody.scrollTop = st.scroll[root.dataset.view];
    if (focusKey) {
      const el = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      el?.focus({ preventScroll: true });
      if (el && caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret[0], caret[1]);
    }
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (st.rail || st.panel) {
        st.rail = false;
        st.panel = false;
        render();
      } else if (st.view.kind === 'thread' && !/^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(document.activeElement?.tagName || '')) {
        goto({ kind: 'board', board: st.view.board });
      }
    },
    { signal: ac.signal },
  );

  root.hidden = false;
  render();
  enter(st.view);
  return {
    close() {
      closed = true;
      clearTimer();
      ac.abort();
      root.hidden = true;
      clear(root);
    },
  };
}
