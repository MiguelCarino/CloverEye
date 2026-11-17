import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../ui/js/columns-model.js';
import * as T from '../ui/js/tabs-model.js';
import { panesFromHash } from '../ui/js/browse-model.js';
import { normalizeDisplay } from '../ui/js/display-model.js';

const thread = (extra = {}) => ({ kind: 'thread', board: 'g', no: 5, ...extra });

test('layoutOf: the tab’s own choice, else Settings, else a list; only threads have one', () => {
  assert.equal(C.layoutOf(thread(), null), 'list');
  assert.equal(C.layoutOf(thread(), { threadLayout: 'columns' }), 'columns', 'new threads take the default');
  assert.equal(C.layoutOf(thread({ layout: 'list' }), { threadLayout: 'columns' }), 'list', 'the tab chose');
  assert.equal(C.layoutOf(thread({ layout: 'columns' }), { threadLayout: 'list' }), 'columns');
  assert.equal(C.layoutOf(thread({ layout: 'rows' }), { threadLayout: 'columns' }), 'columns', 'junk: the default');
  assert.equal(C.layoutOf({ kind: 'offline', board: 'g', no: 5, layout: 'columns' }, null), 'columns', 'a saved copy too');
  assert.equal(C.layoutOf({ kind: 'board', board: 'g', layout: 'columns' }, { threadLayout: 'columns' }), 'list');
  assert.equal(C.layoutDefault(normalizeDisplay({ threadLayout: 'columns' })), 'columns');
  assert.equal(C.layoutDefault(normalizeDisplay({ threadLayout: 'sideways' })), 'list');
});

test('flipLayout: a new view with the other layout; carryLayout keeps it for the same thread', () => {
  const v = thread();
  const f = C.flipLayout(v, null);
  assert.deepEqual(f, thread({ layout: 'columns' }));
  assert.notEqual(f, v, 'a new object (history keeps the old one)');
  assert.deepEqual(C.flipLayout(f, null), thread({ layout: 'list' }));
  assert.deepEqual(C.flipLayout(thread(), { threadLayout: 'columns' }), thread({ layout: 'list' }));
  const b = { kind: 'board', board: 'g' };
  assert.equal(C.flipLayout(b, null), b);

  assert.deepEqual(C.carryLayout(thread({ layout: 'columns' }), thread()), thread({ layout: 'columns' }), 'a link to the thread shown');
  assert.deepEqual(C.carryLayout({ kind: 'offline', board: 'g', no: 5, layout: 'columns' }, thread()), thread({ layout: 'columns' }), 'Open live thread');
  assert.deepEqual(C.carryLayout(thread({ layout: 'columns' }), thread({ no: 6 })), thread({ no: 6 }), 'another thread: the default');
  assert.deepEqual(C.carryLayout(thread({ layout: 'columns' }), thread({ layout: 'list' })), thread({ layout: 'list' }), 'said: kept');
  assert.deepEqual(C.carryLayout(thread(), thread()), thread());
  assert.deepEqual(C.carryLayout(thread({ layout: 'columns' }), b), b);
});

test('the layout goes with the view in the window’s address (#panes=)', () => {
  const panes = [{ tabs: [thread({ layout: 'columns' }), { kind: 'board', board: 'g' }, thread({ no: 6 })], active: 0 }, { kind: 'offline', board: 'diy', no: 7, layout: 'list' }];
  const out = T.decodePanes(`#panes=${T.encodePanes(panes)}`);
  assert.deepEqual(out[0].tabs[0], thread({ layout: 'columns' }));
  assert.deepEqual(out[0].tabs[2], thread({ no: 6 }), 'no choice: none written');
  assert.deepEqual(out[1].tabs[0], { kind: 'offline', board: 'diy', no: 7, layout: 'list' });
  assert.deepEqual(panesFromHash(`#panes=${T.encodePanes(panes)}`)[0], thread({ layout: 'columns' }));
  assert.deepEqual(T.cleanView(thread({ layout: 'sideways' })), thread(), 'junk dropped');
  assert.deepEqual(T.cleanView({ kind: 'board', board: 'g', layout: 'columns' }), { kind: 'board', board: 'g' });
  // an older address (no layout) still opens
  assert.deepEqual(T.decodePanes(`#panes=${encodeURIComponent(JSON.stringify([thread()]))}`)[0].tabs[0], thread());
});

