import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Q from '../ui/js/quote-model.js';

test('a click opens inline by default; Ctrl/⌘ or the setting jumps, and Ctrl/⌘ turns the setting round', () => {
  assert.equal(Q.quoteClickAction('inline', {}), 'inline');
  assert.equal(Q.quoteClickAction('inline', { ctrlKey: true }), 'jump');
  assert.equal(Q.quoteClickAction('inline', { metaKey: true }), 'jump');
  assert.equal(Q.quoteClickAction('jump', {}), 'jump');
  assert.equal(Q.quoteClickAction('jump', { ctrlKey: true }), 'inline');
  assert.equal(Q.quoteClickAction(undefined), 'inline');
  assert.deepEqual(Q.QUOTE_LINK_MODES, ['inline', 'jump']);
});

test('where a link points: this thread, another thread (left for later), or nowhere', () => {
  const here = { board: 'g', thread: 100 };
  assert.deepEqual(Q.quoteTarget({ target: 105 }, here), { kind: 'local', no: 105 });
  assert.deepEqual(Q.quoteTarget({ target: 105, board: 'g', thread: 100 }, here), { kind: 'local', no: 105 });
  assert.deepEqual(Q.quoteTarget({ target: 7, board: 'g', thread: 5 }, here), { kind: 'cross', board: 'g', thread: 5, no: 7 });
  assert.deepEqual(Q.quoteTarget({ target: 7, board: 'v', thread: 100 }, here), { kind: 'cross', board: 'v', thread: 100, no: 7 });
  assert.deepEqual(Q.quoteTarget({ target: null }, here), { kind: 'none' });
  assert.deepEqual(Q.quoteTarget({ target: -3 }, here), { kind: 'none' });
});

test('paths name opened copies and read back', () => {
  const a = Q.childPath('123', 'q', 456);
  const b = Q.childPath(a, 'b', 789, 1);
  assert.equal(a, '123/q456');
  assert.equal(b, '123/q456/b789.1');
  assert.deepEqual(Q.parsePath(b), {
    root: 123,
    steps: [
      { kind: 'q', target: 456, nth: 0 },
      { kind: 'b', target: 789, nth: 1 },
    ],
  });
  assert.equal(Q.parsePath('x/q1'), null);
  assert.equal(Q.parsePath('1/z2'), null);
  assert.equal(Q.parsePath('1/q0'), null);
  assert.deepEqual(Q.chainOf(b), [123, 456, 789]);
  assert.deepEqual(Q.chainOf('junk'), []);
  assert.equal(Q.pathSlug(b), '123_q456_b789_1');
});

test('a post never opens inside itself, at any depth', () => {
  assert.equal(Q.canExpand('5', 5), false, 'a post quoting itself');
  assert.equal(Q.canExpand('5/q3', 5), false, "the quoted post's backlink back to the post");
  assert.equal(Q.canExpand('5/q3/q2', 3), false);
  assert.equal(Q.canExpand('5/q3/q2', 9), true);
  assert.equal(Q.canExpand('5', 3), true);
  // Deep chains stay allowed as long as no post repeats.
  let path = '1';
  for (let n = 2; n < 50; n++) {
    assert.equal(Q.canExpand(path, n), true);
    path = Q.childPath(path, 'q', n);
  }
  assert.equal(Q.canExpand(path, 25), false);
});

test('closing a copy closes the ones opened inside it; replay opens outer ones first', () => {
  let s = new Set();
  s = Q.expandPath(s, '1/q2');
  s = Q.expandPath(s, '1/q2/b3');
  s = Q.expandPath(s, '1/q20');
  s = Q.expandPath(s, 'nonsense');
  assert.deepEqual([...s].sort(), ['1/q2', '1/q2/b3', '1/q20']);
  assert.deepEqual(Q.replayOrder(['1/q2/b3', '4/b1', '1/q2', 'bad']), ['1/q2', '4/b1', '1/q2/b3']);
  const closed = Q.collapsePath(s, '1/q2');
  assert.deepEqual([...closed], ['1/q20'], '1/q20 is a sibling, not inside 1/q2');
  assert.ok(Q.isWithin('1/q2/b3', '1/q2'));
  assert.ok(!Q.isWithin('1/q20', '1/q2'));
});

