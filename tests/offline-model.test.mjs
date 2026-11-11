// Saved threads and Download all (ui/js/offline-model.js), and the bridge's
// side of them: the mock that simulates saving, and the app's commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as O from '../ui/js/offline-model.js';
import { createBridge } from '../ui/js/bridge.js';
import { panesFromHash } from '../ui/js/browse-model.js';

const posts = [
  { no: 100, tim: 1700000000001, ext: '.jpg', filename: 'cat', fsize: 2000 },
  { no: 101 },
  { no: 102, tim: 1700000000002, ext: '.webm', filename: 'cat', fsize: 9000 },
  { no: 103, tim: 1700000000003, ext: '.png', filedeleted: 1 },
  { no: 104, tim: 1700000000004, ext: '.exe', filename: 'bad' },
  { no: 105, tim: '../../x', ext: '.jpg' },
  { no: 106, tim: 1700000000006, ext: '.pdf', filename: 'Cat', fsize: 0 },
];

test('fileJobs: thumbnails first, then full files; only real, known files', () => {
  const jobs = O.fileJobs(posts);
  assert.deepEqual(
    jobs.map((j) => `${j.kind}:${j.tim}${j.ext}`),
    ['thumb:1700000000001.jpg', 'thumb:1700000000002.webm', 'thumb:1700000000006.pdf', 'full:1700000000001.jpg', 'full:1700000000002.webm', 'full:1700000000006.pdf'],
  );
  assert.equal(jobs.find((j) => j.kind === 'full' && j.no === 100).size, 2000);
  assert.equal(jobs.find((j) => j.kind === 'thumb').size, 0, 'thumbnail sizes are unknown');
  assert.deepEqual(O.fileJobs(null), []);
  assert.equal(O.hasSavableFile({ tim: 1, ext: '.gif' }), true);
  assert.equal(O.hasSavableFile({ tim: 1, ext: '.svg' }), false);
});

test('downloadJobs: original names, the same name made unique the same way every run', () => {
  const urlOf = (p) => `https://i.4cdn.org/g/${p.tim}${p.ext}`;
  const jobs = O.downloadJobs(posts, urlOf);
  assert.deepEqual(
    jobs.map((j) => j.name),
    ['cat.jpg', 'cat.webm', 'Cat.pdf'],
  );
  const twice = O.downloadJobs([{ no: 1, tim: 11, ext: '.png', filename: 'a' }, { no: 2, tim: 22, ext: '.png', filename: 'a' }, { no: 3, tim: 33, ext: '.png', filename: 'a/b' }], urlOf);
  assert.deepEqual(twice.map((j) => j.name), ['a.png', 'a-22.png', 'a_b.png']);
  assert.deepEqual(O.downloadJobs(twice, urlOf).length, 0, 'jobs are not posts');
  assert.equal(O.downloadJobs(posts, () => null).length, 0, 'no URL, no job');
  assert.equal(jobs[0].url, 'https://i.4cdn.org/g/1700000000001.jpg');
});

test('mergePosts: a saved copy keeps posts the site dropped; newer copies win', () => {
  const saved = [{ no: 1, com: 'op' }, { no: 2, com: 'gone later' }, { no: 3, com: 'old' }];
  const loaded = [{ no: 1, com: 'op', closed: 1 }, { no: 3, com: 'edited' }, { no: 4, com: 'new' }];
  assert.deepEqual(O.mergePosts(saved, loaded), [{ no: 1, com: 'op', closed: 1 }, { no: 2, com: 'gone later' }, { no: 3, com: 'edited' }, { no: 4, com: 'new' }]);
  assert.deepEqual(O.mergePosts(undefined, loaded).length, 3);
  assert.deepEqual(O.mergePosts([{ no: 'x' }, null], []), []);
});

test('runQueue: one at a time, a gap after each request, none after a skip', async () => {
  const log = [];
  const sleep = async (ms) => log.push(`sleep ${ms}`);
  const worker = async (j) => {
    log.push(`job ${j}`);
    return { status: j % 2 ? 'saved' : 'skipped' };
  };
  const progress = [];
  const r = await O.runQueue([1, 2, 3, 4], worker, { sleep, onProgress: (n) => progress.push(n) });
  assert.deepEqual(log, ['job 1', 'sleep 1000', 'job 2', 'job 3', 'sleep 1000', 'job 4']);
  assert.deepEqual(progress, [1, 2, 3, 4]);
  assert.deepEqual(r, { done: 4, saved: 2, skipped: 2, failed: 0, cancelled: false, stopped: null });
});

test('runQueue: cancelling stops before the next file', async () => {
  let cancelled = false;
  const done = [];
  const r = await O.runQueue([1, 2, 3], async (j) => (done.push(j), j === 1 && (cancelled = true), { status: 'saved' }), {
    sleep: async () => {},
    isCancelled: () => cancelled,
  });
  assert.deepEqual(done, [1]);
  assert.equal(r.cancelled, true);
  assert.equal(r.done, 1);
});