test('axis helpers: the start and end of a box down a list or along columns', () => {
  const r = { top: 10, bottom: 50, left: 100, right: 400 };
  assert.equal(C.axisOf('columns'), 'x');
  assert.equal(C.axisOf('list'), 'y');
  assert.equal(C.axisOf(undefined), 'y');
  assert.equal(C.startOf(r, 'y'), 10);
  assert.equal(C.endOf(r, 'y'), 50);
  assert.equal(C.startOf(r, 'x'), 100);
  assert.equal(C.endOf(r, 'x'), 400);
});

test('firstInView: the first item whose end is past the view’s start (binary search)', () => {
  // columns 300 px wide: posts 0-2 in column 0, 3-4 in column 1, 5 in column 2
  const ends = [300, 300, 300, 610, 610, 920];
  const at = (start) => C.firstInView(ends.length, (i) => ends[i], start);
  assert.equal(at(0), 0);
  assert.equal(at(299), 0);
  assert.equal(at(300), 3, 'column 0 scrolled out: the first post of column 1');
  assert.equal(at(700), 5);
  assert.equal(at(920), -1, 'all scrolled past');
  assert.equal(C.firstInView(0, () => 0, 0), -1);
  // a list: bottoms going down
  const bottoms = [120, 260, 400];
  assert.equal(C.firstInView(3, (i) => bottoms[i], 130), 1);
});

test('anchorShift: how far an anchor moved, under a pixel is nothing', () => {
  assert.equal(C.anchorShift(500, 100, 0), 400, 'pushed into the next column');
  assert.equal(C.anchorShift(100.4, 100, 0), 0);
  assert.equal(C.anchorShift(80, 100, -20), 0, 'a post begun in the column before');
  assert.equal(C.anchorShift(60, 100, -20), -20);
});

test('columnMetrics: as many columns as fit, at least one as wide as the box', () => {
  assert.deepEqual(C.columnMetrics(1000, 448, 24), { count: 2, width: 488, step: 512 });
  assert.deepEqual(C.columnMetrics(328, 448, 24), { count: 1, width: 328, step: 352 }, 'a phone: one column, the pane wide');
  assert.deepEqual(C.columnMetrics(1416, 448, 24), { count: 3, width: 456, step: 480 });
  assert.equal(C.columnMetrics(0, 448, 24).count, 1);
  assert.equal(C.columnMetrics(500, 0, 10).count, 1);
});

test('columnStop and keyScroll: a column at a time, a page of columns, either end', () => {
  const box = { pos: 0, step: 512, count: 2, max: 3000 };
  assert.equal(C.columnStop(0, 512, 1, 3000), 512);
  assert.equal(C.columnStop(511, 512, 1, 3000), 1024, 'a hair before a column counts as on it');
  assert.equal(C.columnStop(700, 512, 1, 3000), 1024);
  assert.equal(C.columnStop(700, 512, -1, 3000), 512);
  assert.equal(C.columnStop(512, 512, -1, 3000), 0);
  assert.equal(C.columnStop(2900, 512, 1, 3000), 3000, 'kept in range');
  assert.equal(C.columnStop(0, 512, -1, 3000), 0);
  assert.equal(C.columnStop(40, 0, 1, 3000), 40, 'no step: stays');
  assert.equal(C.keyScroll({ key: 'ArrowRight' }, box), 512);
  assert.equal(C.keyScroll({ key: 'ArrowDown' }, box), 512);
  assert.equal(C.keyScroll({ key: 'ArrowLeft' }, { ...box, pos: 1024 }), 512);
  assert.equal(C.keyScroll({ key: 'ArrowUp' }, { ...box, pos: 1024 }), 512);
  assert.equal(C.keyScroll({ key: 'PageDown' }, box), 1024, 'the columns in sight');
  assert.equal(C.keyScroll({ key: 'PageUp' }, { ...box, pos: 2048 }), 1024);
  assert.equal(C.keyScroll({ key: ' ' }, box), 1024);
  assert.equal(C.keyScroll({ key: ' ', shiftKey: true }, { ...box, pos: 2048 }), 1024);
  assert.equal(C.keyScroll({ key: 'PageDown' }, { ...box, count: 1, step: 352 }), 352, 'a phone: a page is a column');
  assert.equal(C.keyScroll({ key: 'Home' }, { ...box, pos: 2048 }), 0);
  assert.equal(C.keyScroll({ key: 'End' }, box), 3000);
  assert.equal(C.keyScroll({ key: 'a' }, box), null);
  assert.equal(C.keyScroll({ key: 'Enter' }, box), null);
});

