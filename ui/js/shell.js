// The shell (SCOPE §3.1a): the rail (favourites, boards, watched threads)
// and a workspace of up to five panes, laid out in one to three rows. A pane
// can move to a window of its own, which has its own panes. Every request
// goes through the bridge, and from there through the Rust core's single
// rate-limited queue (shared by every window).

import * as M from './setup-model.js';
import * as B from './browse-model.js';
import * as C from './compose-model.js';
import { h, clear, icon, toast } from './dom.js';
import { renderSettings } from './settings-view.js';
import { catalogView, threadView } from './browse.js';
import { createComposer } from './compose.js';
import { galleryItems } from './gallery-model.js';
import { openGallery } from './gallery.js';

/** A catalog is fetched again on its own after this long (manual Refresh
 *  any time; the queue still keeps ≤ 1 request/s). */
const CATALOG_MAX_AGE_MS = 60_000;
const NARROW = '(max-width: 900px)';
export const MAX_PANES = 5;

/** Splits n panes into rows (row-major): the first rows take the extra. */
export function paneRows(n, rows) {
  const r = Math.max(1, Math.min(rows || 1, n || 1, 3));
  const base = Math.floor(n / r);
  const extra = n % r;
  return Array.from({ length: r }, (_, i) => base + (i < extra ? 1 : 0)).filter((k) => k > 0);
}