test('runQueue: failures are counted; five in a row stop the run', async () => {
  const sleeps = [];
  const r = await O.runQueue([1, 2, 3], async (j) => {
    if (j === 2) throw new Error('404');
    return { status: 'saved' };
  }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(r.failed, 1);
  assert.equal(r.saved, 2);
  assert.equal(sleeps.length, 2, 'a failed request still waits the gap');
  const stop = await O.runQueue(Array.from({ length: 9 }, (_, i) => i), async () => {
    throw new Error('offline');
  }, { sleep: async () => {} });
  assert.equal(stop.done, O.MAX_FAILURES_IN_ROW);
  assert.equal(stop.stopped, 'offline');
});

test('progress and result texts', () => {
  assert.equal(O.progressText({ kind: 'offline', done: 12, total: 48 }), 'Saving 12/48 files…');
  assert.equal(O.progressText({ kind: 'all', done: 3, total: 20 }), 'Downloading 3/20 files…');
  assert.equal(O.progressText({ kind: 'offline', done: 0, total: 0 }), 'Saving the thread…');
  assert.equal(O.progressText(null), '');
  assert.equal(O.doneText('offline', { saved: 3, skipped: 1, failed: 0 }), 'Saved offline: 3 new, 1 already there.');
  assert.equal(O.doneText('all', { saved: 3, skipped: 1, failed: 2 }), 'Downloaded: 3 new, 1 already there, 2 failed.');
  assert.equal(O.doneText('all', { saved: 1, skipped: 0, failed: 0, cancelled: true }), 'Downloaded: stopped, 1 new, 0 already there.');
  assert.match(O.doneText('offline', { failed: 5, stopped: 'x' }), /^Stopped after 5 failures in a row: x$/);
});

test('savedEntries: checked and newest first', () => {
  const list = O.savedEntries([
    { board: 'g', no: 1, title: 'old', savedAt: 10, files: 2, bytes: 300, posts: 4, folder: '/x/g-1' },
    { board: '../x', no: 2 },
    { board: 'v', no: 0 },
    { board: 'v', no: 5, savedAt: 20, title: 7, files: -1, bytes: 'a' },
    null,
  ]);
  assert.deepEqual(list.map((e) => `${e.board}/${e.no}`), ['v/5', 'g/1']);
  assert.deepEqual(list[0], { board: 'v', no: 5, title: '', folder: '', savedAt: 20, posts: 0, files: 0, bytes: 0 });
  assert.equal(O.isSaved(list, 'g', 1), true);
  assert.equal(O.isSaved(list, 'g', 2), false);
  assert.deepEqual(O.savedEntries('nope'), []);
});

test('saved files: paths only for real files, missing ones never reach the site', () => {
  const p = { no: 100, tim: 1700000000001, ext: '.jpg' };
  assert.equal(O.savedFilePath('g', 100, p, 'full'), 'g/100/files/1700000000001.jpg');
  assert.equal(O.savedFilePath('g', 100, p, 'thumb'), 'g/100/thumbs/1700000000001s.jpg');
  assert.equal(O.savedFilePath('../g', 100, p, 'full'), null);
  assert.equal(O.savedFilePath('g', 0, p, 'full'), null);
  assert.equal(O.savedFilePath('g', 1, { tim: '1/../2', ext: '.jpg' }, 'full'), null);
  const toUrl = (path) => `local:${path}`;
  const urls = O.savedUrls(100, { files: ['1700000000001.jpg', '1700000000002.webm'], thumbs: ['1700000000002s.jpg'] }, toUrl);
  assert.equal(urls.mediaUrl('g', p), 'local:g/100/files/1700000000001.jpg');
  assert.equal(urls.thumbUrl('g', p), 'local:g/100/files/1700000000001.jpg', 'no thumbnail: the picture itself');
  const v = { no: 102, tim: 1700000000002, ext: '.webm' };
  assert.equal(urls.thumbUrl('g', v), 'local:g/100/thumbs/1700000000002s.jpg');
  const missing = { no: 103, tim: 1700000000009, ext: '.webm' };
  assert.equal(urls.mediaUrl('g', missing), null);
  assert.equal(urls.thumbUrl('g', missing), null, 'a video without its thumbnail shows no file');
  assert.equal(O.savedUrls(1, null, toUrl).mediaUrl('g', p), null);
  assert.equal(O.savedFileOnDisk('/d/g-100', p), '/d/g-100/files/1700000000001.jpg');
  assert.equal(O.savedFileOnDisk('C:\\d\\g-100', p), 'C:\\d\\g-100\\files\\1700000000001.jpg');
  assert.equal(O.savedFileOnDisk('', p), '');
});

test('panes in a new window may be the saved list or a saved thread', () => {
  const enc = (v) => `#panes=${encodeURIComponent(JSON.stringify(v))}`;
  assert.deepEqual(panesFromHash(enc([{ kind: 'saved', junk: 1 }, { kind: 'offline', board: 'g', no: 5 }, { kind: 'offline', board: '../g', no: 5 }])), [
    { kind: 'saved' },
    { kind: 'offline', board: 'g', no: 5 },
  ]);
});

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('mock: saving is simulated (no files), listed, read back, updated, deleted', async () => {
  const storage = memoryStorage();
  const b = createBridge({ storage, mock: { delayMs: 0 } });
  await assert.rejects(() => b.offlineRead('', 'g', 100), /not-saved/);
  await assert.rejects(() => b.offlineFetchFile('', 'g', 100, { tim: 1, ext: '.jpg', kind: 'full' }), /Save the thread first/);
  await b.offlineWriteThread('', 'g', 100, 'A title', { posts });
  const jobs = O.fileJobs(posts);
  const r = await O.runQueue(jobs, (j) => b.offlineFetchFile('', 'g', 100, j), { sleep: async () => {} });
  assert.equal(r.saved, jobs.length);
  const again = await O.runQueue(jobs, (j) => b.offlineFetchFile('', 'g', 100, j), { sleep: async () => {} });
  assert.equal(again.skipped, jobs.length, 'a second run asks for nothing');
  const list = O.savedEntries(await b.offlineList(''));
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'A title');
  assert.equal(list[0].files, 3);
  assert.ok(list[0].bytes > 0);
  const read = await b.offlineRead('', 'g', 100);
  assert.equal(read.thread.posts.length, posts.length);
  assert.deepEqual(read.thumbs.sort(), ['1700000000001s.jpg', '1700000000002s.jpg', '1700000000006s.jpg']);
  assert.match(b.savedFileUrl('g/100/files/1700000000001.jpg'), /^assets\//, 'local pictures only');
  // kept across a reload of the page
  const reloaded = createBridge({ storage, mock: { delayMs: 0 } });
  assert.equal((await reloaded.offlineList('')).length, 1);
  await reloaded.offlineDelete('', 'g', 100);
  assert.deepEqual(await reloaded.offlineList(''), []);
});

test('mock: ?mock-save=fail fails full files; Download all is recorded, not downloaded', async () => {
  const b = createBridge({ storage: memoryStorage(), mock: { delayMs: 0, save: 'fail' } });
  await b.offlineWriteThread('', 'g', 100, '', { posts });
  await b.offlineFetchFile('', 'g', 100, { tim: 1, ext: '.jpg', kind: 'thumb' });
  await assert.rejects(() => b.offlineFetchFile('', 'g', 100, { tim: 1, ext: '.jpg', kind: 'full' }), /mock failure/);
  const r1 = await b.downloadFile('u', 'cat.jpg', '', 10);
  const r2 = await b.downloadFile('u', 'cat.jpg', '', 10);
  assert.deepEqual([r1.status, r2.status], ['saved', 'skipped']);
  assert.equal(b.downloads.length, 1);
});

test('tauri: saved threads and Download all go to their commands', async () => {
  const calls = [];
  const tauri = {
    core: {
      invoke: async (cmd, args) => {
        calls.push([cmd, args]);
        return cmd === 'offline_list' ? [] : { status: 'saved' };
      },
      convertFileSrc: (path, scheme) => `${scheme}://localhost/${encodeURIComponent(path)}`,
    },
  };
  const b = createBridge({ tauri });
  await b.offlineList('');
  await b.offlineRead('/d', 'g', 1);
  await b.offlineWriteThread('', 'g', 1, 't', { posts: [{ no: 1 }] });
  await b.offlineFetchFile('/d', 'g', 1, { tim: 5, ext: '.jpg', kind: 'full', size: 9 });
  await b.offlineDelete('', 'g', 1);
  await b.downloadFile('https://i.4cdn.org/g/5.jpg', 'a.jpg', '', 0);
  assert.deepEqual(calls, [
    ['offline_list', { dir: null }],
    ['offline_read', { dir: '/d', board: 'g', no: 1 }],
    ['offline_write_thread', { dir: null, board: 'g', no: 1, title: 't', thread: { posts: [{ no: 1 }] } }],
    ['offline_fetch_file', { dir: '/d', board: 'g', no: 1, tim: 5, ext: '.jpg', kind: 'full', size: 9 }],
    ['offline_delete', { dir: null, board: 'g', no: 1 }],
    ['download_file', { url: 'https://i.4cdn.org/g/5.jpg', name: 'a.jpg', dir: null, size: null }],
  ]);
  assert.equal(b.siteRequests(), 2, 'only the file downloads reach the site');
  assert.equal(b.savedFileUrl('g/1/files/5.jpg'), 'cesaved://localhost/g%2F1%2Ffiles%2F5.jpg');
  const plain = createBridge({ tauri: { core: { invoke: async () => null } } });
  assert.equal(plain.savedFileUrl('g/1/files/5.jpg'), 'cesaved://localhost/g%2F1%2Ffiles%2F5.jpg');
});