test('wheelPixels: the wheel’s up-down turns sideways; Shift, zoom and sideways gestures are left alone', () => {
  assert.equal(C.wheelPixels({ deltaY: 100, deltaX: 0, deltaMode: 0 }, 800), 100);
  assert.equal(C.wheelPixels({ deltaY: -100, deltaX: 0, deltaMode: 0 }, 800), -100);
  assert.equal(C.wheelPixels({ deltaY: 3, deltaX: 0, deltaMode: 1 }, 800), 3 * C.LINE_PX, 'lines');
  assert.equal(C.wheelPixels({ deltaY: 1, deltaX: 0, deltaMode: 2 }, 800), 800, 'a page');
  assert.equal(C.wheelPixels({ deltaY: 100, deltaX: 0, deltaMode: 0, shiftKey: true }, 800), 0, 'Shift: the webview scrolls sideways itself');
  assert.equal(C.wheelPixels({ deltaY: 100, deltaX: 0, deltaMode: 0, ctrlKey: true }, 800), 0, 'zoom');
  assert.equal(C.wheelPixels({ deltaY: 10, deltaX: 30, deltaMode: 0 }, 800), 0, 'a touchpad going sideways');
  assert.equal(C.wheelPixels({ deltaY: 0, deltaX: 0, deltaMode: 0 }, 800), 0);
  assert.equal(C.wheelGlides(100, 0), true, 'a mouse notch glides');
  assert.equal(C.wheelGlides(4, 0), false, 'a touchpad step is followed');
  assert.equal(C.wheelGlides(3, 1), true);
});

test('canScrollY: an inner box keeps the wheel while it can still go that way', () => {
  assert.equal(C.canScrollY({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }, 10), false, 'nothing to scroll');
  assert.equal(C.canScrollY({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 }, 10), true);
  assert.equal(C.canScrollY({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 }, -10), false, 'at its top');
  assert.equal(C.canScrollY({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 }, 10), false, 'at its end');
  assert.equal(C.canScrollY({ scrollTop: 200, scrollHeight: 300, clientHeight: 100 }, -10), true);
});

test('glideStep: most of the way in about a tenth of a second, then exactly there', () => {
  let pos = 0;
  let t = 0;
  while (pos !== 500 && t < 1000) {
    pos = C.glideStep(pos, 500, 16);
    t += 16;
  }
  assert.equal(pos, 500);
  assert.ok(t <= 400, `arrived in ${t} ms`);
  const tenth = C.glideStep(0, 500, 100);
  assert.ok(tenth > 400 && tenth < 500, `${tenth} after 100 ms`);
  assert.equal(C.glideStep(499.5, 500, 16), 500);
  assert.equal(C.glideStep(100, 100, 16), 100);
  assert.equal(C.glideStep(0, -300, 0), 0, 'no time, no move');
});

