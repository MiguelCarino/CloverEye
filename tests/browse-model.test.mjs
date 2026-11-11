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
