// Your own stats (Stats → You): counted per day on this computer, 90 days.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Y from '../ui/js/my-stats-model.js';

const now = new Date(2026, 10, 11, 15, 0, 0).getTime(); // local time
const DAY = 86_400_000;

test('dayKey and lastDays use local days, oldest first', () => {
  assert.equal(Y.dayKey(now), '2026-11-11');
  assert.deepEqual(Y.lastDays(now, 3), ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.equal(Y.lastDays(now, 90).length, 90);
  assert.equal(new Set(Y.lastDays(now, 400)).size, 400, 'no day twice, none skipped');
});

test('bump and applyDelta: counters, per-board time and threads', () => {
  const d = Y.emptyDelta();
  Y.bump(d, '2026-11-11', 'time', 30, 'g');
  Y.bump(d, '2026-11-11', 'time', 15, 'g');
  Y.bump(d, '2026-11-11', 'threads', 1, 'v');
  Y.bump(d, '2026-11-11', 'read', 12, 'g'); // read is not per board
  Y.bump(d, '2026-11-11', 'nope', 3);
  Y.bump(d, '2026-11-11', 'files', -2);
  Y.bump(d, 'yesterday', 'files', 2);
  const m = Y.applyDelta(Y.emptyMine(), d, now);
  const day = m.days['2026-11-11'];
  assert.equal(day.time, 45);
  assert.equal(day.threads, 1);
  assert.equal(day.read, 12);
  assert.equal(day.files, 0);
  assert.deepEqual(day.boards, { g: { time: 45, threads: 0 }, v: { time: 0, threads: 1 } });
  assert.deepEqual(Object.keys(m.days), ['2026-11-11']);
  const again = Y.applyDelta(m, d, now);
  assert.equal(again.days['2026-11-11'].time, 90, 'a delta adds');
  assert.equal(m.days['2026-11-11'].time, 45, 'not changed in place');
});

test('pruneMine keeps 90 days and nothing dated far ahead', () => {
  const m = Y.emptyMine();
  for (let i = 0; i < 120; i++) m.days[Y.dayKey(now - i * DAY)] = { ...Y.normalizeMine({ days: { x: {} } }).days.x, time: 60 };
  m.days['2027-05-01'] = { time: 5, boards: {} };
  const p = Y.pruneMine(Y.normalizeMine(m), now);
  const keys = Object.keys(p.days).sort();
  assert.equal(keys.length, 90);
  assert.equal(keys[keys.length - 1], '2026-11-11');
  assert.ok(!keys.includes('2027-05-01'));
});

test('normalizeMine drops garbage', () => {
  const m = Y.normalizeMine({ rev: 2, since: 5, days: { '2026-11-11': { time: 12.6, read: -1, boards: { g: { time: 3 }, 'G!': { time: 9 } } }, junk: {} }, counted: ['g/1', 'nope', 7] });
  assert.equal(m.rev, 2);
  assert.equal(m.days['2026-11-11'].time, 13);
  assert.equal(m.days['2026-11-11'].read, 0);
  assert.deepEqual(m.days['2026-11-11'].boards, { g: { time: 3, threads: 0 } });
  assert.deepEqual(Object.keys(m.days), ['2026-11-11']);
  assert.deepEqual(m.counted, ['g/1']);
  assert.deepEqual(Y.normalizeMine(null), Y.emptyMine());
});

test('replies to you count once, and only those made after counting began', () => {
  const since = now - DAY;
  const m = { ...Y.emptyMine(), since, counted: ['g/5'] };
  const d = Y.emptyDelta();
  assert.equal(Y.replyCounts(m, d, 'g', 5, now / 1000, since), false, 'already counted');
  assert.equal(Y.replyCounts(m, d, 'g', 6, now / 1000, since), true);
  d.counted.push('g/6');
  assert.equal(Y.replyCounts(m, d, 'g', 6, now / 1000, since), false, 'waiting to be stored');
  assert.equal(Y.replyCounts(m, d, 'g', 7, (since - 1000) / 1000, since), false, 'older than counting');
  assert.equal(Y.replyCounts(m, d, 'g', 8, now / 1000, null), false, 'counting never began');
  const stored = Y.applyDelta(m, d, now);
  assert.deepEqual(stored.counted, ['g/5', 'g/6']);
});

test('mergeDeltas adds counts and joins keys (a write that failed goes back)', () => {
  const a = Y.bump(Y.emptyDelta(), '2026-11-11', 'time', 30, 'g');
  a.counted.push('g/1');
  const b = Y.bump(Y.emptyDelta(), '2026-11-11', 'time', 15, 'g');
  Y.bump(b, '2026-11-10', 'posts', 2);
  b.counted.push('g/1', 'g/2');
  b.since = 7;
  const m = Y.mergeDeltas(a, b);
  assert.equal(m.days['2026-11-11'].time, 45);
  assert.deepEqual(m.days['2026-11-11'].boards.g, { time: 45, threads: 0 });
  assert.equal(m.days['2026-11-10'].posts, 2);
  assert.deepEqual(m.counted, ['g/1', 'g/2']);
  assert.equal(m.since, 7);
  assert.equal(Y.deltaEmpty(Y.emptyDelta()), true);
  assert.equal(Y.deltaEmpty(m), false);
});

test('totals, dailySeries and topBoards over today, 7 and 30 days', () => {
  const d = Y.emptyDelta();
  Y.bump(d, Y.dayKey(now), 'read', 10);
  Y.bump(d, Y.dayKey(now), 'time', 600, 'g');
  Y.bump(d, Y.dayKey(now - 3 * DAY), 'read', 5);
  Y.bump(d, Y.dayKey(now - 3 * DAY), 'time', 1200, 'v');
  Y.bump(d, Y.dayKey(now - 3 * DAY), 'threads', 4, 'v');
  Y.bump(d, Y.dayKey(now - 20 * DAY), 'read', 100);
  const m = Y.applyDelta(Y.emptyMine(), d, now);
  assert.equal(Y.totals(m, now, 1).read, 10);
  assert.equal(Y.totals(m, now, 7).read, 15);
  assert.equal(Y.totals(m, now, 30).read, 115);
  const series = Y.dailySeries(m, now, 30, 'read');
  assert.equal(series.length, 30);
  assert.deepEqual(series[29], { day: Y.dayKey(now), value: 10 });
  assert.equal(series.reduce((n, s) => n + s.value, 0), 115);
  assert.deepEqual(Y.topBoards(m, now, 30), [
    { board: 'v', time: 1200, threads: 4 },
    { board: 'g', time: 600, threads: 0 },
  ]);
  assert.deepEqual(Y.topBoards(m, now, 1), [{ board: 'g', time: 600, threads: 0 }]);
});

test('bars: scaled to the busiest day, empty days still drawn', () => {
  const b = Y.bars([{ day: 'a', value: 0 }, { day: 'b', value: 5 }, { day: 'c', value: 10 }], 32, 40, 1);
  assert.equal(b.length, 3);
  assert.equal(b[2].h, 40);
  assert.equal(b[1].h, 20);
  assert.equal(b[0].h, 1);
  assert.equal(b[2].y, 0);
  assert.equal(b[1].x, 11);
  assert.deepEqual(Y.bars([], 10, 10), []);
});

test('formatDuration', () => {
  assert.equal(Y.formatDuration(0), '0 s');
  assert.equal(Y.formatDuration(42), '42 s');
  assert.equal(Y.formatDuration(600), '10 min');
  assert.equal(Y.formatDuration(3600 + 5 * 60), '1 h 05 min');
});
