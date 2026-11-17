// The shell (SCOPE §3.1a): the rail (favourites, boards, watched threads)
// and a workspace of up to five panes, laid out in one to three rows. A pane
// can move to a window of its own, which has its own panes. Every request
// goes through the bridge, and from there through the Rust core's single
// rate-limited queue (shared by every window).

import * as M from './setup-model.js';
import * as B from './browse-model.js';
import { h, clear, icon, toast, restoreScroll, cloverBusy } from './dom.js';
import * as CM from './columns-model.js';
import { scrollerOf, axisOfBox, scrollPos, setScroll, isRestoreAnyAxis, isColumnsBox, revealPost, firstPart, fitColumns } from './columns.js';
import { renderSettings, showSection } from './settings-view.js';
import { catalogView, threadView, updateThreadView, statusLine, statsLine, markRefresh } from './browse.js';
import * as R from './redraw-model.js';
import { createComposer } from './compose.js';
import { galleryItems } from './gallery-model.js';
import { openGallery } from './gallery.js';
import { fileShown } from './setup.js';
import * as F from './filter-model.js';
import { hiddenPosts } from './hide-model.js';
import * as U from './unread-model.js';
import { idCounts, toggleIdHighlight } from './ids-model.js';
import { crossStale } from './quote-model.js';
import { archiveLink } from './archive-model.js';
import { createEmbedPlayer } from './embeds.js';
import * as O from './offline-model.js';
import { savedListView, confirmDialog } from './offline.js';
import { postFlag, waitingMs } from './bridge.js';
import * as SM from './stats-model.js';
import { createStats } from './stats.js';
import { statsView, statusText, FOURSTATS_URL } from './stats-view.js';
import { askView, newAsk, stopAsk } from './ai-view.js';
import { idleDetect, runDetect, runMemory, unloadModel } from './ai-setup-view.js';
import { openLogDialog } from './log-dialog.js';
import { createLibrary } from './library.js';
import { createLibraryView } from './library-view.js';
import { knownFiles, md5Hex } from './library-model.js';
import { commentText } from './render.js';
import { menuAnchorRedrawn } from './post-menu.js';
import * as TG from './tag-model.js';
import { tagChips, editTag, tagPage } from './tag-view.js';
import * as T from './tabs-model.js';
import * as P from './pasta-model.js';
import * as K from './keys-model.js';
import { openPastas, pastasOpen } from './pasta-view.js';

/** A catalog is fetched again on its own after this long (manual Refresh
 *  any time; the queue still keeps ≤ 1 request/s). */
const CATALOG_MAX_AGE_MS = 60_000;
/** Another thread fetched for a quote link (preview or inline copy) is asked
 *  for again after this long; the queue still keeps its 10 s per thread. */
const CROSS_MAX_AGE_MS = 60_000;
/** Other threads kept for quote links (the oldest goes first). */
const CROSS_KEEP = 40;
const NARROW = '(max-width: 900px)';
/** The Rust queue answers a thread at most once per this long (older copies
 *  come back as "too soon to ask again"); fetch/src/client.rs. */
const THREAD_FLOOR_MS = 10_000;
/** After posting a reply, the thread is asked for again this long after
 *  the floor at the earliest (the site's own copy takes a moment), and at
 *  most this many times before the usual interval takes over. */
const SOON_MARGIN_MS = 1_000;
const SOON_MIN_MS = 1_500;
const SOON_TRIES = 4;
/** When the queue holds requests back for a while (bridge.js waitingMs),
 *  the next try comes this long after it says. */
