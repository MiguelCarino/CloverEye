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
import * as F from './filter-model.js';
import { hiddenPosts } from './hide-model.js';
import * as U from './unread-model.js';
import { idCounts, toggleIdHighlight } from './ids-model.js';
import { crossStale } from './quote-model.js';
import { archiveLink } from './archive-model.js';
import { createEmbedPlayer } from './embeds.js';
import * as O from './offline-model.js';
import { savedListView, confirmDialog } from './offline.js';
import { postFlag } from './bridge.js';
import * as SM from './stats-model.js';
import { createStats } from './stats.js';
import { statsView, statusText, FOURSTATS_URL } from './stats-view.js';

/** A catalog is fetched again on its own after this long (manual Refresh
 *  any time; the queue still keeps ≤ 1 request/s). */
const CATALOG_MAX_AGE_MS = 60_000;
/** Another thread fetched for a quote link (preview or inline copy) is asked
 *  for again after this long; the queue still keeps its 10 s per thread. */
const CROSS_MAX_AGE_MS = 60_000;
/** Other threads kept for quote links (the oldest goes first). */
const CROSS_KEEP = 40;
const NARROW = '(max-width: 900px)';
/** Saved threads listed in the rail (the rest are in All saved threads). */
const SAVED_IN_RAIL = 8;
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
  const newPane = (view) => ({ id: ++paneSeq, view, catView: { query: '', sort: 'bump' }, statsView: { tab: 'boards', sort: 'ppm', dir: 'desc', metric: 'time' } });
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
    revealed: new Set(), // "board/no" of filtered posts shown anyway (this session)
    lines: new Map(), // "board/no" → the "New posts" line (after this No.; unread-model.js)
    idHl: new Map(), // "board/no" → the poster ID highlighted in it
    cross: new Map(), // "board/no" → another thread fetched for quote links: { status, posts: Map, at }
    crossWait: new Map(), // "board/no" → the fetch under way
    jumpTo: null, // { paneId, board, no, post }: scroll there once the thread is drawn
    saved: { status: 'idle', list: [], error: '' }, // saved threads (offline-model.js savedEntries)
    offline: {}, // "board/no" → a saved thread read from disk: { status, posts, have, folder, savedAt, error }
    jobs: new Map(), // "board/no" → a save or download running: { kind, done, total, cancelled }
  };
  const ac = new AbortController();
  let closed = false;
  let watchTimer = null;
  let saveTimer = null;
  let boardWaiters = [];

  // ------------------------------------------------------------------ stats

  // Board activity and your own counts (stats.js): samples from catalogs
  // loaded anyway, background sampling (main window, opt-in), and the Stats
  // pane, which is redrawn in place when they change.
  const isWorksafe = (b) => b.ws_board === 1 || b.ws_board === true;
  /** The boards the sampler follows; null while the board list it needs
   *  is not here (`load`: ask for it). */
  function trackedBoards(load = true) {
    const o = SM.normalizeStatsSettings(settings.stats);
    if (o.scope === 'favourites') return SM.trackedBoards('favourites', { favourites: M.visibleFavourites(settings, boards) });
    if (!boards) {
      if (load && bridge && st.boardList === 'idle') loadBoardList();
      return st.boardList === 'error' ? [] : null;
    }
    return SM.trackedBoards(o.scope, {
      worksafe: boards.filter(isWorksafe).map((b) => b.board),
      visible: M.visibleBoards(boards, settings).map((b) => b.board),
    });
  }
  const stats = createStats({
    bridge,
    getSettings: () => settings,
    isMain,
    tracked: () => trackedBoards(true),
    focusBoard: () => {
      const v = focused()?.view;
      return v?.kind === 'board' || v?.kind === 'thread' ? v.board : null;
    },
    onBoards: () => scheduleStats(),
    onMine: () => scheduleStats(),
    onStatus: (status) => {
      for (const el of root.querySelectorAll('[data-stats-status]')) el.textContent = statusText(status, { isMain });
    },
    // a catalog the sampler fetched freshens one already loaded this session
    onCatalog: (board, res, at) => {
      const prev = st.cats[board];
      if (!prev || prev.status === 'loading' || isShown({ kind: 'board', board })) return;
      st.cats[board] = { status: 'ok', threads: B.catalogThreads(res?.data), at, freshness: res?.freshness, error: null };
    },
  });

  const tkey = (board, no) => `${board}/${no}`;
  const viewKey = (v) =>
    !v ? '' : v.kind === 'board' ? `b:${v.board}` : v.kind === 'thread' ? `t:${tkey(v.board, v.no)}` : v.kind === 'offline' ? `o:${tkey(v.board, v.no)}` : v.kind;
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

  /** Keeps a watched thread's title current. What has been read (its
   *  `seen`) follows the posts that were on screen: trackRead(). */
  function markSeen(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!posts?.length || !M.isWatched(settings, board, no)) return;
    const next = M.updateWatched(settings, board, no, { title: B.threadTitle(posts[0], 120) });
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
      // a catalog loaded anyway is a board activity sample: no extra request
      stats.recordCatalog(board, res?.data);
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
      // New posts while the thread is open: the "New posts" line moves above
      // them once everything before them was read (unread-model.js).
      if (fresh.size && prev?.posts?.length && st.lines.has(key)) {
        st.lines.set(key, U.lineAfterUpdate(st.lines.get(key), U.readOf(settings, board, no), prev.posts[prev.posts.length - 1].no));
      }
      st.threads[key] = { status: 'ok', posts, at: Date.now(), freshness: res?.freshness, error: null, gone: false, fresh };
      countRepliesToYou(board, posts);
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

  // ----------------------------------------------- other threads (quotes)

  const postMaps = new WeakMap(); // a thread's posts array → Map No. → post

  /** Another thread for quote links: a thread loaded here (open or watched)
   *  or the copy fetched for quotes, whichever is newer. */
  function crossEntry(board, no) {
    const key = tkey(board, no);
    const own = st.threads[key];
    const got = st.cross.get(key);
    if (own?.gone) return { status: 'gone', at: own.at };
    if (own?.posts && (!got?.at || (own.at || 0) >= got.at)) {
      if (!postMaps.has(own.posts)) postMaps.set(own.posts, new Map(own.posts.map((p) => [p.no, p])));
      return { status: own.status === 'loading' ? 'loading' : 'ok', posts: postMaps.get(own.posts), at: own.at };
    }
    return got;
  }

  /** Fetches another thread for a quote link through the queue, unless the
   *  copy here is fresh enough (or the thread is gone). Returns the fetch
   *  under way, or null when nothing is asked for. Draws nothing itself:
   *  the copy or preview waiting for it fills itself in. */
  function loadCross(board, no, force = false) {
    const key = tkey(board, no);
    if (st.crossWait.has(key)) return st.crossWait.get(key);
    const have = crossEntry(board, no);
    if (!crossStale(have, Date.now(), CROSS_MAX_AGE_MS, force ? 0 : undefined)) return null;
    const prev = st.cross.get(key);
    if (!bridge || closed) {
      st.cross.set(key, { ...prev, status: 'error', at: Date.now() });
      return null;
    }
    st.cross.delete(key); // re-added last: the newest
    st.cross.set(key, { ...prev, status: 'loading' });
    while (st.cross.size > CROSS_KEEP) st.cross.delete(st.cross.keys().next().value);
    const job = (async () => {
      try {
        const res = await bridge.fetchThread(board, no);
        const posts = Array.isArray(res?.data?.posts) ? res.data.posts : [];
        if (!posts.length) throw new Error('The thread came back empty.');
        st.cross.set(key, { status: 'ok', posts: new Map(posts.map((p) => [p.no, p])), at: Date.now() });
      } catch (e) {
        const gone = String(e?.message || e) === 'not-found';
        st.cross.set(key, gone ? { status: 'gone', at: Date.now() } : { ...prev, status: 'error', at: Date.now() });
      } finally {
        st.crossWait.delete(key);
      }
    })();
    st.crossWait.set(key, job);
    return job;
  }

  /** An archive's address, in the system browser (https only). */
  function openArchive(url) {
    if (!/^https:\/\//.test(String(url)) || !bridge?.openExternal) return;
    Promise.resolve(bridge.openExternal(url)).catch((e) => toast(`Couldn’t open the archive: ${e?.message || e}`));
  }

  /** A link from a post, in the system browser (link-model.js made it
   *  http or https; the app checks again). */
  function openLink(url) {
    if (!/^https?:\/\//i.test(String(url)) || !bridge?.openLink) return;
    Promise.resolve(bridge.openLink(url)).catch((e) => toast(`Couldn’t open the link: ${e?.message || e}`));
  }

  // One player for the window, outside the panes, so redraws never reload it.
  const player = createEmbedPlayer({ openLink });
  const postLinks = () => ({
    open: openLink,
    embeds: settings.embeds?.mode || 'click',
    onEmbed: (emb, href) => player.open(emb, href),
    isPlaying: player.isPlaying,
  });

  const crossThreads = {
    entry: crossEntry,
    load: loadCross,
    archive: (ref) => archiveLink(settings.archives, ref),
    open: openArchive,
  };

  /** A quote link to another thread's post, clicked to jump: that thread
   *  opens beside this pane, scrolled to the post. */
  function openCross(q, paneIndex) {
    const v = { kind: 'thread', board: q.board, no: q.thread };
    const before = st.panes.length;
    openBeside(v, paneIndex);
    if (st.panes.length === before) return; // five panes: it went to a new window
    st.jumpTo = { paneId: st.panes[st.focus]?.id, board: q.board, no: q.thread, post: q.no };
    showJump();
  }

  /** Scrolls to the post a jump to another thread asked for, once drawn. */
  function showJump() {
    const j = st.jumpTo;
    if (!j) return;
    const i = st.panes.findIndex((p) => p.id === j.paneId);
    const v = st.panes[i]?.view;
    if (i < 0 || v?.kind !== 'thread' || v.board !== j.board || v.no !== j.no) {
      st.jumpTo = null;
      return;
    }
    const entry = st.threads[tkey(v.board, v.no)];
    if (entry?.status === 'error') st.jumpTo = null;
    const el = root.querySelector(`[data-pane="${i}"] .thread > [data-no="${j.post}"]`);
    if (!el) return;
    st.jumpTo = null;
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
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

  /** A thread being opened: its "New posts" line goes after what was read
   *  so far. Set before the first render, which marks what is on screen as
   *  read and would otherwise move the line past the new posts. */
  function startLine(v) {
    if (v?.kind === 'thread') st.lines.set(tkey(v.board, v.no), U.lineOnOpen(U.readOf(settings, v.board, v.no)));
  }

  /** Starts what a view needs: the board list, a catalog or a thread. */
  function enter(v) {
    if (!v) return;
    if (v.kind === 'board') loadCatalog(v.board);
    else if (v.kind === 'thread') {
      stats.count('threads', 1, v.board);
      const entry = st.threads[tkey(v.board, v.no)];
      if (entry?.posts && Date.now() - entry.at < 10_000) {
        markSeen(v.board, v.no);
        render();
      } else loadThread(v.board, v.no);
    } else if (v.kind === 'boards' && st.boardList === 'idle') loadBoardList();
    else if (v.kind === 'saved') loadSaved();
    else if (v.kind === 'offline' && st.offline[tkey(v.board, v.no)]?.status !== 'ok') loadOffline(v.board, v.no);
    else if (v.kind === 'stats') {
      stats.reload();
      // sampling every worksafe (or visible) board needs the board list
      if (!boards && st.boardList === 'idle' && settings.stats?.track && settings.stats?.scope !== 'favourites') loadBoardList();
    }
    scheduleOpen();
  }

  /** Shows a view in a pane (default: the focused one). */
  function goto(view, paneIndex = st.focus) {
    const i = Math.max(0, Math.min(paneIndex, st.panes.length - 1));
    st.panes[i].view = view;
    st.focus = i;
    st.rail = false;
    startLine(view);
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
    startLine(view);
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
      stats.count('posts', 1);
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
    if (v?.kind !== 'thread' && v?.kind !== 'offline') {
      toast('The gallery opens from a thread.');
      return;
    }
    const saved = v.kind === 'offline';
    const entry = saved ? st.offline[tkey(v.board, v.no)] : st.threads[tkey(v.board, v.no)];
    if (!entry?.posts) return;
    const { why } = threadMarks(v.board, entry.posts);
    const shownPosts = entry.posts.filter((p) => !why.has(p.no) || st.revealed.has(tkey(v.board, p.no)));
    const items = galleryItems(shownPosts, v.board, saved ? savedFiles(v.board, v.no) : bridge);
    openGallery({
      items,
      title: B.threadTitle(entry.posts[0], 80),
      // a saved copy's file is already on disk: Save says where
      onSave: saved
        ? async (it) => O.savedFileOnDisk(entry.folder, entry.posts.find((p) => p.no === it.no))
        : (it) => bridge.saveMedia(it.full, it.name, settings.files?.downloadDir || ''),
      preload: settings.display?.galleryPreload !== false,
      onClose: (no) => {
        const el = root.querySelector(`[data-pane="${paneIndex}"] [data-no="${no}"]`);
        el?.scrollIntoView({ block: 'center' });
      },
    });
  }

  // --------------------------------------------------------- saved threads

  // Save offline (offline-model.js, src-tauri/src/offline.rs): the thread as
  // loaded through the queue, then its files from the image host, one at a
  // time, a second apart. Saved copies open from disk, with no request.
  const savedDir = () => settings.files?.savedDir || '';

  async function loadSaved() {
    if (!bridge?.offlineList || closed) return;
    st.saved = { ...st.saved, status: 'loading' };
    try {
      st.saved = { status: 'ok', list: O.savedEntries(await bridge.offlineList(savedDir())), error: '' };
    } catch (e) {
      st.saved = { ...st.saved, status: 'error', error: String(e?.message || e) };
    }
    if (!closed) render();
  }

  async function loadOffline(board, no) {
    const key = tkey(board, no);
    if (!bridge?.offlineRead || st.offline[key]?.status === 'loading') return;
    st.offline[key] = { ...st.offline[key], status: 'loading' };
    render();
    try {
      const r = await bridge.offlineRead(savedDir(), board, no);
      const posts = Array.isArray(r?.thread?.posts) ? r.thread.posts : [];
      if (!posts.length) throw new Error('The saved thread has no posts.');
      st.offline[key] = { status: 'ok', posts, have: { files: r.files || [], thumbs: r.thumbs || [] }, folder: r.folder || '', savedAt: r.savedAt || 0, error: null };
    } catch (e) {
      const gone = String(e?.message || e) === 'not-saved';
      st.offline[key] = { status: 'error', gone, error: gone ? new Error('This thread is not in the saved threads folder.') : e };
    }
    if (!closed) render();
  }

  /** A saved thread's file URLs (the app's own scheme; nothing from the site). */
  function savedFiles(board, no) {
    const entry = st.offline[tkey(board, no)];
    const urls = O.savedUrls(no, entry?.have, (path) => bridge?.savedFileUrl?.(path) || null);
    return { ...urls, flag: (b, p) => postFlag(b, p, false) };
  }

  /** The running saves' "Saving 12/48 files…", set in place. */
  function showJobs() {
    for (const [key, job] of st.jobs) {
      for (const el of root.querySelectorAll(`[data-save-progress="${CSS.escape(key)}"]`)) el.textContent = job.cancelled ? 'Stopping…' : O.progressText(job);
    }
  }

  /** Runs one save or download job for a thread, with its progress. */
  async function runJob(board, no, kind, prepare) {
    const key = tkey(board, no);
    if (st.jobs.has(key)) return;
    const job = { kind, done: 0, total: 0, cancelled: false };
    st.jobs.set(key, job);
    render();
    try {
      const { jobs, worker } = await prepare();
      if (!jobs.length) {
        toast('This thread has no files.');
        return;
      }
      job.total = jobs.length;
      showJobs();
      const r = await O.runQueue(jobs, worker, {
        isCancelled: () => job.cancelled || closed,
        onProgress: (n) => {
          job.done = n;
          showJobs();
        },
      });
      if (kind === 'offline') stats.count('saved', 1);
      toast(O.doneText(kind, r));
    } catch (e) {
      toast(kind === 'all' ? `Couldn’t download the files: ${e?.message || e}` : `Couldn’t save the thread: ${e?.message || e}`);
    } finally {
      st.jobs.delete(key);
      if (!closed) {
        if (kind === 'offline') {
          loadSaved();
          if (views().some((x) => x?.kind === 'offline' && x.board === board && x.no === no)) loadOffline(board, no);
          else delete st.offline[key];
        }
        render();
      }
    }
  }

  /** Save offline, or update the saved copy: posts the site dropped stay. */
  function saveOffline(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!bridge?.offlineWriteThread || !posts?.length) return;
    const dir = savedDir();
    runJob(board, no, 'offline', async () => {
      let all = posts;
      try {
        const old = await bridge.offlineRead(dir, board, no);
        all = O.mergePosts(old?.thread?.posts, posts);
      } catch (e) {
        if (String(e?.message || e) !== 'not-saved') throw e;
      }
      await bridge.offlineWriteThread(dir, board, no, B.threadTitle(all[0], 120), { posts: all });
      loadSaved();
      return { jobs: O.fileJobs(all), worker: (j) => bridge.offlineFetchFile(dir, board, no, j) };
    });
  }

  /** Every file of the thread to the download folder, one a second. */
  function downloadAll(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!bridge?.downloadFile || !posts?.length) return;
    const dir = settings.files?.downloadDir || '';
    runJob(board, no, 'all', async () => ({
      jobs: O.downloadJobs(posts, (p) => bridge.mediaUrl(board, p)),
      worker: (j) => bridge.downloadFile(j.url, j.name, dir, j.size),
    }));
  }

  function cancelJob(board, no) {
    const job = st.jobs.get(tkey(board, no));
    if (!job) return;
    job.cancelled = true;
    render();
  }

  async function deleteSaved(e, opener) {
    const key = tkey(e.board, e.no);
    if (st.jobs.has(key)) {
      toast('This thread is being saved: cancel that first.');
      return;
    }
    const name = e.title || `No. ${e.no}`;
    const ok = await confirmDialog({
      title: 'Delete this saved thread?',
      text: `The saved copy of “${name}” and every file saved with it are deleted from the disk. This cannot be undone.`,
      confirm: 'Delete',
      opener,
    });
    if (!ok || closed) return;
    try {
      await bridge.offlineDelete(savedDir(), e.board, e.no);
      toast('Saved thread deleted');
    } catch (err) {
      toast(`Couldn’t delete the saved thread: ${err?.message || err}`);
    }
    forgetOffline(key);
    loadSaved();
  }

  /**
   * Drops cached saved copies (one, or all when the folder moved) and
   * reloads the ones still open in a pane, so none sits on its placeholder.
   */
  function forgetOffline(key = null) {
    if (key) delete st.offline[key];
    else st.offline = {};
    for (const v of views()) {
      if (v?.kind === 'offline' && (!key || tkey(v.board, v.no) === key)) loadOffline(v.board, v.no);
    }
  }

  /** The saved threads to list: none on NSFW boards while those are off. */
  function savedShown() {
    return st.saved.list.filter((e) => !M.boardHidden(settings, e.board, boards));
  }

  function savedRail() {
    if (!bridge?.offlineList) return null;
    const list = savedShown();
    return h(
      'section',
      {},
      h('h2', { class: 'rail__heading', text: 'Saved threads' }),
      h(
        'ul',
        { class: 'rail__list' },
        railItem([icon('folder'), h('span', { class: 'rail__label', text: 'All saved threads' }), list.length ? h('span', { class: 'pill', text: String(list.length) }) : null], {
          current: views().some((x) => x?.kind === 'saved'),
          key: 'saved-all',
          onclick: () => goto({ kind: 'saved' }),
        }),
        list.slice(0, SAVED_IN_RAIL).map((e) =>
          railItem([tag(e.board), h('span', { class: 'rail__label', translate: e.title ? 'no' : null, text: e.title || `No. ${e.no}` })], {
            current: views().some((x) => x?.kind === 'offline' && x.board === e.board && x.no === e.no),
            key: `saved-${e.board}-${e.no}`,
            onclick: () => goto({ kind: 'offline', board: e.board, no: e.no }),
            extra: h(
              'button',
              {
                type: 'button',
                class: 'icon-btn icon-btn--sm',
                title: 'Delete the saved copy',
                'aria-label': `Delete the saved copy of ${e.title || `No. ${e.no}`}`,
                'data-key': `saved-delete-${e.board}-${e.no}`,
                onclick: (ev) => deleteSaved(e, ev.currentTarget),
              },
              icon('trash'),
            ),
          }),
        ),
      ),
    );
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

  // --------------------------------------------------- filters and (You)s

  // Marks are worked out once per loaded list and kept until the list, the
  // filters, the hidden posts or the (You)s change.
  const markCache = new WeakMap(); // posts or catalog threads → { key, marks, you }
  function postMarks(board, list) {
    const hit = markCache.get(list);
    if (hit && hit.filters === settings.filters && hit.hidden === settings.hiddenPosts && hit.yous === settings.yous && hit.board === board) return hit;
    const c = {
      board,
      filters: settings.filters,
      hidden: settings.hiddenPosts,
      yous: settings.yous,
      marks: F.markPosts(list, F.compileFilters(settings.filters, board), F.hiddenSet(settings.hiddenPosts, board)),
      you: F.repliesToYou(list, F.youSet(settings.yous, board)),
    };
    markCache.set(list, c);
    return c;
  }

  /** postMarks() plus which posts of a thread are hidden and why, replies
   *  to hidden posts included when Settings says so (hide-model.js): `why`. */
  function threadMarks(board, posts) {
    const c = postMarks(board, posts);
    const replies = settings.hide?.replies !== false;
    if (!c.why || c.whyReplies !== replies) {
      c.whyReplies = replies;
      c.why = hiddenPosts(posts, c.marks, { replies, keep: F.youSet(settings.yous, board) });
    }
    return c;
  }

  // ------------------------------------------------ poster IDs and unread

  const idCache = new WeakMap(); // posts → Map(poster ID → posts with it)
  function idsOf(posts) {
    let c = idCache.get(posts);
    if (!c) idCache.set(posts, (c = idCounts(posts)));
    return c;
  }

  /** Clicking a poster ID highlights that poster's posts; again clears. */
  function toggleIdHl(board, no, id) {
    const key = tkey(board, no);
    const next = toggleIdHighlight(st.idHl.get(key) || null, id);
    if (next) st.idHl.set(key, next);
    else st.idHl.delete(key);
    render();
  }

  /** A thread's unread posts: after what was read, neither hidden (unless
   *  shown anyway) nor the person's own (unread-model.js). */
  function unreadOf(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!posts?.length) return [];
    const { why } = threadMarks(board, posts);
    const skip = new Set([...why.keys()].filter((n) => !st.revealed.has(tkey(board, n))));
    return U.unreadPosts(posts, U.readOf(settings, board, no), { skip, isYou: (n) => C.isYou(settings, board, n) });
  }

  const focusedUnread = () => {
    const v = focused()?.view;
    return v?.kind === 'thread' ? unreadOf(v.board, v.no).length : 0;
  };

  /** Scrolls pane i to its thread's first unread post. */
  function jumpUnread(i = st.focus) {
    const v = st.panes[i]?.view;
    if (v?.kind !== 'thread') return;
    const first = unreadOf(v.board, v.no)[0];
    const el = first && root.querySelector(`[data-pane="${i}"] .thread > [data-no="${first}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
  }

  /** The unread counts drawn outside a full redraw (reading only lowers
   *  them): each thread pane's jump button, the watcher and the title. */
  function showUnread() {
    for (const paneNode of root.querySelectorAll('[data-pane]')) {
      const v = st.panes[Number(paneNode.dataset.pane)]?.view;
      if (v?.kind !== 'thread') continue;
      const n = unreadOf(v.board, v.no).length;
      const btn = paneNode.querySelector('[data-unread-jump]');
      if (btn) btn.disabled = !n;
      const badge = paneNode.querySelector('[data-unread-count]');
      if (badge) {
        badge.hidden = !n;
        badge.textContent = String(n);
      }
    }
    // The rail's counts only go down here (reading never adds unread posts).
    for (const w of settings.watched || []) {
      const railBadge = root.querySelector(`[data-key="${CSS.escape(`watched-${w.board}-${w.no}`)}"] [data-unread-badge]`);
      if (!railBadge) continue;
      const n = unreadOf(w.board, w.no).length;
      if (!n) railBadge.remove();
      else {
        railBadge.textContent = String(n);
        railBadge.setAttribute('aria-label', `${n} unread`);
      }
    }
    setTitle(shownTitle, focusedUnread());
  }

  /** Marks as read what has been on screen of the thread in a pane body:
   *  every post down to the last one whose bottom is in view. Only while
   *  the window has the focus (someone is looking). */
  function trackRead(body) {
    const v = st.panes[Number(body.closest('[data-pane]')?.dataset.pane)]?.view;
    if (v?.kind !== 'thread' || document.visibilityState === 'hidden' || !document.hasFocus()) return;
    const list = body.querySelector('.thread');
    if (!list) return;
    const items = [];
    for (const el of list.children) {
      if (!el.dataset.no) continue;
      items.push({
        no: Number(el.dataset.no),
        get bottom() {
          return el.getBoundingClientRect().bottom;
        },
      });
    }
    const last = U.lastOnScreen(items, body.getBoundingClientRect().bottom);
    const before = U.readOf(settings, v.board, v.no);
    const next = last ? U.markRead(settings, v.board, v.no, last) : settings;
    if (next === settings) return;
    // Stats → You: the posts newly marked read
    const posts = st.threads[tkey(v.board, v.no)]?.posts;
    if (posts) stats.count('read', posts.filter((p) => p.no > before && p.no <= last).length);
    save(next);
    showUnread();
  }

  function trackAllRead() {
    if (closed) return;
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) trackRead(body);
  }

  /** Whether a filter hides a post or thread (from what is loaded). */
  function filterHides(board, no) {
    if (!settings.filters?.length) return false;
    const post =
      st.cats[board]?.threads?.find((t) => t.no === no) ||
      Object.entries(st.threads)
        .filter(([k]) => k.startsWith(`${board}/`))
        .map(([, e]) => e.posts?.find((p) => p.no === no))
        .find(Boolean);
    return Boolean(post) && F.classifyPost(F.compileFilters(settings.filters, board), post) === 'hide';
  }

  function toggleHiddenPost(board, no, what = 'post') {
    const was = F.isHidden(settings, board, no);
    save(F.toggleHidden(settings, board, no), { now: true });
    st.revealed.delete(tkey(board, no));
    const still = was && filterHides(board, no);
    if (what === 'thread') toast(still ? 'Thread unhidden, but a filter still hides it.' : was ? 'Thread shown again' : 'Thread hidden');
    else toast(still ? 'Post unhidden, but a filter still hides it.' : was ? 'Post shown again' : 'Post hidden');
    render();
  }

  function addQuickFilter(board, q) {
    const next = F.addFilter(settings, F.quickFilter(board, q));
    if (next === settings) {
      toast(F.addProblemText(F.addProblem(settings, F.quickFilter(board, q))) || 'That filter is already there.');
      return;
    }
    save(next, { now: true });
    toast(`Filter added for /${board}/. Change it in Settings → Filters.`);
    render();
  }

  /** A post's "…" menu. */
  function postMenu(board, post) {
    const hidden = F.isHidden(settings, board, post.no);
    return [
      { label: hidden ? 'Unhide post' : 'Hide post', onSelect: () => toggleHiddenPost(board, post.no) },
      ...F.quickFilters(post).map((q) => ({ label: q.label, onSelect: () => addQuickFilter(board, q) })),
    ];
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
        const unread = entry?.posts ? unreadOf(w.board, w.no).length : 0;
        const toYou = entry?.posts ? postMarks(w.board, entry.posts).you.size : 0;
        const youBadge = toYou
          ? h('span', { class: 'badge badge--you', title: `Replies to you: ${toYou}`, 'aria-label': `Replies to you: ${toYou}`, text: String(toYou) })
          : null;
        const state = w.dead
          ? h('span', { class: 'pill pill--dead', text: '404' })
          : w.archived
            ? h('span', { class: 'pill', text: 'Archived' })
            : unread
              ? h('span', { class: 'badge', 'data-unread-badge': '', 'aria-label': `${unread} unread`, text: String(unread) })
              : null;
        return railItem([tag(w.board), h('span', { class: 'rail__label', translate: w.title ? 'no' : null, text: w.title || `No. ${w.no}` }), youBadge, state], {
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
          onDeleteMyStats: (opener) => deleteMyStats(opener),
          onChange: (next, { redraw = true, focus = null } = {}) => {
            const moved = (next.files?.savedDir || '') !== savedDir();
            save(next, { now: true });
            stats.poke();
            if (moved) {
              forgetOffline();
              loadSaved();
            }
            if (!redraw) return;
            render();
            if (focus) root.querySelector(`[data-key="${CSS.escape(focus)}"]`)?.focus();
          },
        }),
      );
    } else if (v.kind === 'board') {
      title = [tag(v.board), h('span', { class: 'centre__title-text', translate: titleOf(v.board) ? 'no' : null, text: titleOf(v.board) || 'Catalog' })];
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
          marks: st.cats[v.board]?.threads ? postMarks(v.board, st.cats[v.board].threads).marks : new Map(),
          onHide: (no) => toggleHiddenPost(v.board, no, 'thread'),
          display: settings.display,
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
        h('span', { class: 'centre__title-text', translate: 'no', text: threadName() }),
      ];
      windowTitle = `/${v.board}/ · ${threadName()}`;
      const pm = entry?.posts ? threadMarks(v.board, entry.posts) : null;
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
          onReply: (quote = null, selection = '') => composer.open({ board: v.board, thread: v.no, quote: quote || 0, selection }),
          onGallery: () => gallery(i),
          marks: pm?.marks,
          hidden: pm?.why,
          youReplies: pm?.you,
          revealed: new Set(entry?.posts?.filter((p) => st.revealed.has(tkey(v.board, p.no))).map((p) => p.no)),
          onReveal: (no) => {
            st.revealed.add(tkey(v.board, no));
            render();
          },
          onUnhide: (no) => toggleHiddenPost(v.board, no),
          menuFor: (post) => postMenu(v.board, post),
          quoteMode: () => settings.quotes?.links || 'inline',
          onCrossQuote: (q) => openCross(q, i),
          cross: crossThreads,
          archive: entry?.gone || entry?.posts?.[0]?.archived ? archiveLink(settings.archives, { board: v.board, thread: v.no }) : null,
          ids: entry?.posts
            ? {
                counts: idsOf(entry.posts),
                colour: settings.ids?.colour !== false,
                active: st.idHl.get(tkey(v.board, v.no)) || null,
                onClick: (id) => toggleIdHl(v.board, v.no, id),
              }
            : null,
          unread: entry?.posts
            ? { line: U.lineBefore(entry.posts, st.lines.get(tkey(v.board, v.no))), count: unreadOf(v.board, v.no).length, onJump: () => jumpUnread(i) }
            : null,
          // the catalog only if it is already here: stats never fetch it
          catalog: st.cats[v.board]?.threads ? { threads: st.cats[v.board].threads, at: st.cats[v.board].at } : null,
          sauce: settings.sauce?.engines || [],
          links: postLinks(),
          display: settings.display,
          save:
            bridge?.offlineWriteThread && entry?.posts
              ? {
                  job: st.jobs.get(tkey(v.board, v.no)) || null,
                  saved: O.isSaved(st.saved.list, v.board, v.no),
                  progressKey: tkey(v.board, v.no),
                  onSave: () => saveOffline(v.board, v.no),
                  onDownloadAll: () => downloadAll(v.board, v.no),
                  onCancel: () => cancelJob(v.board, v.no),
                }
              : null,
        }),
      );
    } else if (v.kind === 'saved') {
      title = [h('span', { class: 'centre__title-text', text: 'Saved threads' })];
      windowTitle = 'Saved threads';
      body.append(
        savedListView({
          saved: { ...st.saved, list: savedShown(), hidden: st.saved.list.length - savedShown().length },
          hue: M.boardHue,
          keyPrefix: prefix,
          onOpen: (e) => goto({ kind: 'offline', board: e.board, no: e.no }, i),
          onDelete: (e, opener) => deleteSaved(e, opener),
          onRefresh: () => loadSaved(),
        }),
      );
    } else if (v.kind === 'offline') {
      const saved = st.offline[tkey(v.board, v.no)];
      const listed = st.saved.list.find((e) => e.board === v.board && e.no === v.no);
      const name = saved?.posts?.[0] ? B.threadTitle(saved.posts[0], 70) : listed?.title || `No. ${v.no}`;
      title = [
        h(
          'button',
          { type: 'button', class: 'icon-btn', 'aria-label': 'Back to the saved threads', 'data-key': `${prefix}back-saved`, onclick: () => goto({ kind: 'saved' }, i) },
          icon('arrowLeft'),
        ),
        tag(v.board),
        h('span', { class: 'centre__title-text', translate: 'no', text: name }),
      ];
      windowTitle = `/${v.board}/ · ${name}`;
      const pm = saved?.posts ? threadMarks(v.board, saved.posts) : null;
      body.append(
        threadView({
          board: v.board,
          no: v.no,
          entry: saved,
          bridge: savedFiles(v.board, v.no),
          keyPrefix: prefix,
          intervalSec: intervalMs() / 1000,
          isYou: (no) => C.isYou(settings, v.board, no),
          onRefresh: () => loadOffline(v.board, v.no),
          onGallery: () => gallery(i),
          marks: pm?.marks,
          hidden: pm?.why,
          youReplies: pm?.you,
          revealed: new Set(saved?.posts?.filter((p) => st.revealed.has(tkey(v.board, p.no))).map((p) => p.no)),
          onReveal: (no) => {
            st.revealed.add(tkey(v.board, no));
            render();
          },
          onUnhide: (no) => toggleHiddenPost(v.board, no),
          menuFor: (post) => postMenu(v.board, post),
          quoteMode: () => settings.quotes?.links || 'inline',
          // another thread's quote: nothing is fetched for previews; a click opens it live beside
          onCrossQuote: (q) => openCross(q, i),
          ids: saved?.posts
            ? {
                counts: idsOf(saved.posts),
                colour: settings.ids?.colour !== false,
                active: st.idHl.get(tkey(v.board, v.no)) || null,
                onClick: (id) => toggleIdHl(v.board, v.no, id),
              }
            : null,
          // links open in the browser when clicked; embeds stay off offline
          links: { ...postLinks(), embeds: 'off' },
          display: settings.display,
          offline: { savedAt: saved?.savedAt || listed?.savedAt || 0, onLive: () => goto({ kind: 'thread', board: v.board, no: v.no }, i) },
        }),
      );
    } else if (v.kind === 'stats') {
      title = [h('span', { class: 'centre__title-text', text: 'Stats' })];
      windowTitle = 'Stats';
      body.append(statsBody(i));
    } else {
      title = [h('span', { class: 'centre__title-text', text: 'All boards' })];
      windowTitle = 'All boards';
      body.append(boardListBody(i));
    }
    return { title, body, windowTitle };
  }

  /** The boards the Stats pane lists: the ones followed (or the favourites
   *  while sampling is off) and any with samples; none hidden as NSFW. */
  function statsBoards() {
    const followed = settings.stats?.track ? trackedBoards(false) || [] : M.visibleFavourites(settings, boards);
    const list = [...new Set([...followed, ...Object.keys(stats.boards().boards)])];
    return list.filter((b) => !M.boardHidden(settings, b, boards));
  }

  function statsBody(i) {
    const pane = st.panes[i];
    const prefix = prefixOf(i);
    const view = pane.statsView;
    return statsView({
      view,
      keyPrefix: prefix,
      status: stats.status(),
      isMain,
      now: Date.now(),
      boards: statsBoards(),
      store: stats.boards(),
      mine: stats.mine(),
      mineOn: Boolean(settings.stats?.mine),
      trackOn: Boolean(settings.stats?.track),
      onOpen4stats: bridge?.openExternal
        ? () => Promise.resolve(bridge.openExternal(FOURSTATS_URL)).catch((e) => toast(`Couldn’t open 4stats.io: ${e?.message || e}`))
        : null,
      hue: M.boardHue,
      refreshKeys: B.refreshKeysLabel(),
      onTab: (t) => {
        view.tab = t;
        showStats(i, `${prefix}stats-tab-${t}`);
      },
      onSort: (k) => {
        if (view.sort === k) view.dir = view.dir === 'asc' ? 'desc' : 'asc';
        else {
          view.sort = k;
          view.dir = k === 'board' ? 'asc' : 'desc';
        }
        showStats(i, `${prefix}stats-sort-${k}`);
      },
      onMetric: (m) => {
        view.metric = m;
        showStats(i, `${prefix}stats-metric-${m}`);
      },
      onRefresh: () => refreshPane(i),
      onOpenBoard: (b) => goto({ kind: 'board', board: b }, i),
      onOpenThread: (b, no) => goto({ kind: 'thread', board: b, no }, i),
      onMineToggle: (on) => {
        save({ ...settings, stats: { ...SM.normalizeStatsSettings(settings.stats), mine: on } }, { now: true });
        showStats(i);
      },
      onDeleteMine: (opener) => deleteMyStats(opener),
    });
  }

  /** Redraws the Stats panes' content in place (or pane `only`): nothing
   *  else on the page is touched. Focus and the table's sideways scroll stay. */
  function showStats(only = null, focusKey = null) {
    if (closed) return;
    const active = document.activeElement;
    const keep = focusKey || (root.contains(active) ? active?.dataset?.key : null);
    st.panes.forEach((p, i) => {
      if (p.view?.kind !== 'stats' || (only !== null && only !== i)) return;
      const host = root.querySelector(`[data-pane="${i}"] [data-stats-host]`);
      if (!host) return;
      const x = host.querySelector('.stats-table-wrap')?.scrollLeft || 0;
      const next = statsBody(i);
      host.replaceWith(next);
      const wrap = next.querySelector('.stats-table-wrap');
      if (wrap && x) wrap.scrollLeft = x;
    });
    if (keep) {
      const el = root.querySelector(`[data-key="${CSS.escape(keep)}"]`);
      if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    }
  }

  // New samples and counts come in bursts: one redraw for each.
  let statsTimer = null;
  function scheduleStats() {
    if (statsTimer || closed || !views().some((v) => v?.kind === 'stats')) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      showStats();
    }, 300);
  }

  /** Stats → You: replies to your posts in a thread just loaded (each
   *  counted once, only while counting is on). */
  function countRepliesToYou(board, posts) {
    if (!settings.stats?.mine || !settings.yous?.length) return;
    const you = postMarks(board, posts).you;
    if (!you.size) return;
    for (const p of posts) if (you.has(p.no)) stats.replyToYou(board, p.no, p.time);
  }

  async function deleteMyStats(opener) {
    const ok = await confirmDialog({
      title: 'Delete your stats?',
      text: 'Every count of your own activity kept on this computer is deleted: time, threads, posts and the rest. Board activity stays. This cannot be undone.',
      confirm: 'Delete',
      opener,
    });
    if (!ok || closed) return;
    try {
      await stats.deleteMine();
      toast('Your stats were deleted');
    } catch (e) {
      toast(`Couldn’t delete your stats: ${e?.message || e}`);
    }
    showStats();
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
              h('span', { class: 'rail__label', translate: 'no', text: b.title }),
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

  // Reading: what scrolls into view of a thread is marked read (at most
  // once a frame).
  let shownTitle = '';
  function watchReading(body) {
    if (!body.querySelector('.thread')) return;
    let frame = 0;
    body.addEventListener(
      'scroll',
      () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (body.isConnected) trackRead(body);
        });
      },
      { passive: true },
    );
    trackRead(body);
  }

  function render() {
    if (closed) return;
    if (settings.embeds?.mode === 'off') player.close();
    const active = document.activeElement;
    const focusKey = root.contains(active) ? active?.dataset?.key : null;
    const caret = focusKey && active?.tagName === 'INPUT' && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) st.scroll[body.dataset.scrollKey] = body.scrollTop;
    // Files the person opened (a playing video, a full image) survive the
    // redraw: the same elements move into the new page within this task,
    // so a video keeps playing instead of starting over or closing. Files
    // that opened by themselves (Expand images) are left to the new page,
    // which opens them again only while the settings still say so.
    const openFiles = new Map();
    for (const fig of root.querySelectorAll('.post__file--open:not([data-auto])')) {
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
                  railItem([tag(code), h('span', { class: 'rail__label', translate: 'no', text: titleOf(code) })], {
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
            railItem([icon('chart'), h('span', { text: 'Stats' })], {
              current: shown((x) => x.kind === 'stats'),
              key: 'stats',
              onclick: () => goto({ kind: 'stats' }),
            }),
          ),
        ),
        h('section', {}, h('h2', { class: 'rail__heading', text: 'Watched threads' }), watchedRail()),
        savedRail(),
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
    shownTitle = focusTitle;
    for (const body of root.querySelectorAll('.centre__body[data-scroll-key]')) {
      const y = st.scroll[body.dataset.scrollKey];
      if (y) body.scrollTop = y;
      watchToolsScroll(body);
      watchReading(body);
    }
    setTitle(focusTitle, focusedUnread());
    showJump();
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

  /** Fetches the pane's catalog or thread again now (the queue still keeps
   *  the 10 s per thread rule), or the board list on the board list. */
  function refreshPane(i) {
    const v = st.panes[i]?.view;
    if (v?.kind === 'board') loadCatalog(v.board, true);
    else if (v?.kind === 'thread') loadThread(v.board, v.no);
    else if (v?.kind === 'boards') loadBoardList();
    else if (v?.kind === 'saved') loadSaved();
    else if (v?.kind === 'offline') loadOffline(v.board, v.no);
    else if (v?.kind === 'stats') {
      // one sample of each board listed whose last one is over a minute old
      const list = statsBoards();
      const due = SM.manualDue(list, (b) => SM.lastSampleAt(stats.boards(), b), Date.now());
      if (due.length) stats.sampleNow(list);
      else toast(list.length ? 'Every board here was sampled in the last minute.' : 'No boards to sample yet.');
    }
  }

  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden) return;
      // The browser's reload keys (F5, Ctrl+R, ⌘R, with or without Shift)
      // update the focused pane instead of reloading the whole window, which
      // would drop every pane and any reply being written.
      if (B.isRefreshKey(e)) {
        e.preventDefault();
        if (!e.repeat) refreshPane(st.focus);
        return;
      }
      if (document.querySelector('dialog[open], .gallery')) return;
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return; // already used (a quote preview hid)
        // An open embedded player closes first (focus is usually still on
        // the post's Embed button, or inside the player's frame).
        if (player.isOpen() && !typing() && !document.activeElement?.closest?.('.composer')) {
          player.close();
          return;
        }
        if (st.rail) {
          st.rail = false;
          render();
          return;
        }
        const v = focused().view;
        // A highlighted poster ID clears first; the next Esc goes back.
        if (v.kind === 'thread' && st.idHl.has(tkey(v.board, v.no)) && !typing()) {
          st.idHl.delete(tkey(v.board, v.no));
          render();
          return;
        }
        if (v.kind === 'thread' && !typing() && document.activeElement?.tagName !== 'VIDEO' && !document.activeElement?.closest?.('.composer')) {
          goto({ kind: 'board', board: v.board });
        }
        return;
      }
      if ((e.key === 'u' || e.key === 'U') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing()) {
        if (focused().view.kind === 'thread') {
          e.preventDefault();
          jumpUnread(st.focus);
        }
        return;
      }
      if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey && !typing()) {
        if (focused().view.kind === 'thread' || focused().view.kind === 'offline') {
          e.preventDefault();
          gallery(st.focus);
        }
      }
    },
    { signal: ac.signal },
  );
  window.addEventListener('resize', () => !closed && render(), { signal: ac.signal });
  // Back to the window: what is on screen now counts as read.
  window.addEventListener('focus', trackAllRead, { signal: ac.signal });
  document.addEventListener('visibilitychange', trackAllRead, { signal: ac.signal });

  root.hidden = false;
  for (const v of views()) startLine(v);
  render();
  for (const v of views()) enter(v);
  if (isMain) watchTimer = setTimeout(watchTick, 2000);
  loadSaved();
  return {
    close() {
      closed = true;
      stats.close();
      clearTimeout(statsTimer);
      clearTimeout(watchTimer);
      clearTimeout(saveTimer);
      onSave(settings);
      composer.close();
      player.close();
      for (const t of st.timers.values()) clearTimeout(t);
      st.timers.clear();
      ac.abort();
      root.hidden = true;
      clear(root);
    },
    /** Settings saved in another window. */
    applySettings(next) {
      const light = U.onlyReadMarksDiffer(settings, next);
      const moved = (next.files?.savedDir || '') !== savedDir();
      settings = next;
      stats.poke();
      if (moved) {
        forgetOffline();
        loadSaved();
      }
      // Read marks saved by another window (every bit of scrolling there):
      // only the counts change, so nothing is torn down and redrawn here.
      if (light) showUnread();
      else render();
    },
  };
}
