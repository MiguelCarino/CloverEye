import { test } from 'node:test';
import assert from 'node:assert/strict';

import { threadStats } from '../ui/js/stats-model.js';
import { catalogThreads } from '../ui/js/browse-model.js';

const cat = catalogThreads([
  { page: 1, threads: [{ no: 10 }, { no: 11 }] },
  { page: 2, threads: [{ no: 12 }] },
  { page: 3, threads: [{ no: 13 }] },
]);

test('threadStats: the site’s own counts first', () => {
  const s = threadStats([{ no: 12, replies: 40, images: 7, unique_ips: 9 }, { no: 14, id: 'a' }], cat);
  assert.deepEqual(s, { replies: 40, files: 7, posters: 9, page: 2, pages: 3, lastPage: false, bumpLimit: false, imageLimit: false, warn: false });
});

test('threadStats: counts the thread when the OP has no counts', () => {
  const posts = [
    { no: 1, tim: 5, id: 'a' },
    { no: 2, tim: 6, id: 'b' },
    { no: 3, tim: 7, filedeleted: 1, id: 'a' },
    { no: 4, id: 'c' },
  ];
  const s = threadStats(posts);
  assert.equal(s.replies, 3);
  assert.equal(s.files, 1, 'replies’ files, deleted ones left out');
  assert.equal(s.posters, 3, 'distinct poster IDs');
  assert.equal(threadStats([{ no: 1 }, { no: 2 }]).posters, null, 'no IDs, no unique_ips: unknown');
});

test('threadStats: page only from a cached catalog that has the thread', () => {
  assert.equal(threadStats([{ no: 13 }]).page, null);
  assert.equal(threadStats([{ no: 13 }], []).page, null);
  const gone = threadStats([{ no: 99 }], cat);
  assert.equal(gone.page, null);
  assert.equal(gone.pages, null);
  const last = threadStats([{ no: 13 }], cat);
  assert.equal(last.page, 3);
  assert.equal(last.lastPage, true);
  assert.equal(last.warn, true);
  // a one-page catalog: every thread is on it, which is no warning
  assert.equal(threadStats([{ no: 1 }], catalogThreads([{ page: 1, threads: [{ no: 1 }] }])).lastPage, false);
});

test('threadStats: bump and image limits', () => {
  const s = threadStats([{ no: 10, bumplimit: 1, imagelimit: 1 }], cat);
  assert.equal(s.bumpLimit, true);
  assert.equal(s.imageLimit, true);
  assert.equal(s.warn, true);
  assert.equal(threadStats([{ no: 10, imagelimit: 1 }], cat).warn, false, 'the image limit alone does not stop bumps');
});

test('threadStats: junk', () => {
  assert.equal(threadStats(null), null);
  assert.equal(threadStats([]), null);
  assert.equal(threadStats([null]), null);
  const s = threadStats([{ no: 1, replies: -3, images: 'x', unique_ips: 1.5 }]);
  assert.equal(s.replies, 0);
  assert.equal(s.files, 0);
  assert.equal(s.posters, null);
});

// ------------------------------------------------------------ board activity

import * as S from '../ui/js/stats-model.js';
import { panesFromHash } from '../ui/js/browse-model.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
/** A catalog: OPs [no, replies, lastReplyNo?]. */
const cat2 = (ops) => ops.map(([no, replies = 0, last]) => ({ no, replies, last_replies: last ? [{ no: last }] : [] }));
/** Samples at T0 + minutes, with the highest post number given. */
const run = (pairs) => pairs.map(([m, maxNo, extra = {}]) => ({ at: T0 + m * MIN, maxNo, threads: 10, newOps: null, since: null, top: null, ...extra }));

test('catalogSample: highest number, live threads; the first has no baseline', () => {
  const made = S.catalogSample(cat2([[100, 3, 140], [120, 0], [90, 9, 150]]), null, T0);
  assert.deepEqual(made.sample, { at: T0, maxNo: 150, threads: 3, newOps: null, since: null, top: null });
  assert.deepEqual(made.snap.r, [[100, 3], [120, 0], [90, 9]]);
  assert.equal(S.catalogSample([], null, T0), null, 'an empty catalog is no sample');
  assert.equal(S.catalogSample([{ no: 'x' }], null, T0), null);
});