test('the preview goes below the link, or above when there is more room, never over it', () => {
  const vw = 1200;
  const vh = 800;
  const low = Q.placeQuotePreview({ link: { left: 100, top: 100, right: 140, bottom: 120 }, w: 500, h: 300, vw, vh });
  assert.equal(low.top, 126);
  assert.ok(low.top >= 120);
  assert.equal(low.left, 100);
  assert.equal(low.width, 500);
  const high = Q.placeQuotePreview({ link: { left: 100, top: 700, right: 140, bottom: 720 }, w: 500, h: 300, vw, vh });
  assert.equal(high.top + 300, 694, 'ends above the link');
  assert.ok(high.top + 300 <= 700);
  // Too tall for either side: the bigger side, capped.
  const tall = Q.placeQuotePreview({ link: { left: 100, top: 300, right: 140, bottom: 320 }, w: 500, h: 2000, vw, vh });
  assert.equal(tall.top, 326);
  assert.equal(tall.maxHeight, 800 - 320 - 6 - 12);
  // Kept inside a narrow window.
  const narrow = Q.placeQuotePreview({ link: { left: 700, top: 100, right: 740, bottom: 120 }, w: 900, h: 200, vw: 800, vh });
  assert.equal(narrow.width, 640);
  assert.equal(narrow.left, 800 - 12 - 640);
  assert.equal(Q.previewWidth(300), 276);
  assert.equal(Q.previewWidth(2000), 640);
});

test('another thread’s post: an x step, left out of the loop guard', () => {
  const x = Q.childPath('123/q456', 'x', 456, 1);
  assert.equal(x, '123/q456/x456.1');
  assert.deepEqual(Q.parsePath(x).steps[1], { kind: 'x', target: 456, nth: 1 });
  assert.deepEqual(Q.chainOf(x), [123, 456]);
  assert.equal(Q.canExpand('5', 5), false);
  assert.equal(Q.canExpand('5/x7', 7), true, 'No. 7 of another thread is not this thread’s No. 7');
  assert.deepEqual([...Q.collapsePath(new Set(['5/x7', '5/q6']), '5/x7')], ['5/q6']);
  assert.deepEqual(Q.replayOrder(['5/q6/b8', '5/x7']), ['5/x7', '5/q6/b8']);
  assert.equal(Q.crossKey('g', 99), 'g/99');
});

test('crossState: loading, the post, missing, gone or failed', () => {
  const posts = new Map([[7, { no: 7 }]]);
  assert.equal(Q.crossState(undefined, 7), 'loading');
  assert.equal(Q.crossState({ status: 'loading' }, 7), 'loading');
  assert.equal(Q.crossState({ status: 'ok', posts }, 7), 'post');
  assert.equal(Q.crossState({ status: 'ok', posts }, 8), 'missing');
  assert.equal(Q.crossState({ status: 'loading', posts }, 8), 'loading', 'asked again: maybe it is new');
  assert.equal(Q.crossState({ status: 'loading', posts }, 7), 'post', 'the old copy while asking again');
  assert.equal(Q.crossState({ status: 'error', posts }, 7), 'post');
  assert.equal(Q.crossState({ status: 'gone' }, 7), 'gone');
  assert.equal(Q.crossState({ status: 'error' }, 7), 'error');
});

test('crossStale: asked again when missing, old or failed a while ago; never while loading or once gone', () => {
  const now = 100_000;
  assert.equal(Q.crossStale(undefined, now, 60_000), true);
  assert.equal(Q.crossStale({ status: 'loading' }, now, 60_000), false);
  assert.equal(Q.crossStale({ status: 'gone', at: 0 }, now, 60_000), false);
  assert.equal(Q.crossStale({ status: 'error', at: now - 2000 }, now, 60_000), false, 'not again at once after a failure');
  assert.equal(Q.crossStale({ status: 'error', at: now - 10_000 }, now, 60_000), true);
  assert.equal(Q.crossStale({ status: 'error', at: now - 2000 }, now, 60_000, 1000), true);
  assert.equal(Q.crossStale({ status: 'ok', at: now - 1000 }, now, 60_000), false);
  assert.equal(Q.crossStale({ status: 'ok', at: now - 60_000 }, now, 60_000), true);
  assert.equal(Q.crossStale({ status: 'ok' }, now, 60_000), true);
});
