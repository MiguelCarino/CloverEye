// The Stats pane's data, for one window: board activity samples
// (stats-model.js) and your own counts (my-stats-model.js), each kept in a
// file of its own through the bridge (src-tauri/src/stats.rs, never in
// settings), and the background sampler.
//
// Samples cost nothing extra when they come from a catalog the shell loads
// anyway. Background sampling is opt-in (Settings → Stats → Track board
// activity) and runs in the main window only: one board at a time, through
// the same request queue as everything else (bridge.fetchCatalog), only
// when no other request is waiting or under way, at least ACTIVE_GAP_MS
// after the last one it made, and each board at most every 5 (10, 15, 30)
// minutes. It pauses once the window has been hidden for longer than that.
//
// Your own counts are kept only while Settings → Stats → Count my own
// activity is on; off, nothing at all is counted.

import * as S from './stats-model.js';
import * as Y from './my-stats-model.js';
import { catalogThreads, threadTitle } from './browse-model.js';

/** How often the sampler looks for a board that is due. */
export const SAMPLER_TICK_MS = 5_000;
/** Background samples are at least this far apart (the queue's own floor
 *  is 1 s between any two requests). */
export const ACTIVE_GAP_MS = 10_000;
/** Time spent is counted in steps of this, while a window is focused. */
export const TIME_TICK_MS = 15_000;
/** The event a file being viewed sends (gallery.js, hover.js, setup.js). */
export const FILE_VIEW_EVENT = 'clovereye:file-view';
const BOARDS_FLUSH_MS = 3_000;
const MINE_FLUSH_MS = 20_000;
const RETRY_MS = 30_000;
const TRIES = 4;
const isConflict = (e) => String(e?.message || e) === 'stats-conflict';

/**
 * @param {object} o
 * @param {object} o.bridge
 * @param {() => object} o.getSettings
 * @param {boolean} o.isMain                 only the main window samples
 * @param {() => string[]|null} o.tracked    the boards to sample (null: the board list is needed first)
 * @param {() => string|null} o.focusBoard   the board of the focused pane, for time per board
 * @param {(board: string|null) => void} [o.onBoards]   samples changed
 * @param {() => void} [o.onMine]            your counts changed
 * @param {(status: object) => void} [o.onStatus]   what the sampler is doing
 * @param {(board: string, res: object, at: number) => void} [o.onCatalog]   a catalog the sampler fetched
 */