export function openShell({
  settings: initial,
  boards: initialBoards = null,
  bridge = null,
  panes: initialPanes = null,
  isMain = true,
  onBoards = () => {},
  onRunSetup,
  onSave = () => {},
  setTitle = () => {},
}) {
  let settings = initial;
  let boards = initialBoards;
  const root = document.getElementById('shell');
  const titleOf = (code) => boards?.find((b) => b.board === code)?.title || '';
  let paneSeq = 0;
  const newPane = (view) => ({ id: ++paneSeq, view, catView: { query: '', sort: 'bump' } });
  const st = {
    panes: (initialPanes?.length ? initialPanes : [M.firstDestination(settings, boards)]).slice(0, MAX_PANES).map(newPane),
    focus: 0,
    rail: false, // the narrow-window overlay
    boardList: boards ? 'ok' : 'idle', // idle | loading | ok | error
    boardError: '',
    cats: {}, // board → { status, threads, error, at, freshness }
    threads: {}, // "board/no" → { status, posts, error, at, freshness, gone, fresh }
    timers: new Map(), // "board/no" → timeout, for threads open in a pane
    scroll: {}, // "paneId:viewKey" → scrollTop
    watchBusy: false,
  };
  const ac = new AbortController();
  let closed = false;
  let watchTimer = null;
  let saveTimer = null;
  let boardWaiters = [];

  const tkey = (board, no) => `${board}/${no}`;
  const viewKey = (v) => (!v ? '' : v.kind === 'board' ? `b:${v.board}` : v.kind === 'thread' ? `t:${tkey(v.board, v.no)}` : v.kind);
  const intervalMs = () => Math.max(M.MIN_WATCH_INTERVAL, settings.watch?.intervalSec || M.MIN_WATCH_INTERVAL) * 1000;
  const views = () => st.panes.map((p) => p.view);
  const openThreads = () => views().filter((v) => v?.kind === 'thread').map((v) => tkey(v.board, v.no));
  const isOpen = (board, no) => openThreads().includes(tkey(board, no));
  const isShown = (v) => views().some((x) => viewKey(x) === viewKey(v));
  const focused = () => st.panes[Math.min(st.focus, st.panes.length - 1)];
  const prefixOf = (i) => (i === 0 ? '' : `p${i}-`);

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
    const waiting = boardWaiters;
    boardWaiters = [];
    for (const w of waiting) w();
    if (!closed) render();
  }

  /** The boards.json entry for a board (loads the list once if needed). */
  async function boardInfo(code) {
    if (!boards && bridge) {
      await new Promise((resolve) => {
        boardWaiters.push(resolve);
        if (st.boardList !== 'loading') loadBoardList();
      });
    }
    return boards?.find((b) => b.board === code) || null;
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
      st.timers.set(
        key,
        setTimeout(() => {
          st.timers.delete(key);
          loadThread(board, Number(no));
        }, intervalMs()),
      );
    }
  }

  /** The watcher (main window only): every interval, the watched threads
   *  that are not open are asked for in turn. The Rust queue spaces the
   *  requests ≥ 1 s apart and answers 304 when nothing changed. */
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

  /** Shows a view in a pane (default: the focused one). */
  function goto(view, paneIndex = st.focus) {
    const i = Math.max(0, Math.min(paneIndex, st.panes.length - 1));
    st.panes[i].view = view;
    st.focus = i;
    st.rail = false;
    render();
    enter(view);
  }

  /** Opens a view in a new pane next to `after`; with five panes already,
   *  in a new window instead. */
  function openBeside(view, after = st.focus) {
    if (st.panes.length >= MAX_PANES) {
      newWindow([view]);
      return;
    }
    const at = Math.min(after + 1, st.panes.length);
    st.panes.splice(at, 0, newPane(view));
    st.focus = at;
    render();
    enter(view);
  }

  function closePane(i) {
    if (st.panes.length <= 1) return;
    st.panes.splice(i, 1);
    st.focus = Math.max(0, Math.min(st.focus >= i ? st.focus - 1 : st.focus, st.panes.length - 1));
    render();
    scheduleOpen();
  }

  async function newWindow(viewsList) {
    if (!bridge?.openWindow) return;
    const clean = viewsList.filter((v) => v && v.kind !== 'settings').slice(0, MAX_PANES);
    try {
      await bridge.openWindow(encodeURIComponent(JSON.stringify(clean.length ? clean : [{ kind: 'boards' }])));
    } catch (e) {
      toast(`Couldn’t open a window: ${e?.message || e}`);
    }
  }

  function popOut(i) {
    const v = st.panes[i].view;
    newWindow([v]);
    if (st.panes.length > 1) closePane(i);
  }

  // ------------------------------------------------------------- posting

  const composer = createComposer({
    bridge,
    getSettings: () => settings,
    saveSettings: (next) => {
      save(next, { now: true });
      render();
    },
    getBoard: boardInfo,
    onSitePage: (board, thread, quote) => openSitePage(board, thread || null, quote || null),
    onPosted: ({ board, thread, no }) => {
      // A reply: watch the thread and show it fresh. A new thread: open it.
      if (!M.isWatched(settings, board, thread)) save(M.toggleWatch(settings, { board, no: thread, seen: no }), { now: true });
      if (isOpen(board, thread)) loadThread(board, thread);
      else goto({ kind: 'thread', board, no: thread });
      void no;
    },
  });

  async function openSitePage(board, thread = null, quote = null) {
    if (!bridge?.openPost) return;
    try {
      const r = await bridge.openPost(board, thread, quote);
      if (r?.mock) toast('In the desktop app this opens the site’s own page in a window.');
    } catch (e) {
      toast(`Couldn’t open the site’s page: ${e?.message || e}`);
    }
  }

  // --------------------------------------------------------------- gallery

  function gallery(paneIndex = st.focus) {
    const v = st.panes[paneIndex]?.view;
    if (v?.kind !== 'thread') {
      toast('The gallery opens from a thread.');
      return;
    }
    const entry = st.threads[tkey(v.board, v.no)];
    if (!entry?.posts) return;
    const items = galleryItems(entry.posts, v.board, bridge);
    openGallery({
      items,
      title: B.threadTitle(entry.posts[0], 80),
      onSave: (it) => bridge.saveMedia(it.full, it.name, settings.files?.downloadDir || ''),
      onClose: (no) => {
        const el = root.querySelector(`[data-pane="${paneIndex}"] [data-no="${no}"]`);
        el?.scrollIntoView({ block: 'center' });
      },
    });
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

  function watchedRail() {
    const list = settings.watched || [];
    if (!list.length) return h('p', { class: 'rail__empty', text: 'Nothing watched yet.' });
    return h(
      'ul',
      { class: 'rail__list' },
      list.map((w) => {
        const entry = st.threads[tkey(w.board, w.no)];
        const unread = entry?.posts ? M.unreadCount(entry.posts, w.seen) : 0;
        const state = w.dead
          ? h('span', { class: 'pill pill--dead', text: '404' })
          : w.archived
            ? h('span', { class: 'pill', text: 'Archived' })
            : unread
              ? h('span', { class: 'badge', 'aria-label': `${unread} unread`, text: String(unread) })
              : null;
        return railItem([tag(w.board), h('span', { class: 'rail__label', text: w.title || `No. ${w.no}` }), state], {
          current: views().some((x) => x?.kind === 'thread' && x.board === w.board && x.no === w.no),
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

  /** Title, body and window title for the view in pane i. */
  function paneContent(i) {
    const pane = st.panes[i];
    const v = pane.view;
    const prefix = prefixOf(i);
    const entry = v.kind === 'thread' ? st.threads[tkey(v.board, v.no)] : null;
    const threadName = () => {
      const op = entry?.posts?.[0] || st.cats[v.board]?.threads?.find((t) => t.no === v.no);
      return op ? B.threadTitle(op, 70) : `No. ${v.no}`;
    };
    const body = h('div', { class: 'centre__body', 'data-scroll-key': `${pane.id}:${viewKey(v)}` });
    let title;
    let windowTitle;
    if (v.kind === 'settings') {
      title = [h('span', { class: 'centre__title-text', text: 'Settings' })];
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
          view: pane.catView,
          bridge,
          keyPrefix: prefix,
          canSplit: true,
          onOpen: (no, where) => (where === 'split' ? openBeside({ kind: 'thread', board: v.board, no }, i) : goto({ kind: 'thread', board: v.board, no }, i)),
          onRefresh: () => loadCatalog(v.board, true),
          onNewThread: () => composer.open({ board: v.board, thread: 0 }),
          onView: (patch) => {
            Object.assign(pane.catView, patch);
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
            'data-key': `${prefix}back-catalog`,
            onclick: () => goto({ kind: 'board', board: v.board }, i),
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
          keyPrefix: prefix,
          watched: M.isWatched(settings, v.board, v.no),
          intervalSec: intervalMs() / 1000,
          isYou: (no) => C.isYou(settings, v.board, no),
          onRefresh: () => loadThread(v.board, v.no),
          onWatch: () => toggleWatchThread(v.board, v.no),
          onReply: (quote = null) => composer.open({ board: v.board, thread: v.no, quote: quote || 0 }),
          onGallery: () => gallery(i),
        }),
      );
    } else {
      title = [h('span', { class: 'centre__title-text', text: 'All boards' })];
      windowTitle = 'All boards';
      body.append(boardListBody(i));
    }
    return { title, body, windowTitle };
  }

  function boardListBody(i) {
    const prefix = prefixOf(i);
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
              { type: 'button', class: 'rail__item', 'data-key': `${prefix}list-${b.board}`, onclick: () => goto({ kind: 'board', board: b.board }, i) },
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
                'data-key': `${prefix}fav-toggle-${b.board}`,
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
          h('button', { type: 'button', class: 'link-btn', 'data-key': `${prefix}retry-boards`, onclick: () => ((st.boardList = 'idle'), loadBoardList()), text: 'Try again' }),
        ),
      );
    }
    return h('p', { class: 'state-line', role: 'status' }, icon('refresh'), 'Loading the board list…');
  }

  function paneEl(i, narrow) {
    const pane = st.panes[i];
    const prefix = prefixOf(i);
    const c = paneContent(i);
    const many = st.panes.length > 1;
    const head = h(
      'div',
      { class: 'pane__head' },
      h('h2', { class: 'centre__title pane__title' }, c.title),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn icon-btn--sm',
          'aria-label': 'Open this in a new window',
          title: 'Open in a new window',
          'data-key': `${prefix}pane-popout`,
          onclick: () => popOut(i),
        },
        icon('external'),
      ),
      many
        ? h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close this pane', 'data-key': `${prefix}pane-close`, onclick: () => closePane(i) }, icon('x'))
        : null,
    );
    void narrow;
    return {
      el: h(
        'section',
        { class: 'pane', 'data-pane': String(i), 'aria-label': `Pane ${i + 1}: ${c.windowTitle}`, 'aria-current': many && i === st.focus ? 'true' : null },
        head,
        c.body,
      ),
      windowTitle: c.windowTitle,
    };
  }

  // ---------------------------------------------------------------- render

  // A thread's control bar: tucked away while scrolling down, back when
  // scrolling up or at the end. Remembered per pane across redraws (the
  // thread redraws itself every few seconds).
  const tucked = new Map(); // scroll key → true
  function watchToolsScroll(body) {
    const bar = body.querySelector('[data-thread-tools]');
    if (!bar) return;
    const k = body.dataset.scrollKey;
    bar.classList.toggle('is-tucked', Boolean(tucked.get(k)));
    let last = body.scrollTop;
    body.addEventListener(
      'scroll',
      () => {
        const y = body.scrollTop;
        const atEnd = y + body.clientHeight >= body.scrollHeight - 24;
        let hide = tucked.get(k) || false;
        if (atEnd || y < 40) hide = false;
        else if (y > last + 4) hide = true;
        else if (y < last - 4) hide = false;
        last = y;
        if (hide !== Boolean(tucked.get(k))) {
          tucked.set(k, hide);
          bar.classList.toggle('is-tucked', hide);
        }
      },
      { passive: true },
    );
  }

  function render() {
    if (closed) return;
    const active = document.activeElement;
    const focusKey = root.contains(active) ? active?.dataset?.key : null;
    const caret = focusKey && active?.tagName === 'INPUT' && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
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
    const narrow = matchMedia(NARROW).matches;
    const favs = M.visibleFavourites(settings, boards);
    const shown = (pred) => views().some((x) => x && pred(x));
    const railHidden = Boolean(settings.ui?.railHidden);
    const rows = settings.ui?.rows || 1;

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
        h('section', {}, h('h2', { class: 'rail__heading', text: 'Watched threads' }), watchedRail()),
      ),
      h(
        'div',
        { class: 'rail__foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'rail__item',
            'aria-current': shown((x) => x.kind === 'settings') ? 'page' : null,
            'data-key': 'settings',
            onclick: () => goto({ kind: 'settings' }),
          },
          icon('settings'),
          h('span', { text: 'Settings' }),
        ),
      ),
    );

    // The panes: all of them on a wide window (rows of columns); on a
    // narrow one the focused pane, with tabs to switch.
    const built = st.panes.map((_, i) => paneEl(i, narrow));
    const grid = h('div', { class: 'workspace__grid', 'data-rows': String(narrow ? 1 : paneRows(st.panes.length, rows).length) });
    if (narrow) {
      grid.append(built[Math.min(st.focus, built.length - 1)].el);
    } else {
      let k = 0;
      for (const count of paneRows(st.panes.length, rows)) {
        const row = h('div', { class: 'workspace__row', style: { '--cols': String(count) } });
        for (let j = 0; j < count; j++) row.append(built[k++].el);
        grid.append(row);
      }
    }
    const focusTitle = built[Math.min(st.focus, built.length - 1)].windowTitle;
    const head = h(
      'div',
      { class: 'workspace__head' },
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
      h('h1', { class: 'workspace__title', text: focusTitle }),
      narrow || st.panes.length < 2
        ? null
        : h(
            'div',
            { class: 'rows-pick', role: 'radiogroup', 'aria-label': 'Rows of panes' },
            [1, 2, 3].map((n) =>
              h('button', {
                type: 'button',
                role: 'radio',
                class: 'rows-pick__btn',
                'aria-checked': String(rows === n),
                'aria-label': `${n} ${n === 1 ? 'row' : 'rows'}`,
                title: `${n} ${n === 1 ? 'row' : 'rows'}`,
                'data-key': `rows-${n}`,
                disabled: n > st.panes.length,
                onclick: () => {
                  save({ ...settings, ui: { ...settings.ui, rows: n } }, { now: true });
                  render();
                },
                text: String(n),
              }),
            ),
          ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': st.panes.length >= MAX_PANES ? 'Five panes is the most; this opens a new window' : 'Add a pane',
          title: 'Add a pane',
          'data-key': 'panel-toggle',
          onclick: () => {
            const v = focused().view;
            const board = v.kind === 'board' || v.kind === 'thread' ? v.board : favs[0];
            openBeside(board ? { kind: 'board', board } : { kind: 'boards' });
          },
        },
        icon('panel'),
      ),
      h(
        'button',
        { type: 'button', class: 'icon-btn', 'aria-label': 'New window', title: 'New window', 'data-key': 'window-new', onclick: () => newWindow([focused().view]) },
        icon('external'),
      ),
    );
    const tabs =
      narrow && st.panes.length > 1
        ? h(
            'div',
            { class: 'workspace__tabs', role: 'tablist', 'aria-label': 'Panes' },
            built.map((b, i) =>
              h('button', {
                type: 'button',
                role: 'tab',
                class: 'workspace__tab',
                'aria-selected': String(i === st.focus),
                'data-key': `pane-tab-${i}`,
                onclick: () => {
                  st.focus = i;
                  render();
                },
                text: b.windowTitle,
              }),
            ),
          )
        : null;
    const workspace = h('main', { class: 'centre workspace' }, head, tabs, grid);

    root.append(rail, workspace);
    if (st.rail) root.append(h('div', { class: 'shell__scrim only-narrow', onclick: () => ((st.rail = false), render()) }));
    if (st.rail) root.dataset.railOpen = '';
    else delete root.dataset.railOpen;
    if (railHidden) root.dataset.railHidden = '';
    else delete root.dataset.railHidden;

    for (const [id, fig] of openFiles) {
      const fresh = root.querySelector(`#${CSS.escape(id)} .post__file`);
      if (fresh) fresh.replaceWith(fig);
    }
    setTitle(focusTitle);
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) {
      const y = st.scroll[body.dataset.scrollKey];
      if (y) body.scrollTop = y;
      watchToolsScroll(body);
    }
    if (focusKey) {
      const el = root.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      el?.focus({ preventScroll: true });
      if (el && caret && typeof el.setSelectionRange === 'function') el.setSelectionRange(caret[0], caret[1]);
    }
  }

  // ------------------------------------------------------------ keyboard

  root.addEventListener(
    'pointerdown',
    (e) => {
      const p = e.target.closest?.('[data-pane]');
      if (p) st.focus = Number(p.dataset.pane);
    },
    { capture: true, signal: ac.signal },
  );
  root.addEventListener(
    'focusin',
    (e) => {
      const p = e.target.closest?.('[data-pane]');
      if (p) st.focus = Number(p.dataset.pane);
    },
    { signal: ac.signal },
  );

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden || document.querySelector('dialog[open], .gallery')) return;
      if (e.key === 'Escape') {
        if (st.rail) {
          st.rail = false;
          render();
          return;
        }
        const v = focused().view;
        if (v.kind === 'thread' && !typing() && document.activeElement?.tagName !== 'VIDEO' && !document.activeElement?.closest?.('.composer')) {
          goto({ kind: 'board', board: v.board });
        }
        return;
      }
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing()) {
        if (focused().view.kind === 'thread') {
          e.preventDefault();
          gallery(st.focus);
        }
      }
    },
    { signal: ac.signal },
  );
  window.addEventListener('resize', () => !closed && render(), { signal: ac.signal });

  root.hidden = false;
  render();
  for (const v of views()) enter(v);
  if (isMain) watchTimer = setTimeout(watchTick, 2000);
  return {
    close() {
      closed = true;
      clearTimeout(watchTimer);
      clearTimeout(saveTimer);
      onSave(settings);
      composer.close();
      for (const t of st.timers.values()) clearTimeout(t);
      st.timers.clear();
      ac.abort();
      root.hidden = true;
      clear(root);
    },
    /** Settings saved in another window. */
    applySettings(next) {
      settings = next;
      render();
    },
  };
}
