import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ARCHIVES,
  ARCHIVE_IDS,
  ARCHIVE_OFF,
  MAX_ARCHIVE_CHOICES,
  archivesFor,
  archivedBoards,
  normalizeArchivePrefs,
  pickArchive,
  archiveUrl,
  archiveLink,
  deadlinkRef,
} from '../ui/js/archive-model.js';

const byId = (id) => ARCHIVES.find((a) => a.id === id);

test('the list: unique ids and hosts, board codes, known software', () => {
  assert.equal(new Set(ARCHIVE_IDS).size, ARCHIVES.length);
  assert.equal(new Set(ARCHIVES.map((a) => a.host)).size, ARCHIVES.length);
  for (const a of ARCHIVES) {
    assert.match(a.host, /^[a-z0-9.-]+\.[a-z]+$/, a.id);
    assert.ok(['foolfuuka', 'fuuka'].includes(a.software), a.id);
    assert.ok(a.boards.length > 0, a.id);
    for (const b of a.boards) assert.match(b, /^[a-z0-9]{1,10}$/, `${a.id} ${b}`);
    assert.equal(new Set(a.boards).size, a.boards.length, `${a.id} lists a board twice`);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.boards));
  }
  assert.ok(archivedBoards().includes('g'));
  assert.deepEqual(archivedBoards(), [...archivedBoards()].sort());
});

test('archivesFor: the archives keeping a board, in order; none for odd codes', () => {
  assert.deepEqual(archivesFor('g').map((a) => a.id), ['desuarchive', 'b4k', 'archivedmoe']);
  assert.deepEqual(archivesFor('sci').map((a) => a.id), ['warosu', 'archivedmoe']);
  assert.deepEqual(archivesFor('zz'), []);
  assert.deepEqual(archivesFor('../g'), []);
  assert.deepEqual(archivesFor(undefined), []);
});

test('pickArchive: the choice, else the first; off and disabled give none', () => {
  assert.equal(pickArchive('g').id, 'desuarchive');
  assert.equal(pickArchive('pol').id, '4plebs');
  assert.equal(pickArchive('g', { enabled: true, boards: { g: 'b4k' } }).id, 'b4k');
  assert.equal(pickArchive('g', { enabled: true, boards: { g: 'warosu' } }).id, 'desuarchive', 'an archive without the board: automatic');
  assert.equal(pickArchive('g', { enabled: true, boards: { g: ARCHIVE_OFF } }), null);
  assert.equal(pickArchive('g', { enabled: false, boards: {} }), null);
  assert.equal(pickArchive('zz'), null);
});

test('archiveUrl: FoolFuuka and Fuuka addresses for threads and posts', () => {
  const desu = byId('desuarchive');
  const waro = byId('warosu');
  assert.equal(archiveUrl(desu, { board: 'g', thread: 100 }), 'https://desuarchive.org/g/thread/100/');
  assert.equal(archiveUrl(desu, { board: 'g', thread: 100, post: 105 }), 'https://desuarchive.org/g/thread/100/#105');
  assert.equal(archiveUrl(desu, { board: 'g', thread: 100, post: 100 }), 'https://desuarchive.org/g/thread/100/');
  assert.equal(archiveUrl(desu, { board: 'g', post: 105 }), 'https://desuarchive.org/g/post/105/');
  assert.equal(archiveUrl(waro, { board: 'sci', thread: 7, post: 9 }), 'https://warosu.org/sci/thread/7#p9');
  assert.equal(archiveUrl(waro, { board: 'sci', post: 9 }), 'https://warosu.org/sci/post/9');
});

test('archiveUrl: nothing for odd parts', () => {
  const desu = byId('desuarchive');
  assert.equal(archiveUrl(desu, { board: 'g' }), null);
  assert.equal(archiveUrl(desu, { board: 'G', thread: 1 }), null);
  assert.equal(archiveUrl(desu, { board: 'g/../x', thread: 1 }), null);
  assert.equal(archiveUrl(desu, { board: 'g', thread: -3, post: 'x' }), null);
  assert.equal(archiveUrl(null, { board: 'g', thread: 1 }), null);
  assert.equal(archiveUrl(desu, { board: 'g', thread: 1.5, post: 2 }), 'https://desuarchive.org/g/post/2/');
});

test('archiveLink: host and address on the chosen archive', () => {
  assert.deepEqual(archiveLink(undefined, { board: 'g', thread: 1, post: 2 }), { id: 'desuarchive', host: 'desuarchive.org', url: 'https://desuarchive.org/g/thread/1/#2' });
  assert.equal(archiveLink({ enabled: false, boards: {} }, { board: 'g', thread: 1 }), null);
  assert.equal(archiveLink(undefined, { board: 'zz', thread: 1 }), null);
  assert.equal(archiveLink(undefined, null), null);
});

test('normalizeArchivePrefs: valid choices kept, the rest dropped', () => {
  assert.deepEqual(normalizeArchivePrefs(undefined), { enabled: true, boards: {} });
  assert.deepEqual(normalizeArchivePrefs([]), { enabled: true, boards: {} });
  assert.deepEqual(
    normalizeArchivePrefs({ enabled: false, boards: { g: 'b4k', v: 'off', sci: 'desuarchive', 'G': 'off', zz: 'off', pol: 7 } }),
    { enabled: false, boards: { g: 'b4k', v: 'off', zz: 'off' } },
  );
  assert.equal(normalizeArchivePrefs({ enabled: 'no' }).enabled, true);
  const many = Object.fromEntries(Array.from({ length: MAX_ARCHIVE_CHOICES + 50 }, (_, i) => [`b${i}`, 'off']));
  // 'off' is kept for any board code; past the cap the rest are dropped
  assert.equal(Object.keys(normalizeArchivePrefs({ boards: many }).boards).length, MAX_ARCHIVE_CHOICES);
});

test('deadlinkRef: >>123 on this board, >>>/g/123 on another', () => {
  assert.deepEqual(deadlinkRef('>>123', 'g'), { board: 'g', post: 123 });
  assert.deepEqual(deadlinkRef(' >>>/v/456 ', 'g'), { board: 'v', post: 456 });
  assert.equal(deadlinkRef('>>123', 'G'), null);
  assert.equal(deadlinkRef('>>>/g/', 'g'), null);
  assert.equal(deadlinkRef('>>0', 'g'), null);
  assert.equal(deadlinkRef('>>12a', 'g'), null);
  assert.equal(deadlinkRef('hello', 'g'), null);
  assert.equal(deadlinkRef(null, 'g'), null);
});

test('the desktop app may open every archive, and nothing else new', () => {
  const cap = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const open = cap.permissions.find((p) => p?.identifier === 'opener:allow-open-url');
  const globs = open.allow.map((a) => new RegExp(`^${a.url.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  for (const a of ARCHIVES) {
    for (const ref of [{ board: a.boards[0], thread: 1, post: 2 }, { board: a.boards[0], post: 2 }]) {
      const url = archiveUrl(a, ref);
      assert.ok(globs.some((g) => g.test(url)), url);
    }
  }
  assert.ok(!globs.some((g) => g.test('https://desuarchive.org.evil.example/g/thread/1/')));
  assert.ok(!globs.some((g) => g.test('http://desuarchive.org/g/thread/1/')));
});
