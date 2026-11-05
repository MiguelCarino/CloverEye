// The shell (SCOPE §3.1a): rail (favourites, boards, watched threads), the
// main pane and an optional second pane beside it (split view). Every
// request goes through the bridge, and from there through the Rust core's
// single rate-limited queue.

import * as M from './setup-model.js';
import * as B from './browse-model.js';
import { h, clear, icon, toast } from './dom.js';
import { renderSettings } from './settings-view.js';
import { catalogView, threadView } from './browse.js';

/** A catalog is fetched again on its own after this long (manual Refresh
 *  any time; the queue still keeps ≤ 1 request/s). */
const CATALOG_MAX_AGE_MS = 60_000;
const NARROW = '(max-width: 900px)';
/** The main pane keeps at least this much room next to the split pane. */
const MAIN_MIN = 360;

export function openShell({ settings: initial, boards: initialBoards = null, bridge = null, onBoards = () => {}, onRunSetup, onSave = () => {}, setTitle = () => {} }) {
  let settings = initial;
  let boards = initialBoards;
  const root = document.getElementById('shell');
  const titleOf = (code) => boards?.find((b) => b.board === code)?.title || '';
  const st = {
    view: M.firstDestination(settings, boards),
    split: null, // a second view beside the main one
    rail: false, // the narrow-window overlay
    boardList: boards ? 'ok' : 'idle', // idle | loading | ok | error
    boardError: '',
    cats: {}, // board → { status, threads, error, at, freshness }
    catViews: { main: { query: '', sort: 'bump' }, split: { query: '', sort: 'bump' } },
    threads: {}, // "board/no" → { status, posts, error, at, freshness, gone, fresh }
    timers: new Map(), // "board/no" → timeout, for threads open in a pane
    scroll: {}, // pane:view key → scrollTop
    watchBusy: false,
  };
  const ac = new AbortController();
  let closed = false;
  let watchTimer = null;
  let saveTimer = null;

  const tkey = (board, no) => `${board}/${no}`;
  const viewKey = (v) => (!v ? '' : v.kind === 'board' ? `b:${v.board}` : v.kind === 'thread' ? `t:${tkey(v.board, v.no)}` : v.kind);
  const intervalMs = () => Math.max(M.MIN_WATCH_INTERVAL, settings.watch?.intervalSec || M.MIN_WATCH_INTERVAL) * 1000;
  const openThreads = () =>
    [st.view, st.split].filter((v) => v?.kind === 'thread').map((v) => tkey(v.board, v.no));
  const isOpen = (board, no) => openThreads().includes(tkey(board, no));
  const isShown = (v) => viewKey(st.view) === viewKey(v) || viewKey(st.split) === viewKey(v);

  // ---------------------------------------------------------------- saving

  /** Keeps and stores new settings. Seen-marks come in bursts, so writes
   *  are grouped. */
  function save(next, { now = false } = {}) {
    settings = next;
    clearTimeout(saveTimer);
    if (now) onSave(next);
    else saveTimer = setTimeout(() => onSave(settings), 800);
  }

  function markSeen(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!posts?.length || !M.isWatched(settings, board, no)) return;
    const last = posts[posts.length - 1].no;
    const next = M.updateWatched(settings, board, no, { seen: last, title: B.threadTitle(posts[0], 120) });
    if (next !== settings) save(next);
  }

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
    if (isShown({ kind: 'board', board })) render();
    try {
      const res = await bridge.fetchCatalog(board);
      st.cats[board] = { status: 'ok', threads: B.catalogThreads(res?.data), at: Date.now(), freshness: res?.freshness, error: null };
    } catch (e) {
      st.cats[board] = { ...prev, status: 'error', error: e };
    }
    if (!closed && isShown({ kind: 'board', board })) render();
  }

  /** Fetches a thread (through the queue: never more often than every 10 s
   *  per thread). Updates its watch record and, if it is open, schedules
   *  the next update. */
  async function loadThread(board, no) {
    if (!bridge || closed) return;
    const key = tkey(board, no);
    const prev = st.threads[key];
    if (prev?.status === 'loading' || prev?.gone) return;
    clearTimeout(st.timers.get(key));
    st.timers.delete(key);
    st.threads[key] = { ...prev, status: 'loading' };
    if (isOpen(board, no)) render();
    try {
      const res = await bridge.fetchThread(board, no);
      const posts = Array.isArray(res?.data?.posts) ? res.data.posts : [];
      if (!posts.length) throw new Error('The thread came back empty.');
      const fresh = prev?.posts ? new Set(B.newPosts(prev.posts, posts).map((p) => p.no)) : new Set();
      st.threads[key] = { status: 'ok', posts, at: Date.now(), freshness: res?.freshness, error: null, gone: false, fresh };
      const op = posts[0];
      if (M.isWatched(settings, board, no)) {
        const next = M.updateWatched(settings, board, no, { archived: Boolean(op.archived || op.closed), title: B.threadTitle(op, 120) });
        if (next !== settings) save(next);
      }
    } catch (e) {
      const gone = String(e?.message || e) === 'not-found';
      st.threads[key] = { ...prev, status: 'error', error: e, gone };
      if (gone && M.isWatched(settings, board, no)) save(M.updateWatched(settings, board, no, { dead: true }));
    }
    if (closed) return;
    if (isOpen(board, no)) markSeen(board, no);
    render();
    scheduleOpen();
  }

  /** Open threads update themselves at the watch interval until they are
   *  closed, archived or gone. */
  function scheduleOpen() {
    const open = new Set(openThreads());
    for (const [key, t] of st.timers) {
      if (!open.has(key)) {
        clearTimeout(t);
        st.timers.delete(key);
      }
    }
    for (const key of open) {
      if (st.timers.has(key)) continue;
      const entry = st.threads[key];
      const op = entry?.posts?.[0];
      if (!entry || entry.status === 'loading' || entry.gone || op?.archived || op?.closed) continue;
      const [board, no] = key.split('/');
      st.timers.set(key, setTimeout(() => {
        st.timers.delete(key);
        loadThread(board, Number(no));
      }, intervalMs()));
    }
  }

  /** The watcher: every interval, the watched threads that are not open
   *  are asked for in turn (open ones update themselves). The Rust queue
   *  spaces the requests ≥ 1 s apart and answers 304 when nothing changed. */
  async function watchTick() {
    if (closed || st.watchBusy) return;
    st.watchBusy = true;
    try {
      for (const w of [...(settings.watched || [])]) {
        if (closed) return;
        if (w.dead || w.archived || isOpen(w.board, w.no)) continue;
        if (!M.isWatched(settings, w.board, w.no)) continue;
        await loadThread(w.board, w.no);
      }
    } finally {
      st.watchBusy = false;
      if (!closed) watchTimer = setTimeout(watchTick, intervalMs());
    }
  }

  /** Starts what a view needs: the board list, a catalog or a thread. */
  function enter(v) {
    if (!v) return;
    if (v.kind === 'board') loadCatalog(v.board);
    else if (v.kind === 'thread') {
      const entry = st.threads[tkey(v.board, v.no)];
      if (entry?.posts && Date.now() - entry.at < 10_000) {
        markSeen(v.board, v.no);
        render();
      } else loadThread(v.board, v.no);
    } else if (v.kind === 'boards' && st.boardList === 'idle') loadBoardList();
    scheduleOpen();
  }

  function goto(view, pane = 'main') {
    if (pane === 'split') st.split = view;
    else st.view = view;
    st.rail = false;
    render();
    enter(view);
  }

  // ---------------------------------------------------------------- pieces

  function tag(code) {
    return h('span', { class: 'board-tag', style: { '--hue': M.boardHue(code) }, text: `/${code}/` });
  }

  function railItem(content, { current = false, onclick, key, extra = null }) {
    return h(
      'li',
      { class: extra ? 'rail__row' : null },
      h('button', { type: 'button', class: 'rail__item', 'aria-current': current ? 'page' : null, 'data-key': key, onclick }, content),
      extra,
    );
  }

  function toggleFav(code) {
    const had = settings.favourites.includes(code);
    const next = M.toggleFavourite(settings, code);
    if (next === settings) {
      toast(`At most ${M.MAX_FAVOURITES} favourites.`);
      return;
    }
    save(next, { now: true });
    toast(had ? `/${code}/ removed from favourites` : `/${code}/ added to favourites`);
    render();
  }

  function toggleWatchThread(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    const was = M.isWatched(settings, board, no);
    const next = M.toggleWatch(settings, {
      board,
      no,
      title: posts ? B.threadTitle(posts[0], 120) : '',
      seen: posts?.length ? posts[posts.length - 1].no : 0,
    });
    if (next === settings) {
      toast(`At most ${M.MAX_WATCHED} watched threads.`);
      return;
    }
    save(next, { now: true });
    toast(was ? 'No longer watching this thread' : 'Watching this thread');
    render();
  }

  async function openPost(board, thread = null, quote = null) {
    if (!bridge?.openPost) return;
    try {
      const r = await bridge.openPost(board, thread, quote);
      if (r?.mock) toast('In the desktop app this opens the site’s own post form, with its captcha.');
    } catch (e) {
      toast(`Couldn’t open the post form: ${e?.message || e}`);
    }
  }

  function watchedRail(v) {
    const list = settings.watched || [];
    if (!list.length) return h('p', { class: 'rail__empty', text: 'Nothing watched yet.' });
    return h(
      'ul',
      { class: 'rail__list' },
      list.map((w) => {
        const entry = st.threads[tkey(w.board, w.no)];
        const unread = entry?.posts ? M.unreadCount(entry.posts, w.seen) : 0;
        const state = w.dead ? h('span', { class: 'pill pill--dead', text: '404' }) : w.archived ? h('span', { class: 'pill', text: 'Archived' }) : unread ? h('span', { class: 'badge', 'aria-label': `${unread} unread`, text: String(unread) }) : null;
        return railItem([tag(w.board), h('span', { class: 'rail__label', text: w.title || `No. ${w.no}` }), state], {
          current: [st.view, st.split].some((x) => x?.kind === 'thread' && x.board === w.board && x.no === w.no),
          key: `watched-${w.board}-${w.no}`,
          onclick: () => goto({ kind: 'thread', board: w.board, no: w.no }),
          extra: h(
            'button',
            {
              type: 'button',
              class: 'icon-btn icon-btn--sm',
              'aria-label': `Stop watching ${w.title || `No. ${w.no}`}`,
              'data-key': `unwatch-${w.board}-${w.no}`,
              onclick: () => toggleWatchThread(w.board, w.no),
            },
            icon('x'),
          ),
        });
      }),
    );
  }

  /** Title, body and window title for a view in a pane. */
  function paneContent(v, pane) {
    const entry = v.kind === 'thread' ? st.threads[tkey(v.board, v.no)] : null;
    const threadName = () => {
      const op = entry?.posts?.[0] || st.cats[v.board]?.threads?.find((t) => t.no === v.no);
      return op ? B.threadTitle(op, 70) : `No. ${v.no}`;
    };
    const body = h('div', { class: 'centre__body' });
    let title;
    let windowTitle;
    if (v.kind === 'settings') {
      title = [h('span', { text: 'Settings' })];
      windowTitle = 'Settings';
      body.append(
        renderSettings({
          settings,
          boards,
          onRunSetup,
          onChange: (next, { redraw = true, focus = null } = {}) => {
            save(next, { now: true });
            if (!redraw) return;
            render();
            if (focus) root.querySelector(`[data-key="${CSS.escape(focus)}"]`)?.focus();
          },
        }),
      );
    } else if (v.kind === 'board') {
      title = [tag(v.board), h('span', { class: 'centre__title-text', text: titleOf(v.board) || 'Catalog' })];
      windowTitle = `/${v.board}/${titleOf(v.board) ? ` · ${titleOf(v.board)}` : ''}`;
      body.append(
        catalogView({
          board: v.board,
          entry: st.cats[v.board],
          view: st.catViews[pane],
          bridge,
          keyPrefix: pane === 'split' ? 'split-' : '',
          onOpen: (no, where = pane) => goto({ kind: 'thread', board: v.board, no }, where),
          canSplit: pane === 'main',
          onRefresh: () => loadCatalog(v.board, true),
          onNewThread: () => openPost(v.board),
          onView: (patch) => {
            Object.assign(st.catViews[pane], patch);
            render();
          },
        }),
      );
    } else if (v.kind === 'thread') {
      title = [
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': `Back to the /${v.board}/ catalog`,
            'data-key': pane === 'split' ? 'split-back-catalog' : 'back-catalog',
            onclick: () => goto({ kind: 'board', board: v.board }, pane),
          },
          icon('arrowLeft'),
        ),
        tag(v.board),
        h('span', { class: 'centre__title-text', text: threadName() }),
      ];
      windowTitle = `/${v.board}/ · ${threadName()}`;
      body.append(
        threadView({
          board: v.board,
          no: v.no,
          entry,
          bridge,
          keyPrefix: pane === 'split' ? 'split-' : '',
          watched: M.isWatched(settings, v.board, v.no),
          intervalSec: intervalMs() / 1000,
          onRefresh: () => loadThread(v.board, v.no),
          onWatch: () => toggleWatchThread(v.board, v.no),
          onReply: (quote = null) => openPost(v.board, v.no, quote),
        }),
      );
    } else {
      title = [h('span', { text: 'All boards' })];
      windowTitle = 'All boards';
      body.append(boardListBody(pane));
    }
    return { title, body, windowTitle };
  }

  function boardListBody(pane) {
    if (boards) {
      const list = M.visibleBoards(boards, settings);
      return h(
        'ul',
        { class: 'board-list', 'aria-label': 'All boards' },
        list.map((b) => {
          const fav = settings.favourites.includes(b.board);
          return h(
            'li',
            { class: 'board-list__row' },
            h(
              'button',
              { type: 'button', class: 'rail__item', 'data-key': `${pane === 'split' ? 'split-' : ''}list-${b.board}`, onclick: () => goto({ kind: 'board', board: b.board }, pane) },
              tag(b.board),
              h('span', { class: 'rail__label', text: b.title }),
            ),
            h(
              'button',
              {
                type: 'button',
                class: `icon-btn star${fav ? ' star--on' : ''}`,
                'aria-pressed': String(fav),
                'aria-label': fav ? `Remove /${b.board}/ from favourites` : `Add /${b.board}/ to favourites`,
                'data-key': `${pane === 'split' ? 'split-' : ''}fav-toggle-${b.board}`,
                onclick: () => toggleFav(b.board),
              },
              icon('star'),
            ),
          );
        }),
      );
    }
    if (st.boardList === 'error') {
      return h(
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
      );
    }
    return h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Loading the board list…');
  }

  // ------------------------------------------------------------ split pane

  function splitWidth() {
    const shellW = root.clientWidth || window.innerWidth;
    const railW = settings.ui?.railHidden ? 0 : root.querySelector('.rail')?.offsetWidth || 248;
    const max = Math.max(M.SPLIT_MIN, shellW - railW - MAIN_MIN);
    return Math.min(max, Math.max(M.SPLIT_MIN, settings.ui?.splitWidth || 520));
  }

  function resizer(panel) {
    const handle = h('div', {
      class: 'panel__resize',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the second pane',
      'aria-valuemin': String(M.SPLIT_MIN),
      'aria-valuemax': String(M.SPLIT_MAX),
      'aria-valuenow': String(settings.ui?.splitWidth || 520),
      'data-key': 'split-resize',
    });
    const set = (w, store) => {
      const next = { ...settings, ui: { ...settings.ui, splitWidth: Math.round(w) } };
      settings = next;
      const width = splitWidth();
      panel.style.width = `${width}px`;
      handle.setAttribute('aria-valuenow', String(width));
      if (store) save(M.normalizeSettings(next), { now: true });
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const right = panel.getBoundingClientRect().right;
      const move = (ev) => set(right - ev.clientX, false);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        set(panel.getBoundingClientRect().width, true);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 96 : 32;
      if (e.key === 'ArrowLeft') set(splitWidth() + step, true);
      else if (e.key === 'ArrowRight') set(splitWidth() - step, true);
      else return;
      e.preventDefault();
    });
    return handle;
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (closed) return;
    const active = document.activeElement;
    const focusKey = active?.dataset?.key;
    const caret = active?.tagName === 'INPUT' && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) st.scroll[body.dataset.scrollKey] = body.scrollTop;
    // Files the person opened (a playing video, a full image) survive the
    // redraw: the same elements move into the new page within this task,
    // so a video keeps playing instead of starting over or closing.
    const openFiles = new Map();
    for (const fig of root.querySelectorAll('.post__file--open')) {
      const post = fig.closest('.post');
      if (post?.id) openFiles.set(post.id, fig);
    }
    clear(root);
    const v = st.view;
    const narrow = matchMedia(NARROW).matches;
    const favs = M.visibleFavourites(settings, boards);
    const shown = (pred) => [st.view, st.split].some((x) => x && pred(x));

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
                  railItem([tag(code), h('span', { class: 'rail__label', text: titleOf(code) })], {
                    current: shown((x) => (x.kind === 'board' || x.kind === 'thread') && x.board === code),
                    key: `fav-${code}`,
                    onclick: () => goto({ kind: 'board', board: code }),
                  }),
                ),
              )
            : h('p', { class: 'rail__empty', text: 'No favourites yet. Star boards in All boards.' }),
        ),
        h(
          'section',
          {},
          h('h2', { class: 'rail__heading', text: 'Browse' }),
          h(
            'ul',
            { class: 'rail__list' },
            railItem([icon('grid'), h('span', { text: 'All boards' })], {
              current: shown((x) => x.kind === 'boards'),
              key: 'all-boards',
              onclick: () => goto({ kind: 'boards' }),
            }),
          ),
        ),
        h('section', {}, h('h2', { class: 'rail__heading', text: 'Watched threads' }), watchedRail(v)),
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

    const main = paneContent(v, 'main');
    main.body.dataset.scrollKey = `main:${viewKey(v)}`;
    const railHidden = Boolean(settings.ui?.railHidden);
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
            class: 'icon-btn',
            'aria-label': narrow ? 'Boards' : railHidden ? 'Show the sidebar' : 'Hide the sidebar',
            'aria-expanded': String(narrow ? st.rail : !railHidden),
            'data-key': 'rail-toggle',
            onclick: () => {
              if (matchMedia(NARROW).matches) st.rail = !st.rail;
              else save({ ...settings, ui: { ...settings.ui, railHidden: !settings.ui?.railHidden } }, { now: true });
              render();
            },
          },
          icon(narrow ? 'menu' : 'sidebar'),
        ),
        h('h1', { class: 'centre__title' }, main.title),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': st.split ? 'Close the second pane' : 'Open a second pane',
            'aria-pressed': String(Boolean(st.split)),
            'data-key': 'panel-toggle',
            onclick: () => {
              if (st.split) {
                st.split = null;
                render();
                scheduleOpen();
              } else {
                const board = v.kind === 'board' || v.kind === 'thread' ? v.board : favs[0];
                goto(board ? { kind: 'board', board } : { kind: 'boards' }, 'split');
              }
            },
          },
          icon('panel'),
        ),
      ),
      main.body,
    );

    let panel = null;
    if (st.split) {
      const sp = paneContent(st.split, 'split');
      sp.body.dataset.scrollKey = `split:${viewKey(st.split)}`;
      panel = h(
        'section',
        { class: 'panel panel--split', 'aria-label': 'Second pane' },
        h(
          'div',
          { class: 'panel__head' },
          h('div', { class: 'centre__title panel__title' }, sp.title),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'aria-label': 'Move to the main pane',
              'data-key': 'split-swap',
              onclick: () => {
                const a = st.view;
                st.view = st.split;
                st.split = a.kind === 'settings' ? null : a;
                render();
              },
            },
            icon('swap'),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'aria-label': 'Close the second pane',
              'data-key': 'panel-close',
              onclick: () => {
                st.split = null;
                render();
                scheduleOpen();
              },
            },
            icon('x'),
          ),
        ),
        sp.body,
      );
      if (!narrow) panel.prepend(resizer(panel));
    }

    root.append(rail, centre);
    if (st.rail) root.append(h('div', { class: 'shell__scrim only-narrow', onclick: () => ((st.rail = false), render()) }));
    if (panel) root.append(panel);
    if (st.rail) root.dataset.railOpen = '';
    else delete root.dataset.railOpen;
    if (railHidden) root.dataset.railHidden = '';
    else delete root.dataset.railHidden;
    if (panel && !narrow) panel.style.width = `${splitWidth()}px`;
    for (const [id, fig] of openFiles) {
      const fresh = root.querySelector(`#${CSS.escape(id)} .post__file`);
      if (fresh) fresh.replaceWith(fig);
    }

    setTitle(main.windowTitle);
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) {
      const y = st.scroll[body.dataset.scrollKey];
      if (y) body.scrollTop = y;
    }
    if (focusKey) {
      const el = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      el?.focus({ preventScroll: true });
      if (el && caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret[0], caret[1]);
    }
  }

  // ------------------------------------------------------------ keyboard

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
      if (st.rail) {
        st.rail = false;
        render();
      } else if (st.view.kind === 'thread' && !/^(INPUT|TEXTAREA|SELECT|VIDEO)$/.test(document.activeElement?.tagName || '') && !document.activeElement?.closest?.('.panel')) {
        goto({ kind: 'board', board: st.view.board });
      }
    },
    { signal: ac.signal },
  );
  window.addEventListener('resize', () => !closed && root.querySelector('.panel--split') && render(), { signal: ac.signal });

  root.hidden = false;
  render();
  enter(st.view);
  watchTimer = setTimeout(watchTick, 2000);
  return {
    close() {
      closed = true;
      clearTimeout(watchTimer);
      clearTimeout(saveTimer);
      onSave(settings);
      for (const t of st.timers.values()) clearTimeout(t);
      st.timers.clear();
      ac.abort();
      root.hidden = true;
      clear(root);
    },
  };
}
