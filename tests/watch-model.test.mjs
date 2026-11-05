import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../ui/js/setup-model.js';
import { placePreview } from '../ui/js/hover.js';

test('defaults: sidebar shown, split 520 px, hover preview on, nothing watched', () => {
  const d = M.defaults();
  assert.deepEqual(d.ui, { railHidden: false, splitWidth: 520, hoverPreview: true, rows: 1 });
  assert.deepEqual(d.watched, []);
});

test('normalizeSettings keeps ui and watched, clamps and de-duplicates', () => {
  const s = M.normalizeSettings({
    ui: { railHidden: true, splitWidth: 99999, hoverPreview: false },
    watched: [
      { board: 'g', no: 5, title: 'x', seen: 7 },
      { board: 'g', no: 5, title: 'dup' },
      { board: 'BAD', no: 1 },
      { board: 'diy', no: -3 },
      { board: 'diy', no: 9, dead: true, junk: 1 },
    ],
  });
  assert.deepEqual(s.ui, { railHidden: true, splitWidth: M.SPLIT_MAX, hoverPreview: false, rows: 1 });
  assert.deepEqual(s.watched, [
    { board: 'g', no: 5, title: 'x', seen: 7, dead: false, archived: false },
    { board: 'diy', no: 9, title: '', seen: 0, dead: true, archived: false },
  ]);
  assert.equal(M.normalizeSettings({ ui: { splitWidth: 10 } }).ui.splitWidth, M.SPLIT_MIN);
});

test('toggleWatch, updateWatched, unreadCount', () => {
  let s = M.defaults();
  s = M.toggleWatch(s, { board: 'g', no: 100, title: 'T', seen: 104 });
  assert.ok(M.isWatched(s, 'g', 100));
  const same = M.updateWatched(s, 'g', 100, { seen: 104 });
  assert.equal(same, s, 'no change returns the same object');
  s = M.updateWatched(s, 'g', 100, { seen: 110, dead: true });
  assert.equal(s.watched[0].seen, 110);
  assert.equal(s.watched[0].dead, true);
  assert.equal(M.unreadCount([{ no: 100 }, { no: 110 }, { no: 111 }, { no: 115 }], 110), 2);
  assert.equal(M.unreadCount(null, 0), 0);
  s = M.toggleWatch(s, { board: 'g', no: 100 });
  assert.equal(s.watched.length, 0);
  let full = M.defaults();
  for (let i = 1; i <= M.MAX_WATCHED; i++) full = M.toggleWatch(full, { board: 'g', no: i });
  assert.equal(M.toggleWatch(full, { board: 'g', no: 9999 }), full, 'capped');
});

test('turning NSFW off drops watched threads on NSFW boards', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  let s = M.setNsfw(M.defaults(), true, { confirmedAdult: true, now });
  s = M.toggleWatch(s, { board: 'b', no: 1 });
  s = M.toggleWatch(s, { board: 'g', no: 2 });
  const off = M.setNsfw(s, false, { boards: [{ board: 'b', ws_board: 0 }, { board: 'g', ws_board: 1 }] });
  assert.deepEqual(off.watched.map((w) => w.board), ['g']);
  const reload = M.normalizeSettings({ ...s, nsfw: { enabled: false }, nsfwBoards: ['b'] });
  assert.deepEqual(reload.watched.map((w) => w.board), ['g']);
});

test('placePreview: beside the pointer, never outside the window, never upscaled', () => {
  const vw = 1280;
  const vh = 800;
  const small = placePreview({ x: 100, y: 400, w: 300, h: 200, vw, vh });
  assert.deepEqual([small.width, small.height], [300, 200], 'no upscaling');
  assert.ok(small.left > 100, 'right of the pointer when there is more room there');
  const big = placePreview({ x: 1100, y: 100, w: 4000, h: 3000, vw, vh });
  assert.ok(big.left + big.width <= 1100, 'left of the pointer near the right edge');
  assert.ok(big.left >= 0 && big.top >= 12 && big.top + big.height <= vh - 12);
  assert.ok(Math.abs(big.width / big.height - 4000 / 3000) < 0.01, 'keeps the aspect ratio');
  const tall = placePreview({ x: 640, y: 790, w: 500, h: 2000, vw, vh });
  assert.ok(tall.height <= vh - 24 && tall.top + tall.height <= vh - 12);
});
