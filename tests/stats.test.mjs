// Stats storage and sampling: the bridge's stats files (the mock's, with the
// app's revision check), the mock's moving catalog and ?mock-stats, and the
// controller (ui/js/stats.js) with a fake bridge and clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBridge, mockOptionsFromSearch, liveCatalog, mockMaxNo, seedBoardStats } from '../ui/js/bridge.js';
import { createStats, ACTIVE_GAP_MS } from '../ui/js/stats.js';
import * as S from '../ui/js/stats-model.js';
import { catalogThreads } from '../ui/js/browse-model.js';

const catalog = JSON.parse(readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8'));
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => structuredClone(catalog) });
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _map: m };
}

test('mock stats files: separate from settings, and a write must name the current revision', async () => {
  const storage = memoryStorage();
  const b = createBridge({ storage, fetchImpl, mock: { delayMs: 0 } });
  assert.equal(await b.statsRead('boards'), null);
  assert.equal(await b.statsWrite('boards', { v: 1, boards: {} }, 0), 1);
  await assert.rejects(b.statsWrite('boards', { v: 1, boards: {} }, 0), /stats-conflict/, 'another window wrote first');
  assert.equal(await b.statsWrite('boards', { v: 1, boards: { g: { samples: [] } } }, 1), 2);
  assert.equal((await b.statsRead('boards')).rev, 2);
  assert.equal(await b.statsWrite('mine', { v: 1, days: {} }, 0), 1, 'each file has its own revision');
  await assert.rejects(b.statsRead('settings'), /unknown stats file/);
  assert.equal(await b.getSettings(), null, 'nothing in settings');
  assert.ok([...storage._map.keys()].every((k) => k.startsWith('clovereye.stats.')));
});

test('the mock catalog moves with the clock: the highest number rises, new threads appear', async () => {
  const t = Date.UTC(2026, 10, 11, 12, 0, 0);
  assert.ok(mockMaxNo('g', t + 5 * 60_000) > mockMaxNo('g', t));
  for (let i = 0; i < 200; i++) assert.ok(mockMaxNo('v', t + (i + 1) * 7 * 60_000) >= mockMaxNo('v', t + i * 7 * 60_000), 'never goes down');
  const a = catalogThreads(liveCatalog(catalog, 'g', t));
  const b = catalogThreads(liveCatalog(catalog, 'g', t + 60 * 60_000));
  assert.ok(S.catalogMaxNo(b) > S.catalogMaxNo(a));
  assert.ok(b.some((x) => x.no > S.catalogMaxNo(a)), 'a thread started in that hour');
  // the made-up threads open (an opening post and nothing more)
  const bridge = createBridge({ fetchImpl, mock: { delayMs: 0 } });
  const cat = catalogThreads((await bridge.fetchCatalog('g')).data);
  const fresh = cat.find((x) => !x.sticky && !x.last_replies);
  assert.equal((await bridge.fetchThread('g', fresh.no)).data.posts.length, 1);
});

test('?mock-stats seeds a day of samples (rates show at once) and a month of your counts', async () => {
  assert.deepEqual(mockOptionsFromSearch('?mock-stats'), { stats: true });
  const b = createBridge({ storage: memoryStorage(), fetchImpl, mock: { delayMs: 0, stats: true } });
  const store = S.normalizeBoardStats(await b.statsRead('boards'));
  const now = Date.now();
  const g = S.boardRow('g', store.boards.g, now);
  assert.ok(g.count > 250, 'every 5 minutes for 24 h');
  assert.ok(g.ppm > 0 && g.hour > 0 && g.day > 0 && g.tph > 0);
  assert.ok(g.busiest, 'a busiest thread');
  assert.ok(g.spark.every((v) => v !== null));
  assert.ok(S.boardRow('tv', store.boards.tv, now).spark.some((v) => v === null), '/tv/ has a two-hour gap');
  const mine = await b.statsRead('mine');
  assert.ok(Object.keys(mine.days).length > 15);
  // seeded once: a second read in the session returns what is stored
  assert.equal((await b.statsRead('boards')).rev, store.rev);
  assert.ok(JSON.stringify(seedBoardStats(catalog, now)).length < S.MAX_STATS_BYTES);
});

