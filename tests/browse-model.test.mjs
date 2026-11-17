import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as B from '../ui/js/browse-model.js';
import { createBridge } from '../ui/js/bridge.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`../crates/fetch/tests/fixtures/${name}`, import.meta.url)));
const catalog = fx('g-catalog-page1.json');

test('catalogThreads flattens pages in bump order and tolerates junk', () => {
  const t = B.catalogThreads(catalog);
  assert.equal(t.length, 15);
  assert.equal(t[0].no, catalog[0].threads[0].no);
  assert.deepEqual(B.catalogThreads(null), []);
  assert.deepEqual(B.catalogThreads([{ page: 1 }]), []);
  assert.equal(B.catalogThreads([...catalog, ...catalog]).length, 30);
  // each thread keeps its page; the catalog itself is left as it was
  assert.ok(t.every((x) => x.page === 1));
  assert.ok(!('page' in catalog[0].threads[0]));
  const two = B.catalogThreads([{ page: 1, threads: [{ no: 1 }] }, { page: 2, threads: [{ no: 2 }, { no: 3 }] }, { threads: [{ no: 4 }] }]);
  assert.deepEqual(two.map((x) => [x.no, x.page]), [[1, 1], [2, 2], [3, 2], [4, undefined]]);
});

test('threadTitle: subject, else comment start, else No.', () => {
  assert.equal(B.threadTitle({ no: 1, sub: 'Tom &amp; Jerry', com: 'x' }), 'Tom & Jerry');
  assert.equal(B.threadTitle({ no: 2, com: '<span class="quote">&gt;be me</span><br>second line' }), '>be me second line');
  const long = B.threadTitle({ no: 3, com: 'a'.repeat(200) }, 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
  assert.equal(B.threadTitle({ no: 4 }), 'No. 4');
});

test('arrangeCatalog: search subject and comment, sorts', () => {
  const t = [
    { no: 3, sub: 'Linux help', com: 'kernel', replies: 5 },
    { no: 9, com: 'Which <b>keyboard</b>?', replies: 50 },
    { no: 1, sub: 'Sticky', com: 'rules', replies: 0, sticky: 1 },
  ];
  assert.deepEqual(B.arrangeCatalog(t, { query: 'KEYBOARD' }).map((x) => x.no), [9]);
  assert.deepEqual(B.arrangeCatalog(t, { query: 'linux' }).map((x) => x.no), [3]);
  assert.deepEqual(B.arrangeCatalog(t, { sort: 'bump' }).map((x) => x.no), [3, 9, 1]);
  assert.deepEqual(B.arrangeCatalog(t, { sort: 'replies' }).map((x) => x.no), [9, 3, 1]);
  assert.deepEqual(B.arrangeCatalog(t, { sort: 'new' }).map((x) => x.no), [9, 3, 1]);
  assert.notEqual(B.arrangeCatalog(t), t, 'never sorts the input in place');
});

test('newPosts and loadErrorText', () => {
  assert.deepEqual(B.newPosts([{ no: 1 }, { no: 2 }], [{ no: 1 }, { no: 2 }, { no: 5 }]).map((p) => p.no), [5]);
  assert.deepEqual(B.newPosts(null, [{ no: 1 }]).map((p) => p.no), [1]);
  assert.match(B.loadErrorText('not-found'), /archived or deleted/);
  assert.match(B.loadErrorText(new Error('not-found'), 'catalog'), /board was not found/);
  assert.equal(B.loadErrorText('network error (dns)'), 'network error (dns)');
});

test('ago', () => {
  const now = 1_000_000_000_000;
  assert.equal(B.ago(now / 1000 - 30, now), '30 s ago');
  assert.equal(B.ago(now / 1000 - 600, now), '10 min ago');
  assert.equal(B.ago(now / 1000 - 7200, now), '2 h ago');
  assert.equal(B.ago(undefined, now), '');
});

test('mock bridge: catalog and thread from local data, no image host', async () => {
  const sample = readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8');
  const seen = [];
  const b = createBridge({
    mock: { delayMs: 0 },
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => JSON.parse(sample) };
    },
  });
  const cat = await b.fetchCatalog('g');
  assert.equal(cat.freshness, 'new');
  const threads = B.catalogThreads(cat.data);
  // the fixture's 15 threads and the three newest the live mock made up (bridge.js liveCatalog)
  assert.equal(threads.length, 18);
  const op = B.catalogThreads(JSON.parse(sample)).find((t) => t.last_replies?.length);
  const th = await b.fetchThread('g', op.no);
  assert.equal(th.data.posts[0].no, op.no);
  assert.equal(th.data.posts.length, 1 + op.last_replies.length);
  assert.ok(!('last_replies' in th.data.posts[0]));
  await assert.rejects(b.fetchThread('g', 1), /not-found/);
  assert.ok(seen.every((u) => u === 'data/catalog.sample.json'));
  assert.equal(b.siteRequests(), 3);
  const withFile = threads.find((t) => t.tim);
  assert.match(b.thumbUrl('g', withFile), /^assets\/sample-[a-z]+\.svg$/);
  assert.equal(b.thumbUrl('g', { no: 1 }), null);
});

