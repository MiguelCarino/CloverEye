// The library's store (ui/js/library.js) against a stand-in for the Rust
// side that keeps library.json per folder and, like library.rs, refuses a
// write not made from the file's revision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary } from '../ui/js/library.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const hex = (c) => c.repeat(32);
const b64 = (h) => Buffer.from(h, 'hex').toString('base64');
const clone = (v) => JSON.parse(JSON.stringify(v));

/** The library folders on "disk": folder → { index, files, unreadable }. */
function makeDisk() {
  const folders = new Map();
  const at = (d) => {
    if (!folders.has(d)) folders.set(d, { index: null, files: new Map(), unreadable: false, saves: 0 });
    return folders.get(d);
  };
  let n = 0;
  const bridge = {
    fetches: 0,
    async libraryLoad(d) {
      await tick();
      const f = at(d);
      if (f.unreadable) throw new Error('library.json is damaged. It was left as it is: fix or move it, then try again.');
      return { root: d, index: f.index ? clone(f.index) : null };
    },
    async librarySave(d, index) {
      await tick();
      const f = at(d);
      if (f.unreadable) throw new Error('library.json can’t be read, so it was not replaced.');
      if (f.index && index.rev !== (f.index.rev || 0) + 1) throw new Error('The library changed in another window.');
      f.index = clone(index);
      f.saves += 1;
    },
    async libraryFetch(d, url, board, name) {
      bridge.fetches += 1;
      await tick(5);
      const rel = `${board}/${++n}-${name}`;
      at(d).files.set(rel, 'x');
      return { rel, bytes: 1 };
    },
    async libraryDelete(d, rel) {
      at(d).files.delete(rel);
    },
    libraryRead: async (rel) => new Blob([rel]),
    libraryFileUrl: (rel) => `celib://localhost/${encodeURIComponent(rel)}`,
    mediaUrl: (board, post) => `https://i.4cdn.org/${board}/${post.tim}${post.ext}`,
  };
  return { folders, at, bridge };
}

function windowOn(disk, settings = { files: { libraryDir: '/lib' } }) {
  const s = { current: settings };
  const lib = createLibrary({ bridge: disk.bridge, getSettings: () => s.current, onChange: () => {} });
  return { lib, settings: s };
}

const post = (id, no = 1) => ({ no, tim: 1700000000000 + no, ext: '.png', filename: `f${no}`, md5: b64(id), w: 10, h: 10, time: 1 });
const add = (lib, id, no) => lib.addFromPost({ board: 'g', thread: 1, post: post(id, no) });

test('two windows: a save in one is never written over by the other', async () => {
  const disk = makeDisk();
  const A = windowOn(disk).lib;
  const B = windowOn(disk).lib;
  await A.load();
  await add(A, hex('a'), 1);
  await A.flush();
  await B.load(); // B reads now, then A saves X
  await add(A, hex('b'), 2);
  await A.flush();
  // B, not knowing X, tags a file
  B.update(hex('a'), { tags: ['frog'] });
  await B.flush();
  const items = disk.at('/lib').index.items;
  assert.deepEqual(items.map((e) => e.id).sort(), [hex('a'), hex('b')], 'X is still there');
  assert.deepEqual(items.find((e) => e.id === hex('a')).tags, ['frog'], 'and so is B’s tag');
  assert.ok(B.has(b64(hex('b'))), 'B now knows X too');
  // a removal in A stays removed when B (stale) writes
  await A.remove(hex('b'));
  await A.flush();
  B.update(hex('a'), { tags: ['frog', 'smug'] });
  await B.flush();
  assert.deepEqual(disk.at('/lib').index.items.map((e) => e.id), [hex('a')]);
  assert.deepEqual(disk.at('/lib').index.items[0].tags, ['frog', 'smug']);
});

test('a library.json that cannot be read is kept: nothing is saved over it', async () => {
  const disk = makeDisk();
  disk.at('/lib').index = { rev: 3, items: [{ id: hex('c'), rel: 'g/c.png', ext: 'png' }] };
  disk.at('/lib').unreadable = true;
  const { lib } = windowOn(disk);
  await lib.load();
  assert.equal(lib.state().status, 'error');
  assert.match(lib.state().error, /damaged/);
  await assert.rejects(add(lib, hex('a'), 1), /Couldn’t open the library/);
  lib.update(hex('c'), { tags: ['x'] });
  assert.equal(lib.addCollection('New'), 'New');
  await lib.flush();
  assert.equal(disk.at('/lib').saves, 0);
  assert.equal(disk.bridge.fetches, 0, 'no file fetched into a library not read');
  // fixed: the next load reads it
  disk.at('/lib').unreadable = false;
  await lib.load();
  assert.equal(lib.state().status, 'ready');
  assert.deepEqual(lib.items().map((e) => e.id), [hex('c')]);
});