test('app bridge: the stats commands and fetch_busy', async () => {
  const calls = [];
  const b = createBridge({ tauri: { core: { invoke: async (cmd, args) => (calls.push([cmd, args]), cmd === 'fetch_busy' ? 2 : cmd === 'stats_write' ? 5 : null) } } });
  assert.equal(await b.statsRead('boards'), null);
  assert.equal(await b.statsWrite('mine', { days: {} }, 4), 5);
  assert.equal(await b.fetchBusy(), 2);
  assert.deepEqual(calls, [
    ['stats_read', { kind: 'boards' }],
    ['stats_write', { kind: 'mine', data: { days: {} }, rev: 4 }],
    ['fetch_busy', undefined],
  ]);
});

// ------------------------------------------------------------- controller

/** A fake bridge: catalogs from the live mock at the fake clock's time,
 *  stats files in memory, and requests counted. */
function fakeWorld({ busy = 0 } = {}) {
  const clock = { t: Date.UTC(2026, 10, 11, 12, 0, 0) };
  const files = {};
  const requests = [];
  const bridge = {
    busy,
    async fetchCatalog(board) {
      requests.push(board);
      return { freshness: 'new', data: liveCatalog(catalog, board, clock.t) };
    },
    async fetchBusy() {
      return this.busy;
    },
    async statsRead(kind) {
      return files[kind] ? structuredClone(files[kind]) : null;
    },
    async statsWrite(kind, data, rev) {
      if ((files[kind]?.rev || 0) !== rev) throw new Error('stats-conflict');
      files[kind] = { ...structuredClone(data), rev: rev + 1 };
      return rev + 1;
    },
  };
  const doc = { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} };
  return { clock, files, requests, bridge, doc };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('controller: a catalog loaded anyway is a sample; nothing of yours is counted while that is off', async () => {
  const w = fakeWorld();
  const settings = { stats: S.normalizeStatsSettings({}) };
  const stats = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: true, tracked: () => ['g'], now: () => w.clock.t, doc: w.doc });
  await flush();
  assert.ok(stats.recordCatalog('g', liveCatalog(catalog, 'g', w.clock.t)));
  w.clock.t += 5 * 60_000;
  assert.ok(stats.recordCatalog('g', liveCatalog(catalog, 'g', w.clock.t)));
  const row = S.boardRow('g', stats.boards().boards.g, w.clock.t);
  assert.ok(row.ppm > 0);
  stats.count('threads', 1, 'g');
  stats.count('time', 30, 'g');
  assert.deepEqual(stats.mine().days, {}, 'off: nothing');
  stats.close();
  await flush();
  await flush();
  assert.equal(w.files.boards, undefined, 'tracking off: samples stay in memory, no file');
  assert.equal(w.files.mine, undefined, 'no file of yours was written');
  assert.deepEqual(w.requests, [], 'no request: the catalogs were loaded anyway');
});

test('controller: with tracking on, samples of catalogs loaded anyway are stored', async () => {
  const w = fakeWorld();
  const settings = { stats: S.normalizeStatsSettings({ track: true }) };
  const stats = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: false, tracked: () => ['g'], now: () => w.clock.t, doc: w.doc });
  await flush();
  assert.ok(stats.recordCatalog('g', liveCatalog(catalog, 'g', w.clock.t)));
  stats.close();
  await flush();
  await flush();
  assert.equal(w.files.boards.boards.g.samples.length, 1, 'stored when closing');
});

