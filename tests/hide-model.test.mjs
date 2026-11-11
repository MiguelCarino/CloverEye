import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as H from '../ui/js/hide-model.js';

const q = (n) => `<a href="#p${n}" class="quotelink">&gt;&gt;${n}</a>`;
const op = { no: 1, resto: 0, com: 'OP' };
const p = (no, ...quotes) => ({ no, resto: 1, com: quotes.length ? quotes.map(q).join('<br>') + '<br>text' : 'text' });
const obj = (m) => Object.fromEntries(m);

test('hiddenPosts: by hand and by a filter, with their reasons; nothing else', () => {
  const posts = [op, p(2), p(3), p(4)];
  const marks = new Map([[2, 'hidden'], [3, 'hide'], [4, 'highlight']]);
  assert.deepEqual(obj(H.hiddenPosts(posts, marks)), { 2: { reason: 'hidden' }, 3: { reason: 'filter' } });
  assert.equal(H.hiddenPosts(posts).size, 0);
  assert.equal(H.hiddenPosts(null, marks).size, 0);
});

test('hiddenPosts: replies that quote only hidden posts are hidden, down the chain', () => {
  const posts = [op, p(2), p(3, 2), p(4, 3), p(5, 2, 6), p(6), p(7, 4, 3), p(8, 99, 2)];
  const marks = new Map([[2, 'hidden']]);
  assert.deepEqual(obj(H.hiddenPosts(posts, marks)), {
    2: { reason: 'hidden' },
    3: { reason: 'reply', via: 2 },
    4: { reason: 'reply', via: 3 },
    7: { reason: 'reply', via: 4 },
    // 5 also quotes 6, which is shown; 8's other quote is not in the thread
    8: { reason: 'reply', via: 2 },
  });
});

test('hiddenPosts: the setting off, quotes of the OP, your posts and highlighted posts', () => {
  const posts = [op, p(2), p(3, 2), p(4, 1, 2), p(5, 2), p(6, 1), p(7, 2)];
  const marks = new Map([[1, 'hidden'], [2, 'hide'], [7, 'highlight']]);
  assert.deepEqual([...H.hiddenPosts(posts, marks, { replies: false }).keys()], [1, 2]);
  const all = H.hiddenPosts(posts, marks, { keep: new Set([5]) });
  // 4 quotes the (hidden) OP and 2: only 2 counts; 6 quotes only the OP
  assert.deepEqual([...all.keys()].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(all.get(4).via, 2);
});

test('hiddenPosts: a post quoting itself or a later hidden post', () => {
  const posts = [op, p(2, 2), p(3, 4), p(4)];
  const marks = new Map([[4, 'hidden']]);
  assert.deepEqual(obj(H.hiddenPosts(posts, marks)), { 3: { reason: 'reply', via: 4 }, 4: { reason: 'hidden' } });
  assert.equal(H.hiddenPosts([op, p(2, 2)], new Map([[1, 'hide']])).has(2), false);
});

test('hiddenCounts', () => {
  const m = new Map([[1, { reason: 'hidden' }], [2, { reason: 'reply', via: 1 }], [3, { reason: 'reply', via: 1 }], [4, { reason: 'filter' }]]);
  assert.deepEqual(H.hiddenCounts(m), { hidden: 1, filter: 1, reply: 2, total: 4 });
  assert.deepEqual(H.hiddenCounts(new Map()), { hidden: 0, filter: 0, reply: 0, total: 0 });
  assert.deepEqual(H.hiddenCounts(null).total, 0);
  assert.deepEqual(H.HIDE_REASONS, ['hidden', 'filter', 'reply']);
});