test('a new library folder: the old index is never written into it', async () => {
  const disk = makeDisk();
  disk.at('/new').index = { rev: 5, items: [{ id: hex('9'), rel: 'g/n.png', ext: 'png', tags: ['theirs'] }] };
  const w = windowOn(disk);
  await w.lib.load();
  await add(w.lib, hex('a'), 1);
  await w.lib.flush();
  w.lib.update(hex('a'), { tags: ['last'] }); // waits to be written
  w.settings.current = { files: { libraryDir: '/new' } };
  assert.equal(w.lib.stale(), true);
  // before the next load, a change still goes to the old folder
  w.lib.update(hex('a'), { tags: ['last', 'edit'] });
  await w.lib.load();
  assert.deepEqual(disk.at('/lib').index.items[0].tags, ['last', 'edit'], 'the last change landed in the old folder');
  assert.deepEqual(disk.at('/new').index, { rev: 5, items: [{ id: hex('9'), rel: 'g/n.png', ext: 'png', tags: ['theirs'] }] }, 'the new folder’s list untouched');
  assert.deepEqual(w.lib.items().map((e) => e.id), [hex('9')]);
  assert.equal(w.lib.stale(), false);
  w.lib.update(hex('9'), { tags: ['theirs', 'mine'] });
  await w.lib.flush();
  assert.equal(disk.at('/new').index.rev, 6);
  assert.equal(disk.at('/lib').index.items.length, 1);
});

test('the same file saved from two threads at once is fetched once', async () => {
  const disk = makeDisk();
  const { lib } = windowOn(disk);
  await lib.load();
  const [r1, r2] = await Promise.all([add(lib, hex('d'), 1), add(lib, hex('d'), 2)]);
  assert.deepEqual([r1.status, r2.status].sort(), ['have', 'saved']);
  assert.equal(r2.entry.id, hex('d'));
  assert.equal(disk.bridge.fetches, 1);
  assert.equal(lib.items().length, 1);
  assert.equal(disk.at('/lib').files.size, 1, 'no second copy on disk');
});

test('a refresh while a folder import runs keeps what it brought in', async () => {
  const disk = makeDisk();
  const { lib } = windowOn(disk);
  const files = ['a.png', 'b.png', 'c.png', 'd.png'];
  let gate;
  disk.bridge.libraryImportDir = async (d, src, deep, skip) => {
    const items = files.filter((f) => !skip.includes(f)).map((f) => {
      const rel = `imported/${f}`;
      disk.at(d).files.set(rel, f);
      return { rel, name: f, from: f, bytes: 1 };
    });
    return { items, more: false };
  };
  const reads = [];
  disk.bridge.libraryRead = async (rel) => {
    reads.push(rel);
    if (reads.length === 3) await new Promise((r) => (gate = r));
    // b.png is the same file as a.png: a copy
    return new Blob([rel === 'imported/b.png' ? 'imported/a.png' : rel]);
  };
  await lib.load();
  const running = lib.importFolder('/pics', { deep: true });
  while (!gate) await tick(1);
  await lib.load(true); // the pane's refresh, in the middle
  gate();
  const r = await running;
  assert.equal(r.added, 3);
  assert.equal(r.have, 1);
  await lib.flush();
  const saved = disk.at('/lib').index;
  assert.equal(saved.items.length, 3, 'nothing dropped by the refresh');
  assert.deepEqual(saved.folders['/pics'].dupes, ['b.png'], 'the copy is remembered');
  assert.ok(!disk.at('/lib').files.has('imported/b.png'), 'and taken back out');
  // a rescan copies only what is new: nothing
  const again = await lib.rescanFolder('/pics');
  assert.equal(again.added + again.have + again.failed.length, 0);
});

test('a file that fails to come in leaves no copy behind', async () => {
  const disk = makeDisk();
  const { lib } = windowOn(disk);
  disk.bridge.libraryImportDir = async (d) => {
    disk.at(d).files.set('imported/bad.png', 'x');
    return { items: [{ rel: 'imported/bad.png', name: 'bad.png', from: 'bad.png', bytes: 1 }], more: false };
  };
  disk.bridge.libraryRead = async () => {
    throw new Error('HTTP 404');
  };
  await lib.load();
  const r = await lib.importFolder('/pics');
  assert.equal(r.failed.length, 1);
  assert.equal(disk.at('/lib').files.size, 0);
});