test('catalogSample: new threads and the busiest thread against the snapshot', () => {
  const first = S.catalogSample(cat2([[100, 3, 140], [90, 9, 150]]), null, T0);
  const next = S.catalogSample(cat2([[100, 10, 170], [90, 11, 160], [155, 4, 165], [158, 0]]), first.snap, T0 + 5 * MIN, { title: (t) => `Thread ${t.no}` });
  assert.equal(next.sample.newOps, 2, 'two OPs above the old highest number');
  assert.equal(next.sample.since, T0);
  assert.deepEqual(next.sample.top, { no: 100, added: 7, title: 'Thread 100' });
  // a new thread can be the busiest
  const hot = S.catalogSample(cat2([[100, 3], [90, 9], [155, 12]]), first.snap, T0 + 5 * MIN);
  assert.deepEqual(hot.sample.top, { no: 155, added: 12 });
  // nothing gained: no busiest thread
  assert.equal(S.catalogSample(cat2([[100, 3, 140], [90, 9, 150]]), first.snap, T0 + 5 * MIN).sample.top, null);
});

test('catalogSample: no baseline over a long gap, a reset or a clock that went back', () => {
  const first = S.catalogSample(cat2([[100, 3, 140]]), null, T0);
  const later = S.catalogSample(cat2([[100, 9, 300], [200, 5]]), first.snap, T0 + 3 * 60 * MIN);
  assert.equal(later.sample.newOps, null, 'over two hours: threads may have come and gone unseen');
  assert.equal(later.sample.top, null);
  const reset = S.catalogSample(cat2([[5, 1, 8]]), first.snap, T0 + 5 * MIN);
  assert.equal(reset.sample.newOps, null, 'numbers went down: no comparison');
  const back = S.catalogSample(cat2([[100, 9, 150]]), first.snap, T0 - 5 * MIN);
  assert.equal(back.sample.newOps, null, 'earlier than the snapshot');
});

test('addSample keeps one sample per 30 s and the newest snapshot', () => {
  let store = S.emptyBoardStats();
  let r = S.addSample(store, 'g', cat2([[100, 1, 120]]), T0);
  assert.ok(r.sample);
  store = r.store;
  r = S.addSample(store, 'g', cat2([[100, 2, 125]]), T0 + 10_000);
  assert.equal(r.sample, null, 'too soon');
  assert.equal(r.store, store);
  r = S.addSample(store, 'g', cat2([[100, 4, 130]]), T0 + MIN);
  assert.equal(r.store.boards.g.samples.length, 2);
  assert.equal(r.store.boards.g.snap.at, T0 + MIN);
  assert.equal(S.lastSampleAt(r.store, 'g'), T0 + MIN);
  assert.equal(S.lastSampleAt(r.store, 'v'), null);
  assert.equal(S.addSample(store, '../x', cat2([[1]]), T0 + MIN).store.boards['../x'], undefined);
});

test('insertSamples merges what two windows recorded: sorted, one per moment', () => {
  const a = S.insertSamples(S.emptyBoardStats(), [{ board: 'g', sample: run([[0, 100]])[0] }, { board: 'g', sample: run([[10, 160]])[0] }]);
  const b = S.insertSamples(a, [{ board: 'g', sample: run([[5, 130]])[0] }, { board: 'g', sample: run([[10, 999]])[0] }]);
  assert.deepEqual(b.boards.g.samples.map((s) => s.maxNo), [100, 130, 160], 'the moment already there wins');
  assert.equal(a.boards.g.samples.length, 2, 'not changed in place');
});

