import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as R from '../ui/js/redraw-model.js';
import { keepReadMarks, sameReadMarks, onlyReadMarksDiffer } from '../ui/js/unread-model.js';

const op = (extra = {}) => ({ no: 100, resto: 0, sub: 'Thread', com: 'OP', time: 1, replies: 2, images: 1, unique_ips: 2, ...extra });
const reply = (no, extra = {}) => ({ no, resto: 100, com: `reply ${no}`, time: no, ...extra });
const thread = () => [op(), reply(101), reply(102)];

test('samePosts: the same content in new arrays is the same', () => {
  const a = thread();
  assert.equal(R.samePosts(a, a), true);
  assert.equal(R.samePosts(a, thread()), true, 'a 304 or throttled answer parses into new objects');
  assert.equal(R.samePosts(a, a.slice(0, 2)), false, 'a different length');
  assert.equal(R.samePosts(a, [op(), reply(101, { com: 'edited' }), reply(102)]), false, 'a comment changed');
  assert.equal(R.samePosts(a, [op(), reply(101, { filedeleted: 1 }), reply(102)]), false, 'a file deleted');
  assert.equal(R.samePosts(a, [op({ closed: 1 }), reply(101), reply(102)]), false, 'the thread closed');
  assert.equal(R.samePosts(null, a), false);
  assert.equal(R.samePosts(a, undefined), false);
});

test('threadDelta: same, appended (OP counters may move), or changed', () => {
  const prev = thread();
  assert.deepEqual(R.threadDelta(prev, thread()), { kind: 'same' });
  const grown = [op({ replies: 3, images: 2, unique_ips: 3, bumplimit: 0, last_modified: 9 }), reply(101), reply(102), reply(103)];
  const d = R.threadDelta(prev, grown);
  assert.equal(d.kind, 'appended');
  assert.deepEqual(d.added.map((p) => p.no), [103]);
  assert.equal(R.threadDelta(prev, [op(), reply(102), reply(103)]).kind, 'changed', 'a post deleted in the middle, one added');
  assert.equal(R.threadDelta(prev, [op(), reply(101, { com: 'x' }), reply(102), reply(103)]).kind, 'changed', 'an old post edited');
  assert.equal(R.threadDelta(prev, [op({ closed: 1 }), reply(101), reply(102), reply(103)]).kind, 'changed', 'the thread closed');
  assert.equal(R.threadDelta(prev, [op({ archived: 1 }), reply(101), reply(102), reply(103)]).kind, 'changed', 'the thread archived');
  assert.equal(R.threadDelta(prev, [op({ sticky: 1 }), reply(101), reply(102), reply(103)]).kind, 'changed', 'made sticky');
  assert.equal(R.threadDelta(prev, [op({ replies: 9 }), reply(101), reply(102)]).kind, 'changed', 'counters alone, no new post');
  assert.equal(R.threadDelta(prev, prev.slice(0, 2)).kind, 'changed', 'a post gone from the end');
  assert.equal(R.threadDelta(undefined, prev).kind, 'changed', 'nothing before');
});

test('paneIndexes: a thread, a board, saved and live copies apart', () => {
  const views = [
    { kind: 'board', board: 'g' },
    { kind: 'thread', board: 'g', no: 1 },
    { kind: 'offline', board: 'g', no: 1 },
    { kind: 'thread', board: 'v', no: 1 },
    null,
    { kind: 'thread', board: 'g', no: 1 },
  ];
  assert.deepEqual(R.paneIndexes(views, R.showsThread('g', 1)), [1, 5]);
  assert.deepEqual(R.paneIndexes(views, R.showsSaved('g', 1)), [2]);
  assert.deepEqual(R.paneIndexes(views, R.usesCatalog('g')), [0, 1, 5], 'the catalog and its threads, not the saved copy');
  assert.deepEqual(R.paneIndexes(views, R.usesCatalog('v')), [3]);
  assert.deepEqual(R.paneIndexes(views, (v) => v.kind === 'stats'), []);
  assert.deepEqual(R.paneIndexes(undefined, () => true), []);
});

test('askKey changes only with the target thread or its title', () => {
  const t = { kind: 'thread', board: 'g', no: 1, title: 'A' };
  assert.equal(R.askKey(null), '');
  assert.equal(R.askKey(t), R.askKey({ ...t }));
  assert.notEqual(R.askKey(t), R.askKey({ ...t, title: 'B' }));
  assert.notEqual(R.askKey(t), R.askKey({ ...t, no: 2 }));
  assert.notEqual(R.askKey(t), R.askKey({ ...t, kind: 'offline' }));
});

