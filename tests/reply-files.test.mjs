// reply-files.js with no IndexedDB (as in node, or a private window): the
// files are kept in memory. The sweep of files no reply points at.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { putFile, getFile, delFile, moveFile, listKeys, sweepFiles } from '../ui/js/reply-files.js';

const file = (n) => ({ name: `f${n}.png`, size: 3, type: 'image/png', bytes: new Uint8Array([n, n, n]), randomName: '' });

test('no database: files are kept in memory', async () => {
  await putFile('a:g/1', file(1));
  assert.deepEqual([...(await getFile('a:g/1')).bytes], [1, 1, 1]);
  const moved = await moveFile('a:g/1', 's:r1');
  assert.equal(moved.name, 'f1.png');
  assert.equal(await getFile('a:g/1'), null);
  assert.ok(await getFile('s:r1'));
  await putFile('s:r1', null); // no file: deleted
  assert.equal(await getFile('s:r1'), null);
  assert.deepEqual(await listKeys(), []);
});

test('the sweep never deletes a file this window wrote', async () => {
  // (files from other windows: reply-files-idb.test.mjs)
  await putFile('s:mine', file(2));
  assert.deepEqual(await sweepFiles(() => new Set(), { sleep: async () => {} }), [], 'written in this session: kept');
  await delFile('s:mine');
});

test('the sweep waits between looks and keeps a file that became used', async () => {
  let looks = 0;
  const used = new Set();
  // nothing stored: nothing to do, live() not even asked twice
  assert.deepEqual(await sweepFiles(() => (looks++, used), { sleep: async () => {} }), []);
  assert.equal(looks, 1);
  // live() can't tell (no storage): nothing deleted
  assert.deepEqual(await sweepFiles(() => null, { sleep: async () => {} }), []);
});