test('normalizeBoardStats drops garbage', () => {
  const s = S.normalizeBoardStats({ rev: 4, boards: { g: { samples: [{ at: T0, maxNo: 5 }, { at: 'x' }, null, { at: T0, maxNo: 6 }] }, 'G!': { samples: [] }, v: 'no' } });
  assert.equal(s.rev, 4);
  assert.deepEqual(Object.keys(s.boards), ['g']);
  assert.equal(s.boards.g.samples.length, 1);
  assert.deepEqual(S.normalizeBoardStats('junk'), S.emptyBoardStats());
});

test('ppmNow: needs two samples a minute apart; resets and stale samples give none', () => {
  assert.equal(S.ppmNow([], T0), null);
  assert.equal(S.ppmNow(run([[0, 100]]), T0), null, 'one sample');
  assert.equal(S.ppmNow(run([[0, 100], [5, 150]]), T0 + 5 * MIN), 10);
  // the newest two are 30 s apart: it reaches back to a minute
  assert.equal(S.ppmNow(run([[0, 100], [4, 140], [4.5, 146]]), T0 + 5 * MIN), 146 / 4.5 - 100 / 4.5);
  // reset between the last two: no rate across it
  assert.equal(S.ppmNow(run([[0, 5000], [5, 20]]), T0 + 5 * MIN), null);
  // the newest sample is three hours old: no "now"
  assert.equal(S.ppmNow(run([[0, 100], [5, 150]]), T0 + 3 * 60 * MIN), null);
  // two samples three hours apart: no "now" either
  assert.equal(S.ppmNow(run([[0, 100], [180, 1000]]), T0 + 180 * MIN), null);
  // out of order (another window's) samples are sorted first
  assert.equal(S.ppmNow(run([[5, 150], [0, 100]]), T0 + 5 * MIN), 10);
});

test('ratePairs: resets and repeated times are left out', () => {
  const pairs = S.ratePairs(run([[0, 100], [5, 150], [10, 30], [15, 80], [15, 90]]));
  assert.deepEqual(pairs.map((p) => p.posts), [50, 50]);
  assert.deepEqual(pairs.map((p) => (p.to - p.from) / MIN), [5, 5]);
});

test('averagePpm: over the window, shared out across a gap, null when too little is covered', () => {
  const now = T0 + 60 * MIN;
  // every 5 minutes over the hour at 10 a minute
  const steady = run(Array.from({ length: 13 }, (_, i) => [i * 5, 1000 + i * 50]));
  assert.equal(S.averagePpm(steady, now, S.HOUR_MS), 10);
  // a gap: one pair spans 40 minutes; still 10 a minute
  const gap = run([[0, 1000], [10, 1100], [50, 1500], [60, 1600]]);
  assert.equal(S.averagePpm(gap, now, S.HOUR_MS), 10);
  // only 20 minutes of the hour: not enough (half needed)
  assert.equal(S.averagePpm(run([[40, 100], [60, 300]]), now, S.HOUR_MS), null);
  assert.equal(S.averagePpm(run([[40, 100], [60, 300]]), now, S.HOUR_MS, 0.25), 10);
  // a pair reaching back before the window counts only for its part inside it
  const straddle = run([[-60, 1], [60, 1201]]);
  assert.equal(S.averagePpm(straddle, now, S.HOUR_MS), 10);
  // a reset in the middle: the pair across it is left out
  const reset = run([[0, 1000], [30, 1300], [35, 10], [60, 260]]);
  assert.equal(S.averagePpm(reset, now, S.HOUR_MS), 10);
});

test('threadsPerHour: new threads over the time the samples counted them', () => {
  const now = T0 + 60 * MIN;
  const list = run([
    [0, 100],
    [20, 200, { newOps: 2, since: T0 }],
    [40, 300, { newOps: 1, since: T0 + 20 * MIN }],
    [60, 400, { newOps: 3, since: T0 + 40 * MIN }],
  ]);
  assert.equal(S.threadsPerHour(list, now), 6);
  assert.equal(S.threadsPerHour(list.slice(0, 2), now), null, '20 minutes is not enough');
  assert.equal(S.threadsPerHour(run([[0, 100], [10, 200, { newOps: 9, since: T0 + 20 * MIN }]]), now), null, 'since after at: ignored');
});