export function createStats({ bridge, getSettings, isMain = true, tracked, focusBoard = () => null, onBoards = () => {}, onMine = () => {}, onStatus = () => {}, onCatalog = () => {}, now = () => Date.now(), doc = globalThis.document }) {
  const can = Boolean(bridge?.statsRead && bridge?.statsWrite);
  let closed = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  // ------------------------------------------------------------ board samples

  let boards = S.emptyBoardStats();
  let pending = []; // samples not stored yet: { board, sample, snap }
  let boardsTimer = null;
  let boardsFlushing = false;

  async function loadBoards() {
    if (!can) return;
    try {
      boards = S.pruneBoardStats(S.insertSamples(S.normalizeBoardStats(await bridge.statsRead('boards')), pending), now());
    } catch {
      /* unreadable: keep what is here */
    }
    if (!closed) onBoards(null);
  }

  function scheduleBoards(ms = BOARDS_FLUSH_MS) {
    if (boardsTimer || closed) return;
    boardsTimer = later(() => {
      boardsTimer = null;
      flushBoards();
    }, ms);
  }

  /** Stores the samples not stored yet: read the file, add them, write it
   *  back naming the revision read (another window may have written). */
  async function flushBoards() {
    if (!can || boardsFlushing || !pending.length) return;
    // With tracking off, samples stay in this window's memory only: the file
    // would otherwise be a day's record of which boards were opened.
    if (!statsSettings().track) return;
    boardsFlushing = true;
    const items = pending;
    pending = [];
    try {
      for (let i = 0; i < TRIES; i++) {
        const stored = S.normalizeBoardStats(await bridge.statsRead('boards'));
        const next = S.pruneBoardStats(S.insertSamples(stored, items), now());
        try {
          const rev = await bridge.statsWrite('boards', next, stored.rev);
          // what other windows stored comes in too; samples taken meanwhile stay
          boards = S.insertSamples({ ...next, rev }, pending);
          if (!closed) onBoards(null);
          return;
        } catch (e) {
          if (!isConflict(e)) throw e;
        }
      }
      throw new Error('stats-conflict');
    } catch {
      pending = [...items, ...pending].slice(-500);
      scheduleBoards(RETRY_MS);
    } finally {
      boardsFlushing = false;
    }
  }

  /** A catalog loaded anyway (or by the sampler) becomes a sample. */
  function recordCatalog(board, data, at = now()) {
    if (!can || closed) return null;
    const r = S.addSample(boards, board, catalogThreads(data), at, { title: (op) => threadTitle(op, 60) });
    if (!r.sample) return null;
    boards = r.store;
    pending = [...pending, { board, sample: r.sample, snap: r.store.boards[board]?.snap }].slice(-500);
    if (statsSettings().track) scheduleBoards();
    onBoards(board);
    return r.sample;
  }

  // ----------------------------------------------------------------- sampler

  let status = { state: 'off' };
  let sampling = false;
  let manual = null; // { done, total }
  let lastActiveEnd = 0;
  const tried = new Map(); // board → when a background sample last failed
  let hiddenAt = doc?.visibilityState === 'hidden' ? now() : null;

  const statsSettings = () => S.normalizeStatsSettings(getSettings()?.stats);
  const setStatus = (s) => {
    status = s;
    if (!closed) onStatus(s);
  };
  // a failed board waits its interval too, so a dead board is not asked every tick
  const lastAt = (b) => {
    const a = S.lastSampleAt(boards, b);
    const t = tried.get(b) ?? null;
    return a === null ? t : t === null ? a : Math.max(a, t);
  };

  async function sampleBoard(board) {
    try {
      const res = await bridge.fetchCatalog(board);
      const at = now();
      tried.delete(board);
      recordCatalog(board, res?.data, at);
      if (!closed) onCatalog(board, res, at);
      return true;
    } catch {
      tried.set(board, now());
      return false;
    }
  }

  async function tick() {
    if (closed || sampling || manual) return;
    const o = statsSettings();
    if (!isMain || !o.track || !can) return setStatus({ state: 'off' });
    if (pending.length) scheduleBoards();
    const interval = o.intervalMin * S.MINUTE_MS;
    if (hiddenAt !== null && now() - hiddenAt > interval) return setStatus({ state: 'paused' });
    const list = tracked();
    if (list === null) return setStatus({ state: 'loading' });
    if (!list.length) return setStatus({ state: 'none' });
    const due = S.pickDue(list, lastAt, now(), interval);
    if (due.wait > 0) return setStatus({ state: 'next', board: due.board, at: now() + due.wait });
    const gap = lastActiveEnd + ACTIVE_GAP_MS - now();
    if (gap > 0) return setStatus({ state: 'next', board: due.board, at: now() + gap });
    // idle only: the person's own requests (any window) go first
    let busy = 0;
    try {
      busy = (await bridge.fetchBusy?.()) || 0;
    } catch {
      busy = 0;
    }
    if (closed) return;
    if (busy > 0) return setStatus({ state: 'busy', board: due.board });
    if (!statsSettings().track) return setStatus({ state: 'off' });
    sampling = true;
    setStatus({ state: 'sampling', board: due.board });
    try {
      await sampleBoard(due.board);
    } finally {
      sampling = false;
      lastActiveEnd = now();
    }
    tick();
  }

  /** F5 in the Stats pane: one sample of each board whose last one is over
   *  a minute old, one after another through the queue. */
  async function sampleNow(list) {
    if (closed || manual || !can) return;
    const due = S.manualDue(list, (b) => S.lastSampleAt(boards, b), now());
    if (!due.length) return;
    manual = { done: 0, total: due.length };
    try {
      for (const b of due) {
        if (closed) break;
        setStatus({ state: 'manual', board: b, done: manual.done, total: manual.total });
        await sampleBoard(b);
        manual.done += 1;
      }
    } finally {
      manual = null;
      if (!closed) {
        lastActiveEnd = now();
        tick();
      }
    }
  }

  // --------------------------------------------------------------- your counts

  let mine = Y.emptyMine();
  let delta = Y.emptyDelta();
  let mineLoaded = false;
  let mineTimer = null;
  let mineFlushing = false;
  let mineNotify = null;
  const mineOn = () => statsSettings().mine;

  async function loadMine() {
    if (!can) return;
    try {
      mine = Y.normalizeMine(await bridge.statsRead('mine'));
      mineLoaded = true;
    } catch {
      /* unreadable: counting waits */
    }
    if (!closed) onMine();
  }

  function changedMine() {
    if (mineNotify || closed) return;
    // the You tab redraws at most every 2 s however much is counted
    mineNotify = later(() => {
      mineNotify = null;
      onMine();
    }, 2_000);
  }

  function scheduleMine(ms = MINE_FLUSH_MS) {
    if (mineTimer || closed) return;
    mineTimer = later(() => {
      mineTimer = null;
      flushMine();
    }, ms);
  }

  async function flushMine() {
    if (!can || mineFlushing || Y.deltaEmpty(delta)) return;
    mineFlushing = true;
    const d = delta;
    delta = Y.emptyDelta();
    try {
      for (let i = 0; i < TRIES; i++) {
        const stored = Y.normalizeMine(await bridge.statsRead('mine'));
        const next = Y.applyDelta(stored, d, now());
        try {
          const rev = await bridge.statsWrite('mine', next, stored.rev);
          mine = { ...next, rev };
          mineLoaded = true;
          return;
        } catch (e) {
          if (!isConflict(e)) throw e;
        }
      }
      throw new Error('stats-conflict');
    } catch {
      // the counts go back, with what came in meanwhile
      delta = Y.mergeDeltas(d, delta);
      scheduleMine(RETRY_MS);
    } finally {
      mineFlushing = false;
    }
  }

  const sinceOf = () => mine.since || delta.since;

  /** Adds to one of your counters for today (nothing while it is off). */
  function count(key, n = 1, board = null) {
    if (closed || !can || !mineOn() || !(n > 0)) return;
    if (!sinceOf()) delta.since = now();
    Y.bump(delta, Y.dayKey(now()), key, n, board);
    scheduleMine();
    changedMine();
  }

  /** A reply to one of your posts, counted once ever, and only if it was
   *  made after counting was turned on. */
  function replyToYou(board, no, time) {
    if (closed || !can || !mineOn() || !mineLoaded) return;
    if (!sinceOf()) delta.since = now();
    if (!Y.replyCounts(mine, delta, board, no, time, sinceOf())) return;
    delta.counted.push(`${board}/${no}`);
    count('replies', 1);
  }

  /** Deletes your counts (the file is emptied; board activity stays). */
  async function deleteMine() {
    if (!can) return;
    delta = Y.emptyDelta();
    for (let i = 0; i < TRIES; i++) {
      const stored = Y.normalizeMine(await bridge.statsRead('mine'));
      try {
        const rev = await bridge.statsWrite('mine', Y.emptyMine(), stored.rev);
        mine = { ...Y.emptyMine(), rev };
        mineLoaded = true;
        delta = Y.emptyDelta();
        if (!closed) onMine();
        return;
      } catch (e) {
        if (!isConflict(e)) throw e;
      }
    }
    throw new Error('Another window kept writing; try again.');
  }

  // Time with a window focused and visible, in steps.
  let lastTime = now();
  function timeTick() {
    const t = now();
    const sec = Math.min(t - lastTime, 2 * TIME_TICK_MS) / 1000;
    lastTime = t;
    if (doc?.visibilityState === 'visible' && doc.hasFocus?.() && sec > 0) count('time', Math.round(sec), focusBoard());
  }

  const onFile = () => count('files', 1);
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') hiddenAt ??= now();
    else {
      hiddenAt = null;
      tick();
    }
    if (doc.visibilityState === 'hidden') {
      flushMine();
      flushBoards();
    }
  };
  const onFocus = () => {
    lastTime = now(); // the time away is not counted
  };

  doc?.addEventListener?.(FILE_VIEW_EVENT, onFile);
  doc?.addEventListener?.('visibilitychange', onVisibility);
  globalThis.addEventListener?.('focus', onFocus);
  const samplerTimer = setInterval(() => tick(), SAMPLER_TICK_MS);
  const timeTimer = setInterval(timeTick, TIME_TICK_MS);
  loadBoards();
  loadMine();
  later(() => tick(), 1_000);

  return {
    recordCatalog,
    sampleNow,
    count,
    replyToYou,
    deleteMine,
    /** The board store (read only). */
    boards: () => boards,
    /** Your counts, the ones not stored yet included. */
    mine: () => (Y.deltaEmpty(delta) ? mine : Y.applyDelta(mine, delta, now())),
    status: () => (manual ? { ...status, state: 'manual', done: manual.done, total: manual.total } : status),
    /** Reads both files again (the pane was opened: other windows may have
     *  added to them). */
    reload() {
      loadBoards();
      if (Y.deltaEmpty(delta)) loadMine();
    },
    /** Settings changed: the sampler looks again now. */
    poke() {
      tick();
    },
    close() {
      if (closed) return;
      timeTick();
      closed = true;
      clearInterval(samplerTimer);
      clearInterval(timeTimer);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      doc?.removeEventListener?.(FILE_VIEW_EVENT, onFile);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('focus', onFocus);
      // what is not stored yet goes now (the window may be closing)
      flushMine();
      flushBoards();
    },
  };
}