test('quietUpdate: only the same posts after a good load', () => {
  const prev = { status: 'ok', posts: thread() };
  assert.equal(R.quietUpdate(prev, thread()), true);
  assert.equal(R.quietUpdate({ ...prev, status: 'error' }, thread()), false, 'the error box has to go');
  assert.equal(R.quietUpdate({ ...prev, gone: true }, thread()), false);
  assert.equal(R.quietUpdate(prev, [...thread(), reply(103)]), false);
  assert.equal(R.quietUpdate(undefined, thread()), false, 'a first load draws');
  assert.equal(R.quietUpdate({ status: 'ok' }, thread()), false);
});

// Settings from another window (shell.js applySettings): read marks never
// go down, and an unchanged mark set is seen as unchanged.
test('keepReadMarks: the higher mark wins, nothing else changes', () => {
  const local = { lastRead: { 'g/1': 50, 'g/2': 10 }, watched: [{ board: 'g', no: 1, seen: 50, title: 'A' }] };
  const incoming = { theme: 'dark', lastRead: { 'g/2': 20, 'g/1': 40, 'v/3': 5 }, watched: [{ board: 'g', no: 1, seen: 40, title: 'B' }] };
  const out = keepReadMarks(local, incoming);
  assert.deepEqual(out.lastRead, { 'g/2': 20, 'g/1': 50, 'v/3': 5 });
  assert.deepEqual(out.watched, [{ board: 'g', no: 1, seen: 50, title: 'B' }], 'only seen comes from here');
  assert.equal(out.theme, 'dark');
  assert.deepEqual(incoming.lastRead, { 'g/2': 20, 'g/1': 40, 'v/3': 5 }, 'incoming is not changed');
  const ahead = { lastRead: { 'g/1': 60 }, watched: [{ board: 'g', no: 1, seen: 60 }] };
  assert.equal(keepReadMarks(local, ahead), ahead, 'already as far: the same object');
  assert.equal(keepReadMarks(local, { lastRead: {}, watched: [] }).lastRead['g/1'], undefined, 'a mark dropped there stays dropped');
});

test('sameReadMarks ignores key order; onlyReadMarksDiffer still sees other changes', () => {
  const a = { lastRead: { 'g/1': 1, 'g/2': 2 }, watched: [{ board: 'g', no: 1, seen: 3 }] };
  const b = { lastRead: { 'g/2': 2, 'g/1': 1 }, watched: [{ board: 'g', no: 1, seen: 3 }] };
  assert.equal(sameReadMarks(a, b), true);
  assert.equal(sameReadMarks(a, { ...b, lastRead: { 'g/1': 1, 'g/2': 3 } }), false);
  assert.equal(sameReadMarks(a, { ...b, watched: [{ board: 'g', no: 1, seen: 4 }] }), false);
  assert.equal(onlyReadMarksDiffer(a, { ...b, lastRead: { 'g/1': 9 } }), true);
  assert.equal(onlyReadMarksDiffer(a, { ...a, theme: 'light' }), false);
});

// ?mock-big=N (bridge.js): big threads for measuring redraws.
test('mock-big: N replies, the same each time, quoting earlier posts', async () => {
  const { mockOptionsFromSearch, bigReplies, MOCK_BIG_MAX } = await import('../ui/js/bridge.js');
  assert.deepEqual(mockOptionsFromSearch('?mock-big=400'), { big: 400 });
  assert.deepEqual(mockOptionsFromSearch('?mock-big=0'), {});
  assert.deepEqual(mockOptionsFromSearch('?mock-big=99999999'), { big: MOCK_BIG_MAX });
  const op = { no: 500010, time: 1000 };
  const a = bigReplies(op, 400, ['A', 'B']);
  assert.equal(a.length, 400);
  assert.deepEqual(a, bigReplies(op, 400, ['A', 'B']), 'the same for the same thread');
  assert.ok(a.every((p, i) => p.resto === op.no && (i === 0 || p.no > a[i - 1].no)), 'replies, in order');
  const quoting = a.filter((p) => p.com.includes('class="quotelink"')).length;
  assert.ok(quoting > 200 && quoting < 320, String(quoting));
  const files = a.filter((p) => p.tim).length;
  assert.ok(files > 70 && files < 160, String(files));
  assert.ok(a.filter((p) => p.tim).every((p) => /^[A-Za-z0-9+/]{22}==$/.test(p.md5)), 'md5 as the site sends it');
});

