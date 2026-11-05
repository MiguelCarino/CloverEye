import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBridge, safeStorage, mockOptionsFromSearch, CANNED_FFMPEG, postFlag } from '../ui/js/bridge.js';

const fixture = readFileSync(new URL('../ui/data/boards.sample.json', import.meta.url), 'utf8');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const throwingStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
  removeItem() {},
};

const fakeFetch = async (url) => {
  assert.equal(url, 'data/boards.sample.json', 'the mock only reads the local fixture');
  return { ok: true, status: 200, json: async () => JSON.parse(fixture) };
};

test('mock: settings round-trip through storage', async () => {
  const storage = memoryStorage();
  const b = createBridge({ storage, mock: { delayMs: 0 } });
  assert.equal(b.kind, 'mock');
  assert.equal(await b.getSettings(), null);
  await b.setSettings({ theme: 'dark', setupVersion: 1 });
  assert.deepEqual(await b.getSettings(), { theme: 'dark', setupVersion: 1 });
  assert.ok(storage._map.has('clovereye.settings'));
  const again = createBridge({ storage, mock: { delayMs: 0 } });
  assert.deepEqual(await again.getSettings(), { theme: 'dark', setupVersion: 1 }, 'survives a reload');
});

test('mock: storage that throws falls back to memory', async () => {
  const b = createBridge({ storage: throwingStorage, mock: { delayMs: 0 } });
  assert.equal(await b.getSettings(), null);
  await b.setSettings({ theme: 'light' });
  assert.deepEqual(await b.getSettings(), { theme: 'light' });
});

test('mock: no storage at all still works for the session', async () => {
  const b = createBridge({ storage: null, mock: { delayMs: 0 } });
  await b.setSettings({ a: 1 });
  assert.deepEqual(await b.getSettings(), { a: 1 });
});

test('mock: corrupt stored JSON reads as nothing', async () => {
  const storage = memoryStorage();
  storage.setItem('clovereye.settings', '{not json');
  const b = createBridge({ storage, mock: { delayMs: 0 } });
  assert.equal(await b.getSettings(), null);
});

test('safeStorage returns null when localStorage throws or is missing', () => {
  assert.equal(safeStorage(null), null);
  assert.equal(safeStorage({}), null);
  const win = {
    get localStorage() {
      throw new Error('blocked');
    },
  };
  assert.equal(safeStorage(win), null);
  const ok = memoryStorage();
  assert.equal(safeStorage({ localStorage: ok }), ok);
});

test('mock: boards come from the recorded fixture and count as a site request', async () => {
  const b = createBridge({ fetchImpl: fakeFetch, mock: { delayMs: 0 } });
  assert.equal(b.siteRequests(), 0);
  const res = await b.fetchBoards();
  assert.ok(res.boards.some((x) => x.board === 'g'));
  assert.equal(b.siteRequests(), 1);
});

test('mock: boards failure modes for the Retry/Skip path', async () => {
  const fail = createBridge({ fetchImpl: fakeFetch, mock: { delayMs: 0, boards: 'fail' } });
  await assert.rejects(fail.fetchBoards(), /mock failure/);
  await assert.rejects(fail.fetchBoards(), /mock failure/);
  const once = createBridge({ fetchImpl: fakeFetch, mock: { delayMs: 0, boards: 'fail-once' } });
  await assert.rejects(once.fetchBoards(), /mock failure/);
  const res = await once.fetchBoards();
  assert.ok(res.boards.length > 0, 'retry succeeds');
  assert.equal(once.siteRequests(), 2);
});

test('mock: ffmpeg check matches this machine and has failure variants', async () => {
  const b = createBridge({ mock: { delayMs: 0 } });
  const c = await b.checkFfmpeg();
  assert.deepEqual(c, CANNED_FFMPEG);
  assert.equal(c.found, true);
  assert.ok(c.encoders.libvpx_vp9 && c.encoders.libsvtav1 && c.encoders.libopus);
  assert.ok(c.filters.ass && c.filters.subtitles && c.filters.libplacebo);
  c.found = false;
  assert.equal((await b.checkFfmpeg()).found, true, 'callers get a copy');
  const missing = await createBridge({ mock: { delayMs: 0, ffmpeg: 'missing' } }).checkFfmpeg();
  assert.equal(missing.found, false);
  const partial = await createBridge({ mock: { delayMs: 0, ffmpeg: 'partial' } }).checkFfmpeg();
  assert.equal(partial.encoders.libsvtav1, false);
});

test('mock: notification permission is only asked when called', async () => {
  const b = createBridge({ mock: { delayMs: 0, notify: 'granted' } });
  assert.equal(await b.requestNotificationPermission(), 'granted');
  const plain = createBridge({ mock: { delayMs: 0 } });
  const r = await plain.requestNotificationPermission();
  assert.ok(['unsupported', 'granted', 'denied', 'default'].includes(r));
});

test('tauri: every call goes through invoke with the right command names', async () => {
  const calls = [];
  const tauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'get_settings') return null;
        if (cmd === 'fetch_boards') return { boards: [{ board: 'g' }] };
        if (cmd === 'check_ffmpeg') return CANNED_FFMPEG;
        return null;
      },
    },
  };
  const b = createBridge({ tauri, storage: memoryStorage() });
  assert.equal(b.kind, 'tauri');
  assert.equal(await b.getSettings(), null);
  await b.setSettings({ theme: 'dark' });
  await b.fetchBoards();
  await b.checkFfmpeg();
  await b.openExternal('https://www.4chan.org/rules');
  assert.deepEqual(calls, [
    ['get_settings', undefined],
    ['set_settings', { settings: { theme: 'dark' } }],
    ['fetch_boards', undefined],
    ['check_ffmpeg', undefined],
    ['plugin:opener|open_url', { url: 'https://www.4chan.org/rules' }],
  ]);
  assert.equal(b.siteRequests(), 1);
  assert.equal(await b.requestNotificationPermission(), 'later');
  assert.equal(b.window.available, false, 'no window API in this fake');
});

test('mock options come from the query string', () => {
  assert.deepEqual(mockOptionsFromSearch(''), {});
  assert.deepEqual(mockOptionsFromSearch('?mock-boards=fail-once&mock-ffmpeg=missing&mock-delay=0'), {
    boards: 'fail-once',
    ffmpeg: 'missing',
    delayMs: 0,
  });
  assert.deepEqual(mockOptionsFromSearch('?mock-delay=-5'), {});
});

test('postFlag: country and board flags, as the site shows them', () => {
  assert.deepEqual(postFlag('int', { country: 'NZ', country_name: 'New Zealand' }), {
    src: 'https://s.4cdn.org/image/country/nz.gif',
    code: 'NZ',
    title: 'New Zealand',
  });
  assert.equal(postFlag('bant', { board_flag: 'TM', flag_name: 'Templar' }).src, 'https://s.4cdn.org/image/flags/bant/tm.gif');
  assert.equal(postFlag('int', { country: 'NZ' }, false).src, null, 'pictures off: the code only');
  assert.equal(postFlag('g', {}), null);
  assert.equal(postFlag('int', { country: '../x' }), null, 'odd codes never reach a URL');
  assert.equal(postFlag('../x', { board_flag: 'TM' }), null);
});