test('fingerprints found while a collection is ticked are kept', async () => {
  const disk = makeDisk();
  disk.at('/lib').index = { rev: 1, items: [{ id: hex('e'), rel: 'g/e.png', ext: 'png' }, { id: hex('f'), rel: 'g/f.png', ext: 'png' }] };
  const { lib } = windowOn(disk);
  let release;
  const slow = new Promise((r) => (release = r));
  const old = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document };
  globalThis.createImageBitmap = async () => {
    await slow;
    return { width: 20, height: 10, close() {} };
  };
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(72 * 64 * 4) }) }) }) };
  try {
    await lib.load(); // starts the fingerprint pass
    lib.addCollection('Best');
    lib.update(hex('e'), { collections: ['Best'] });
    release();
    while (lib.items().some((e) => !e.dhash)) await tick(1);
    await lib.flush();
    const saved = disk.at('/lib').index.items;
    assert.ok(saved.every((e) => e.dhash === '0000000000000000'), 'every hash saved');
    assert.deepEqual(saved.find((e) => e.id === hex('e')).collections, ['Best']);
    assert.equal(saved[0].w, 20);
  } finally {
    globalThis.createImageBitmap = old.createImageBitmap;
    globalThis.document = old.document;
  }
});

test('library addresses name the file’s content', () => {
  const { lib } = windowOn(makeDisk());
  assert.equal(lib.fileUrl({ id: hex('a'), rel: 'g/x y.png' }), `celib://localhost/g%2Fx%20y.png?v=${hex('a')}`);
  const mock = createLibrary({ bridge: { libraryFileUrl: () => 'blob:abc' }, getSettings: () => ({}) });
  assert.equal(mock.fileUrl({ id: hex('a'), rel: 'g/x.png' }), 'blob:abc', 'other addresses as they are');
});


test('another window’s write (library-changed) is read again, merged; this window’s own is not', async () => {
  const disk = makeDisk();
  const A = windowOn(disk).lib;
  const B = windowOn(disk).lib;
  const C = windowOn(disk).lib; // never opened its library
  let loads = 0;
  const load = disk.bridge.libraryLoad;
  disk.bridge.libraryLoad = (d) => ((loads += 1), load(d));
  await A.load();
  await B.load();
  loads = 0;
  await add(A, hex('a'), 1);
  await A.flush();
  const ev = { root: '/lib', rev: disk.at('/lib').index.rev };
  A.otherWrote(ev); // its own write: nothing to read
  C.otherWrote(ev); // not open there
  B.otherWrote({ ...ev, root: '/elsewhere' }); // another folder
  await tick(5);
  assert.equal(loads, 0);
  // B has a change of its own not written yet: kept through the read
  B.addCollection('Mine');
  B.otherWrote(ev);
  await B.load();
  assert.equal(loads, 1);
  assert.ok(B.has(b64(hex('a'))), 'B knows A’s file');
  assert.ok(B.collections().includes('Mine'), 'B’s own change is kept');
  B.otherWrote(ev); // the same revision again: already read
  await tick(5);
  assert.equal(loads, 1);
  await B.flush();
  assert.ok(disk.at('/lib').index.collections.includes('Mine'));
  assert.deepEqual(disk.at('/lib').index.items.map((e) => e.id), [hex('a')]);
});

test('a failed write does not hide another window’s write of the same revision', async () => {
  const disk = makeDisk();
  const A = windowOn(disk).lib;
  const B = windowOn(disk).lib;
  await A.load();
  await add(A, hex('a'), 1);
  await A.flush();
  await B.load();
  const rev = disk.at('/lib').index.rev;
  // A's next write fails (disk full): no event of its own will come
  const save = disk.bridge.librarySave;
  disk.bridge.librarySave = async () => {
    await tick();
    throw new Error('No space left on device');
  };
  A.addCollection('Lost for now');
  await A.flush();
  assert.match(A.state().error, /No space left/);
  disk.bridge.librarySave = save;
  // B writes that same revision
  await add(B, hex('b'), 2);
  await B.flush();
  assert.equal(disk.at('/lib').index.rev, rev + 1);
  A.otherWrote({ root: '/lib', rev: rev + 1 });
  await tick(5);
  await A.load();
  assert.ok(A.has(b64(hex('b'))), 'A read B’s write');
});

test('a post’s file goes in the library under its name as the post shows it', async () => {
  const disk = makeDisk();
  const names = [];
  const fetch = disk.bridge.libraryFetch;
  disk.bridge.libraryFetch = (d, url, board, name) => (names.push(name), fetch(d, url, board, name));
  const { lib } = windowOn(disk);
  await lib.load();
  await lib.addFromPost({ board: 'g', thread: 1, post: { ...post(hex('e'), 3), filename: 'don&#039;t &amp; do' } });
  assert.deepEqual(names, ['don\'t & do.png']);
});