test('busiestThread: the newest sample’s, while it is recent', () => {
  const list = run([[0, 100, { top: { no: 7, added: 3 } }], [5, 150, { top: { no: 9, added: 12, title: 'Hot' } }]]);
  assert.deepEqual(S.busiestThread(list, T0 + 6 * MIN), { no: 9, added: 12, title: 'Hot', at: T0 + 5 * MIN });
  assert.equal(S.busiestThread(list, T0 + 4 * 60 * MIN), null);
  assert.equal(S.busiestThread(run([[0, 100]]), T0), null);
});

test('pruneBoardStats: 24 hours, no future samples, caps, titles only on the newest', () => {
  const now = T0;
  const store = S.insertSamples(S.emptyBoardStats(), [
    { board: 'g', sample: run([[-25 * 60, 1]])[0] },
    { board: 'g', sample: run([[-60, 2, { top: { no: 1, added: 2, title: 'Old' } }]])[0] },
    { board: 'g', sample: run([[-30, 3, { top: { no: 1, added: 2, title: 'New' } }]])[0] },
    { board: 'g', sample: run([[30, 4]])[0] },
    { board: 'v', sample: run([[-26 * 60, 1]])[0] },
  ]);
  const p = S.pruneBoardStats(store, now);
  assert.deepEqual(p.boards.g.samples.map((s) => s.maxNo), [2, 3], 'older than a day and over 10 min ahead are dropped');
  assert.deepEqual(p.boards.g.samples.map((s) => s.top.title), [undefined, 'New']);
  assert.equal(p.boards.v, undefined, 'a board with nothing left goes');
  const many = S.insertSamples(S.emptyBoardStats(), Array.from({ length: 50 }, (_, i) => ({ board: 'g', sample: run([[-i, 1000 - i]])[0] })));
  assert.equal(S.pruneBoardStats(many, now, { perBoard: 20 }).boards.g.samples.length, 20);
  const small = S.pruneBoardStats(many, now, { maxBytes: 2000 });
  assert.ok(JSON.stringify(small).length <= 2000);
  assert.equal(small.boards.g.samples[small.boards.g.samples.length - 1].at, T0, 'the newest stay');
});

test('sparkValues and sparkPath: hourly rates, broken over gaps, dots for lone hours', () => {
  const now = T0 + 24 * 60 * MIN;
  const list = run([
    [0, 1],
    [60, 601],
    [120, 1801],
    [23 * 60, 5001],
    [24 * 60, 5301],
  ]);
  const v = S.sparkValues(list, now);
  assert.equal(v.length, 24);
  assert.equal(v[0], 10);
  assert.equal(v[1], 20);
  assert.ok(v.slice(2, 23).every((x) => x === null), 'no samples for 21 hours: a gap in the line');
  assert.equal(v[23], 5);
  // a reset an hour in: the pair across it is dropped, the next one counts again
  const reset = S.sparkValues(run([[0, 9000], [60, 9600], [61, 5], [91, 305]]), now);
  assert.equal(reset[0], 10);
  assert.equal(reset[1], 10);
  const sparse = S.sparkValues(run([[0, 1], [60, 601]]), now);
  assert.deepEqual(sparse.slice(1), Array(23).fill(null), 'no samples: no value');
  const path = S.sparkPath([1, 2, null, 4, null, null], 100, 20, 0);
  assert.equal(path.low, 1);
  assert.equal(path.high, 4);
  assert.equal(path.d, 'M0 15L20 10M60 0h0.01', 'a break, then a lone point drawn as a dot');
  assert.deepEqual(S.sparkPath([null, null]), { d: '', low: null, high: null });
  assert.match(S.sparkPath([0, 0, 0]).d, /^M2 22L/, 'all zero: a flat line at the bottom');
});