const WAITING_MARGIN_MS = 500;
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
  let tabSeq = 0;
  // A pane holds browser-like tabs (tabs-model.js): `tabs`, and `active`,
  // the one shown. Each tab has its own view, its own back and forward
  // (past / ahead: mouse side buttons, Alt+←/→), its catalog search and
  // sort, its Stats tabs, its Ask, and its scroll (st.scroll, by tab id).
  // `opener`: the tab it was opened from (where the next ones go).
  const newTab = (view, opener = null) => ({ id: ++tabSeq, opener, view, catView: { query: '', sort: 'bump' }, statsView: { tab: 'boards', sort: 'ppm', dir: 'desc', metric: 'time' }, ask: newAsk(), past: [], ahead: [], jump: null });
  // pane.view, .past, .ahead, .catView, .statsView and .ask are the active
  // tab's, so what reads a pane reads what it shows. motion: how its next
  // draws move in (see paneMotion).
  const TAB_FIELDS = ['view', 'past', 'ahead', 'catView', 'statsView', 'ask'];
  const newPane = (entry) => {
    const group = Array.isArray(entry?.tabs) && entry.tabs.length ? entry : { tabs: [entry], active: 0 };
    const pane = { id: ++paneSeq, tabs: group.tabs.map((v) => newTab(v)), active: 0, motion: null };
    pane.active = Math.max(0, Math.min(Number(group.active) || 0, pane.tabs.length - 1));
    for (const k of TAB_FIELDS) {
      Object.defineProperty(pane, k, {
        enumerable: true,
        get() {
          return this.tabs[this.active][k];
        },
        set(x) {
          this.tabs[this.active][k] = x;
        },
      });
    }
    return pane;
  };
  const tabOf = (pane) => pane.tabs[pane.active];
  const st = {
    panes: (initialPanes?.length ? initialPanes : [M.firstDestination(settings, boards)]).slice(0, MAX_PANES).map(newPane),
    focus: 0,
    rail: false, // the narrow-window overlay
    boardList: boards ? 'ok' : 'idle', // idle | loading | ok | error
    boardError: '',
    cats: {}, // board → { status, threads, error, at, freshness }
    threads: {}, // "board/no" → { status, posts, error, at, freshness, gone, fresh }
    timers: new Map(), // "board/no" → timeout, for threads open in a pane
    catRetry: new Map(), // board → timeout: its catalog asked for again once the queue lets it
    scroll: {}, // "tabId:viewKey" → scrollTop
    anchors: new Map(), // "tabId:viewKey" → what was at its top (scrollAnchor), for a tab shown again
    closedTabs: [], // tabs closed, newest last, for Ctrl+Shift+T: { tab, paneId, index }
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
    aiDetect: idleDetect(), // model servers on this computer, for Settings → Assistant (ai-setup-view.js)
    // replies going out (compose.js onPending), shown in their thread:
    // { id, board, thread, post, file, from, state: 'sending' | 'sent' | 'failed', no, message, colour }
    pending: [],
    landed: new Set(), // "board/no" of those now in the thread: they appear without motion
    // "board/no" → quick updates left: a reply was just posted there, so the
    // thread is asked for again as soon as the queue allows (scheduleOpen)
    soon: new Map(),
  };
  const ac = new AbortController();
  let closed = false;
  let watchTimer = null;
  let saveTimer = null;
  // The changes a grouped save still holds (save() with `op`), by what they
  // change: settings from another window take them on (applySettings).
  let pendingOps = new Map();
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
  // ------------------------------------------------------------- library

  // The library (meme gallery): kept files with their source and tags.
  // Each pane showing it keeps its own view node across redraws.
  const libraryViews = new WeakMap(); // pane → createLibraryView(...)
  const library = createLibrary({
    bridge,
    getSettings: () => settings,
    onChange: () => {
      for (const p of st.panes) libraryViews.get(p)?.draw();
      // the "in the library" marks in threads, saved threads and the tag
      // pages that list library files (Library panes draw themselves, above)
      invalidate({ panes: panesWhere((x) => x.kind === 'thread' || x.kind === 'offline' || (x.kind === 'tag' && Boolean(tagOf(x.id)?.library))) });
    },
  });
  // another window wrote the library's index: read again, merged (library.js)
  const stopLibraryEvents = bridge?.onLibraryChanged?.((ev) => library.otherWrote(ev));
  const toLibrary = () => settings.files?.toLibrary !== false && library.available();

  /** What the app knows about files from the threads it holds, for imports. */
  function seenFiles() {
    const threads = [];
    for (const [k, e] of [...Object.entries(st.threads), ...Object.entries(st.offline)]) {
      if (e?.posts?.length) threads.push({ board: k.split('/')[0], posts: e.posts });
    }
    return knownFiles(threads, commentText);
  }

  function libraryBody(i) {
    const pane = st.panes[i];
    let v = libraryViews.get(pane);
    if (!v) {
      // The view lives as long as its pane, which can move (a pane opened
      // or closed before it): where it is gets looked up when it is used,
      // and its keys follow the pane itself, never its place.
      v = createLibraryView({
        library,
        bridge,
        getSettings: () => settings,
        saveSettings: (next) => {
          save(next, { now: true });
          render();
        },
        onOpenPost: ({ board, thread, no }) => {
          const j = st.panes.indexOf(pane);
          if (j < 0) return;
          goto({ kind: 'thread', board, no: thread }, j);
          if (no !== thread) {
            setTimeout(() => {
              const k = st.panes.indexOf(pane);
              const el = k >= 0 && root.querySelector(`[data-pane="${k}"] [data-no="${no}"]`);
              if (el) revealPost(el, { align: 'center' });
            }, 600);
          }
        },
        knownFiles: seenFiles,
        keyPrefix: `lib${pane.id}-`,
      });
      libraryViews.set(pane, v);
    }
    return v.node;
  }

  /** A post's file into the library; says how it went. */
  async function saveToLibrary(board, thread, post) {
    const subject = st.threads[tkey(board, thread)]?.posts?.[0]?.sub || '';
    try {
      const r = await library.addFromPost({ board, thread, post, subject });
      toast(r.status === 'have' ? 'Already in the library.' : `In the library: ${r.entry.rel}`);
      return r;
    } catch (e) {
      toast(`Couldn’t save the file: ${e?.message || e}`);
      return null;
    }
  }

  // ----------------------------------------------------------------- tags

  // What each tag found, day by day (tag-model.js recordFinds): kept on this
  // computer, for Stats → Tags.
  const TAG_STATS_KEY = 'clovereye-tag-stats';
  let tagHistory = (() => {
    try {
      return TG.normalizeHistory(JSON.parse(localStorage.getItem(TAG_STATS_KEY) || '{}'));
    } catch {
      return {};
    }
  })();
  let tagHistoryTimer = 0;
  function writeTagHistory() {
    clearTimeout(tagHistoryTimer);
    tagHistoryTimer = 0;
    try {
      localStorage.setItem(TAG_STATS_KEY, JSON.stringify(tagHistory));
    } catch {
      /* no storage: the counts last until the app closes */
    }
  }
  function noteTagFinds(board, threads) {
    if (!settings.tags?.length || !threads?.length) return;
    tagHistory = TG.recordFinds(tagHistory, settings.tags, board, threads, commentText);
    clearTimeout(tagHistoryTimer);
    tagHistoryTimer = setTimeout(writeTagHistory, 1000);
  }

  /** Stats → Tags: each tag's finds now (loaded catalogs and threads) and
   *  over the last two weeks. */
  function tagStatsRows() {
    const now = Date.now();
    return (settings.tags || []).map((t) => {
      const where = tagBoards(t);
      const loaded = where.filter((b) => st.cats[b]?.threads);
      const found = loaded.flatMap((b) => st.cats[b].threads.filter((th) => TG.matchesPost(t, th, commentText)));
      // posts it hides in the threads open or cached on its boards
      let hidden = 0;
      if (t.mode === 'hide' && t.on) {
        for (const [k, e] of Object.entries(st.threads)) {
          if (!e?.posts || !where.includes(k.split('/')[0])) continue;
          hidden += e.posts.filter((p) => TG.matchesPost(t, p, commentText)).length;
        }
      }
      const { days, total } = TG.dailyFinds(tagHistory, t.id, 14, now);
      return {
        id: t.id,
        name: t.name,
        mode: t.mode,
        on: t.on,
        where: t.board ? `/${t.board}/` : where.map((b) => `/${b}/`).join(' ') || '—',
        loaded: loaded.length,
        boards: where.length,
        now: found.length,
        replies: found.reduce((n, th) => n + (th.replies || 0), 0),
        hidden,
        days,
        total,
      };
    });
  }

  // Tags for lurking (tag-model.js): a board's own, and universal ones that
  // look in every active board. Kept in settings.tags.
  const tagBoards = (t) => (t.board ? [t.board] : TG.activeBoards(settings.favourites, views().filter((x) => x?.kind === 'board' || x?.kind === 'thread').map((x) => x.board)));

  // A catalog's tag labels, worked out once per loaded catalog and kept
  // until the tags change (every tag edit makes a new settings.tags).
  const tagLabels = new WeakMap(); // catalog threads → { all, board, labels, shown }
  function catalogLabels(board, threads, tags) {
    const hit = tagLabels.get(threads);
    if (hit && hit.all === settings.tags && hit.board === board) return hit;
    const labels = tags.length ? TG.labelThreads(tags, threads, commentText) : new Map();
    const c = {
      all: settings.tags,
      board,
      labels,
      // a hide tag's label would only sit on threads it hides
      shown: new Map([...labels].map(([no, l]) => [no, l.filter((t) => t.mode === 'show')]).filter(([, l]) => l.length)),
    };
    tagLabels.set(threads, c);
    return c;
  }

  /** What a catalog needs for its tags: the chips, the labels, the one pressed. */
  function catalogTags(board, pane, i) {
    const tags = TG.tagsFor(settings.tags || [], board);
    const threads = st.cats[board]?.threads;
    const { labels, shown } = threads ? catalogLabels(board, threads, tags) : { labels: new Map(), shown: new Map() };
    // only a show tag narrows the catalog to its threads; hide tags work
    // through the filter marks
    const active = tags.some((t) => t.id === pane.catView.tag && t.mode === 'show') ? pane.catView.tag : '';
    return {
      labels: shown,
      activeTag: active,
      tagBar: tagChips({
        board,
        tags,
        labels,
        active,
        query: pane.catView.query || '',
        onToggle: (t) => {
          save({ ...settings, tags: (settings.tags || []).map((x) => (x.id === t.id ? { ...x, on: !x.on } : x)) }, { now: true });
          toast(t.on ? `Showing what “${t.name}” hid` : `Hiding what “${t.name}” finds`);
          render();
        },
        keyPrefix: st.panes.length > 1 ? `p${i}-` : '',
        onPick: (id) => {
          pane.catView.tag = id;
          renderPaneOf(pane);
        },
        onEdit: (tag) => editTagFlow(tag, board, document.activeElement, tag ? '' : pane.catView.query || ''),
        onPage: (tag) => {
          const j = st.panes.indexOf(pane);
          if (j >= 0) goto({ kind: 'tag', id: tag.id }, j);
        },
      }),
    };
  }

  async function editTagFlow(tag, board = '', opener = document.activeElement, terms = '') {
    // flags to pick from: this board's (from the board list, loaded if need be)
    const here = board || tag?.board || '';
    if (here && !boards && st.boardList !== 'loading') await loadBoardList().catch(() => {});
    const flagList = here ? F.flagChoices(boards, [here], document.documentElement.lang || 'en') : [];
    const r = await editTag({ tag, board, opener, terms, flagList });
    if (!r) return;
    const list = settings.tags || [];
    const next = r.deleted ? list.filter((t) => t.id !== tag.id) : tag ? list.map((t) => (t.id === tag.id ? { ...r, id: tag.id } : t)) : [...list, r];
    save({ ...settings, tags: TG.normalizeTags(next) }, { now: true });
    if (!r.deleted && !tag) {
      // the search that made it gives way to it; a new show tag is pressed
      // at once on the catalog it was made on (a hide tag is already at work)
      const p = focused();
      if (p?.view?.kind === 'board') Object.assign(p.catView, { query: '', tag: r.mode === 'show' ? settings.tags.at(-1)?.id || '' : p.catView.tag });
    }
    for (const b of r.deleted ? [] : tagBoards(r)) loadCatalog(b);
    if (r.library) library.load();
    toast(r.deleted ? 'Tag deleted.' : tag ? 'Tag saved.' : `Tag added: ${r.name}`);
    render();
  }

  // tag pane → the boards it was drawn waiting for (loadCatalog redraws it
  // when they come, even unchanged)
  const tagWaiting = new WeakMap();
  function tagPageBody(t, pane, i) {
    const boardsHere = tagBoards(t);
    tagWaiting.set(pane, new Set(boardsHere.filter((b) => !st.cats[b] || st.cats[b].status === 'loading')));
    // where the pane is when it is clicked (panes come and go)
    const here = () => st.panes.indexOf(pane);
    return tagPage({
      tag: t,
      boards: boardsHere,
      catalog: (b) => st.cats[b],
      bridge,
      files: t.library && library.available() ? library.items().filter((e) => TG.libraryMatches(t, e)) : null,
      fileUrl: (e) => library.fileUrl(e),
      keyPrefix: st.panes.length > 1 ? `p${i}-` : '',
      onOpen: (board, no) => here() >= 0 && goto({ kind: 'thread', board, no }, here()),
      onOpenFile: (e) => {
        if (here() < 0) return;
        goto({ kind: 'library' }, here());
        libraryViews.get(pane)?.select(e.id);
      },
      onEdit: (opener) => editTagFlow(t, t.board, opener),
      onRefresh: () => {
        for (const b of boardsHere) loadCatalog(b, true);
        // at once: "Still loading", then what came (even the same threads)
        renderPaneOf(pane);
      },
    });
  }

  /** The sidebar's edge: drag it to make the sidebar wider or narrower;
   *  ←/→ on it too; a double-click puts the width back. */
  function railGrip() {
    const width = () => M.fitRail(settings.ui?.railWidth);
    const keep = (w) => save({ ...settings, ui: { ...settings.ui, railWidth: M.fitRail(w) } }, { now: true });
    const show = (w, grip) => {
      root.style.setProperty('--rail-w', `${M.fitRail(w)}px`);
      grip?.setAttribute('aria-valuenow', String(M.fitRail(w)));
    };
    return h('div', {
      class: 'rail__grip',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Sidebar width',
      'aria-valuemin': String(M.RAIL_MIN),
      'aria-valuemax': String(M.RAIL_MAX),
      'aria-valuenow': String(width()),
      title: 'Drag to resize the sidebar · double-click: back to its width',
      'data-key': 'rail-grip',
      onpointerdown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const grip = e.currentTarget;
        const x0 = e.clientX;
        const w0 = width();
        let w = w0;
        grip.setPointerCapture?.(e.pointerId);
        root.classList.add('shell--resizing');
        dragGrip = grip;
        const move = (ev) => {
          w = w0 + (ev.clientX - x0);
          show(w, grip);
        };
        // the end of the drag: let go, cancelled, or the capture lost
        // (another grab took the pointer): whichever comes first
        const up = () => {
          grip.removeEventListener('pointermove', move);
          grip.removeEventListener('pointerup', up);
          grip.removeEventListener('pointercancel', up);
          grip.removeEventListener('lostpointercapture', up);
          if (dragGrip !== grip) return;
          dragGrip = null;
          root.classList.remove('shell--resizing');
          if (M.fitRail(w) !== w0) keep(w);
          if (renderAfterDrag) render();
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
        grip.addEventListener('lostpointercapture', up);
      },
      onkeydown: (e) => {
        const step = e.shiftKey ? 48 : 16;
        const w = e.key === 'ArrowLeft' ? width() - step : e.key === 'ArrowRight' ? width() + step : e.key === 'Home' ? M.RAIL_MIN : e.key === 'End' ? M.RAIL_MAX : null;
        if (w === null) return;
        e.preventDefault();
        show(w, e.currentTarget);
        keep(w);
      },
      ondblclick: (e) => {
        show(M.RAIL_DEFAULT, e.currentTarget);
        keep(M.RAIL_DEFAULT);
      },
    });
  }

  function tagsRail() {
    const list = settings.tags || [];
    if (!list.length) return h('p', { class: 'rail__empty', text: 'No tags yet: press + Tag on a catalog.' });
    return h(
      'ul',
      { class: 'rail__list' },
      list.map((t) =>
        railItem([icon(t.board ? 'tag' : 'grid'), h('span', { class: 'rail__label', translate: 'no', text: t.name }), t.board ? tag(t.board) : null], {
          current: views().some((x) => x?.kind === 'tag' && x.id === t.id),
          key: `tagrail-${t.id}`,
          onclick: () => goto({ kind: 'tag', id: t.id }),
        }),
      ),
    );
  }

  function showInLibrary(post) {
    goto({ kind: 'library' });
    libraryViews.get(focused())?.select(md5Hex(post.md5));
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
      const threads = B.catalogThreads(res?.data);
      // the same threads keep the list the marks were worked out for
      st.cats[board] = { status: 'ok', threads: prev.threads && R.samePosts(prev.threads, threads) ? prev.threads : threads, at, freshness: res?.freshness, error: null };
    },
  });

  const tkey = (board, no) => `${board}/${no}`;
  const viewKey = (v) =>
    !v ? '' : v.kind === 'board' ? `b:${v.board}` : v.kind === 'thread' ? `t:${tkey(v.board, v.no)}` : v.kind === 'offline' ? `o:${tkey(v.board, v.no)}` : v.kind === 'tag' ? `g:${v.id}` : v.kind;
  const intervalMs = () => Math.max(M.MIN_WATCH_INTERVAL, settings.watch?.intervalSec || M.MIN_WATCH_INTERVAL) * 1000;
  const views = () => st.panes.map((p) => p.view);
  const openThreads = () => views().filter((v) => v?.kind === 'thread').map((v) => tkey(v.board, v.no));
  const isOpen = (board, no) => openThreads().includes(tkey(board, no));
  const isShown = (v) => views().some((x) => viewKey(x) === viewKey(v));
  const focused = () => st.panes[Math.min(st.focus, st.panes.length - 1)];
  const prefixOf = (i) => (i === 0 ? '' : `p${i}-`);
  /** Panes that are not fading out (closePane): the ones that stay. */
  const livePanes = () => st.panes.filter((p) => p.motion?.kind !== 'closing');

  // ---------------------------------------------------------------- saving

  /** Keeps and stores new settings. Seen-marks come in bursts, so writes
   *  are grouped. `op`: [what it changes, (settings) => settings], the same
   *  change again, for settings another window saves meanwhile. */
  function save(next, { now = false, op = null } = {}) {
    // close() already stored this shell's settings: a late fetch (a watched
    // thread's title) must not write over newer ones
    if (closed) return undefined;
    settings = next;
    clearTimeout(saveTimer);
    saveTimer = null;
    if (now) {
      // built on `settings`, so it holds every grouped change too
      pendingOps = new Map();
      return onSave(next);
    }
    if (op) {
      pendingOps.delete(op[0]); // the newest last, so they replay in order
      pendingOps.set(op[0], op[1]);
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      pendingOps = new Map();
      onSave(settings);
    }, 800);
    return undefined;
  }

  /** Stores a grouped save now (the window is closing). */
  function flushSave() {
    if (!saveTimer) return Promise.resolve();
    clearTimeout(saveTimer);
    saveTimer = null;
    pendingOps = new Map();
    return Promise.resolve(onSave(settings));
  }

  /** Keeps a watched thread's title current. What has been read (its
   *  `seen`) follows the posts that were on screen: trackRead(). Says
   *  whether it changed anything (the rail shows the title). */
  function markSeen(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!posts?.length || !M.isWatched(settings, board, no)) return false;
    const patch = { title: B.threadTitle(posts[0], 120) };
    const next = M.updateWatched(settings, board, no, patch);
    if (next === settings) return false;
    save(next, { op: [`title:${tkey(board, no)}`, (s) => M.updateWatched(s, board, no, patch)] });
    return true;
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
      // older board-flag filters, made to mean what they meant (filter-model);
      // the same list back when there is nothing (left) to do
      const fixed = F.fixBoardFlagFilters(settings.filters, list);
      if (fixed !== settings.filters) {
        save({ ...settings, filters: fixed }, { op: ['flag-filters', (s) => ({ ...s, filters: F.fixBoardFlagFilters(s.filters, list) })] });
      }
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

  // The fetch under way for each catalog and thread ('c:board' / 't:board/no'):
  // a manual update pressed while a poll is out waits for that one (the
  // clover spins until it is back).
  const inFlight = new Map();
  function joinFetch(key, run) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = run();
    // run() marks the entry loading before its first wait: only then is it out
    if (p && (key.startsWith('c:') ? st.cats[key.slice(2)] : st.threads[key.slice(2)])?.status === 'loading') {
      inFlight.set(key, p);
      p.finally(() => inFlight.get(key) === p && inFlight.delete(key));
    }
    return p;
  }

  /** Fetches a board's catalog (unless a fresh copy is here, or `force`).
   *  Resolves when the fetch is back (at once when none was needed). */
  function loadCatalog(board, force = false) {
    return joinFetch(`c:${board}`, () => fetchCatalogNow(board, force));
  }

  async function fetchCatalogNow(board, force) {
    if (!bridge) return;
    const prev = st.cats[board];
    if (prev?.status === 'loading') return;
    if (!force && prev?.status === 'ok' && Date.now() - prev.at < CATALOG_MAX_AGE_MS) return;
    st.cats[board] = { ...prev, status: 'loading' };
    // what is on screen stays: only the status line and Refresh change
    // (after an error, the error box gives way to the loading line)
    if (isShown({ kind: 'board', board })) {
      if (prev?.status === 'error') renderPanes((v) => v.kind === 'board' && v.board === board);
      else patchCatalog(board);
    }
    let quiet = false;
    try {
      const res = await bridge.fetchCatalog(board);
      const threads = B.catalogThreads(res?.data);
      // the same threads keep the list the marks and tags were worked out for
      quiet = Boolean(prev?.threads) && prev.status === 'ok' && R.samePosts(prev.threads, threads);
      st.cats[board] = { status: 'ok', threads: quiet ? prev.threads : threads, at: Date.now(), freshness: res?.freshness, error: null };
      // a catalog loaded anyway is a board activity sample: no extra request
      stats.recordCatalog(board, res?.data);
      if (!quiet) noteTagFinds(board, st.cats[board].threads);
    } catch (e) {
      st.cats[board] = { ...prev, status: 'error', error: e };
    }
    if (closed) return;
    retryCatalogLater(board);
    // Stats (its Tags tab counts what the catalogs find): redrawn in place
    scheduleStats();
    // the board's catalog panes; its threads (their page in the toolbar)
    if (quiet) patchCatalog(board);
    else invalidate({ panes: panesWhere((v) => v.kind === 'board' && v.board === board) });
    patchThreadStats(board);
    // a tag's page gathers several catalogs: redrawn when this one changed,
    // or when it was drawn waiting for it ("Still loading")
    invalidate({
      panes: panesWhere((v) => {
        const t = v.kind === 'tag' && tagOf(v.id);
        return Boolean(t) && tagBoards(t).includes(board);
      }).filter((p) => !quiet || tagWaiting.get(p)?.has(board)),
    });
  }

  /** A catalog the queue would not ask for yet (it is holding requests
   *  back after an error: bridge.js waitingMs) is asked for again once it
   *  will, while a pane still shows it (its board, or a tag on it). Any
   *  other answer drops a retry still waiting. */
  function retryCatalogLater(board) {
    clearTimeout(st.catRetry.get(board));
    st.catRetry.delete(board);
    const entry = st.cats[board];
    const wait = entry?.status === 'error' ? waitingMs(entry.error) : 0;
    if (!wait) return;
    const wanted = () =>
      panesWhere((v) => (v.kind === 'board' && v.board === board) || (v.kind === 'tag' && Boolean(tagOf(v.id)) && tagBoards(tagOf(v.id)).includes(board))).length > 0;
    st.catRetry.set(
      board,
      setTimeout(() => {
        st.catRetry.delete(board);
        if (!closed && st.cats[board]?.status === 'error' && wanted()) loadCatalog(board, true);
      }, wait + WAITING_MARGIN_MS),
    );
  }

  /** The thread panes of a board whose catalog just loaded: their page in
   *  the catalog (the toolbar's stats line), in place; a thread still
   *  loading takes its title from the catalog, so it is redrawn. */
  function patchThreadStats(board) {
    const cat = st.cats[board];
    st.panes.forEach((p, i) => {
      const v = p.view;
      if (v?.kind !== 'thread' || v.board !== board) return;
      const entry = st.threads[tkey(v.board, v.no)];
      if (!entry?.posts) {
        invalidate({ panes: [p] });
        return;
      }
      const tools = root.querySelector(`.workspace__grid section[data-pane="${i}"] [data-thread-tools]`);
      if (!tools) return;
      const key = `${prefixOf(i)}thread-stats`;
      const old = tools.querySelector(`[data-key="${CSS.escape(key)}"]`);
      const next = statsLine(entry.posts, cat?.threads ? { threads: cat.threads, at: cat.at } : null, prefixOf(i));
      if (old && next) old.replaceWith(next);
      else if (old) old.remove();
      else if (next) {
        const hint = tools.querySelector(':scope > .field__hint');
        if (hint) hint.before(next);
        else tools.append(next);
      }
    });
  }

  /** The catalog panes of a board after a fetch that changed nothing else:
   *  the status line and the Refresh button, in place. */
  function patchCatalog(board) {
    const entry = st.cats[board];
    st.panes.forEach((p, i) => {
      if (p.view?.kind !== 'board' || p.view.board !== board) return;
      const node = root.querySelector(`.workspace__grid [data-pane="${i}"]`);
      if (!node) return;
      patchStatus(node, entry, 'catalog');
      const btn = node.querySelector(`[data-key="${CSS.escape(`${prefixOf(i)}catalog-refresh`)}"]`);
      markRefresh(btn, { loading: entry?.status === 'loading' });
    });
  }

  /** The thread panes of "board/no" after a fetch that changed no post:
   *  the status line, the Update button and the "new" marks, in place. */
  function patchThread(key) {
    const entry = st.threads[key];
    st.panes.forEach((p, i) => {
      const v = p.view;
      if (v?.kind !== 'thread' || tkey(v.board, v.no) !== key) return;
      const node = root.querySelector(`.workspace__grid [data-pane="${i}"]`);
      if (!node) return;
      patchStatus(node, entry, 'thread');
      const btn = node.querySelector(`[data-key="${CSS.escape(`${prefixOf(i)}thread-refresh`)}"]`);
      markRefresh(btn, { loading: entry?.status === 'loading', gone: Boolean(entry?.gone) });
      if (!entry?.fresh?.size) for (const el of node.querySelectorAll('.post--new')) el.classList.remove('post--new');
    });
  }

  /** Swaps a pane's status line (browse.js statusLine) for the entry's. */
  function patchStatus(node, entry, what) {
    const old = node.querySelector('[data-status]');
    const next = statusLine(entry, what);
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) node.querySelector('.browse > .browse__tools')?.after(next);
  }

  /** Fetches a thread (through the queue: never more often than every 10 s
   *  per thread). Updates its watch record and, if it is open, schedules
   *  the next update. */
  function loadThread(board, no) {
    return joinFetch(`t:${tkey(board, no)}`, () => fetchThreadNow(board, no));
  }

  async function fetchThreadNow(board, no) {
    if (!bridge || closed) return;
    const key = tkey(board, no);
    const prev = st.threads[key];
    if (prev?.status === 'loading' || prev?.gone) return;
    clearTimeout(st.timers.get(key));
    st.timers.delete(key);
    st.threads[key] = { ...prev, status: 'loading' };
    // The posts on screen stay: only the status line and Update change
    // (after an error, the error box gives way to the loading line; on a
    // first open, goto() has drawn the loading thread already).
    if (isOpen(board, no)) {
      if (prev?.status === 'error') renderPanes(R.showsThread(board, no));
      else patchThread(key);
    }
    // quiet: the same posts as before (a 304, too soon to ask, or nothing
    // new); watch: the watched record changed (the rail shows it)
    let quiet = false;
    let watch = false;
    try {
      const res = await bridge.fetchThread(board, no);
      const posts = Array.isArray(res?.data?.posts) ? res.data.posts : [];
      if (!posts.length) throw new Error('The thread came back empty.');
      // "too soon to ask again" gives the last copy: it is as old as that copy
      const at = res?.freshness === 'throttled' && prev?.at ? prev.at : Date.now();
      quiet = R.quietUpdate(prev, posts);
      if (quiet) {
        // the same posts array: what was worked out for it (marks, IDs, the
        // quote map) still holds
        st.threads[key] = { ...prev, status: 'ok', posts: prev.posts, at, freshness: res?.freshness, error: null, gone: false, fresh: new Set() };
      } else {
        const fresh = prev?.posts ? new Set(B.newPosts(prev.posts, posts).map((p) => p.no)) : new Set();
        // New posts while the thread is open: the "New posts" line moves above
        // them once everything before them was read (unread-model.js).
        if (fresh.size && prev?.posts?.length && st.lines.has(key)) {
          st.lines.set(key, U.lineAfterUpdate(st.lines.get(key), U.readOf(settings, board, no), prev.posts[prev.posts.length - 1].no));
        }
        st.threads[key] = { status: 'ok', posts, at, freshness: res?.freshness, error: null, gone: false, fresh };
        settlePending(board, no);
        countRepliesToYou(board, posts);
      }
      const op = posts[0];
      if (M.isWatched(settings, board, no)) {
        const patch = { archived: Boolean(op.archived || op.closed), title: B.threadTitle(op, 120) };
        const next = M.updateWatched(settings, board, no, patch);
        if (next !== settings) {
          save(next, { op: [`watch:${key}`, (s) => M.updateWatched(s, board, no, patch)] });
          watch = true;
        }
      }
    } catch (e) {
      const gone = String(e?.message || e) === 'not-found';
      // the queue holding requests back: the next try once it lets one go
      const wait = waitingMs(e);
      st.threads[key] = { ...prev, status: 'error', error: e, gone, retryAt: wait ? Date.now() + wait : 0 };
      if (gone && M.isWatched(settings, board, no)) save(M.updateWatched(settings, board, no, { dead: true }), { op: [`dead:${key}`, (s) => M.updateWatched(s, board, no, { dead: true })] });
    }
    if (closed) return;
    const open = isOpen(board, no);
    if (open && markSeen(board, no)) watch = true;
    // Nothing new: the open panes' status lines change, nothing else (a
    // watched thread that is not open changes nothing on screen). New
    // posts (or an error): the panes showing the thread, the sidebar when
    // it is watched (its unread count), an Ask pane reading it (flushDraw),
    // Stats (what hide tags find).
    if (quiet) {
      if (open) patchThread(key);
    } else {
      // new posts at the end are added in place (growPane); anything else
      // redraws the pane
      invalidate({ grown: panesWhere(R.showsThread(board, no)), strips: tabbedWhere(R.showsThread(board, no)) });
      scheduleStats();
    }
    if (watch || (!quiet && M.isWatched(settings, board, no))) invalidate({ rail: true });
    // a reply posted here that the thread now has: back to the usual pace
    if (st.soon.has(key) && !sentIn(board, no)) st.soon.delete(key);
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

  /** A quote link to another thread's post: Ctrl/⌘+clicked (in the
   *  default inline mode, where a plain click opens a copy), a new tab of
   *  the pane, scrolled to the post once shown; else beside (openCross). */
  function crossQuote(q, i, e) {
    const tab = T.clickTab(e);
    if (tab) openTab({ kind: 'thread', board: q.board, no: q.thread }, i, { ...tab, jump: { board: q.board, no: q.thread, post: q.no } });
    else openCross(q, i);
  }

  /** A board link (>>>/g/, >>>/g/search/) clicked in pane `from` (the pane
   *  object: indexes shift while the board list loads): that board's
   *  catalog opens beside it, with the link's search in its search box. */
  async function openBoardLink({ board, search = '' }, from, tab = null) {
    if (!board) return;
    // the board list, loaded once if need be (it failing: the catalog says)
    const known = await boardInfo(board);
    if (closed) return;
    const at = st.panes.indexOf(from);
    if (at < 0 || from.motion?.kind === 'closing') return; // its pane went meanwhile
    if (!known && boards) {
      toast(`There is no board /${board}/.`);
      return;
    }
    // an NSFW board while they are hidden: never opened from a link
    if (known && !M.visibleBoards([known], settings).length) {
      toast(`/${board}/ is an NSFW board: Settings → Content can show NSFW boards.`);
      return;
    }
    // Ctrl/⌘+click or a middle click: a new tab of its pane, searched
    if (tab) {
      openTab({ kind: 'board', board }, at, { ...tab, query: search });
      return;
    }
    const before = st.panes.length;
    openBeside({ kind: 'board', board }, at);
    if (st.panes.length === before) return; // five panes: it went to a new window
    const opened = st.panes[st.focus];
    if (opened?.view?.kind !== 'board' || !search) return;
    opened.catView.query = search;
    renderPaneOf(opened);
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
    revealPost(el, { align: 'center' });
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
      // a reply was just posted here: asked for again once the queue's 10 s
      // per thread have passed since the last copy (a few tries, then the
      // usual interval), so the real post replaces the placeholder soon
      const tries = st.soon.get(key) || 0;
      let delay = intervalMs();
      if (tries > 0) {
        st.soon.set(key, tries - 1);
        delay = Math.min(delay, Math.max(SOON_MIN_MS, (entry.at || 0) + THREAD_FLOOR_MS + SOON_MARGIN_MS - Date.now()));
      }
      // the queue said when it will ask again (bridge.js waitingMs): then,
      // not at the usual interval (no sooner: it would make no request)
      if (entry.status === 'error' && entry.retryAt) delay = Math.max(SOON_MIN_MS, entry.retryAt - Date.now() + WAITING_MARGIN_MS);
      st.timers.set(
        key,
        setTimeout(() => {
          st.timers.delete(key);
          loadThread(board, Number(no));
        }, delay),
      );
    }
  }

  /** Whether a reply of yours in board/no is posted but not in the thread yet. */
  const sentIn = (board, thread) => st.pending.some((p) => p.state === 'sent' && p.board === board && p.thread === thread);

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
      library.load(); // for the "in the library" marks
      const entry = st.threads[tkey(v.board, v.no)];
      // fresh enough: goto() or openBeside() has just drawn it; the rail
      // redraws only when the watched thread's title changed
      if (entry?.posts && Date.now() - entry.at < 10_000) {
        if (markSeen(v.board, v.no)) renderRail();
      } else loadThread(v.board, v.no);
    } else if (v.kind === 'boards' && st.boardList === 'idle') loadBoardList();
    else if (v.kind === 'saved') loadSaved();
    else if (v.kind === 'library') library.load();
    // Settings → Filters lists each board's own flags from the board list
    else if (v.kind === 'settings' && !boards && st.boardList === 'idle') loadBoardList();
    else if (v.kind === 'tag') {
      const t = (settings.tags || []).find((x) => x.id === v.id);
      if (t) {
        for (const b of tagBoards(t)) loadCatalog(b);
        if (t.library) library.load();
      }
    }
    else if (v.kind === 'offline' && st.offline[tkey(v.board, v.no)]?.status !== 'ok') loadOffline(v.board, v.no);
    else if (v.kind === 'stats') {
      stats.reload();
      // sampling every worksafe (or visible) board needs the board list
      if (!boards && st.boardList === 'idle' && settings.stats?.track && settings.stats?.scope !== 'favourites') loadBoardList();
    }
    scheduleOpen();
  }

  const sameView = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const MOTION_MS = { forward: 260, back: 260, enter: 280, closing: 180 };
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Starts a pane's motion: its next draws (the shell redraws often, as a
   *  thread loads) carry the same animation, picked up where it was. */
  function setMotion(pane, kind) {
    pane.motion = kind && !reducedMotion() ? { kind, at: performance.now() } : null;
  }

  /** The motion class and how far along it is, for a pane being drawn. */
  function paneMotion(pane) {
    const m = pane.motion;
    if (!m) return null;
    const done = performance.now() - m.at;
    if (done >= MOTION_MS[m.kind]) {
      if (m.kind !== 'closing') pane.motion = null;
      return m.kind === 'closing' ? { kind: m.kind, delay: -MOTION_MS[m.kind] } : null;
    }
    return { kind: m.kind, delay: -Math.round(done) };
  }

  /** Shows a view in a pane (default: the focused one). `motion`: how it
   *  comes in (forward, or back); `record`: kept in the pane's history. */
  function goto(view, paneIndex = st.focus, { motion = 'forward', record = true } = {}) {
    const i = Math.max(0, Math.min(paneIndex, st.panes.length - 1));
    // a Ctrl/⌘+click (or a middle click) on whatever navigates: a new tab
    // of that pane instead (in front with Shift), as a browser does
    const intent = record ? takeClickIntent() : null;
    if (intent) {
      openTab(view, i, intent);
      return;
    }
    const pane = st.panes[i];
    // the same thread keeps the layout its tab chose (columns-model.js)
    view = CM.carryLayout(pane.view, view);
    const wasRail = st.rail;
    const boardsBefore = activeBoardsKey();
    const changed = !sameView(pane.view, view);
    if (changed) {
      if (record) {
        pane.past.push(pane.view);
        if (pane.past.length > 50) pane.past.shift();
        pane.ahead = [];
      }
      setMotion(pane, motion);
    }
    // Stats → You: a thread opened (not the one already shown, not back
    // and forward, not the panes a window starts with)
    if (changed && record && view?.kind === 'thread') stats.count('threads', 1, view.board);
    pane.view = view;
    showPaneView(i, wasRail, boardsBefore);
  }

  /** Pane i shows something else (goto, or another tab of it): drawn, with
   *  what follows it, and started (enter: its polling; the threads no
   *  longer shown stop theirs). */
  function showPaneView(i, wasRail, boardsBefore) {
    const pane = st.panes[i];
    const view = pane.view;
    st.focus = i;
    st.rail = false;
    startLine(view);
    // The pane on its own, with the sidebar (its "current" marks) and the
    // panes that follow this one: an Ask pane's "This thread", tag pages
    // that look in the boards open. The sidebar's overlay closing, or a
    // narrow window switching panes, is a new layout.
    if (wasRail || !root.querySelector(`.workspace__grid section[data-pane="${i}"]`)) render();
    else {
      renderPane(i);
      renderRail();
      if (activeBoardsKey() !== boardsBefore) {
        renderPanes((v) => v.kind === 'tag' && !tagOf(v.id)?.board);
        scheduleStats(); // its Tags tab counts over tagBoards() too
      }
      refreshAskPanes();
      syncFocus();
    }
    enter(view);
  }

  // ------------------------------------------------------------------ tabs

  // Browser-like tabs in each pane (tabs-model.js). Only a pane's active
  // tab is drawn and polled: views() lists active tabs, so a background
  // tab costs nothing until it is shown (a thread's first fetch aside, for
  // its title, when the catalog does not have it).

  /** Ctrl/⌘ (or the middle button) on the click being handled: set by the
   *  root's click listener (and the middle-click one), read once by goto. */
  let clickIntent = null;
  let forcedIntent = null;
  function takeClickIntent() {
    const x = clickIntent;
    clickIntent = null;
    return x;
  }

  /** Opens `view` in a new tab of pane i: in the background (the pane
   *  goes on showing what it shows; only its tab strip changes) or in
   *  front. `jump`: { board, no, post }, a post to scroll to once shown;
   *  `query`: a catalog's search. Says whether it opened (20 tabs at most). */
  function openTab(view, i = st.focus, { background = true, jump = null, query = '' } = {}) {
    clickIntent = null;
    const pane = st.panes[Math.max(0, Math.min(i, st.panes.length - 1))];
    if (!pane || !view || pane.motion?.kind === 'closing') return false;
    const tab = newTab(view, tabOf(pane).id);
    if (query) tab.catView.query = query;
    if (jump) tab.jump = jump;
    const r = T.addTab({ tabs: pane.tabs, active: pane.active }, tab, { background });
    if (!r) {
      toast(`At most ${T.MAX_TABS} tabs in a pane.`);
      return false;
    }
    if (view.kind === 'thread') stats.count('threads', 1, view.board);
    const at = st.panes.indexOf(pane);
    if (background) {
      pane.tabs = r.tabs;
      pane.active = r.active;
      primeTitle(view);
      patchStrip(pane, tab.id);
      return true;
    }
    const boardsBefore = activeBoardsKey();
    const wasRail = st.rail;
    pane.tabs = r.tabs;
    pane.active = r.active;
    if (pane.motion?.kind !== 'closing') pane.motion = null;
    takeJump(pane);
    showPaneView(at, wasRail, boardsBefore);
    return true;
  }

  /** A thread opened in a background tab is fetched once (through the
   *  queue) for its title in the strip, only when neither it nor its board's
   *  catalog is here (a quote link, a link to a thread the catalog does not
   *  list): tabName reads the catalog's first post otherwise, and a card
   *  Ctrl+clicked N times must not queue N fetches ahead of the pane in
   *  sight. It is not polled meanwhile; it loads when it is shown. */
  function primeTitle(v) {
    if (v?.kind !== 'thread' || st.threads[tkey(v.board, v.no)]?.posts) return;
    if (st.cats[v.board]?.threads?.some((t) => t.no === v.no)) return;
    loadThread(v.board, v.no);
  }

  /** The tab now shown carries a post to scroll to (a quote link opened
   *  in a tab): showJump scrolls there once the thread is drawn. */
  function takeJump(pane) {
    const t = tabOf(pane);
    if (!t.jump) return;
    st.jumpTo = { paneId: pane.id, ...t.jump };
    t.jump = null;
  }

  /** Shows tab `index` of pane i: that pane alone is drawn (its scroll as
   *  the tab left it); the tab left stops polling, the one shown starts. */
  function activateTab(i, index) {
    const pane = st.panes[i];
    if (!pane || !pane.tabs[index] || pane.motion?.kind === 'closing') return;
    if (index === pane.active) {
      if (st.focus !== i) {
        st.focus = i;
        syncFocus();
      }
      return;
    }
    const boardsBefore = activeBoardsKey();
    const wasRail = st.rail;
    pane.active = index;
    pane.motion = null;
    takeJump(pane);
    showPaneView(i, wasRail, boardsBefore);
  }

  /** Closes tab `index` of pane i (default: its active tab). A pane's last
   *  tab closes the pane, when there are others; the last tab of the last
   *  pane stays. Closed tabs come back with Ctrl+Shift+T. */
  function closeTab(i = st.focus, index = st.panes[i]?.active) {
    const pane = st.panes[i];
    if (!pane || !pane.tabs[index] || pane.motion?.kind === 'closing') return;
    if (pane.tabs.length <= 1) {
      if (livePanes().length <= 1) return;
      // the pane went with it: Ctrl+Shift+T makes it again, where it was
      st.closedTabs = T.pushClosed(st.closedTabs, { tab: pane.tabs[0], paneId: pane.id, index: 0, paneAt: i });
      closePane(i);
      return;
    }
    const wasActive = index === pane.active;
    const boardsBefore = activeBoardsKey();
    const wasRail = st.rail;
    const r = T.closeTab({ tabs: pane.tabs, active: pane.active }, index);
    if (!r) return;
    stopAsk(r.closed.ask, bridge);
    st.closedTabs = T.pushClosed(st.closedTabs, { tab: r.closed, paneId: pane.id, index });
    pane.tabs = r.tabs;
    pane.active = r.active;
    if (!wasActive) {
      patchStrip(pane);
      return;
    }
    pane.motion = null;
    takeJump(pane);
    showPaneView(i, wasRail, boardsBefore);
  }

  /** Ctrl+Shift+T: the last tab closed, back where it was, in front, with
   *  its history and scroll: in its pane if it is still here; a pane's last
   *  tab brings its pane back, at its place (five panes already: in the
   *  focused pane, after its tab shown). */
  function reopenTab() {
    const p = T.popClosed(st.closedTabs);
    if (!p) return;
    const { tab, paneId, index, paneAt } = p.entry;
    let i = st.panes.findIndex((x) => x.id === paneId && x.motion?.kind !== 'closing');
    if (i < 0 && Number.isInteger(paneAt) && st.panes.length < MAX_PANES) {
      st.closedTabs = p.stack;
      const pane = newPane(tab.view);
      pane.tabs = [tab];
      pane.active = 0;
      setMotion(pane, 'enter');
      const at = Math.max(0, Math.min(paneAt, st.panes.length));
      st.panes.splice(at, 0, pane);
      st.focus = at;
      st.rail = false;
      takeJump(pane);
      startLine(tab.view);
      render();
      enter(tab.view);
      return;
    }
    let at = index;
    if (i < 0) {
      i = Math.min(st.focus, st.panes.length - 1);
      at = T.insertIndex(st.panes[i].tabs, st.panes[i].active);
    }
    const pane = st.panes[i];
    const r = T.addTab({ tabs: pane.tabs, active: pane.active }, tab, { background: false, at });
    if (!r) {
      toast(`At most ${T.MAX_TABS} tabs in a pane.`);
      return;
    }
    st.closedTabs = p.stack;
    const boardsBefore = activeBoardsKey();
    const wasRail = st.rail;
    pane.tabs = r.tabs;
    pane.active = r.active;
    pane.motion = null;
    showPaneView(i, wasRail, boardsBefore);
  }

  /** Ctrl+T: a new tab in front, on the active tab's board catalog (or
   *  where a window starts). */
  function newTabHere(i = st.focus) {
    const v = st.panes[i]?.view;
    const view = v?.kind === 'board' || v?.kind === 'thread' ? { kind: 'board', board: v.board } : M.firstDestination(settings, boards);
    openTab(view, i, { background: false });
  }

  /** A tab's name in its strip: [board tag, text, whether the text is the
   *  site's own (kept from the page translator)]. */
  function tabName(v) {
    if (v?.kind === 'board') return { board: v.board, text: titleOf(v.board) || T.kindLabel('board'), site: Boolean(titleOf(v.board)) };
    if (v?.kind === 'thread' || v?.kind === 'offline') {
      const op =
        v.kind === 'offline'
          ? st.offline[tkey(v.board, v.no)]?.posts?.[0]
          : st.threads[tkey(v.board, v.no)]?.posts?.[0] || st.cats[v.board]?.threads?.find((t) => t.no === v.no);
      const listed = v.kind === 'offline' ? st.saved.list.find((e) => e.board === v.board && e.no === v.no)?.title : '';
      const text = op ? B.threadTitle(op, 60) : listed || '';
      return { board: v.board, text: text || `No. ${v.no}`, site: Boolean(text) };
    }
    if (v?.kind === 'tag') {
      const t = tagOf(v.id);
      return { board: null, text: t ? t.name : T.kindLabel('tag'), site: Boolean(t) };
    }
    return { board: null, text: T.kindLabel(v?.kind) || T.kindLabel('boards'), site: false };
  }

  /** Pane i's tab strip (two tabs or more), or null. */
  function stripEl(i) {
    const pane = st.panes[i];
    if (!pane || pane.tabs.length < 2) return null;
    const prefix = prefixOf(i);
    const here = () => st.panes.indexOf(pane);
    const strip = h('div', {
      class: 'pane-tabs',
      role: 'tablist',
      'aria-label': 'Tabs in this pane',
      'data-strip': String(pane.id),
      onkeydown: (e) => {
        const btns = [...e.currentTarget.querySelectorAll('[role="tab"]')];
        const at = btns.indexOf(document.activeElement);
        if (at < 0 || e.ctrlKey || e.metaKey || e.altKey) return;
        let to = null;
        if (e.key === 'ArrowRight') to = (at + 1) % btns.length;
        else if (e.key === 'ArrowLeft') to = (at - 1 + btns.length) % btns.length;
        else if (e.key === 'Home') to = 0;
        else if (e.key === 'End') to = btns.length - 1;
        else if (e.key === 'Delete') {
          e.preventDefault();
          const k = here();
          if (k < 0) return;
          closeTab(k, at);
          // the focus goes on to the tab shown now (none left: its pane)
          const node = root.querySelector(`.workspace__grid section[data-pane="${st.panes.indexOf(pane)}"]`);
          if (node && !node.contains(document.activeElement)) (node.querySelector('.pane-tabs [aria-selected="true"]') || node.querySelector('.pane__head button'))?.focus({ preventScroll: true });
          return;
        }
        if (to === null) return;
        e.preventDefault();
        // the focus moves along; Enter or Space shows the tab
        for (const [j, b] of btns.entries()) b.tabIndex = j === to ? 0 : -1;
        btns[to].focus();
        btns[to].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      },
    });
    pane.tabs.forEach((t, j) => {
      const name = tabName(t.view);
      const on = j === pane.active;
      strip.append(
        h(
          'div',
          {
            class: `pane-tab${on ? ' pane-tab--on' : ''}`,
            role: 'presentation',
            'data-tab': String(t.id),
            // the middle button closes a tab (and never starts autoscroll)
            onmousedown: (e) => e.button === 1 && e.preventDefault(),
            onauxclick: (e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              const k = here();
              if (k >= 0) closeTab(k, st.panes[k].tabs.indexOf(t));
            },
          },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: 'pane-tab__btn',
              id: `pane-tab-${t.id}`,
              'aria-selected': String(on),
              // only the tab shown has its panel drawn (markPanel)
              'aria-controls': on ? `pane-panel-${pane.id}` : null,
              'aria-keyshortcuts': 'Delete',
              tabindex: on ? '0' : '-1',
              title: name.text,
              translate: name.site ? 'no' : null,
              'data-key': `${prefix}tab-${t.id}`,
              onclick: () => {
                const k = here();
                if (k >= 0) activateTab(k, st.panes[k].tabs.indexOf(t));
              },
            },
            name.board ? tag(name.board) : null,
            h('span', { class: 'pane-tab__text', text: name.text }),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'pane-tab__close',
              tabindex: '-1',
              // a mouse target: the tablist holds tabs only (Delete on a tab,
              // its aria-keyshortcuts, or Ctrl+W close one from the keyboard)
              'aria-hidden': 'true',
              'aria-label': 'Close tab',
              title: 'Close tab (Ctrl+W)',
              'data-key': `${prefix}tab-close-${t.id}`,
              onclick: () => {
                const k = here();
                if (k >= 0) closeTab(k, st.panes[k].tabs.indexOf(t));
              },
            },
            icon('x'),
          ),
        ),
      );
    });
    return strip;
  }

  /** A pane's tab strip redrawn in place (a tab opened in the background
   *  or closed, a title that came): the pane itself stays. `show`: the id
   *  of a tab to bring into sight in the strip. */
  function patchStrip(pane, show = null) {
    if (closed || renderAfterDrag) return;
    toDraw.strips.delete(pane);
    const i = st.panes.indexOf(pane);
    const node = i >= 0 ? root.querySelector(`.workspace__grid section[data-pane="${i}"]`) : null;
    if (!node) return;
    const old = node.querySelector('.pane-tabs[data-strip]');
    const x = old?.scrollLeft || 0;
    const active = document.activeElement;
    const focusKey = old?.contains(active) ? active.dataset.key : null;
    const next = stripEl(i);
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) node.prepend(next);
    node.classList.toggle('pane--tabbed', Boolean(next));
    markPanel(node, pane, Boolean(next));
    if (!next) return;
    next.scrollLeft = x;
    fitStrip(next, show);
    if (focusKey) {
      const el = next.querySelector(`[data-key="${CSS.escape(focusKey)}"]`) || next.querySelector('[aria-selected="true"]');
      el?.focus({ preventScroll: true });
    }
  }

  /** A pane with tabs: its body is the shown tab's tabpanel (an id the tab's
   *  aria-controls names, labelled by that tab); without tabs, a plain div. */
  function markPanel(node, pane, tabbed) {
    const body = node?.querySelector(':scope > .centre__body');
    if (!body) return;
    if (tabbed) {
      body.setAttribute('role', 'tabpanel');
      body.id = `pane-panel-${pane.id}`;
      body.setAttribute('aria-labelledby', `pane-tab-${tabOf(pane).id}`);
    } else {
      for (const k of ['role', 'id', 'aria-labelledby']) body.removeAttribute(k);
    }
  }

  /** Keeps the shown tab (or tab `show`) in sight in a crowded strip. */
  function fitStrip(strip, show = null) {
    if (strip.scrollWidth <= strip.clientWidth) return;
    const el = show !== null ? strip.querySelector(`[data-tab="${show}"]`) : strip.querySelector('.pane-tab--on');
    if (!el) return;
    const s = strip.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < s.left) strip.scrollLeft -= s.left - r.left;
    else if (r.right > s.right) strip.scrollLeft += r.right - s.right;
  }

  /** Back in a pane's own history (mouse back button, Alt+←); a thread
   *  opened with no history goes back to its catalog. */
  function back(i = st.focus) {
    const pane = st.panes[i];
    if (!pane) return;
    const prev = pane.past.pop();
    const to = prev || (pane.view.kind === 'thread' ? { kind: 'board', board: pane.view.board } : null);
    if (!to) return;
    pane.ahead.push(pane.view);
    goto(to, i, { motion: 'back', record: false });
  }

  /** A thread's ← and Esc: back to its catalog, as back() when that is
   *  where the pane came from. */
  function backToCatalog(i = st.focus) {
    const pane = st.panes[i];
    const v = pane?.view;
    if (v?.kind !== 'thread') return;
    const cat = { kind: 'board', board: v.board };
    if (!pane.past.length || sameView(pane.past[pane.past.length - 1], cat)) return back(i);
    goto(cat, i, { motion: 'back' });
  }

  /** Forward again after going back (mouse forward button, Alt+→). */
  function forward(i = st.focus) {
    const pane = st.panes[i];
    const next = pane?.ahead.pop();
    if (!next) return;
    pane.past.push(pane.view);
    goto(next, i, { motion: 'forward', record: false });
  }

  /** Opens a view in a new pane next to `after`; with five panes already,
   *  in a new window instead. */
  function openBeside(view, after = st.focus) {
    if (view?.kind === 'thread') stats.count('threads', 1, view.board);
    if (st.panes.length >= MAX_PANES) {
      newWindow([view]);
      return;
    }
    const at = Math.min(after + 1, st.panes.length);
    const pane = newPane(view);
    setMotion(pane, 'enter');
    st.panes.splice(at, 0, pane);
    st.focus = at;
    startLine(view);
    render();
    enter(view);
  }

  /** Closes a pane: it fades out first (redraws meanwhile keep it fading),
   *  then goes. */
  function closePane(i) {
    const pane = st.panes[i];
    // the last pane that stays never goes (one fading out does not count)
    if (!pane || pane.motion?.kind === 'closing' || livePanes().length <= 1) return;
    for (const t of pane.tabs) stopAsk(t.ask, bridge); // an answer under way ends with its pane
    if (reducedMotion()) return removePane(pane);
    setMotion(pane, 'closing');
    // what is opened next goes to a pane that stays
    if (focused() === pane) {
      const live = st.panes.map((p, j) => (p.motion?.kind === 'closing' ? -1 : j)).filter((j) => j >= 0);
      st.focus = live.reduce((best, j) => (Math.abs(j - i) < Math.abs(best - i) ? j : best), live[0]);
    }
    render();
    setTimeout(() => removePane(pane), MOTION_MS.closing);
  }

  function removePane(pane) {
    const i = st.panes.indexOf(pane);
    // brought back meanwhile (a goto gave it a new motion): it stays
    if (i < 0 || (pane.motion && pane.motion.kind !== 'closing')) return;
    if (st.panes.length <= 1) {
      pane.motion = null;
      render();
      return;
    }
    st.panes.splice(i, 1);
    st.focus = Math.max(0, Math.min(st.focus >= i ? st.focus - 1 : st.focus, st.panes.length - 1));
    render();
    scheduleOpen();
  }

  /** A new window with these panes: views, or panes with tabs
   *  ({ tabs: [view…], active }); tabs-model.js encodePanes (Settings
   *  stays here; All boards when nothing is left). */
  async function newWindow(entries) {
    if (!bridge?.openWindow) return;
    try {
      await bridge.openWindow(T.encodePanes(entries));
    } catch (e) {
      toast(`Couldn’t open a window: ${e?.message || e}`);
    }
  }

  function popOut(i) {
    // the pane with all its tabs
    const p = st.panes[i];
    newWindow([{ tabs: p.tabs.map((t) => t.view), active: p.active }]);
    if (livePanes().length > 1) closePane(i);
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
    onPending: (e) => pendingEvent(e),
    library,
    paneFor: (board, thread) => {
      const i = st.panes.findIndex((p) => (thread ? p.view?.kind === 'thread' && p.view.no === thread : p.view?.kind === 'board') && p.view.board === board);
      return root.querySelector(`[data-pane="${i >= 0 ? i : st.focus}"]`);
    },
    onPosted: (p) => posted(p),
    onPastas: (anchor, where) => openPastasFor(anchor, where),
  });

  // ------------------------------------------------- pre-written posts (pastas)

  // The pastas popup (pasta-view.js) open from this window: right-click (or
  // the ContextMenu key, Shift+F10) on a Reply or New thread button, or the
  // reply form's own button. A pick opens the form that button would and
  // puts the text in at its caret. Pins and own posts are saved like any
  // setting (an op, so they merge with another window's).
  let pastaPopup = null;
  let pastaFrom = { key: '', at: 0 };
  /** Opens the popup next to `anchor` for the form of `where`
   *  ({ board, thread }: thread 0 is a new thread on the board). */
  function openPastasFor(anchor, where) {
    if (closed || !anchor) return;
    const key = anchor.dataset?.key || '';
    // the ContextMenu key, caught on keydown, may still send a contextmenu
    if (pastaPopup && key && pastaFrom.key === key && performance.now() - pastaFrom.at < 500) return;
    pastaFrom = { key, at: performance.now() };
    const popup = openPastas({
      anchor,
      settings,
      // built on this window's settings now (the popup's copy may be older)
      onSettings: (_next, op) => {
        save(op[1](settings), { op });
        pastaPopup?.update(settings);
      },
      onPick: (text) => {
        composer.open({ board: where.board, thread: where.thread || 0 });
        composer.insertText(text, { board: where.board, thread: where.thread || 0 });
      },
      onClose: () => {
        if (pastaPopup === popup) pastaPopup = null;
        if (anchor.hasAttribute?.('aria-expanded')) anchor.setAttribute('aria-expanded', 'false');
      },
    });
    pastaPopup = popup;
    if (anchor.hasAttribute?.('aria-expanded')) anchor.setAttribute('aria-expanded', 'true');
  }

  /** The R key on the focused pane: a thread's reply form, or a board's new
   *  thread form, as its Reply / New thread button opens it (an open form
   *  takes the focus in its comment). A thread that takes no replies says
   *  why. Says whether the key was used. */
  function replyKey(i) {
    const v = st.panes[i]?.view;
    if (v?.kind === 'board') {
      composer.open({ board: v.board, thread: 0 });
      return true;
    }
    if (v?.kind !== 'thread') return false;
    const why = K.replyBlock(st.threads[tkey(v.board, v.no)]);
    if (why) toast(K.REPLY_BLOCKED[why]);
    else composer.open({ board: v.board, thread: v.no });
    return true;
  }

  /** A manual update of pane i (F5, Ctrl+R, ⌘R): refreshPane, with the
   *  clover of its Update or Refresh button spinning until it is done. */
  function manualRefresh(i) {
    const v = st.panes[i]?.view;
    const name = v?.kind === 'thread' ? 'thread-refresh' : v?.kind === 'board' ? 'catalog-refresh' : '';
    const btn = name ? root.querySelector(`.workspace__grid [data-pane="${i}"] [data-key="${CSS.escape(`${prefixOf(i)}${name}`)}"]`) : null;
    // a thread that is gone is not fetched again: nothing to show
    const gone = v?.kind === 'thread' && st.threads[tkey(v.board, v.no)]?.gone;
    if (btn && !gone) cloverBusy(btn, () => refreshPane(i));
    else refreshPane(i);
  }

  /** A post went out (compose.js). */
  function posted({ board, thread, no }) {
    stats.count('posts', 1);
    // A reply: watch the thread and show it fresh. A new thread: open it.
    if (!M.isWatched(settings, board, thread)) {
      const posts = st.threads[tkey(board, thread)]?.posts;
      const next = M.toggleWatch(settings, { board, no: thread, title: posts?.length ? B.threadTitle(posts[0], 120) : '', seen: no });
      if (next !== settings) {
        save(next, { now: true });
        // its Watch button and the sidebar's Watched list say so at once
        // (the reply form's save drew them before the thread was watched)
        renderRail();
        renderPanes(R.showsThread(board, thread));
      }
    }
    if (isOpen(board, thread)) {
      // Asking at once would most likely get the queue's last copy ("too
      // soon"), without the reply: the next updates come as soon as the
      // queue allows instead (scheduleOpen). One under way finishes first.
      const key = tkey(board, thread);
      st.soon.set(key, SOON_TRIES);
      if (st.threads[key]?.status !== 'loading') {
        clearTimeout(st.timers.get(key));
        st.timers.delete(key);
        scheduleOpen();
      }
    } else goto({ kind: 'thread', board, no: thread });
  }

  /** A reply going out: shown at the end of its thread at once, grey; it
   *  flies in from the reply form; coloured when the site says it is
   *  posted, and replaced by the real post when the thread brings it. A
   *  reply that did not go out says so for a few seconds. */
  function pendingEvent(e) {
    if (closed) return;
    if (e.type === 'start') {
      st.pending = st.pending.filter((p) => !(p.state === 'failed' && p.board === e.board && p.thread === e.thread));
      const p = { ...e, state: 'sending', no: 0, message: '', flyAt: 0 };
      st.pending.push(p);
      // drawn at once: it flies in from the form right after
      renderPanes(R.showsThread(p.board, p.thread));
      p.flyAt = performance.now();
      flyIn(p, 0);
      return;
    }
    const p = st.pending.find((x) => x.id === e.id);
    if (!p) return;
    const here = R.showsThread(p.board, p.thread);
    if (e.type === 'posted') {
      Object.assign(p, { state: 'sent', no: e.no, post: { ...p.post, no: e.no }, colourAt: performance.now() });
      settlePending(p.board, p.thread);
      renderPanes(here);
      return;
    }
    Object.assign(p, { state: 'failed', message: e.message || '' });
    renderPanes(here);
    setTimeout(() => {
      if (!st.pending.includes(p)) return;
      st.pending = st.pending.filter((x) => x !== p);
      invalidate({ panes: panesWhere(here) });
    }, 6000);
  }

  /** Replies the thread now has: the real post takes the grey one's place. */
  function settlePending(board, thread) {
    const posts = st.threads[tkey(board, thread)]?.posts;
    if (!posts || !st.pending.length) return;
    const have = new Set(posts.map((p) => p.no));
    st.pending = st.pending.filter((p) => {
      if (p.board !== board || p.thread !== thread || p.state !== 'sent' || !have.has(p.no)) return true;
      st.landed.add(tkey(board, p.no));
      return false;
    });
    if (!sentIn(board, thread)) st.soon.delete(tkey(board, thread));
  }

  const FLY_MS = 620;
  const COLOUR_MS = 900;

  /** The grey reply comes out of the form's comment box and settles at the
   *  end of the thread (nothing moves with reduced motion). `elapsed`: a
   *  redraw during the flight picks it up where it was. */
  function flyIn(p, elapsed, scope = root) {
    const card = scope.querySelector(`[data-pending="${CSS.escape(p.id)}"]`);
    if (!card) return;
    if (!elapsed) card.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    const from = p.from;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !from || typeof card.animate !== 'function') return;
    const to = card.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const sx = Math.min(2.5, Math.max(0.3, from.width / to.width));
    const sy = Math.min(2.5, Math.max(0.3, from.height / to.height));
    const a = card.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})`, opacity: 0.15 },
        { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)', opacity: 0.6 },
      ],
      { duration: FLY_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
    a.currentTime = elapsed;
  }

  /** The thread redraws itself (updates, the post's own refresh): a reply
   *  still flying in or taking its colours carries on from where it was,
   *  in what was redrawn (`scope`) only. */
  function resumePendingMotion(scope = root) {
    if (!st.pending.length) return;
    const now = performance.now();
    for (const p of st.pending) {
      if (p.flyAt && p.state === 'sending' && now - p.flyAt < FLY_MS) flyIn(p, now - p.flyAt, scope);
      if (p.colourAt && now - p.colourAt < COLOUR_MS) {
        const card = scope.querySelector(`[data-pending="${CSS.escape(p.id)}"]`);
        card?.classList.add('post--colouring');
        card?.style.setProperty('animation-delay', `${-(now - p.colourAt)}ms`);
      }
    }
  }

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
    // Spoilers and work mode as the thread shows them; a file opened from
    // its work-mode line there (keyed by the URL renderPost got) shows too
    const urls = saved ? savedFiles(v.board, v.no) : bridge;
    const items = galleryItems(shownPosts, v.board, urls, settings.display, { isShown: (p) => fileShown(urls.mediaUrl(v.board, p)) });
    openGallery({
      items,
      title: B.threadTitle(entry.posts[0], 80),
      // a saved copy's file is already on disk: Save says where
      onSave: saved
        ? async (it) => O.savedFileOnDisk(entry.folder, entry.posts.find((p) => p.no === it.no))
        : toLibrary()
          ? async (it) => {
              const r = await library.addFromPost({ board: v.board, thread: v.no, post: entry.posts.find((p) => p.no === it.no), subject: entry.posts[0]?.sub || '' });
              return r.status === 'have' ? `${r.entry.rel} (already in the library)` : r.entry.rel;
            }
          : (it) => bridge.saveMedia(it.full, it.name, settings.files?.downloadDir || ''),
      preload: settings.display?.galleryPreload !== false,
      onClose: (no) => {
        const el = root.querySelector(`[data-pane="${paneIndex}"] [data-no="${no}"]`);
        if (el) revealPost(el, { align: 'center' });
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
    const before = st.saved;
    st.saved = { ...st.saved, status: 'loading' };
    try {
      st.saved = { status: 'ok', list: O.savedEntries(await bridge.offlineList(savedDir())), error: '' };
    } catch (e) {
      st.saved = { ...st.saved, status: 'error', error: String(e?.message || e) };
    }
    // The sidebar's list and the saved threads; when the list changed,
    // saved copies (their title) and threads (whether they are saved).
    const sameList = R.samePosts(before.list, st.saved.list);
    if (sameList && before.status === st.saved.status && before.error === st.saved.error) return;
    invalidate({ rail: true, panes: panesWhere((v) => v.kind === 'saved' || (!sameList && (v.kind === 'offline' || v.kind === 'thread'))) });
  }

  async function loadOffline(board, no) {
    const key = tkey(board, no);
    if (!bridge?.offlineRead || st.offline[key]?.status === 'loading') return;
    st.offline[key] = { ...st.offline[key], status: 'loading' };
    renderPanes(R.showsSaved(board, no));
    try {
      const r = await bridge.offlineRead(savedDir(), board, no);
      const posts = Array.isArray(r?.thread?.posts) ? r.thread.posts : [];
      if (!posts.length) throw new Error('The saved thread has no posts.');
      st.offline[key] = { status: 'ok', posts, have: { files: r.files || [], thumbs: r.thumbs || [] }, folder: r.folder || '', savedAt: r.savedAt || 0, error: null };
    } catch (e) {
      const gone = String(e?.message || e) === 'not-saved';
      st.offline[key] = { status: 'error', gone, error: gone ? new Error('This thread is not in the saved threads folder.') : e };
    }
    // (an Ask pane reading it follows: flushDraw)
    invalidate({ panes: panesWhere(R.showsSaved(board, no)) });
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
    renderPanes(R.showsThread(board, no));
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
        invalidate({ panes: panesWhere(R.showsThread(board, no)) });
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
    const lib = toLibrary();
    runJob(board, no, 'all', async () => ({
      jobs: O.downloadJobs(posts, (p) => bridge.mediaUrl(board, p)),
      // into the library, with each file's post; one already there is skipped
      worker: lib
        ? async (j) => {
            const r = await library.addFromPost({ board, thread: no, post: posts.find((p) => p.no === j.no), subject: posts[0]?.sub || '' });
            return { status: r.status === 'have' ? 'skipped' : 'saved', path: r.entry.rel };
          }
        : (j) => bridge.downloadFile(j.url, j.name, dir, j.size),
    }));
  }

  function cancelJob(board, no) {
    const job = st.jobs.get(tkey(board, no));
    if (!job) return;
    job.cancelled = true;
    renderPanes(R.showsThread(board, no));
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

  /** Which of the five drawn patterns a board's card gets (stable). */
  function artOf(code) {
    let n = 0;
    for (const ch of code) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return n % 5;
  }

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

  // Your posts on each board, as a set: asked for per post, per quote link
  // and per unread post, with up to 1000 kept. Every change to the (You)s
  // makes a new list, so the sets follow it; read when used, never kept
  // by a caller.
  let youMemo = { yous: null, by: new Map() };
  function youSetOf(board) {
    if (youMemo.yous !== settings.yous) youMemo = { yous: settings.yous, by: new Map() };
    let s = youMemo.by.get(board);
    if (!s) youMemo.by.set(board, (s = F.youSet(settings.yous, board)));
    return s;
  }
  const isYouOn = (board, no) => youSetOf(board).has(no);

  function postMarks(board, list) {
    const hit = markCache.get(list);
    if (hit && hit.filters === settings.filters && hit.tags === settings.tags && hit.hidden === settings.hiddenPosts && hit.yous === settings.yous && hit.board === board) return hit;
    const byFilter = new Map();
    const marks = F.markPosts(list, F.compileFilters(settings.filters, board), F.hiddenSet(settings.hiddenPosts, board), byFilter);
    // who hid what: post No. → { kind: 'filter' | 'tag', id }, so a hidden
    // post can name it, and delete it
    const by = new Map([...byFilter].map(([no, id]) => [no, { kind: 'filter', id }]));
    // hide tags at work hide like a filter (a line to show it this time)
    for (const [no, id] of TG.hiddenByTagsBy(settings.tags, board, list, commentText)) {
      const m = marks.get(no);
      if (!m || m === 'highlight') {
        marks.set(no, 'hide');
        by.set(no, { kind: 'tag', id });
      }
    }
    const c = {
      board,
      filters: settings.filters,
      tags: settings.tags,
      hidden: settings.hiddenPosts,
      yous: settings.yous,
      marks,
      by,
      you: F.repliesToYou(list, youSetOf(board)),
    };
    markCache.set(list, c);
    return c;
  }

  /** The filter or tag that hid a post: { kind, id, name } or null. */
  function hiderOf(board, list, no) {
    const src = postMarks(board, list).by?.get(no);
    if (!src) return null;
    if (src.kind === 'tag') {
      const t = (settings.tags || []).find((x) => x.id === src.id);
      return t ? { ...src, name: t.name } : null;
    }
    const f = (settings.filters || []).find((x) => x.id === src.id);
    return f ? { ...src, name: `${F.fieldLabel(f.field)}: ${f.pattern}` } : null;
  }

  /** Deletes the filter or tag that hid a post, after asking. */
  async function removeHider(src, opener) {
    if (!src) return;
    const tagOne = src.kind === 'tag';
    const ok = await confirmDialog({
      title: tagOne ? 'Delete this tag?' : 'Delete this filter?',
      text: `“${src.name}” is deleted, and what it hid shows again.`,
      confirm: 'Delete',
      opener,
    });
    if (!ok) return;
    const next = tagOne ? { ...settings, tags: (settings.tags || []).filter((t) => t.id !== src.id) } : F.removeFilter(settings, src.id);
    save(next, { now: true });
    toast(tagOne ? 'Tag deleted.' : 'Filter deleted.');
    render();
  }

  /** postMarks() plus which posts of a thread are hidden and why, replies
   *  to hidden posts included when Settings says so (hide-model.js): `why`. */
  function threadMarks(board, posts) {
    const c = postMarks(board, posts);
    const replies = settings.hide?.replies !== false;
    if (!c.why || c.whyReplies !== replies) {
      c.whyReplies = replies;
      c.why = hiddenPosts(posts, c.marks, { replies, keep: youSetOf(board) });
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
    renderPanes(showsEither(board, no));
  }

  /** A pane showing board/no, live or saved (they share the highlighted
   *  ID and the posts shown anyway). */
  const showsEither = (board, no) => (v) => (v.kind === 'thread' || v.kind === 'offline') && v.board === board && v.no === no;

  /** A hidden post shown this time: in each pane of its thread; a watched
   *  thread's unread count can go up. */
  function reveal(board, thread, no) {
    st.revealed.add(tkey(board, no));
    renderPanes(showsEither(board, thread));
    if (M.isWatched(settings, board, thread)) renderRail();
    showUnread();
  }

  /** A thread's unread posts: after what was read, neither hidden (unless
   *  shown anyway) nor the person's own (unread-model.js). */
  function unreadOf(board, no) {
    const posts = st.threads[tkey(board, no)]?.posts;
    if (!posts?.length) return [];
    const { why } = threadMarks(board, posts);
    const skip = new Set([...why.keys()].filter((n) => !st.revealed.has(tkey(board, n))));
    return U.unreadPosts(posts, U.readOf(settings, board, no), { skip, isYou: (n) => isYouOn(board, n) });
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
    // in columns: its column first (columns.js)
    revealPost(el, { align: 'start', smooth: true });
    el.classList.remove('post--flash');
    void el.offsetWidth;
    el.classList.add('post--flash');
  }

  // What each layout left behind when its thread was switched to the other
  // one: "tabId:viewKey:layout" → { pos, arrived } (CM.placeAfterSwitch).
  const switched = new Map();

  /** Switches pane i's thread between a list and columns (the thread tools'
   *  toggle, L). Only that tab's view changes (kept in its history and the
   *  window's address) and only that pane is drawn. The post first in sight
   *  stays first in sight; switched straight back, the thread is where it
   *  was. */
  function toggleLayout(i = st.focus) {
    const pane = st.panes[i];
    const v = pane?.view;
    if (!v || (v.kind !== 'thread' && v.kind !== 'offline') || pane.motion?.kind === 'closing') return;
    const bodyOf = () => root.querySelector(`.workspace__grid section[data-pane="${i}"] .centre__body[data-scroll-key]`);
    const before = bodyOf();
    const from = CM.layoutOf(v, settings.display);
    const next = CM.flipLayout(v, settings.display);
    const memoKey = (layout) => `${tabOf(pane).id}:${viewKey(v)}:${layout}`;
    const now = before ? { pos: scrollPos(scrollerOf(before)), no: scrollAnchor(before)?.no } : { pos: 0 };
    pane.view = next;
    renderPane(i);
    const body = bodyOf();
    if (!body) return;
    const sc = scrollerOf(body);
    // (straight back: restore() in renderPane put it where it was)
    const place = CM.placeAfterSwitch(now, switched.get(memoKey(next.layout)));
    if (place.no) {
      const el = body.querySelector(`.thread > [data-no="${place.no}"]`);
      if (el) revealPost(el, { align: 'start' });
    } else if (!place.back) setScroll(sc, 0);
    switched.set(memoKey(from), { arrived: scrollPos(sc) });
    trackRead(body);
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
    // in columns: every post up to the last one whose column is wholly in sight
    const sc = scrollerOf(body);
    const axis = axisOfBox(sc);
    const items = [];
    for (const el of list.children) {
      if (!el.dataset.no) continue;
      items.push({
        no: Number(el.dataset.no),
        get bottom() {
          return CM.endOf(el.getBoundingClientRect(), axis);
        },
      });
    }
    const last = U.lastOnScreen(items, CM.endOf(sc.getBoundingClientRect(), axis));
    const before = U.readOf(settings, v.board, v.no);
    const next = last ? U.markRead(settings, v.board, v.no, last) : settings;
    if (next === settings) return;
    // Stats → You: the posts newly marked read
    const posts = st.threads[tkey(v.board, v.no)]?.posts;
    if (posts) stats.count('read', posts.filter((p) => p.no > before && p.no <= last).length);
    save(next, { op: [`read:${tkey(v.board, v.no)}`, (s) => U.markRead(s, v.board, v.no, last)] });
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
    const m = Boolean(post) && F.classifyPost(F.compileFilters(settings.filters, board), post);
    return m === 'hide' || m === 'discard';
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
    const thread = post.resto || post.no;
    const keep =
      post.tim && !post.filedeleted && library.available()
        ? [library.has(post.md5) ? { label: 'Show in the library', onSelect: () => showInLibrary(post) } : { label: 'Save the file to the library', onSelect: () => saveToLibrary(board, thread, post) }]
        : [];
    return [
      ...keep,
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
    renderRail();
    renderPanes(R.showsThread(board, no));
    showUnread();
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
  // -------------------------------------------------------------------- ask

  /** The thread "This thread" means for the Ask pane `i`: the nearest pane
   *  showing a thread (live or saved), left first. */
  function askThread(i) {
    const order = [...st.panes.keys()].filter((j) => j !== i).sort((a, b) => (a < i ? i - a : 100 + a) - (b < i ? i - b : 100 + b));
    for (const j of order) {
      const v = st.panes[j].view;
      if (v?.kind !== 'thread' && v?.kind !== 'offline') continue;
      const e = v.kind === 'offline' ? st.offline[tkey(v.board, v.no)] : st.threads[tkey(v.board, v.no)];
      if (!e?.posts?.length) continue;
      return { kind: v.kind, board: v.board, no: v.no, title: B.threadTitle(e.posts[0], 60) };
    }
    return null;
  }

  /** What a question reads (ai-model.js corpus): loaded threads, catalogs
   *  and saved threads; never a hidden board, a hidden or filtered post. */
  function aiSources(scope, target) {
    const out = [];
    const shownBoard = (b) => !M.boardHidden(settings, b, boards);
    const addThread = (board, no, posts, saved) => {
      if (!posts?.length || !shownBoard(board)) return;
      const c = threadMarks(board, posts);
      out.push({ board, thread: no, posts, hidden: new Set(c.why.keys()), saved });
    };
    if (scope === 'thread' && target) {
      const k = tkey(target.board, target.no);
      const e = target.kind === 'offline' ? st.offline[k] : st.threads[k];
      addThread(target.board, target.no, e?.posts, target.kind === 'offline');
      return out;
    }
    for (const [k, e] of Object.entries(st.threads)) {
      const [board, no] = k.split('/');
      addThread(board, Number(no), e?.posts, false);
    }
    for (const [k, e] of Object.entries(st.offline)) {
      const [board, no] = k.split('/');
      addThread(board, Number(no), e?.posts, true);
    }
    const hiddenOf = (board, list) => new Set([...postMarks(board, list).marks].filter(([, m]) => F.isHiddenMark(m)).map(([no]) => no));
    for (const [board, e] of Object.entries(st.cats)) {
      if (!e?.threads?.length || !shownBoard(board)) continue;
      const hidden = hiddenOf(board, e.threads);
      out.push({ board, catalog: true, posts: e.threads, hidden });
      // the replies a catalog shows under each thread, unless their thread is hidden
      for (const t of e.threads) {
        if (!Array.isArray(t?.last_replies) || !t.last_replies.length || hidden.has(t.no)) continue;
        const why = threadMarks(board, [t, ...t.last_replies]).why;
        out.push({ board, thread: t.no, posts: t.last_replies, hidden: new Set(why.keys()) });
      }
    }
    return out;
  }

  /** A post an answer cites: shown in its thread (open already, or opened
   *  beside the Ask pane), scrolled to and flashed. */
  function showCited(ref, from) {
    const j = st.panes.findIndex((p) => (p.view?.kind === 'thread' || p.view?.kind === 'offline') && p.view.board === ref.board && p.view.no === ref.thread);
    if (j >= 0) {
      st.focus = j;
      if (st.panes[j].view.kind === 'thread') st.jumpTo = { paneId: st.panes[j].id, board: ref.board, no: ref.thread, post: ref.no };
      // the pane is on screen: it only gets the focus and scrolls (a narrow
      // window shows one pane at a time, so it switches)
      if (matchMedia(NARROW).matches || st.rail) render();
      else {
        syncFocus();
        showJump();
      }
      return;
    }
    const saved = st.offline[tkey(ref.board, ref.thread)]?.posts && !st.threads[tkey(ref.board, ref.thread)];
    if (saved) {
      openBeside({ kind: 'offline', board: ref.board, no: ref.thread }, from);
      return;
    }
    openCross({ board: ref.board, thread: ref.thread, no: ref.no }, from);
  }

  /** What the assistant's detection found: in the Settings panes. */
  const redrawSettings = () => renderPanes((v) => v.kind === 'settings');

  /** Frees the model's memory, says what happened, and checks again. */
  async function unloadAi(ai = settings.ai) {
    const r = await unloadModel(bridge, ai);
    if (r.text) toast(r.text);
    runMemory(bridge, st.aiDetect, settings.ai?.kind ? settings.ai : ai, redrawSettings);
  }

  function showLog(opener = null) {
    openLogDialog({ load: () => bridge.diagnosticsText(), save: () => bridge.saveDiagnostics(settings.files?.downloadDir || ''), opener });
  }

  function openAssistantSettings(i) {
    goto({ kind: 'settings' }, i);
    showSection(root.querySelector('#set-ai'));
  }

  /** What the thread view of pane i (a live thread) is drawn with: for
   *  paneContent, and for updateThreadView when only new posts came. */
  function threadOpts(i) {
    const pane = st.panes[i];
    const v = pane.view;
    const prefix = prefixOf(i);
    const entry = st.threads[tkey(v.board, v.no)];
    const pm = entry?.posts ? threadMarks(v.board, entry.posts) : null;
    return {
      board: v.board,
      no: v.no,
      entry,
      bridge,
      keyPrefix: prefix,
      watched: M.isWatched(settings, v.board, v.no),
      intervalSec: intervalMs() / 1000,
      isYou: (no) => isYouOn(v.board, no),
      onRefresh: () => loadThread(v.board, v.no),
      onWatch: () => toggleWatchThread(v.board, v.no),
      onReply: (quote = null, selection = '') => composer.open({ board: v.board, thread: v.no, quote: quote || 0, selection }),
      onPastas: (anchor) => openPastasFor(anchor, { board: v.board, thread: v.no }),
      layout: CM.layoutOf(v, settings.display),
      onLayout: () => toggleLayout(st.panes.indexOf(pane)),
      pending: st.pending.filter((p) => p.board === v.board && p.thread === v.no),
      landed: st.landed,
      onGallery: () => gallery(i),
      marks: pm?.marks,
      hidden: pm?.why,
      hiderOf: (no) => (pm ? hiderOf(v.board, entry.posts, no) : null),
      onRemoveHider: (src, opener) => removeHider(src, opener),
      youReplies: pm?.you,
      revealed: new Set(entry?.posts?.filter((p) => st.revealed.has(tkey(v.board, p.no))).map((p) => p.no)),
      onReveal: (no) => reveal(v.board, v.no, no),
      onUnhide: (no) => toggleHiddenPost(v.board, no),
      menuFor: (post) => postMenu(v.board, post),
      inLibrary: library.available() ? (post) => library.has(post.md5) : null,
      quoteMode: () => settings.quotes?.links || 'inline',
      onCrossQuote: (q, e) => crossQuote(q, i, e),
      onBoardLink: (q, e) => openBoardLink(q, pane, T.clickTab(e)),
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
    };
  }

  function paneContent(i) {
    const pane = st.panes[i];
    const v = pane.view;
    const prefix = prefixOf(i);
    const entry = v.kind === 'thread' ? st.threads[tkey(v.board, v.no)] : null;
    const threadName = () => {
      const op = entry?.posts?.[0] || st.cats[v.board]?.threads?.find((t) => t.no === v.no);
      return op ? B.threadTitle(op, 70) : `No. ${v.no}`;
    };
    // by tab: each tab keeps its own place, also when it comes back closed
    // A thread in columns keeps its own (sideways) place apart from the list's.
    const columns = CM.layoutOf(v, settings.display) === 'columns';
    const body = h('div', { class: columns ? 'centre__body centre__body--columns' : 'centre__body', 'data-scroll-key': `${tabOf(pane).id}:${viewKey(v)}${columns ? ':x' : ''}` });
    let title;
    let windowTitle;
    if (v.kind === 'settings') {
      if (st.aiDetect.status === 'idle') {
        queueMicrotask(() => runDetect(bridge, st.aiDetect, settings.ai?.kind === 'custom' ? settings.ai.port : 0, redrawSettings).then(() => runMemory(bridge, st.aiDetect, settings.ai, redrawSettings)));
      }
      title = [h('span', { class: 'centre__title-text', text: 'Settings' })];
      windowTitle = 'Settings';
      body.append(
        renderSettings({
          settings,
          boards,
          onRunSetup,
          onDeleteMyStats: (opener) => deleteMyStats(opener),
          assistant: {
            detect: st.aiDetect,
            onDetect: (port) => runDetect(bridge, st.aiDetect, port, redrawSettings).then(() => runMemory(bridge, st.aiDetect, settings.ai, redrawSettings)),
            onUnload: (ai) => unloadAi(ai),
          },
          diagnostics: {
            text: () => bridge.diagnosticsText(),
            save: () => bridge.saveDiagnostics(settings.files?.downloadDir || ''),
            show: (opener) => showLog(opener),
          },
          onChange: (next, { redraw = true, focus = null } = {}) => {
            const moved = (next.files?.savedDir || '') !== savedDir();
            save(next, { now: true });
            stats.poke();
            if (moved) {
              forgetOffline();
              loadSaved();
            }
            // another library folder: the old one finishes, the new one is read
            if (library.stale()) library.load();
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
          // 'split': beside; 'tab' / 'tab-front': a new tab (Ctrl/⌘ or middle click)
          onOpen: (no, where) =>
            where === 'split'
              ? openBeside({ kind: 'thread', board: v.board, no }, i)
              : where === 'tab' || where === 'tab-front'
                ? openTab({ kind: 'thread', board: v.board, no }, i, { background: where === 'tab' })
                : goto({ kind: 'thread', board: v.board, no }, i),
          onRefresh: () => loadCatalog(v.board, true),
          onNewThread: () => composer.open({ board: v.board, thread: 0 }),
          onPastas: (anchor) => openPastasFor(anchor, { board: v.board, thread: 0 }),
          onView: (patch) => {
            Object.assign(pane.catView, patch);
            renderPaneOf(pane);
          },
          marks: st.cats[v.board]?.threads ? postMarks(v.board, st.cats[v.board].threads).marks : new Map(),
          hiderOf: (no) => (st.cats[v.board]?.threads ? hiderOf(v.board, st.cats[v.board].threads, no) : null),
          onRemoveHider: (src, opener) => removeHider(src, opener),
          onHide: (no) => toggleHiddenPost(v.board, no, 'thread'),
          display: settings.display,
          ...catalogTags(v.board, pane, i),
        }),
      );
    } else if (v.kind === 'tag') {
      const t = (settings.tags || []).find((x) => x.id === v.id);
      title = [icon(t && !t.board ? 'grid' : 'tag'), h('span', { class: 'centre__title-text', translate: 'no', text: t ? t.name : 'Tag' })];
      windowTitle = t ? t.name : 'Tag';
      body.append(t ? tagPageBody(t, pane, i) : h('p', { class: 'rail__empty', text: 'This tag was deleted.' }));
    } else if (v.kind === 'thread') {
      title = [
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': `Back to the /${v.board}/ catalog`,
            'data-key': `${prefix}back-catalog`,
            onclick: () => backToCatalog(i),
          },
          icon('arrowLeft'),
        ),
        tag(v.board),
        h('span', { class: 'centre__title-text', translate: 'no', text: threadName() }),
      ];
      windowTitle = `/${v.board}/ · ${threadName()}`;
      body.append(threadView(threadOpts(i)));
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
          isYou: (no) => isYouOn(v.board, no),
          onRefresh: () => loadOffline(v.board, v.no),
          onGallery: () => gallery(i),
          layout: CM.layoutOf(v, settings.display),
          onLayout: () => toggleLayout(st.panes.indexOf(pane)),
          marks: pm?.marks,
          hidden: pm?.why,
          hiderOf: (no) => (pm ? hiderOf(v.board, saved.posts, no) : null),
          onRemoveHider: (src, opener) => removeHider(src, opener),
          youReplies: pm?.you,
          revealed: new Set(saved?.posts?.filter((p) => st.revealed.has(tkey(v.board, p.no))).map((p) => p.no)),
          onReveal: (no) => reveal(v.board, v.no, no),
          onUnhide: (no) => toggleHiddenPost(v.board, no),
          menuFor: (post) => postMenu(v.board, post),
          inLibrary: library.available() ? (post) => library.has(post.md5) : null,
          quoteMode: () => settings.quotes?.links || 'inline',
          // another thread's quote: nothing is fetched for previews; a click opens it live beside
          onCrossQuote: (q, e) => crossQuote(q, i, e),
          onBoardLink: (q, e) => openBoardLink(q, pane, T.clickTab(e)),
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
    } else if (v.kind === 'ask') {
      title = [icon('sparkle'), h('span', { class: 'centre__title-text', text: 'Ask' })];
      windowTitle = 'Ask';
      const target = askThread(i);
      const askTab = tabOf(pane);
      askDrawn.set(pane, R.askKey(target));
      body.append(
        askView({
          ask: pane.ask,
          ai: settings.ai,
          bridge,
          keyPrefix: prefix,
          thread: target,
          sources: (scope) => aiSources(scope, target),
          onCite: (ref) => showCited(ref, i),
          onSettings: () => openAssistantSettings(i),
          onUnload: () => unloadAi(),
          onShowLog: (opener) => showLog(opener),
          // the pane showing this Ask tab, wherever it is now (panes move);
          // none while the tab is in the background: the answer is drawn
          // when the tab is shown again (its turn is kept in tab.ask)
          redraw: () => {
            const p = st.panes.find((x) => tabOf(x) === askTab);
            if (p) renderPaneOf(p);
          },
        }),
      );
    } else if (v.kind === 'library') {
      title = [h('span', { class: 'centre__title-text', text: 'Library' })];
      windowTitle = 'Library';
      body.append(libraryBody(i));
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
      tagRows: view.tab === 'tags' ? tagStatsRows() : [],
      onOpenTag: (id) => goto({ kind: 'tag', id }, i),
      onLoadTagBoards: () => {
        for (const t of settings.tags || []) for (const b of tagBoards(t)) loadCatalog(b);
      },
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
      // A card per board with a drawn background (its own hue, one of five
      // patterns and its name as a watermark): nothing is fetched for it.
      return h(
        'ul',
        { class: 'board-list board-list--cards', 'aria-label': 'All boards' },
        list.map((b) => {
          const fav = settings.favourites.includes(b.board);
          return h(
            'li',
            { class: 'board-card', style: { '--hue': M.boardHue(b.board) }, 'data-art': String(artOf(b.board)), 'data-code': b.board, translate: 'no' },
            h(
              'button',
              { type: 'button', class: 'board-card__open', 'data-key': `${prefix}list-${b.board}`, onclick: () => goto({ kind: 'board', board: b.board }, i) },
              tag(b.board),
              h('span', { class: 'board-card__title', translate: 'no', text: b.title }),
            ),
            h(
              'button',
              {
                type: 'button',
                class: `icon-btn star board-card__star${fav ? ' star--on' : ''}`,
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
    paneTitles.set(pane, c.windowTitle);
    drawnWith.set(pane, settings);
    const many = st.panes.length > 1;
    // the last pane that stays has no close button (one fading out does not count)
    const canClose = many && pane.motion?.kind !== 'closing' && livePanes().length > 1;
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
      canClose
        ? h('button', { type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': 'Close this pane', 'data-key': `${prefix}pane-close`, onclick: () => closePane(i) }, icon('x'))
        : null,
    );
    void narrow;
    // opening (forward), going back, a new pane, a pane closing: picked up
    // where it was when the shell redraws during it
    const m = paneMotion(pane);
    const strip = stripEl(i);
    const el = h(
      'section',
      {
        class: `pane${strip ? ' pane--tabbed' : ''}${m ? ` pane--${m.kind}` : ''}`,
        'data-pane': String(i),
        'aria-label': `Pane ${i + 1}: ${c.windowTitle}`,
        'aria-current': many && i === st.focus ? 'true' : null,
        style: m ? { '--motion-delay': `${m.delay}ms` } : null,
      },
      strip,
      head,
      c.body,
    );
    markPanel(el, pane, Boolean(strip));
    return { el, windowTitle: c.windowTitle };
  }

  // ---------------------------------------------------------------- render

  // A redraw is as small as what changed:
  //   render()         everything: the layout, settings, panes opened or closed
  //   renderRail()     the sidebar's lists (never its edge: a drag goes on)
  //   renderPane(i)    one pane (renderPaneOf(pane), renderPanes(pred))
  //   syncFocus()      which pane has the focus, and the titles
  //   invalidate(...)  the same for what arrives by itself (a fetch, a save
  //                    done): gathered, then drawn once in the next frame
  // What each part reads, so a change redraws every part that shows it:
  //   rail     favourites, boards, views() (the "current" marks), the
  //            watched list with each watched thread's posts (unread, (You)),
  //            st.saved, settings.tags, settings.ai.enabled
  //   board    st.cats[board], pane.catView, the marks, the tag labels
  //   thread   st.threads[key]; st.cats[board] (its page in the toolbar, the
  //            title while it loads); st.revealed, st.idHl, st.lines,
  //            st.pending, st.landed, st.jobs, st.saved (saved or not),
  //            the library (In library), settings
  //   offline  st.offline[key], st.saved (its title), st.revealed, st.idHl
  //   ask      pane.ask, settings.ai, the nearest thread pane (askKey)
  //   tag      settings.tags, the catalogs of tagBoards() (which follows
  //            views()), the library
  //   saved    st.saved; boards: boards, favourites; settings: settings
  //   stats    redrawn in place (showStats; its Tags tab reads tagBoards(),
  //            so it follows views() too); library: draws itself

  /** The sidebar's lists (the part that scrolls). */
  function railScrollEl() {
    const favs = M.visibleFavourites(settings, boards);
    const shown = (pred) => views().some((x) => x && pred(x));
    return h(
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
          railItem([icon('images'), h('span', { text: 'Library' })], {
            current: shown((x) => x.kind === 'library'),
            key: 'library',
            onclick: () => goto({ kind: 'library' }),
          }),
          railItem([icon('chart'), h('span', { text: 'Stats' })], {
            current: shown((x) => x.kind === 'stats'),
            key: 'stats',
            onclick: () => goto({ kind: 'stats' }),
          }),
          settings.ai?.enabled
            ? railItem([icon('sparkle'), h('span', { text: 'Ask' })], {
                current: shown((x) => x.kind === 'ask'),
                key: 'ask',
                // beside what is being read, so "This thread" has a thread
                onclick: () => {
                  const j = st.panes.findIndex((p) => p.view?.kind === 'ask');
                  if (j >= 0) {
                    const wasRail = st.rail;
                    st.focus = j;
                    st.rail = false;
                    // on screen already: only the focus moves (a narrow
                    // window shows one pane at a time, so it switches)
                    if (wasRail || matchMedia(NARROW).matches) render();
                    else syncFocus();
                  } else if (['thread', 'offline', 'board'].includes(focused()?.view?.kind)) openBeside({ kind: 'ask' });
                  else goto({ kind: 'ask' });
                },
              })
            : null,
        ),
      ),
      h('section', {}, h('h2', { class: 'rail__heading', text: 'Watched threads' }), watchedRail()),
      savedRail(),
      h('section', {}, h('h2', { class: 'rail__heading', text: 'Tags' }), tagsRail()),
    );
  }

  const settingsShown = () => views().some((x) => x?.kind === 'settings');

  /** The sidebar: its lists, Settings at its foot, and its edge. */
  function railEl(narrow, railHidden) {
    const rail = h(
      'nav',
      { class: 'rail', 'aria-label': 'Boards and watcher' },
      railScrollEl(),
      h(
        'div',
        { class: 'rail__foot' },
        h(
          'button',
          {
            type: 'button',
            class: 'rail__item',
            'aria-current': settingsShown() ? 'page' : null,
            'data-key': 'settings',
            onclick: () => goto({ kind: 'settings' }),
          },
          icon('settings'),
          h('span', { text: 'Settings' }),
        ),
      ),
    );
    if (!narrow && !railHidden) rail.append(railGrip());
    return rail;
  }

  /** The workspace's bar: the sidebar's button, the focused pane's title,
   *  the rows, a new pane, a new window. */
  function headEl(narrow, focusTitle) {
    const railHidden = Boolean(settings.ui?.railHidden);
    const rows = settings.ui?.rows || 1;
    return h(
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
            const board = v.kind === 'board' || v.kind === 'thread' ? v.board : M.visibleFavourites(settings, boards)[0];
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
  }

  /** A narrow window's tabs, one per pane (only the focused one is shown). */
  function tabsEl(narrow, built) {
    if (!narrow || st.panes.length < 2) return null;
    return h(
      'div',
      { class: 'workspace__tabs', role: 'tablist', 'aria-label': 'Panes' },
      built.map((b, i) =>
        h('button', {
          type: 'button',
          role: 'tab',
          class: 'workspace__tab',
          'aria-selected': String(i === st.focus),
          'data-key': `pane-tab-${i}`,
          'data-title': b.windowTitle,
          onclick: () => {
            st.focus = i;
            render();
          },
          text: b.windowTitle,
        }),
      ),
    );
  }

  /** Where a pane body was scrolled to, as what is at its top: a thread's
   *  first post in sight (by its No.), a catalog's first card in sight (by
   *  its place), and how far its top is from the body's. The same pixels
   *  are not the same place in a fresh page: a thumbnail not loaded yet
   *  has its given size, and a catalog's cards out of sight only their
   *  estimated one (app.css content-visibility). */
  //  In columns (columns.js) the same along the other axis: the first
  //  post whose column is in sight, and how far its first part's column
  //  is from the box's left edge.
  function scrollAnchor(body) {
    const sc = scrollerOf(body);
    if (!scrollPos(sc)) return null;
    const axis = axisOfBox(sc);
    const thread = body.querySelector('.thread');
    const items = thread ? thread.querySelectorAll(':scope > [data-no]') : body.querySelectorAll('.catalog > .catalog__item');
    if (!items.length) return null;
    const start = CM.startOf(sc.getBoundingClientRect(), axis);
    // they go down (or along the columns) in order: the first one whose
    // end is in sight
    const at = CM.firstInView(items.length, (k) => CM.endOf(items[k].getBoundingClientRect(), axis), start);
    if (at < 0) return null;
    const offset = CM.startOf(firstPart(items[at]), axis) - start;
    return thread ? { no: items[at].dataset.no, offset, axis } : { index: at, offset, axis };
  }

  /** Puts what an anchor stands for back where it was in `body`, along the
   *  axis it was taken on (a list's anchor means nothing to columns). */
  function keepAnchor(body, a) {
    const sc = scrollerOf(body);
    const axis = axisOfBox(sc);
    if (!a || (a.axis || 'y') !== axis) return;
    const el = anchorEl(body, a);
    if (!el) return;
    const d = CM.anchorShift(CM.startOf(firstPart(el), axis), CM.startOf(sc.getBoundingClientRect(), axis), a.offset);
    if (d) setScroll(sc, scrollPos(sc) + d);
  }

  /** The element an anchor (scrollAnchor) stands for in a fresh body. */
  function anchorEl(body, a) {
    if (a.no !== undefined) return body.querySelector(`.thread > [data-no="${CSS.escape(a.no)}"]`);
    const items = body.querySelectorAll('.catalog > .catalog__item');
    return items[Math.min(a.index, items.length - 1)] || null;
  }

  /** What a redraw of `scope` (the whole shell, a pane, the sidebar's
   *  lists) keeps: the focus and caret, where each pane body and the
   *  sidebar were scrolled to, and the files the person opened. */
  function capture(scope) {
    const active = document.activeElement;
    const focusKey = scope.contains(active) ? active?.dataset?.key || null : null;
    const caret = focusKey && /^(INPUT|TEXTAREA)$/.test(active.tagName) && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const anchors = new Map();
    for (const body of scope.querySelectorAll('.centre__body[data-scroll-key]')) {
      st.scroll[body.dataset.scrollKey] = scrollPos(scrollerOf(body));
      const a = scrollAnchor(body);
      if (a) anchors.set(body.dataset.scrollKey, a);
      // kept for a tab shown again later (another tab of the pane drawn now)
      if (a) st.anchors.set(body.dataset.scrollKey, a);
      else st.anchors.delete(body.dataset.scrollKey);
    }
    // tab strips keep their sideways scroll
    const strips = new Map();
    for (const s of scope.querySelectorAll('.pane-tabs[data-strip]')) strips.set(s.dataset.strip, s.scrollLeft);
    // the sidebar keeps its place too (a long watched list)
    const railNode = scope.classList?.contains('rail__scroll') ? scope : scope.querySelector('.rail__scroll');
    const railY = railNode?.scrollTop || 0;
    // Files the person opened (a playing video, a full image) survive the
    // redraw: the same elements move into the new page within this task,
    // so a video keeps playing instead of starting over or closing. Files
    // that opened by themselves (Expand images) are left to the new page,
    // which opens them again only while the settings still say so.
    const openFiles = new Map();
    for (const fig of scope.querySelectorAll('.post__file--open:not([data-auto])')) {
      const post = fig.closest('.post');
      if (post?.id) openFiles.set(post.id, fig);
    }
    return { focusKey, caret, anchors, railY, openFiles, strips };
  }

  /** The other half of capture(), on what was drawn in its place: opened
   *  files back, each body scrolled back (and watched again). */
  function restore(scope, saved) {
    for (const [id, fig] of saved.openFiles) {
      const fresh = scope.querySelector(`#${CSS.escape(id)} .post__file`);
      if (fresh) fresh.replaceWith(fig);
    }
    for (const body of scope.querySelectorAll('.centre__body[data-scroll-key]')) {
      const y = st.scroll[body.dataset.scrollKey];
      const a = y ? saved.anchors.get(body.dataset.scrollKey) || st.anchors.get(body.dataset.scrollKey) : null;
      // A fresh catalog's cards above the one in sight are laid out at
      // their real size while it is put back, and for its first frames
      // (then each keeps that size out of sight): estimates would move it.
      if (a && a.index !== undefined) {
        body.classList.add('is-placing');
        requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('is-placing')));
      }
      const sc = scrollerOf(body);
      // columns: their media fit a column's height before anything is measured
      fitColumns(sc);
      if (y) setScroll(sc, y);
      keepAnchor(body, a);
      watchToolsScroll(body);
      watchReading(body);
    }
    for (const s of scope.querySelectorAll('.pane-tabs[data-strip]')) {
      const x = saved.strips?.get(s.dataset.strip);
      if (x) s.scrollLeft = x;
      fitStrip(s);
    }
  }

  /** The focus (and the caret in a text box) back on the same control. */
  // A redraw putting the focus back is not the person moving to that pane
  // (opening a pane beside from a catalog card leaves the new pane focused).
  let refocusing = false;
  function restoreFocus(scope, saved) {
    if (!saved.focusKey) return;
    const el = scope.querySelector(`[data-key="${CSS.escape(saved.focusKey)}"]`);
    refocusing = true;
    try {
      el?.focus({ preventScroll: true });
    } finally {
      refocusing = false;
    }
    if (el && saved.caret && typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(saved.caret[0], saved.caret[1]);
      } catch {
        /* a control that has no caret */
      }
    }
  }

  // A thread's control bar: tucked away while scrolling down, back when
  // scrolling up or at the end. Remembered per pane across redraws (the
  // thread redraws itself every few seconds).
  const tucked = new Map(); // scroll key → true
  function watchToolsScroll(body) {
    const bar = body.querySelector('[data-thread-tools]');
    if (!bar) return;
    const k = body.dataset.scrollKey;
    // In columns the body does not scroll and the bar stays: tucking it
    // away would give the columns more height, and move every post.
    if (isColumnsBox(scrollerOf(body))) return;
    bar.classList.toggle('is-tucked', Boolean(tucked.get(k)));
    let last = body.scrollTop;
    body.addEventListener(
      'scroll',
      (e) => {
        // put back where it was by a redraw: nobody scrolled
        if (isRestoreAnyAxis(e)) {
          last = body.scrollTop;
          return;
        }
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

  let shownTitle = '';
  const paneTitles = new WeakMap(); // pane → the title it was last drawn with
  const drawnWith = new WeakMap(); // pane → the settings it was last drawn with (growPane)

  /** The focus moved to another pane, or a pane was redrawn on its own:
   *  the pane marker, the workspace title, the window title, and a narrow
   *  window's tabs. */
  function syncFocus() {
    if (closed) return;
    const f = Math.min(st.focus, st.panes.length - 1);
    const many = st.panes.length > 1;
    for (const node of root.querySelectorAll('.workspace__grid section[data-pane]')) {
      if (many && Number(node.dataset.pane) === f) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
    for (const tab of root.querySelectorAll('.workspace__tab[data-key^="pane-tab-"]')) {
      const k = Number(tab.dataset.key.slice('pane-tab-'.length));
      tab.setAttribute('aria-selected', String(k === f));
      const t = paneTitles.get(st.panes[k]);
      if (t !== undefined && tab.dataset.title !== t) {
        tab.dataset.title = t;
        tab.textContent = t;
      }
    }
    const title = paneTitles.get(st.panes[f]);
    if (title !== undefined && title !== shownTitle) {
      shownTitle = title;
      const h1 = root.querySelector('.workspace__title');
      if (h1) h1.textContent = title;
    }
    setTitle(shownTitle, focusedUnread());
  }

  // Reading: what scrolls into view of a thread is marked read (at most
  // once a frame).
  function watchReading(body) {
    if (!body.querySelector('.thread')) return;
    let frame = 0;
    // a thread in columns scrolls itself, sideways
    scrollerOf(body).addEventListener(
      'scroll',
      (e) => {
        // a redraw putting it back: what is on screen was marked just now
        if (frame || isRestoreAnyAxis(e)) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (body.isConnected) trackRead(body);
        });
      },
      { passive: true },
    );
    trackRead(body);
  }

  /** Redraws pane i alone; the other panes and the sidebar stay as they
   *  are (their scroll, their focus, a video playing, an open menu). A
   *  pane not on screen (a narrow window shows one) is drawn when it is. */
  function renderPane(i) {
    // While a full redraw waits for a sidebar drag (render), the sections may
    // still carry their old numbers: that redraw draws every pane anyway.
    if (closed || renderAfterDrag) return;
    const pane = st.panes[i];
    if (!pane) return;
    toDraw.panes.delete(pane);
    toDraw.grown.delete(pane);
    toDraw.strips.delete(pane);
    const old = root.querySelector(`.workspace__grid section[data-pane="${i}"]`);
    if (!old) {
      pane.stale = true;
      return;
    }
    const saved = capture(old);
    const { el } = paneEl(i, matchMedia(NARROW).matches);
    old.replaceWith(el);
    pane.stale = false;
    restore(el, saved);
    syncFocus();
    showJump();
    resumePendingMotion(el);
    restoreFocus(el, saved);
    keepDialogOpeners(el);
    // an open "…" menu stays (it is on the page) and follows its new button
    menuAnchorRedrawn();
  }

  /** A dialog open over the shell (the 18+ question, Skip setup: setup.js
   *  openDialog) gives the focus back to the control that opened it when it
   *  closes. A redraw under the dialog (the assistant's detection ending in
   *  Settings) draws that control anew: the dialog gets the new one, found
   *  by its data-key, so the focus does not fall back to the page. */
  function keepDialogOpeners(scope) {
    for (const d of document.querySelectorAll('dialog[open]')) {
      const back = d._returnFocus;
      const key = back?.dataset?.key;
      if (!key || back.isConnected) continue;
      const now = scope.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (now) d._returnFocus = now;
    }
  }

  /** A thread pane whose thread only gained posts at the end: they are
   *  added in place (browse.js updateThreadView), which costs a few ms
   *  where a redraw of a long thread costs hundreds (and its layout). False
   *  when the pane has to be redrawn instead: settings changed beyond the
   *  read marks, the watched list and the pre-written posts, or the view is
   *  not sure. */
  function growPane(pane) {
    const i = st.panes.indexOf(pane);
    // a full redraw waits for a sidebar drag: the sections' numbers may be stale
    if (i < 0 || closed || renderAfterDrag) return true;
    if (pane.view?.kind !== 'thread' || pane.stale) return false;
    const node = root.querySelector(`.workspace__grid section[data-pane="${i}"]`);
    if (!node) {
      pane.stale = true;
      return true;
    }
    const drawn = drawnWith.get(pane);
    if (drawn !== settings && !M.onlyWatchedOrPastasDiffer(drawn, settings)) return false;
    const view = node.querySelector('.centre__body > .browse');
    if (!view) return false;
    const body = view.parentElement;
    const a = scrollAnchor(body); // null at the start: nothing to keep
    // The view puts the focus back on a reply link or a control it drew
    // again: not the person moving to this pane (see restoreFocus).
    let grew;
    refocusing = true;
    try {
      grew = updateThreadView(view, threadOpts(i));
    } finally {
      refocusing = false;
    }
    if (!grew) return false;
    // Backlink rows, reopened quote copies or the "New posts" line above the
    // post in sight move it (WebKitGTK has no CSS scroll anchoring); in
    // columns they push it down its column, or into the next one.
    fitColumns(scrollerOf(body));
    keepAnchor(body, a);
    drawnWith.set(pane, settings);
    trackRead(body);
    showJump();
    return true;
  }

  /** Redraws `pane` wherever it is now (it may have moved, or gone). */
  function renderPaneOf(pane) {
    const i = st.panes.indexOf(pane);
    if (i >= 0) renderPane(i);
  }

  /** Redraws each pane whose view matches `pred(view)`. */
  function renderPanes(pred) {
    for (const i of R.paneIndexes(views(), pred)) renderPane(i);
  }

  /** The panes whose view matches `pred(view)`. */
  const panesWhere = (pred) => st.panes.filter((p) => p.view && pred(p.view));
  /** The panes with a background tab whose view matches `pred(view)`: their
   *  tab strip names it (R.backgroundTabs). */
  const tabbedWhere = (pred) => st.panes.filter((p) => R.backgroundTabs(p.tabs, p.active, pred).length > 0);

  /** Redraws the sidebar's lists. Its edge (and a drag on it) and its foot
   *  stay; the Settings button's marker follows. */
  function renderRail() {
    if (closed) return;
    toDraw.rail = false;
    const old = root.querySelector(':scope > nav.rail > .rail__scroll');
    if (!old) return;
    const saved = capture(old);
    const next = railScrollEl();
    old.replaceWith(next);
    if (saved.railY) restoreScroll(next, saved.railY);
    restoreFocus(next, saved);
    const foot = root.querySelector(':scope > nav.rail [data-key="settings"]');
    if (settingsShown()) foot?.setAttribute('aria-current', 'page');
    else foot?.removeAttribute('aria-current');
  }

  // What a fetch (or a save, a library change) brought is drawn once, in
  // the next frame: several arrivals together are one redraw, and a window
  // nobody can see (hidden, minimised) waits until it is seen. What the
  // person does is drawn at once instead (code right after it reads the
  // page). A full render() drops what is waiting.
  // `grown`: thread panes whose thread only got new posts (growPane);
  // `strips`: panes whose tab strip changed alone (a background tab's title).
  let toDraw = { rail: false, panes: new Set(), grown: new Set(), strips: new Set() };
  let drawFrame = 0;
  function invalidate({ rail = false, panes = [], grown = [], strips = [] } = {}) {
    if (closed) return;
    if (rail) toDraw.rail = true;
    for (const p of panes) toDraw.panes.add(p);
    for (const p of grown) toDraw.grown.add(p);
    for (const p of strips) toDraw.strips.add(p);
    if (!drawFrame && (toDraw.rail || toDraw.panes.size || toDraw.grown.size || toDraw.strips.size)) drawFrame = requestAnimationFrame(flushDraw);
    // A hidden or minimised window gets no frames: its title (the taskbar's
    // "(3) …", the focused thread's unread count) follows at once all the
    // same. It touches no pane.
    if (document.visibilityState === 'hidden') setTitle(shownTitle, focusedUnread());
  }
  function flushDraw() {
    drawFrame = 0;
    if (closed) return;
    const d = toDraw;
    toDraw = { rail: false, panes: new Set(), grown: new Set(), strips: new Set() };
    if (d.rail) renderRail();
    for (const p of d.panes) renderPaneOf(p);
    for (const p of d.grown) if (!d.panes.has(p) && !growPane(p)) renderPaneOf(p);
    for (const p of d.strips) if (!d.panes.has(p)) patchStrip(p);
    refreshAskPanes();
    showUnread();
    menuAnchorRedrawn();
  }
  function dropInvalidations() {
    if (drawFrame) cancelAnimationFrame(drawFrame);
    drawFrame = 0;
    toDraw = { rail: false, panes: new Set(), grown: new Set(), strips: new Set() };
  }

  // An Ask pane's "This thread" is the nearest thread pane's (askThread):
  // it is redrawn when that changes, and only then.
  const askDrawn = new WeakMap(); // pane → R.askKey of what it was drawn with
  function refreshAskPanes() {
    st.panes.forEach((p, i) => {
      if (p.view?.kind === 'ask' && askDrawn.get(p) !== R.askKey(askThread(i))) renderPane(i);
    });
  }

  /** The boards universal tags look in (they follow the panes). */
  const activeBoardsKey = () =>
    TG.activeBoards(
      settings.favourites,
      views()
        .filter((x) => x?.kind === 'board' || x?.kind === 'thread')
        .map((x) => x.board),
    ).join(',');
  const tagOf = (id) => (settings.tags || []).find((t) => t.id === id) || null;

  // A drag on the sidebar's edge goes on to its end: a full redraw waits.
  // dragGrip: the edge being dragged (railGrip), null when none is.
  let renderAfterDrag = false;
  let dragGrip = null;

  /** Draws everything again: the sidebar, every pane, the workspace bar. */
  function render() {
    if (closed) return;
    // Only while the edge is really dragged (and still on the page): a drag
    // whose end never came does not stop every redraw after it.
    if (dragGrip?.isConnected) {
      renderAfterDrag = true;
      return;
    }
    dragGrip = null;
    root.classList.remove('shell--resizing');
    renderAfterDrag = false;
    dropInvalidations();
    if (settings.embeds?.mode === 'off') player.close();
    const saved = capture(root);
    clear(root);
    const narrow = matchMedia(NARROW).matches;
    const railHidden = Boolean(settings.ui?.railHidden);
    const rows = settings.ui?.rows || 1;
    const rail = railEl(narrow, railHidden);

    // The panes: all of them on a wide window (rows of columns); on a
    // narrow one the focused pane, with tabs to switch.
    const built = st.panes.map((p, i) => {
      p.stale = false;
      return paneEl(i, narrow);
    });
    const grid = h('div', { class: 'workspace__grid', 'data-rows': String(narrow ? 1 : paneRows(st.panes.length, rows).length) });
    if (narrow) {
      const f = Math.min(st.focus, built.length - 1);
      grid.append(built[f].el);
      st.panes.forEach((p, i) => {
        if (i !== f) p.stale = true;
      });
    } else {
      let k = 0;
      for (const count of paneRows(st.panes.length, rows)) {
        const row = h('div', { class: 'workspace__row', style: { '--cols': String(count) } });
        for (let j = 0; j < count; j++) row.append(built[k++].el);
        grid.append(row);
      }
    }
    const focusTitle = built[Math.min(st.focus, built.length - 1)].windowTitle;
    const workspace = h('main', { class: 'centre workspace' }, headEl(narrow, focusTitle), tabsEl(narrow, built), grid);

    root.style.setProperty('--rail-w', `${M.fitRail(settings.ui?.railWidth)}px`);
    root.append(rail, workspace);
    if (saved.railY) {
      const railScroll = rail.querySelector('.rail__scroll');
      if (railScroll) restoreScroll(railScroll, saved.railY);
    }
    if (st.rail) root.append(h('div', { class: 'shell__scrim only-narrow', onclick: () => ((st.rail = false), render()) }));
    if (st.rail) root.dataset.railOpen = '';
    else delete root.dataset.railOpen;
    if (railHidden) root.dataset.railHidden = '';
    else delete root.dataset.railHidden;

    shownTitle = focusTitle;
    restore(root, saved);
    setTitle(focusTitle, focusedUnread());
    showJump();
    resumePendingMotion(root);
    restoreFocus(root, saved);
    keepDialogOpeners(root);
    menuAnchorRedrawn();
  }

  // ------------------------------------------------------------ keyboard

  // The pane clicked or tabbed into gets the focus (never one fading out);
  // its marker and the titles follow at once, without a redraw.
  const focusPane = (e) => {
    if (refocusing) return;
    const node = e.target.closest?.('[data-pane]');
    if (!node) return;
    const i = Number(node.dataset.pane);
    if (i === st.focus || st.panes[i]?.motion?.kind === 'closing') return;
    st.focus = i;
    syncFocus();
  };
  root.addEventListener('pointerdown', focusPane, { capture: true, signal: ac.signal });
  root.addEventListener('focusin', focusPane, { signal: ac.signal });

  // Ctrl/⌘+click on anything that navigates a pane opens it in a new tab
  // of that pane (goto reads it: takeClickIntent); with Shift, in front.
  // Set before the click reaches its control, dropped after it.
  root.addEventListener(
    'click',
    (e) => {
      clickIntent = forcedIntent || T.clickTab(e);
      if (clickIntent) setTimeout(() => (clickIntent = null), 0);
    },
    { capture: true, signal: ac.signal },
  );
  root.addEventListener('click', () => (clickIntent = null), { signal: ac.signal });

  // A middle click on what navigates: the same as Ctrl+click. Catalog
  // cards draw their own (browse.js); quote and board links open their
  // thread or board here; the rest gets a click that goto reads as such.
  const MIDDLE_NAV = '.rail__item, .board-card__open, .saved__open, .stats-table__open, .catalog-card, .seg-boardlink, .seg-quotelink[data-thread]';
  root.addEventListener(
    'mousedown',
    (e) => {
      // no autoscroll (or paste) from the middle button on these
      if (e.button === 1 && e.target.closest?.(MIDDLE_NAV)) e.preventDefault();
    },
    { signal: ac.signal },
  );
  root.addEventListener(
    'auxclick',
    (e) => {
      if (e.button !== 1 || e.defaultPrevented || closed) return;
      const el = e.target.closest?.(MIDDLE_NAV);
      if (!el || el.disabled || !root.contains(el)) return;
      e.preventDefault();
      const at = Number(el.closest('[data-pane]')?.dataset.pane);
      const i = Number.isInteger(at) ? at : st.focus;
      const tab = T.clickTab(e);
      const v = st.panes[i]?.view;
      if (el.matches('.seg-boardlink')) {
        if (st.panes[i]) openBoardLink({ board: el.dataset.board || '', search: el.dataset.search || '' }, st.panes[i], tab);
        return;
      }
      if (el.matches('.seg-quotelink')) {
        const board = el.dataset.board || v?.board;
        const thread = Number(el.dataset.thread);
        const post = Number(el.dataset.target) || thread;
        // a quote of a post of this same thread: nothing to open
        if (!board || !Number.isSafeInteger(thread) || thread <= 0 || ((v?.kind === 'thread' || v?.kind === 'offline') && v.board === board && v.no === thread)) return;
        openTab({ kind: 'thread', board, no: thread }, i, { ...tab, jump: { board, no: thread, post } });
        return;
      }
      forcedIntent = tab;
      try {
        el.click();
      } finally {
        forcedIntent = null;
        clickIntent = null;
      }
    },
    { signal: ac.signal },
  );

  /** Fetches the pane's catalog or thread again now (the queue still keeps
   *  the 10 s per thread rule), or the board list on the board list. */
  function refreshPane(i) {
    const v = st.panes[i]?.view;
    // a catalog or thread: the fetch, for the clover (manualRefresh)
    if (v?.kind === 'board') return loadCatalog(v.board, true);
    if (v?.kind === 'thread') return loadThread(v.board, v.no);
    if (v?.kind === 'boards') loadBoardList();
    else if (v?.kind === 'saved') loadSaved();
    else if (v?.kind === 'library') library.load(true);
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

  /** A tab key (tabs-model.js tabKeyAction) on the focused pane. Held
   *  down, only the moves between tabs repeat. */
  function runTabKey(k, repeat = false) {
    const i = Math.min(st.focus, st.panes.length - 1);
    const pane = st.panes[i];
    if (!pane) return;
    const state = { tabs: pane.tabs, active: pane.active };
    if (k.kind === 'next' || k.kind === 'prev') activateTab(i, T.cycleIndex(state, k.kind === 'next' ? 1 : -1));
    else if (repeat) return;
    else if (k.kind === 'pick') {
      const j = T.pickIndex(k.digit, pane.tabs.length);
      if (j !== null) activateTab(i, j);
    } else if (k.kind === 'new') newTabHere(i);
    else if (k.kind === 'close') closeTab(i, pane.active);
    else if (k.kind === 'reopen') reopenTab();
    keepTabFocus();
  }

  /** After a tab key the focus may have been in the view that went (it
   *  falls to <body>): it goes to the focused pane's tab shown in its strip,
   *  else its head (as the strip's Delete does), so a keyboard or screen
   *  reader user keeps their place. */
  function keepTabFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const node = root.querySelector(`.workspace__grid section[data-pane="${st.focus}"]`);
    (node?.querySelector('.pane-tabs [aria-selected="true"]') || node?.querySelector('.pane__head button'))?.focus({ preventScroll: true });
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (root.hidden) return;
      // The browser's reload keys (F5, Ctrl+R, ⌘R, with or without Shift)
      // update the focused pane instead of reloading the whole window, which
      // would drop every pane and any reply being written.
      if (B.isRefreshKey(e)) {
        e.preventDefault();
        if (!e.repeat) manualRefresh(st.focus);
        return;
      }
      if (document.querySelector('dialog[open], .gallery')) return;
      // The tab keys (tabs-model.js tabKeyAction): never while typing, nor
      // in the reply form; kept from the webview, which would do its own.
      const tabKey = T.tabKeyAction(e);
      if (tabKey && !typing() && !pastasOpen() && !document.activeElement?.closest?.('.composer')) {
        e.preventDefault();
        runTabKey(tabKey, e.repeat);
        return;
      }
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
          renderPanes(showsEither(v.board, v.no));
          return;
        }
        if (v.kind === 'thread' && !typing() && document.activeElement?.tagName !== 'VIDEO' && !document.activeElement?.closest?.('.composer')) {
          backToCatalog(st.focus);
        }
        return;
      }
      // R: reply to the thread shown, or a new thread on the board shown
      // (never with Ctrl/⌘, which is Update; nor while typing, in the reply
      // form or with the pre-written posts open)
      if (K.isReplyKey(e) && !typing() && !pastasOpen() && !document.activeElement?.closest?.('.composer')) {
        const kind = focused()?.view?.kind;
        if (kind === 'thread' || kind === 'board') {
          e.preventDefault();
          if (!e.repeat) replyKey(st.focus);
        }
        return;
      }
      // L: the focused thread in a list or in columns (columns-model.js)
      if (K.isLayoutKey(e) && !typing() && !pastasOpen() && !document.activeElement?.closest?.('.composer')) {
        const kind = focused()?.view?.kind;
        if (kind === 'thread' || kind === 'offline') {
          e.preventDefault();
          if (!e.repeat) toggleLayout(st.focus);
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
  // Only crossing the narrow width changes the layout (one pane and tabs):
  // the rest follows the CSS. A bigger window can show more of a thread,
  // which then counts as read (once a frame while it is dragged).
  matchMedia(NARROW).addEventListener('change', () => !closed && render(), { signal: ac.signal });
  let resizeFrame = 0;
  window.addEventListener(
    'resize',
    () => {
      if (closed || resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        trackAllRead();
      });
    },
    { passive: true, signal: ac.signal },
  );

  // The mouse's side buttons (DOM buttons 3 and 4) and Alt+← / Alt+→: back
  // and forward in the pane under the pointer (or the focused pane). The
  // press is kept from the webview, which would otherwise try its own
  // history.
  const sideButton = (e) => {
    if (closed || root.hidden || (e.button !== 3 && e.button !== 4)) return;
    e.preventDefault();
    if (e.type !== 'mouseup' || document.querySelector('dialog[open], .gallery')) return;
    const at = Number(e.target?.closest?.('[data-pane]')?.dataset.pane);
    const i = Number.isInteger(at) ? at : st.focus;
    if (e.button === 3) back(i);
    else forward(i);
  };
  for (const type of ['mousedown', 'mouseup', 'auxclick']) window.addEventListener(type, sideButton, { capture: true, signal: ac.signal });
  // Linux: WebKitGTK keeps the side buttons from the page, so the app
  // catches them on the web view and calls this (extra.rs side_buttons),
  // for the pane last under the pointer.
  let pointerPane = null;
  root.addEventListener(
    'pointerover',
    (e) => {
      const at = Number(e.target?.closest?.('[data-pane]')?.dataset.pane);
      pointerPane = Number.isInteger(at) ? at : null;
    },
    { signal: ac.signal },
  );
  window.__cloverEyeNav = (dir) => {
    if (closed || root.hidden || document.querySelector('dialog[open], .gallery')) return;
    const i = pointerPane !== null && pointerPane < st.panes.length ? pointerPane : st.focus;
    if (dir === 'back') back(i);
    else if (dir === 'forward') forward(i);
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (closed || root.hidden || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || typing()) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (document.querySelector('dialog[open], .gallery')) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') back(st.focus);
      else forward(st.focus);
    },
    { signal: ac.signal },
  );
  // Back to the window: what is on screen now counts as read.
  window.addEventListener('focus', trackAllRead, { signal: ac.signal });
  document.addEventListener('visibilitychange', trackAllRead, { signal: ac.signal });

  // For the e2e checks only (tests/e2e/redraw.mjs): a pane drawn anew on
  // demand, to compare with one updated in place. Never with the real site.
  if (bridge?.kind === 'mock') {
    window.__ceDebug = {
      renderPane: (i) => renderPane(i),
      render: () => render(),
      posted: (p) => posted(p),
      // each pane's tabs: the views, which one is shown, the focused pane
      tabs: () => ({ focus: st.focus, panes: st.panes.map((p) => ({ active: p.active, views: p.tabs.map((t) => t.view) })) }),
      timers: () => [...st.timers.keys()],
      // whether a thread ("board/no") was fetched this session
      loaded: (key) => Boolean(st.threads[key]),
    };
  }

  root.hidden = false;
  for (const v of views()) startLine(v);
  render();
  for (const v of views()) enter(v);
  if (isMain) watchTimer = setTimeout(watchTick, 2000);
  loadSaved();
  /** What is still waiting to be stored, stored now: the window is closing
   *  (app.js). What is on screen counts as read first. Resolves once the
   *  settings are sent. */
  function flush() {
    if (closed) return Promise.resolve();
    trackAllRead();
    if (tagHistoryTimer) writeTagHistory();
    // the library's own index (library.js)
    return Promise.all([flushSave(), library.flush()]).then(() => undefined);
  }

  return {
    flush,
    /** The focused pane's shown view (its active tab's). */
    focusedView: () => focused()?.view || null,
    /** Opens a view in a new tab of a pane (default: the focused one), in
     *  the background unless `background: false`. */
    openTab: (view, { pane = st.focus, background = true } = {}) => openTab(view, pane, { background }),
    close() {
      for (const p of st.panes) for (const t of p.tabs) stopAsk(t.ask, bridge);
      closed = true;
      stats.close();
      clearTimeout(statsTimer);
      clearTimeout(watchTimer);
      clearTimeout(saveTimer);
      saveTimer = null;
      pendingOps = new Map();
      onSave(settings);
      if (tagHistoryTimer) writeTagHistory();
      library.flush();
      stopLibraryEvents?.();
      pastaPopup?.close({ focus: false });
      composer.close();
      player.close();
      for (const t of st.timers.values()) clearTimeout(t);
      st.timers.clear();
      for (const t of st.catRetry.values()) clearTimeout(t);
      st.catRetry.clear();
      ac.abort();
      root.hidden = true;
      clear(root);
    },
    /** Settings saved in another window. */
    applySettings(incoming) {
      if (closed) return;
      // Changes this window still holds for its grouped save go on top
      // (each only moves forward: a read mark up, a watched thread's
      // title, archived or 404), and read marks never go down here: the
      // grouped save then stores the lot.
      const prev = settings;
      const replayed = [...pendingOps.values()].reduce((s, f) => f(s), incoming);
      const merged = U.keepReadMarks(prev, replayed);
      const light = U.onlyReadMarksDiffer(prev, merged);
      const moved = (merged.files?.savedDir || '') !== savedDir();
      // Read marks saved by another window (every bit of scrolling there):
      // only the counts change, so nothing is torn down and redrawn here,
      // and everything else keeps its identity (the filter and (You)
      // caches hold). Other changes keep each list that stayed the same.
      if (light) settings = U.sameReadMarks(prev, merged) ? prev : { ...prev, lastRead: merged.lastRead, watched: merged.watched };
      else settings = M.keepSameLists(prev, merged);
      // what this window adds is stored: by the grouped save under way
      // (it saves `settings` when it fires), or by a new one
      if (merged !== incoming && !saveTimer) save(settings);
      if (light) {
        if (settings !== prev) showUnread();
        return;
      }
      // Only the watched threads (a title, archived, 404, one watched or
      // not): the sidebar, and the threads whose Watch button changed.
      // Only the pins or own pre-written posts: the popup, if open, nothing else
      pastaPopup?.update(settings);
      if (P.onlyPastasDiffer(prev, settings)) return;
      if (M.onlyWatchedDiffer(prev, settings)) {
        const was = new Set((prev.watched || []).map((w) => tkey(w.board, w.no)));
        const now = new Set((settings.watched || []).map((w) => tkey(w.board, w.no)));
        renderRail();
        renderPanes((v) => v.kind === 'thread' && was.has(tkey(v.board, v.no)) !== now.has(tkey(v.board, v.no)));
        showUnread();
        return;
      }
      stats.poke();
      if (moved) {
        forgetOffline();
        loadSaved();
      }
      if (library.stale()) library.load();
      render();
    },
  };
}