test('controller: background sampling is off by default, then idle-only, one board at a time, every interval', async () => {
  const w = fakeWorld({ busy: 1 });
  const settings = { stats: S.normalizeStatsSettings({}) };
  const statuses = [];
  const stats = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: true, tracked: () => ['g', 'v'], now: () => w.clock.t, doc: w.doc, onStatus: (s) => statuses.push(s) });
  await flush();
  stats.poke();
  await flush();
  assert.equal(stats.status().state, 'off');
  assert.deepEqual(w.requests, []);
  settings.stats = S.normalizeStatsSettings({ track: true });
  stats.poke();
  await flush();
  assert.equal(stats.status().state, 'busy', 'your own requests first');
  assert.deepEqual(w.requests, []);
  w.bridge.busy = 0;
  stats.poke();
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(w.requests, ['g'], 'one board');
  stats.poke();
  await flush();
  assert.equal(stats.status().state, 'next');
  assert.deepEqual(w.requests, ['g'], 'the gap between background samples');
  w.clock.t += ACTIVE_GAP_MS;
  stats.poke();
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(w.requests, ['g', 'v']);
  w.clock.t += ACTIVE_GAP_MS;
  stats.poke();
  await flush();
  assert.equal(stats.status().state, 'next', 'both sampled: wait for the interval');
  assert.equal(stats.status().board, 'g');
  assert.ok(stats.status().at - w.clock.t > 4 * 60_000);
  w.clock.t += 5 * 60_000;
  stats.poke();
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(w.requests, ['g', 'v', 'g']);
  // hidden for longer than the interval: paused
  w.doc.visibilityState = 'hidden';
  stats.close();
  const w2 = fakeWorld();
  w2.doc.visibilityState = 'hidden';
  const s2 = createStats({ bridge: w2.bridge, getSettings: () => settings, isMain: true, tracked: () => ['g'], now: () => w2.clock.t, doc: w2.doc });
  w2.clock.t += 6 * 60_000;
  s2.poke();
  await flush();
  assert.equal(s2.status().state, 'paused');
  assert.deepEqual(w2.requests, []);
  s2.close();
  // never in an extra window
  const w3 = fakeWorld();
  const s3 = createStats({ bridge: w3.bridge, getSettings: () => settings, isMain: false, tracked: () => ['g'], now: () => w3.clock.t, doc: w3.doc });
  s3.poke();
  await flush();
  assert.equal(s3.status().state, 'off');
  assert.deepEqual(w3.requests, []);
  s3.close();
  void statuses;
});

test('controller: a manual refresh samples boards whose last sample is over a minute old', async () => {
  const w = fakeWorld();
  const settings = { stats: S.normalizeStatsSettings({}) };
  const stats = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: true, tracked: () => [], now: () => w.clock.t, doc: w.doc });
  await flush();
  stats.recordCatalog('g', liveCatalog(catalog, 'g', w.clock.t));
  w.clock.t += 30_000;
  await stats.sampleNow(['g', 'v']);
  assert.deepEqual(w.requests, ['v'], '/g/ was sampled 30 s ago');
  w.clock.t += 61_000;
  await stats.sampleNow(['g', 'v']);
  assert.deepEqual(w.requests, ['v', 'g', 'v']);
  stats.close();
});

test('controller: your counts, stored with a revision check that survives another window', async () => {
  const w = fakeWorld();
  const settings = { stats: S.normalizeStatsSettings({ mine: true }) };
  const stats = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: true, tracked: () => [], now: () => w.clock.t, doc: w.doc });
  await flush();
  stats.count('threads', 1, 'g');
  stats.count('read', 7);
  // another window stored first
  w.files.mine = { v: 1, rev: 3, since: w.clock.t - 1000, days: { '2026-11-10': { time: 60, boards: {} } }, counted: [] };
  stats.replyToYou('g', 99, w.clock.t / 1000);
  stats.close();
  for (let i = 0; i < 10; i++) await flush();
  const day = Object.keys(w.files.mine.days).find((k) => k !== '2026-11-10');
  assert.equal(w.files.mine.days[day].threads, 1);
  assert.equal(w.files.mine.days[day].read, 7);
  assert.equal(w.files.mine.days['2026-11-10'].time, 60, 'the other window’s counts stay');
  assert.equal(w.files.mine.rev, 4);
  // delete: emptied
  const again = createStats({ bridge: w.bridge, getSettings: () => settings, isMain: true, tracked: () => [], now: () => w.clock.t, doc: w.doc });
  await flush();
  await again.deleteMine();
  assert.deepEqual(w.files.mine.days, {});
  assert.deepEqual(again.mine().days, {});
  again.close();
});