test('boardRow: collecting until there are two samples', () => {
  const one = S.boardRow('g', { samples: run([[0, 100]]) }, T0 + MIN);
  assert.equal(one.count, 1);
  assert.equal(one.ppm, null);
  assert.equal(one.last, T0);
  assert.equal(one.threads, 10);
  const none = S.boardRow('v', undefined, T0);
  assert.equal(none.count, 0);
  assert.equal(none.last, null);
  assert.equal(none.spark.length, 24);
});

test('sortRows: by board, posts a minute or threads an hour; unknown last', () => {
  const rows = [
    { board: 'v', ppm: 5, tph: null },
    { board: 'a', ppm: null, tph: 2 },
    { board: 'g', ppm: 20, tph: 1 },
    { board: 'b', ppm: 5, tph: 9 },
  ];
  assert.deepEqual(S.sortRows(rows, 'ppm').map((r) => r.board), ['g', 'b', 'v', 'a']);
  assert.deepEqual(S.sortRows(rows, 'ppm', 'asc').map((r) => r.board), ['b', 'v', 'g', 'a']);
  assert.deepEqual(S.sortRows(rows, 'tph').map((r) => r.board), ['b', 'a', 'g', 'v']);
  assert.deepEqual(S.sortRows(rows, 'board').map((r) => r.board), ['a', 'b', 'g', 'v']);
  assert.deepEqual(S.sortRows(rows, 'board', 'desc').map((r) => r.board), ['v', 'g', 'b', 'a']);
});

test('trackedBoards, pickDue and manualDue: what to sample and when', () => {
  const lists = { favourites: ['g', 'v'], worksafe: ['g', 'v', 'a'], visible: ['g', 'v', 'a', 'b'] };
  assert.deepEqual(S.trackedBoards('favourites', lists), ['g', 'v']);
  assert.deepEqual(S.trackedBoards('worksafe', lists), ['g', 'v', 'a']);
  assert.deepEqual(S.trackedBoards('visible', lists), ['g', 'v', 'a', 'b']);
  assert.deepEqual(S.trackedBoards('nope', { favourites: ['g', 'g', '../x'] }), ['g']);
  const at = { g: T0 - 6 * MIN, v: T0 - 2 * MIN, a: null };
  const last = (b) => at[b] ?? null;
  const five = 5 * MIN;
  assert.deepEqual(S.pickDue(['g', 'v', 'a'], last, T0, five), { board: 'a', wait: 0 }, 'never sampled first');
  assert.deepEqual(S.pickDue(['g', 'v'], last, T0, five), { board: 'g', wait: 0 });
  assert.deepEqual(S.pickDue(['v'], last, T0, five), { board: 'v', wait: 3 * MIN }, 'not due: how long to wait');
  assert.deepEqual(S.pickDue([], last, T0, five), { board: null, wait: 0 });
  // a sample "from the future" (the clock went back) waits a full interval from now
  assert.deepEqual(S.pickDue(['g'], () => T0 + 60 * MIN, T0, five), { board: 'g', wait: five });
  assert.deepEqual(S.manualDue(['g', 'v', 'a'], last, T0), ['g', 'v', 'a']);
  assert.deepEqual(S.manualDue(['g', 'v'], (b) => (b === 'g' ? T0 - 30_000 : T0 - 61_000), T0), ['v'], 'a minute at least');
});

test('stats settings: off by default; the Stats pane opens in other windows', () => {
  assert.deepEqual(S.normalizeStatsSettings(undefined), { track: false, scope: 'favourites', intervalMin: 5, mine: false });
  assert.deepEqual(S.normalizeStatsSettings({ track: true, scope: 'worksafe', intervalMin: 15 }), { track: true, scope: 'worksafe', intervalMin: 15, mine: false });
  assert.equal(S.normalizeStatsSettings({ intervalMin: 2 }).intervalMin, 5, 'never under five minutes');
  const enc = (v) => `#panes=${encodeURIComponent(JSON.stringify(v))}`;
  assert.deepEqual(panesFromHash(enc([{ kind: 'stats', junk: 1 }, { kind: 'boards' }])), [{ kind: 'stats' }, { kind: 'boards' }]);
});