test('app bridge: media comes from the image host by board and tim', async () => {
  const calls = [];
  const b = createBridge({ tauri: { core: { invoke: async (cmd, args) => (calls.push([cmd, args]), { freshness: 'new', data: [] }) } } });
  await b.fetchCatalog('g');
  await b.fetchThread('g', 123);
  assert.deepEqual(calls, [['fetch_catalog', { board: 'g' }], ['fetch_thread', { board: 'g', no: 123 }]]);
  assert.equal(b.thumbUrl('g', { tim: 1793731659876000, ext: '.webm' }), 'https://i.4cdn.org/g/1793731659876000s.jpg');
  assert.equal(b.mediaUrl('g', { tim: 1793731659876000, ext: '.webm' }), 'https://i.4cdn.org/g/1793731659876000.webm');
  assert.equal(b.mediaUrl('g', { no: 5 }), null);
});

test('the UI catalog sample is the synthetic fixture', () => {
  const a = readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../crates/fetch/tests/fixtures/g-catalog-page1.json', import.meta.url), 'utf8');
  assert.equal(a, b);
});

test('excerpt drops quote links and keeps the words', () => {
  const op = { com: '<a href="#p5" class="quotelink">&gt;&gt;5</a><br>Hello <span class="quote">&gt;there</span>' };
  assert.equal(B.excerpt(op), 'Hello >there');
  assert.ok(B.excerpt({ com: 'x'.repeat(500) }, 50).length === 50);
});

test('excerpt drops board links too', () => {
  assert.equal(B.excerpt({ com: '<a href="//boards.4chan.org/g/catalog#s=fglt" class="quotelink">&gt;&gt;&gt;/g/fglt/</a><br>new thread' }), 'new thread');
  assert.equal(B.excerpt({ com: 'see <a href="//boards.4chan.org/a/" class="quotelink">&gt;&gt;&gt;/a/</a> too' }), 'see too');
});

