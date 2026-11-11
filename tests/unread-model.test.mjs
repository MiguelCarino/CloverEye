import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as U from '../ui/js/unread-model.js';

const posts = (...nos) => nos.map((no) => ({ no }));

test('normalizeLastRead keeps valid marks, the newest MAX_LAST_READ', () => {
  assert.deepEqual(U.normalizeLastRead(null), {});
  assert.deepEqual(U.normalizeLastRead([1]), {});
  assert.deepEqual(U.normalizeLastRead({ 'g/1': 5, 'G/2': 3, 'g/x': 1, 'g/3': -1, 'g/4': 1.5, 'diy/9': 12 }), { 'g/1': 5, 'diy/9': 12 });
  const many = {};
  for (let i = 1; i <= U.MAX_LAST_READ + 10; i++) many[`g/${i}`] = i;
  const out = U.normalizeLastRead(many);
  assert.equal(Object.keys(out).length, U.MAX_LAST_READ);
  assert.equal(Object.keys(out)[0], 'g/11', 'the oldest go');
});

test('readOf: own mark or the watcher’s seen, whichever is further', () => {
  const s = { lastRead: { 'g/1': 10 }, watched: [{ board: 'g', no: 1, seen: 12 }, { board: 'g', no: 2, seen: 4 }] };
  assert.equal(U.readOf(s, 'g', 1), 12);
  assert.equal(U.readOf(s, 'g', 2), 4);
  assert.equal(U.readOf(s, 'g', 3), 0);
  assert.equal(U.readOf({}, 'g', 3), 0);
});

test('markRead only moves up, makes the thread newest, and moves seen', () => {
  const s = { lastRead: { 'g/1': 10, 'g/2': 20 }, watched: [{ board: 'g', no: 1, seen: 8, title: 't' }] };
  assert.equal(U.markRead(s, 'g', 1, 9), s, 'never down');
  assert.equal(U.markRead(s, 'g', 1, 10), s, 'same: unchanged');
  assert.equal(U.markRead(s, 'g', 1, 0), s);
  const n = U.markRead(s, 'g', 1, 15);
  assert.deepEqual(Object.entries(n.lastRead), [['g/2', 20], ['g/1', 15]]);
  assert.deepEqual(n.watched, [{ board: 'g', no: 1, seen: 15, title: 't' }]);
  assert.equal(s.lastRead['g/1'], 10, 'the old object is untouched');
  const fresh = U.markRead({}, 'a', 5, 7);
  assert.deepEqual(fresh.lastRead, { 'a/5': 7 });
});

test('markRead drops the oldest past MAX_LAST_READ', () => {
  let s = { lastRead: {} };
  for (let i = 1; i <= U.MAX_LAST_READ; i++) s.lastRead[`g/${i}`] = i;
  s = U.markRead(s, 'g', 999999, 5);
  assert.equal(Object.keys(s.lastRead).length, U.MAX_LAST_READ);
  assert.equal(s.lastRead['g/1'], undefined);
  assert.equal(s.lastRead['g/999999'], 5);
});

test('unreadPosts and firstUnread skip hidden posts and your own', () => {
  const list = posts(1, 2, 3, 4, 5);
  assert.deepEqual(U.unreadPosts(list, 2), [3, 4, 5]);
  assert.deepEqual(U.unreadPosts(list, 2, { skip: new Set([3]), isYou: (n) => n === 5 }), [4]);
  assert.equal(U.firstUnread(list, 2, { skip: new Set([3]) }), 4);
  assert.equal(U.firstUnread(list, 5), null);
  assert.deepEqual(U.unreadPosts(null, 0), []);
});

test('the New posts line: on open, after updates, and where it is drawn', () => {
  assert.equal(U.lineOnOpen(0), null, 'never read: no line');
  assert.equal(U.lineOnOpen(40), 40);
  // read everything up to the old last post: the line moves to the new ones
  assert.equal(U.lineAfterUpdate(40, 50, 50), 50);
  // scrolled up, posts still unread: it stays
  assert.equal(U.lineAfterUpdate(40, 45, 50), 40);
  // opened unread: the first update's new posts get the line
  assert.equal(U.lineAfterUpdate(null, 3, 50), 50);
  assert.equal(U.lineAfterUpdate(40, 45, 0), 40);
  assert.equal(U.lineBefore(posts(10, 20, 30), 20), 30);
  assert.equal(U.lineBefore(posts(10, 20, 30), 25), 30);
  assert.equal(U.lineBefore(posts(10, 20, 30), 30), null);
  assert.equal(U.lineBefore(posts(10, 20, 30), null), null);
});

test('lastOnScreen: the last post whose bottom is in view', () => {
  const items = [
    { no: 1, bottom: 100 },
    { no: 2, bottom: 300 },
    { no: 3, bottom: 600 },
    { no: 4, bottom: 900 },
  ];
  assert.equal(U.lastOnScreen(items, 50), 0);
  assert.equal(U.lastOnScreen(items, 100), 1);
  assert.equal(U.lastOnScreen(items, 595), 3, 'a few pixels out still counts');
  assert.equal(U.lastOnScreen(items, 899, 0), 3);
  assert.equal(U.lastOnScreen(items, 5000), 4);
  assert.equal(U.lastOnScreen([], 5000), 0);
});

test('titleWithCount', () => {
  assert.equal(U.titleWithCount('/g/ · x', 3), '(3) /g/ · x');
  assert.equal(U.titleWithCount('/g/ · x', 0), '/g/ · x');
});

test('onlyReadMarksDiffer: read marks and watched seen only', () => {
  const a = { theme: 'dark', lastRead: { 'g/1': 5 }, watched: [{ board: 'g', no: 1, title: 't', seen: 5 }] };
  assert.ok(U.onlyReadMarksDiffer(a, a));
  assert.ok(U.onlyReadMarksDiffer(a, U.markRead(a, 'g', 1, 9)));
  assert.ok(U.onlyReadMarksDiffer(a, { ...a, lastRead: { 'g/1': 5, 'v/2': 3 } }));
  assert.ok(!U.onlyReadMarksDiffer(a, { ...a, theme: 'light' }));
  assert.ok(!U.onlyReadMarksDiffer(a, { ...a, watched: [{ board: 'g', no: 1, title: 'other', seen: 5 }] }));
  assert.ok(!U.onlyReadMarksDiffer(a, { ...a, watched: [] }));
});
