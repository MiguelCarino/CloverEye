import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createBridge, safeStorage, mockOptionsFromSearch, CANNED_FFMPEG, postFlag } from '../ui/js/bridge.js';
import { findLinks, embedFor } from '../ui/js/link-model.js';
import { parseComment } from '../ui/js/render.js';

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
  await b.openLink('https://example.org/a');
  assert.deepEqual(calls, [
    ['get_settings', undefined],
    ['set_settings', { settings: { theme: 'dark' } }],
    ['fetch_boards', undefined],
    ['check_ffmpeg', undefined],
    ['plugin:opener|open_url', { url: 'https://www.4chan.org/rules' }],
    ['open_link', { url: 'https://example.org/a' }],
  ]);
  assert.equal(b.siteRequests(), 1);
  assert.equal(await b.requestNotificationPermission(), 'later');
  assert.equal(b.window.available, false, 'no window API in this fake');
});

test('the mock opens post links in a new tab, http and https only', async () => {
  const opened = [];
  const was = globalThis.open;
  globalThis.open = (...a) => opened.push(a);
  try {
    const b = createBridge({ storage: memoryStorage() });
    await b.openLink('https://example.org/a');
    await assert.rejects(() => b.openLink('javascript:alert(1)'));
    assert.deepEqual(opened, [['https://example.org/a', '_blank', 'noopener,noreferrer']]);
  } finally {
    globalThis.open = was;
  }
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

test('mock: ?mock-links adds a reply with web addresses, embeddable and not', async () => {
  const catalog = readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8');
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => JSON.parse(url.includes('catalog') ? catalog : fixture) });
  assert.deepEqual(mockOptionsFromSearch('?mock-links'), { links: true });
  const b = createBridge({ fetchImpl, mock: { delayMs: 0, links: true } });
  const no = JSON.parse(catalog)[0].threads[0].no;
  const posts = (await b.fetchThread('g', no)).data.posts;
  const text = parseComment(posts[posts.length - 1].com).map((l) => l.map((s) => s.text).join(''));
  const hrefs = text.flatMap((t) => findLinks(t).filter((p) => p.href).map((p) => p.href));
  assert.ok(hrefs.includes('https://en.wikipedia.org/wiki/Clover_(disambiguation)'), 'joined across <wbr>, the full stop left out');
  assert.equal(hrefs.filter((h) => embedFor(h)).length, 6);
  assert.ok(hrefs.includes('https://x.com/user/status/123'));
  assert.ok(hrefs.every((h) => /^https:\/\//.test(h)));
  assert.ok(!hrefs.some((h) => /javascript|data:|example\.org\/x|file\.txt/.test(h)));
});

test('mock: ?mock-cross adds a reply quoting another thread, a gone thread and a dead post', async () => {
  const catalog = readFileSync(new URL('../ui/data/catalog.sample.json', import.meta.url), 'utf8');
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => JSON.parse(url.includes('catalog') ? catalog : fixture) });
  assert.deepEqual(mockOptionsFromSearch('?mock-cross'), { cross: true });
  const plain = createBridge({ fetchImpl, mock: { delayMs: 0 } });
  const cross = createBridge({ fetchImpl, mock: { delayMs: 0, cross: true } });
  const no = JSON.parse(catalog)[0].threads[0].no;
  const a = (await plain.fetchThread('g', no)).data.posts;
  const b = (await cross.fetchThread('g', no)).data.posts;
  assert.equal(b.length, a.length + 1);
  const com = b[b.length - 1].com;
  assert.match(com, /class="quotelink">&gt;&gt;&gt;\/g\/\d+<\/a>/);
  assert.match(com, /href="\/g\/thread\/1#p2"/);
  assert.match(com, /<span class="deadlink">&gt;&gt;\d+<\/span>/);
  await assert.rejects(cross.fetchThread('g', 1), /not-found/);
});