test('isRefreshKey: F5, Ctrl+R and ⌘R (with or without Shift), nothing else', () => {
  const k = (key, mods = {}) => B.isRefreshKey({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.ok(k('F5'));
  assert.ok(k('F5', { shiftKey: true }));
  assert.ok(k('F5', { ctrlKey: true }));
  assert.ok(k('r', { ctrlKey: true }));
  assert.ok(k('r', { metaKey: true }));
  assert.ok(k('R', { metaKey: true, shiftKey: true }));
  assert.ok(!k('r'));
  assert.ok(!k('r', { altKey: true, ctrlKey: true }));
  assert.ok(!k('r', { ctrlKey: true, metaKey: true }));
  assert.ok(!k('F5', { altKey: true }));
  assert.ok(!k('t', { ctrlKey: true }));
});

test('refreshKeysLabel names ⌘ on a Mac and Ctrl elsewhere', () => {
  assert.equal(B.refreshKeysLabel('MacIntel'), '⌘R · F5');
  assert.equal(B.refreshKeysLabel('Linux x86_64'), 'Ctrl+R · F5');
});

test('statusText: the status line in words (the shell patches it in place)', () => {
  const time = () => '10:00:00';
  assert.equal(B.statusText(undefined, 'thread', { time }), 'Loading the thread…');
  assert.equal(B.statusText({ status: 'loading', posts: [] }, 'catalog', { time }), 'Loading the catalog…');
  assert.equal(B.statusText({ status: 'error', error: 'x' }, 'thread', { time }), null, 'the error box says it');
  assert.equal(B.statusText({ status: 'ok', at: 1, freshness: 'new', fresh: new Set() }, 'thread', { time }), 'Updated 10:00:00');
  assert.equal(B.statusText({ status: 'ok', at: 1, freshness: 'not-modified' }, 'thread', { time }), 'Updated 10:00:00 · no changes');
  assert.equal(B.statusText({ status: 'ok', at: 1, freshness: 'throttled' }, 'thread', { time }), 'Updated 10:00:00 · too soon to ask again, showing the last copy');
  assert.equal(B.statusText({ status: 'ok', at: 1, freshness: 'new', fresh: new Set([5, 6, 7]) }, 'thread', { time }), 'Updated 10:00:00 · 3 new');
  assert.equal(B.statusText({ status: 'ok' }, 'thread', { time }), null, 'nothing to say');
  assert.match(B.statusText({ status: 'ok', at: Date.now() }, 'thread'), /^Updated \S/, 'the clock time by default');
});

// Spoilers (<s>) stay hidden in titles and catalog cards (confirmed[9]).
test('threadTitle and excerpt mask spoiler text; the search still finds it', () => {
  const op = { no: 1, com: 'Who dies? <s>Snape kills Dumbledore</s>' };
  assert.equal(B.threadTitle(op), 'Who dies? ' + B.SPOILER_MASK);
  assert.ok(!B.threadTitle(op).includes('Snape'));
  assert.equal(B.excerpt({ ...op, sub: 'Books' }), 'Who dies? ' + B.SPOILER_MASK);
  assert.equal(B.threadTitle({ no: 1, sub: 'A subject', com: '<s>x</s>' }), 'A subject', 'a subject has no spoilers');
  assert.equal(B.threadTitle({ no: 1, com: '<s>a</s><s>b</s> after' }), B.SPOILER_MASK + ' after', 'one tag after another is one mask');
  const greenInside = { no: 1, com: 'see <s><span class="quote">&gt;green secret</span></s>' };
  assert.ok(!B.threadTitle(greenInside).includes('secret'), 'greentext inside a spoiler too');
  assert.equal(B.arrangeCatalog([op], { query: 'snape' }).length, 1, 'the catalog search reads the whole comment');
});

test('titleRuns and excerptRuns mark spoiler runs for the catalog card', () => {
  assert.deepEqual(B.titleRuns({ com: 'Who dies? <s>Snape</s> end' }), [
    { text: 'Who dies? ', spoiler: false },
    { text: 'Snape', spoiler: true },
    { text: ' end', spoiler: false },
  ]);
  assert.deepEqual(B.titleRuns({ sub: 'Sub', com: '<s>x</s>' }), [{ text: 'Sub', spoiler: false }]);
  assert.deepEqual(B.titleRuns({ no: 7 }), [{ text: 'No. 7', spoiler: false }]);
  // cut through a spoiler: the "…" stays outside it
  assert.deepEqual(B.excerptRuns({ com: 'Who dies? <s>Snape kills Dumbledore</s>' }, 15), [
    { text: 'Who dies? ', spoiler: false },
    { text: 'Snap', spoiler: true },
    { text: '…', spoiler: false },
  ]);
  // quote links are left out of the excerpt, white space is one space
  assert.deepEqual(B.excerptRuns({ com: '<a href="#p1" class="quotelink">&gt;&gt;1</a><br>a   b<br><s>c</s>' }), [
    { text: 'a b ', spoiler: false },
    { text: 'c', spoiler: true },
  ]);
  const long = 'x'.repeat(300);
  const runs = B.titleRuns({ com: long });
  assert.equal(runs.map((r) => r.text).join('').length, 80);
  assert.equal(B.threadTitle({ com: long }), runs.map((r) => r.text).join(''), 'the same cut as the plain title');
});

// Backlinks and quote previews only reach posts that are drawn (confirmed[11]).
test('shownPosts: no backlinks from discarded or hidden posts; discarded posts unreachable', () => {
  const q = (n) => '<a href="#p' + n + '" class="quotelink">&gt;&gt;' + n + '</a>';
  const posts = [
    { no: 100, com: 'op' },
    { no: 120, com: q(100) + ' discarded' },
    { no: 121, com: q(100) + ' hidden' },
    { no: 122, com: q(100) + ' shown' },
  ];
  const hidden = new Map([
    [120, { reason: 'discard' }],
    [121, { reason: 'filter' }],
  ]);
  const a = B.shownPosts(posts, hidden, new Set());
  assert.deepEqual(a.refs.get(100), [122]);
  assert.ok(!a.posts.has(120), 'a discarded post: "Post not found"');
  assert.ok(a.posts.has(121), 'a hidden post is there (drawn as its stub line)');
  assert.equal(B.shownPosts(posts, hidden, new Set()), a, 'kept while the same posts are hidden');
  const b = B.shownPosts(posts, hidden, new Set([121]));
  assert.notEqual(b, a);
  assert.deepEqual(b.refs.get(100), [121, 122], 'shown this time: its backlink is back');
  assert.deepEqual(B.shownPosts(posts, new Map(), new Set()).refs.get(100), [120, 121, 122]);
});
