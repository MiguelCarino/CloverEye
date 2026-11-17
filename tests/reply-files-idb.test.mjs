// reply-files.js over IndexedDB (a small fake of it): a file the database
// took is not also kept in memory; one it refused is, and wins over an older
// stored copy; the sweep deletes files no reply points at.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const stored = new Map(); // the database's contents, as other windows see them
let refuse = 0; // the next N writes are refused (a full disk, say)

function transaction() {
  const tx = {};
  const request = (op) => {
    const req = {};
    setTimeout(() => {
      if (op(req) === false) tx.onabort?.();
      else tx.oncomplete?.();
    });
    return req;
  };
  tx.objectStore = () => ({
    put: (v, k) =>
      request((r) => {
        if (refuse > 0) return (refuse--, false);
        stored.set(k, v);
        r.result = k;
      }),
    get: (k) => request((r) => void (r.result = stored.get(k))),
    delete: (k) => request((r) => void (stored.delete(k), (r.result = undefined))),
    getAllKeys: () => request((r) => void (r.result = [...stored.keys()])),
  });
  return tx;
}

globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = { transaction, createObjectStore() {} };
      req.onsuccess();
    });
    return req;
  },
};

const { putFile, getFile, delFile, listKeys, sweepFiles } = await import('../ui/js/reply-files.js');

const file = (n) => ({ name: `f${n}.png`, size: 3, type: 'image/png', bytes: new Uint8Array([n, n, n]), randomName: '' });

test('a stored file is not also held in memory', async () => {
  await putFile('s:a', file(1));
  assert.ok(stored.has('s:a'));
  assert.deepEqual([...(await getFile('s:a')).bytes], [1, 1, 1]);
  // gone from the database behind the module's back: no copy in memory answers
  stored.delete('s:a');
  assert.equal(await getFile('s:a'), null);
});

test('a read right after a write not awaited still finds the file', async () => {
  const writing = putFile('a:g/1', file(2));
  assert.deepEqual([...(await getFile('a:g/1')).bytes], [2, 2, 2]);
  await writing;
  await delFile('a:g/1');
  assert.equal(stored.has('a:g/1'), false);
});

test('a refused write keeps the new file in memory, and the old stored one is not read', async () => {
  await putFile('s:b', file(3));
  refuse = 1;
  await putFile('s:b', file(4));
  assert.deepEqual([...(await getFile('s:b')).bytes], [4, 4, 4]);
  assert.equal(stored.has('s:b'), false, 'the older copy is deleted');
  assert.deepEqual(await listKeys(), ['s:b']);
  await delFile('s:b');
  assert.equal(await getFile('s:b'), null);
});

test('the sweep deletes files unused at both looks, and only those', async () => {
  // left by other windows or an earlier run
  stored.set('s:orphan', file(5));
  stored.set('a:g/7', file(6)); // another window's reply: stored a moment after the file
  stored.set('s:kept', file(7));
  stored.set('other', file(8)); // not a reply's file: never touched
  await putFile('a:g/8', file(9)); // this window's own, never swept
  const used = new Set(['s:kept']);
  const gone = await sweepFiles(() => new Set(used), {
    sleep: async () => {
      used.add('a:g/7'); // the other window stored its reply meanwhile
    },
  });
  assert.deepEqual(gone, ['s:orphan']);
  assert.deepEqual([...stored.keys()].sort(), ['a:g/7', 'a:g/8', 'other', 's:kept']);
});