// dom.js: a scroll that only puts a redrawn pane back is not the person's
// (post-menu.js and the shell's scroll handlers ask).
test('restoreScroll / isRestoreScroll', async () => {
  const { restoreScroll, isRestoreScroll } = await import('../ui/js/dom.js');
  const el = { scrollTop: 0 };
  restoreScroll(el, 120);
  assert.equal(el.scrollTop, 120);
  assert.equal(isRestoreScroll({ target: el }), true, 'the restore taking effect');
  assert.equal(isRestoreScroll({ target: el }), true, 'still there: asked by several listeners');
  el.scrollTop = 300;
  assert.equal(isRestoreScroll({ target: el }), false, 'scrolled by the person');
  el.scrollTop = 120;
  assert.equal(isRestoreScroll({ target: el }), false, 'and from then on');
  assert.equal(isRestoreScroll({ target: { scrollTop: 5 } }), false, 'never restored');
  assert.equal(isRestoreScroll(null), false);
});

// ?mock-grow with ?mock-big: each later fetch adds one reply at the end that
// quotes an earlier post, which is what the shell adds in place (browse.js
// updateThreadView); without ?mock-big the new reply quotes nothing.
test('mock-grow: a later fetch only appends a reply (quoting one, with mock-big)', async () => {
  const { readFileSync } = await import('node:fs');
  const { createBridge } = await import('../ui/js/bridge.js');
  const catalog = readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8');
  const fetchImpl = async (url) => {
    assert.equal(url, 'data/catalog.sample.json');
    return { ok: true, status: 200, json: async () => JSON.parse(catalog) };
  };
  const no = JSON.parse(catalog)[0].threads[0].no;
  const big = createBridge({ fetchImpl, mock: { delayMs: 0, grow: true, big: 30 } });
  const first = (await big.fetchThread('g', no)).data.posts;
  const second = (await big.fetchThread('g', no)).data.posts;
  const d = R.threadDelta(first, second);
  assert.equal(d.kind, 'appended');
  assert.equal(d.added.length, 1);
  const target = Number(/#p(\d+)/.exec(d.added[0].com)?.[1]);
  assert.ok(first.some((p) => p.no === target), 'it quotes a post already there');
  assert.match(d.added[0].com, /New reply 1$/);
  const plain = createBridge({ fetchImpl, mock: { delayMs: 0, grow: true } });
  await plain.fetchThread('g', no);
  const grown = (await plain.fetchThread('g', no)).data.posts;
  assert.equal(grown[grown.length - 1].com, 'New reply 1');
});

// post-menu.js: a click on a "…" button drawn anew (same data-key) is a
// click on the open menu's own button: it closes the menu.
test('isMenuAnchor: the same button, or the one a redraw drew in its place', async () => {
  const { isMenuAnchor } = await import('../ui/js/post-menu.js');
  const old = { dataset: { key: 'p1-menu-500011' } };
  const redrawn = { dataset: { key: 'p1-menu-500011' } };
  const other = { dataset: { key: 'p1-menu-500012' } };
  const cur = { anchor: old, key: 'p1-menu-500011' };
  assert.equal(isMenuAnchor(cur, old), true);
  assert.equal(isMenuAnchor(cur, redrawn), true, 'drawn anew, same key');
  assert.equal(isMenuAnchor(cur, other), false, 'another post');
  assert.equal(isMenuAnchor({ anchor: old, key: '' }, { dataset: { key: '' } }), false, 'no key: only the element itself');
  assert.equal(isMenuAnchor({ anchor: old, key: '' }, { dataset: {} }), false);
  assert.equal(isMenuAnchor(null, old), false, 'no menu open');
  assert.equal(isMenuAnchor(cur, null), false);
});

test('backgroundTabs: only the tabs a pane is not showing', () => {
  const tabs = [{ view: { kind: 'thread', board: 'g', no: 1 } }, { view: { kind: 'board', board: 'g' } }, { view: { kind: 'thread', board: 'g', no: 1 } }];
  assert.deepEqual(R.backgroundTabs(tabs, 0, R.showsThread('g', 1)), [2]);
  assert.deepEqual(R.backgroundTabs(tabs, 2, R.showsThread('g', 1)), [0]);
  assert.deepEqual(R.backgroundTabs(tabs, 1, R.usesCatalog('g')), [0, 2]);
  assert.deepEqual(R.backgroundTabs(null, 0, () => true), []);
});