test('revealPos: a post’s column first, or left alone when it is wholly in sight', () => {
  const box = { pos: 512, view: 1000, max: 3000 };
  assert.equal(C.revealPos({ ...box, start: 1024, end: 1500, align: 'start' }), 1024);
  assert.equal(C.revealPos({ ...box, start: 1024, end: 1500, align: 'center' }), 512, 'in sight already');
  assert.equal(C.revealPos({ ...box, start: 1536, end: 2000, align: 'center' }), 1536, 'out of sight: its column first');
  assert.equal(C.revealPos({ ...box, start: 0, end: 400, align: 'nearest' }), 0);
  assert.equal(C.revealPos({ ...box, start: 3500, end: 3900 }), 3000, 'kept in range');
  assert.equal(C.revealPos({ ...box, start: 1024, end: 2600, align: 'center' }), 1024, 'taller than the view: its start');
});

test('placeAfterSwitch: straight back, its own place; else the post in sight leads', () => {
  assert.deepEqual(C.placeAfterSwitch({ pos: 800, no: 12 }, null), { no: 12 }, 'first switch: the post first in sight');
  assert.deepEqual(C.placeAfterSwitch({ pos: 0 }, null), { pos: 0 }, 'at the top');
  const memo = { arrived: 1024 };
  assert.deepEqual(C.placeAfterSwitch({ pos: 1024, no: 12 }, memo), { back: true }, 'nothing moved since: back where it was');
  assert.deepEqual(C.placeAfterSwitch({ pos: 1024.6, no: 12 }, memo), { back: true }, 'rounding');
  assert.deepEqual(C.placeAfterSwitch({ pos: 2048, no: 30 }, memo), { no: 30 }, 'read on meanwhile: from there');
  assert.deepEqual(C.placeAfterSwitch({ pos: 2048, no: '30' }, memo), { no: 30 });
  assert.deepEqual(C.placeAfterSwitch({ pos: 1024, no: 12 }, { arrived: NaN }), { no: 12 });
});

test('columnsHeight: what the body has left below the bar, never nothing', () => {
  assert.equal(C.columnsHeight({ top: 120, bottom: 780 }), 660);
  assert.equal(C.columnsHeight({ top: 120, bottom: 780.9, after: 40.5 }), 620, 'whole px, rounded down');
  assert.equal(C.columnsHeight({ top: 700, bottom: 780 }), C.MIN_COLUMNS_H, 'a tiny pane: the least height');
  assert.equal(C.columnsHeight({ top: 0, bottom: 0, min: 0 }), 1, 'never no height at all');
  assert.equal(C.columnsHeight({ top: NaN, bottom: undefined }), C.MIN_COLUMNS_H);
});

test('setScroll / isRestoreAnyAxis: a columns box put back sideways is not the reader scrolling', async () => {
  const { setScroll, isRestoreAnyAxis, scrollPos, isColumnsBox } = await import('../ui/js/columns.js');
  const box = { classList: { contains: (c) => c === 'thread--columns' }, scrollLeft: 0, scrollTop: 0 };
  assert.equal(isColumnsBox(box), true);
  setScroll(box, 1024);
  assert.equal(scrollPos(box), 1024);
  assert.equal(isRestoreAnyAxis({ target: box }), true, 'the restore taking effect');
  assert.equal(isRestoreAnyAxis({ target: box }), true, 'asked by several listeners');
  box.scrollLeft = 1100;
  assert.equal(isRestoreAnyAxis({ target: box }), false, 'scrolled by the reader');
  assert.equal(isRestoreAnyAxis({ target: box }), false, 'and from then on');
  // a list (a pane body) goes through dom.js restoreScroll
  const body = { classList: { contains: () => false }, scrollTop: 0, scrollLeft: 0 };
  setScroll(body, 300);
  assert.equal(scrollPos(body), 300);
  assert.equal(isRestoreAnyAxis({ target: body }), true);
  body.scrollTop = 10;
  assert.equal(isRestoreAnyAxis({ target: body }), false);
  assert.equal(isRestoreAnyAxis(null), false);
});
