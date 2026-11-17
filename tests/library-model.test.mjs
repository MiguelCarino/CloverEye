import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../ui/js/library-model.js';

const enc = (s) => new TextEncoder().encode(s);

test('md5 matches the RFC 1321 vectors, and the site’s base64 form', () => {
  assert.equal(L.md5(enc('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(L.md5(enc('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(L.md5(enc('The quick brown fox jumps over the lazy dog')), '9e107d9d372bb6826bd81d3542a419d6');
  assert.equal(L.md5(enc('a'.repeat(1000))), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
  // 4chan sends the same sum in base64
  assert.equal(L.md5Hex(Buffer.from('900150983cd24fb0d6963f7d28e17f72', 'hex').toString('base64')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(L.md5Hex('nope'), '');
  assert.equal(L.md5Hex(undefined), '');
});

test('look-alike fingerprints: steps of brightness, noise ignored', () => {
  const ramp = Array.from({ length: 72 }, (_, i) => 255 - (i % 9) * 20);
  assert.equal(L.dhash(ramp), 'ffffffffffffffff');
  assert.equal(L.dhash(new Array(72).fill(128)), '0000000000000000');
  const noisy = Array.from({ length: 72 }, (_, i) => 128 + (i % 2));
  assert.equal(L.dhash(noisy), '0000000000000000', 'a step of 1 is JPEG noise');
  assert.equal(L.hamming('ff00', 'ff01'), 1);
  assert.equal(L.hamming('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(L.hamming('', 'ff'), 64);
  // block averages
  const rgba = new Uint8ClampedArray(18 * 16 * 4).fill(255);
  const g = L.greyOf(rgba, 18, 16);
  assert.equal(g.length, 72);
  assert.ok(g.every((v) => Math.abs(v - 255) < 0.01));
});

const entry = (over) => L.normalizeEntry({ id: 'a'.repeat(32), rel: 'g/x.png', ext: 'png', size: 10, w: 10, h: 10, added: 1, tags: [], ...over });

test('look-alike groups: close fingerprints together, the biggest first; videos out', () => {
  const a = entry({ id: '1'.repeat(32), dhash: '0030e8e8c0c07030', w: 400, h: 400 });
  const b = entry({ id: '2'.repeat(32), dhash: '0030e8e8c0c07031', w: 200, h: 200 });
  const c = entry({ id: '3'.repeat(32), dhash: 'ffffffffffffffff' });
  const v = entry({ id: '4'.repeat(32), dhash: '0030e8e8c0c07030', ext: 'webm' });
  const groups = L.lookalikeGroups([b, c, a, v]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((e) => e.id), [a.id, b.id]);
});

test('entries and the index are cleaned; collections gathered', () => {
  assert.equal(L.normalizeEntry({ id: 'xyz', rel: 'g/x.png' }), null);
  assert.equal(L.normalizeEntry({ id: 'a'.repeat(32), rel: 'nofolder' }), null);
  const e = entry({ tags: ['Smug Frog', 'smug-frog', '', 'a,b'], board: 'G!', collections: ['Pepes', 'Pepes'], ext: 'GIF' });
  assert.deepEqual(e.tags, ['smug-frog', 'ab']);
  assert.equal(e.board, '');
  assert.equal(e.kind, 'gif');
  const idx = L.normalizeIndex({ items: [e, e, { id: 'bad' }], collections: ['Reactions'] });
  assert.equal(idx.items.length, 1);
  assert.deepEqual(idx.collections, ['Reactions', 'Pepes']);
  assert.deepEqual(L.normalizeIndex(null), L.emptyIndex());
});

test('an entry from a post keeps its source', () => {
  const post = { no: 5, resto: 1, tim: 1700000000000, ext: '.png', filename: 'frog', fsize: 1234, w: 300, h: 200, time: 1700000000, md5: Buffer.from('ab'.repeat(16), 'hex').toString('base64') };
  const e = L.entryFromPost({ board: 'g', thread: 1, post, subject: 'Pepe thread', text: 'feels good', rel: 'g/frog.png', now: 5 });
  assert.equal(e.id, 'ab'.repeat(16));
  assert.equal(e.name, 'frog.png');
  assert.deepEqual([e.board, e.thread, e.post, e.posted, e.size, e.sub], ['g', 1, 5, 1700000000000, 1234, 'Pepe thread']);
  // no MD5 (rare): a stable id from the file's name
  const noSum = L.entryFromPost({ board: 'g', thread: 1, post: { ...post, md5: undefined }, rel: 'g/frog.png' });
  assert.match(noSum.id, /^[0-9a-f]{32}$/);
  // the name as the post shows it: the API's HTML entities decoded
  assert.equal(L.entryFromPost({ board: 'g', thread: 1, post: { ...post, filename: 'don&#039;t &amp; do' }, rel: 'g/x.png' }).name, "don't & do.png");
  assert.equal(L.knownFiles([{ board: 'g', posts: [{ ...post, filename: 'a&amp;b' }] }]).get('ab'.repeat(16)).name, 'a&b.png');
});

test('imports: a file seen in a thread gets its source back; site names give the date', () => {
  const id = 'cd'.repeat(16);
  const posts = [
    { no: 10, sub: 'Comfy &amp; cozy', tim: 1, ext: '.jpg', md5: Buffer.from(id, 'hex').toString('base64'), com: 'look<br>at this', filename: 'cozy', time: 1600000000 },
    { no: 11, tim: 2, ext: '.png' },
  ];
  const known = L.knownFiles([{ board: 'cozy', posts }], (s) => s.replace(/<br>/g, '\n').replace(/&amp;/g, '&'));
  assert.equal(known.size, 1);
  const e = L.entryFromImport({ id, rel: 'imported/x.jpg', name: 'x.jpg', size: 5, known });
  assert.deepEqual([e.board, e.thread, e.post, e.sub, e.text, e.name], ['cozy', 10, 10, 'Comfy & cozy', 'look\nat this', 'cozy.jpg']);
  const f = L.entryFromImport({ id: 'ef'.repeat(16), rel: 'imported/1699999999999.jpg', name: '1699999999999.jpg', size: 5 });
  assert.equal(f.posted, 1699999999999);
  assert.equal(f.board, '');
  assert.equal(L.timeFromName('1699999999999123.png'), 1699999999999);
  assert.equal(L.timeFromName('frog.png'), 0);
  assert.equal(L.timeFromName('0000000000001.png'), 0);
});

test('search, filters and sorting', () => {
  const items = [
    entry({ id: '1'.repeat(32), name: 'frog.png', tags: ['smug'], board: 'g', added: 3, size: 5 }),
    entry({ id: '2'.repeat(32), name: 'cat.gif', ext: 'gif', tags: [], board: 'a', added: 2, size: 50, sub: 'Cat thread' }),
    entry({ id: '3'.repeat(32), name: 'clip.webm', ext: 'webm', tags: ['smug', 'loop'], board: 'g', added: 1, size: 9, collections: ['Best'] }),
  ];
  const names = (o) => L.filterItems(items, o).map((e) => e.name);
  assert.deepEqual(names({}), ['frog.png', 'cat.gif', 'clip.webm']);
  assert.deepEqual(names({ q: 'SMUG' }), ['frog.png', 'clip.webm']);
  assert.deepEqual(names({ q: 'cat thread' }), ['cat.gif']);
  assert.deepEqual(names({ kind: 'video' }), ['clip.webm']);
  assert.deepEqual(names({ board: 'g', sort: 'size' }), ['clip.webm', 'frog.png']);
  assert.deepEqual(names({ tag: 'untagged' }), ['cat.gif']);
  assert.deepEqual(names({ collection: 'Best' }), ['clip.webm']);
  assert.deepEqual(names({ sort: 'name' }), ['cat.gif', 'clip.webm', 'frog.png']);
  assert.deepEqual(L.tagCounts(items), [['smug', 2], ['loop', 1]]);
  assert.deepEqual(L.boardsOf(items), ['a', 'g']);
});

test('tag suggestions from the thread, minus common words and tags it has', () => {
  const e = entry({ sub: 'Wojak general', text: 'this wojak is the best wojak >>123456 anon', name: 'feels_guy.png', tags: ['feels'] });
  const s = L.suggestTags(e);
  assert.equal(s[0], 'wojak');
  assert.ok(!s.includes('feels') && !s.includes('anon') && !s.includes('the') && !s.includes('general'));
  assert.ok(!s.some((t) => /\d{5}/.test(t)));
});

test('the assistant: picture models by name, messages per server, tags from the answer', () => {
  assert.deepEqual(L.visionModels(['llama3.1:8b', 'llava:7b', 'gemma3:4b', 'qwen2.5vl:7b', 'nomic-embed-text', 'moondream']), ['llava:7b', 'gemma3:4b', 'qwen2.5vl:7b', 'moondream']);
  assert.deepEqual(L.aiTagMessages('ollama', 'QUJD')[0].images, ['QUJD']);
  assert.equal(L.aiTagMessages('lmstudio', 'QUJD')[0].content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
  assert.deepEqual(L.parseAiTags('Tags: Smug Frog, reaction,  green\n- pepe\n1. meme'), ['smug-frog', 'reaction', 'green', 'pepe', 'meme']);
  assert.deepEqual(L.parseAiTags('<think>hmm, x</think>cat, cat, a'), ['cat']);
  assert.equal(L.parseAiTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(',')).length, 8);
});

test('imported folders: listed, named, and filtered by where files came from', () => {
  const items = [
    entry({ id: '1'.repeat(32), name: 'a.png', folder: '/Users/x/Pictures/memes', from: 'reactions/a.png' }),
    entry({ id: '2'.repeat(32), name: 'b.png', folder: '/Users/x/Pictures/memes' }),
    entry({ id: '3'.repeat(32), name: 'c.png', folder: 'C:\\Users\\x\\Wojaks' }),
    entry({ id: '4'.repeat(32), name: 'd.png', board: 'g', post: 5, thread: 1 }),
    entry({ id: '5'.repeat(32), name: 'e.png' }),
  ];
  assert.deepEqual(L.foldersOf(items), [['/Users/x/Pictures/memes', 2], ['C:\\Users\\x\\Wojaks', 1]]);
  assert.equal(L.folderName('/Users/x/Pictures/memes/'), 'memes');
  assert.equal(L.folderName('C:\\Users\\x\\Wojaks'), 'Wojaks');
  const names = (source) => L.filterItems(items, { source, sort: 'name' }).map((e) => e.name);
  assert.deepEqual(names('dir:/Users/x/Pictures/memes'), ['a.png', 'b.png']);
  assert.deepEqual(names('threads'), ['d.png']);
  assert.deepEqual(names('files'), ['e.png']);
  assert.equal(names('').length, 5);
  assert.deepEqual(L.filterItems(items, { q: 'reactions' }).map((e) => e.name), ['a.png'], 'its path in the folder is searched');
});

const hex = (n) => n.toString(16).padStart(16, '0');
const hashOf = (big) => big.toString(16).padStart(16, '0');

test('look-alike groups form around the file kept: a chain of near ones is not one group', () => {
  // a ~ b and b ~ c (6 bits each), but a and c are 12 bits apart
  const a = entry({ id: '1'.repeat(32), dhash: hex(0), w: 100, h: 100 });
  const b = entry({ id: '2'.repeat(32), dhash: hex(0x3f), w: 50, h: 50 });
  const c = entry({ id: '3'.repeat(32), dhash: hex(0xfc3f), w: 400, h: 400 });
  assert.equal(L.hamming(a.dhash, c.dhash), 12);
  const groups = L.lookalikeGroups([a, b, c]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((e) => e.id), [c.id, b.id], 'c (the largest) keeps only what looks like it');
  for (const g of groups) for (const e of g.slice(1)) assert.ok(L.hamming(g[0].dhash, e.dhash) <= L.LOOKALIKE_BITS);
  // copies of the same picture (the same fingerprint) are one group
  const flat = Array.from({ length: 5 }, (_, i) => entry({ id: String(i + 4).repeat(32), dhash: hex(0), w: 10 + i, h: 10 }));
  assert.deepEqual(L.lookalikeGroups(flat)[0].map((e) => e.w), [14, 13, 12, 11, 10]);
});

test('look-alike groups match comparing every pair, and a big library is quick', () => {
  // random fingerprints, with near copies of some
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const items = [];
  for (let i = 0; i < 5000; i++) {
    let v = (BigInt(rnd()) << 33n) ^ (BigInt(rnd()) << 2n) ^ BigInt(rnd() & 3);
    if (i % 10 === 1) v = BigInt('0x' + items[i - 1].dhash) ^ (1n << BigInt(rnd() % 64)) ^ (1n << BigInt(rnd() % 64));
    items.push(entry({ id: i.toString(16).padStart(32, '0'), dhash: hashOf(v & 0xffffffffffffffffn), w: rnd() % 1000, h: 100, size: i }));
  }
  const t0 = performance.now();
  const groups = L.lookalikeGroups(items);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `5000 pictures took ${ms.toFixed(0)} ms`);
  // the same greedy grouping, comparing every pair
  const sorted = [...items].sort((x, y) => y.w * y.h - x.w * x.h || y.size - x.size);
  const placed = new Set();
  const want = [];
  for (const c of sorted) {
    if (placed.has(c)) continue;
    const g = sorted.filter((e) => !placed.has(e) && L.hamming(c.dhash, e.dhash) <= L.LOOKALIKE_BITS);
    g.forEach((e) => placed.add(e));
    if (g.length > 1) want.push(g.map((e) => e.id).sort());
  }
  assert.ok(want.length > 100);
  assert.deepEqual(groups.map((g) => g.map((e) => e.id).sort()).sort(), want.sort());
});

test('the index keeps its revision, and what a rescan leaves out of each folder', () => {
  const idx = L.normalizeIndex({ rev: 7, items: [], folders: { '/m': { deep: false, at: 3, removed: ['a.png', 'a.png', 5], dupes: ['b.png'] } } });
  assert.equal(idx.rev, 7);
  assert.deepEqual(idx.folders['/m'], { deep: false, at: 3, removed: ['a.png'], dupes: ['b.png'] });
  assert.equal(L.emptyIndex().rev, 0);
  const many = Array.from({ length: 6000 }, (_, i) => `${i}.png`);
  assert.equal(L.normalizeIndex({ folders: { '/m': { removed: many } } }).folders['/m'].removed.length, 6000, 'more than one import’s worth');
});

test('merging: this window’s changes made again on the file another window wrote', () => {
  const x = entry({ id: '1'.repeat(32), rel: 'g/x.png', tags: ['old'] });
  const y = entry({ id: '2'.repeat(32), rel: 'g/y.png' });
  const z = entry({ id: '3'.repeat(32), rel: 'g/z.png' });
  const start = L.normalizeIndex({ rev: 1, items: [x, y, z], collections: ['Keep'], folders: { '/a': { removed: ['1.png'] } } });
  const base = L.snapshotOf(start);
  // here: x tagged, z removed, w added, collection "New", /a gets a removal
  const mine = L.normalizeIndex(JSON.parse(JSON.stringify(start)));
  mine.items[0].tags = ['old', 'mine'];
  mine.items = mine.items.filter((e) => e.id !== z.id);
  const w = entry({ id: '4'.repeat(32), rel: 'g/w.png' });
  const v = entry({ id: '5'.repeat(32), rel: 'g/v-2.png' });
  mine.items.unshift(w, v);
  mine.collections.push('New');
  mine.folders['/a'].removed.push('2.png');
  // there: y removed, x got a fingerprint, u added, v added too (its own copy)
  const theirs = L.normalizeIndex(JSON.parse(JSON.stringify(start)));
  theirs.rev = 2;
  theirs.items = theirs.items.filter((e) => e.id !== y.id);
  theirs.items[0].dhash = 'ffffffffffffffff';
  theirs.items.unshift(entry({ id: '6'.repeat(32), rel: 'g/u.png' }), entry({ id: '5'.repeat(32), rel: 'g/v.png' }));
  theirs.folders['/a'].dupes = ['3.png'];
  const { index, dropped } = L.mergeIndex(base, mine, theirs);
  const byId = new Map(index.items.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), ['1', '4', '5', '6'].map((c) => c.repeat(32)), 'y stays removed (there), z removed (here), w and u added');
  assert.deepEqual(byId.get(x.id).tags, ['old', 'mine'], 'the tag added here');
  assert.equal(byId.get(x.id).dhash, 'ffffffffffffffff', 'the fingerprint found there');
  assert.equal(byId.get(v.id).rel, 'g/v.png', 'one kept there stays theirs');
  assert.deepEqual(dropped.map((e) => e.rel), ['g/v-2.png'], 'this copy of it is not used');
  assert.equal(index.rev, 2);
  assert.ok(index.collections.includes('New') && index.collections.includes('Keep'));
  assert.deepEqual(index.folders['/a'].removed, ['1.png', '2.png']);
  assert.deepEqual(index.folders['/a'].dupes, ['3.png']);
  // nothing changed here: the file as it is
  assert.deepEqual(L.mergeIndex(L.snapshotOf(theirs), theirs, theirs).index.items.map((e) => e.id), theirs.items.map((e) => e.id));
});

test('a folder’s left-out paths are added once each, quickly, and the oldest go past the limit', () => {
  const rec = L.normalizeFolder({ dupes: ['a', 'b'] });
  L.addFolderPath(rec, 'dupes', 'b');
  L.addFolderPath(rec, 'dupes', 'c');
  L.addFolderPath(rec, 'removed', 'a');
  L.addFolderPath(rec, 'removed', '');
  assert.deepEqual(rec.dupes, ['a', 'b', 'c']);
  assert.deepEqual(rec.removed, ['a']);
  const big = L.normalizeFolder({ dupes: Array.from({ length: L.MAX_FOLDER_PATHS }, (_, i) => `old/${i}`) });
  const list = big.dupes;
  const t0 = performance.now();
  for (let i = 0; i < 5000; i++) L.addFolderPath(big, 'dupes', `new/${i}`);
  for (let i = 0; i < 5000; i++) L.addFolderPath(big, 'dupes', `new/${i}`);
  const ms = performance.now() - t0;
  assert.equal(big.dupes, list, 'in place');
  assert.equal(big.dupes.length, L.MAX_FOLDER_PATHS);
  assert.equal(big.dupes[0], 'old/5000');
  assert.equal(big.dupes.at(-1), 'new/4999');
  assert.equal(new Set(big.dupes).size, big.dupes.length);
  assert.ok(ms < 1500, `5000 copies into a full list took ${ms.toFixed(0)} ms`);
  // a list read again (a new array) is checked against itself, not the old one
  big.dupes = ['new/1'];
  L.addFolderPath(big, 'dupes', 'old/1');
  assert.deepEqual(big.dupes, ['new/1', 'old/1']);
});
