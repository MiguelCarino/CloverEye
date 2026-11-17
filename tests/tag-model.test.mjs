import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../ui/js/tag-model.js';
import { normalizeSettings } from '../ui/js/setup-model.js';

const tag = (o) => T.normalizeTag({ name: 'x', terms: 'x', ...o });

test('tags are cleaned: a name and words needed; a board or universal; an id always', () => {
  assert.equal(T.normalizeTag({ name: '', terms: 'a' }), null);
  assert.equal(T.normalizeTag({ name: 'a', terms: ' , ' }), null);
  const t = T.normalizeTag({ name: '  Rust  ', terms: 'rust, cargo,rust\nborrow checker', board: 'g', library: true });
  assert.deepEqual([t.name, t.terms, t.board, t.library], ['Rust', ['rust', 'cargo', 'borrow checker'], 'g', true]);
  assert.match(t.id, /^[a-z0-9-]+$/);
  // a missing id or board is not the word "undefined"
  assert.notEqual(T.normalizeTag({ name: 'a', terms: 'b', id: undefined }).id, 'undefined');
  assert.equal(T.normalizeTag({ name: 'a', terms: 'b', board: undefined }).board, '');
  assert.equal(T.normalizeTag({ name: 'a', terms: 'b', board: 'G/../' }).board, '');
  const list = T.normalizeTags([{ id: 'same', name: 'a', terms: 'a' }, { id: 'same', name: 'b', terms: 'b' }, null]);
  assert.deepEqual(list.map((x) => x.id), ['same', 'same-2']);
  assert.deepEqual(normalizeSettings({ tags: [{ name: 'a', terms: 'b' }] }).tags.length, 1);
  assert.deepEqual(normalizeSettings({}).tags, []);
});

test('matching: any word, case and accents ignored, -words leave out, /patterns/', () => {
  const t = tag({ terms: 'rust, Borrow Checker, -crab' });
  assert.equal(T.matchesText(t, 'Learning RUST today'), true);
  assert.equal(T.matchesText(t, 'the borrow checker hates me'), true);
  assert.equal(T.matchesText(t, 'rust crab rave'), false, '-crab leaves it out');
  assert.equal(T.matchesText(t, 'go is fine'), false);
  assert.equal(T.matchesText(tag({ terms: 'cafe' }), 'Café talk'), true);
  assert.equal(T.matchesText(tag({ terms: '/^\\d{3}$/m' }), 'abc\n123'), true);
  assert.equal(T.matchesText(tag({ terms: '/(/' }), '((('), false, 'a broken pattern finds nothing');
});

test('a board shows its own tags first, then universal ones; threads get labels', () => {
  const tags = [tag({ id: 'u', name: 'u', terms: 'desk' }), tag({ id: 'g1', name: 'g1', terms: 'rust', board: 'g' }), tag({ id: 'v1', name: 'v1', terms: 'game', board: 'v' })];
  assert.deepEqual(T.tagsFor(tags, 'g').map((t) => t.id), ['g1', 'u']);
  const threads = [
    { no: 1, sub: 'Rust thread', com: 'my desk' },
    { no: 2, sub: '', com: 'nothing<br>here' },
    { no: 3, com: 'battlestation', filename: 'desk_setup' },
  ];
  const labels = T.labelThreads(T.tagsFor(tags, 'g'), threads, (s) => s.replace(/<br>/g, '\n'));
  assert.deepEqual([...labels].map(([no, l]) => [no, l.map((t) => t.id)]), [[1, ['g1', 'u']], [3, ['u']]]);
});

test('universal tags look in the favourites and open boards, most replied first', () => {
  assert.deepEqual(T.activeBoards(['g', 'v'], ['v', 'a', 'BAD']), ['g', 'v', 'a']);
  const t = tag({ terms: 'desk' });
  const finds = T.findAcross(t, [['g', [{ no: 1, sub: 'desk', replies: 3 }]], ['a', [{ no: 2, com: 'desk', replies: 9 }, { no: 3, com: 'no' }]]], (s) => s);
  assert.deepEqual(finds.map((f) => `${f.board}/${f.thread.no}`), ['a/2', 'g/1']);
});

test('library files match a tag by name, tags, thread and words', () => {
  const t = tag({ terms: 'pepe' });
  const e = { name: 'x.png', tags: ['frog'], sub: '', text: '', from: '' };
  assert.equal(T.libraryMatches(t, e), false);
  assert.equal(T.libraryMatches(t, { ...e, tags: ['pepe'] }), true);
  assert.equal(T.libraryMatches(t, { ...e, from: 'memes/pepe/x.png' }), true);
});

test('hide tags: on by default, whole words when asked, only the ones at work hide', () => {
  const t = T.normalizeTag({ name: 'h', terms: 'art', mode: 'hide' });
  assert.deepEqual([t.mode, t.on, t.whole], ['hide', true, false]);
  assert.equal(T.normalizeTag({ name: 's', terms: 'x', mode: 'weird' }).mode, 'show');
  const whole = { ...t, whole: true };
  assert.equal(T.matchesText(whole, 'start a party'), false);
  assert.equal(T.matchesText(whole, 'pixel ART, nice'), true);
  assert.equal(T.matchesText(t, 'start a party'), true, 'without whole, a part counts');
  assert.equal(T.matchesText({ ...whole, terms: ['art', '-pixel'] }, 'pixel art'), false);
  const posts = [{ no: 1, com: 'art thread' }, { no: 2, com: 'start' }, { no: 3, sub: 'Art' }];
  const tags = [{ ...whole, id: 'h1' }, T.normalizeTag({ id: 's1', name: 's', terms: 'start' }), { ...whole, id: 'off', on: false, terms: ['start'] }];
  assert.deepEqual([...T.hiddenByTags(tags, 'g', posts, (x) => x)], [1, 3], 'show tags and switched-off hide tags hide nothing');
  assert.deepEqual(T.hidingOn(tags, 'g').map((x) => x.id), ['h1']);
  assert.deepEqual([...T.hiddenByTags([{ ...whole, board: 'v' }], 'g', posts, (x) => x)], [], 'another board’s tag');
});

test('a flag code in a tag means the country, never a board flag that reuses it', () => {
  const nazi = { no: 1, board_flag: 'NZ', flag_name: 'Nazi', com: 'x' };
  const kiwi = { no: 2, country: 'NZ', country_name: 'New Zealand', com: 'x' };
  const autumn = { no: 3, board_flag: 'AU', flag_name: 'Autumn Blaze', com: 'x' };
  const posts = [nazi, kiwi, autumn];
  const pick = (flags) => posts.filter((p) => T.matchesPost(T.normalizeTag({ name: 't', terms: '', flags }), p)).map((p) => p.no);
  assert.deepEqual(pick(['NZ']), [2]);
  assert.deepEqual(pick(['AU']), []);
  assert.deepEqual(pick(['Nazi', 'Autumn Blaze']), [1, 3], 'board flags by name');
});

test('a tag can find flags: alone, or with words; -words still leave out', () => {
  assert.equal(T.normalizeTag({ name: 'kiwis', terms: '', flags: ['NZ'] }).flags[0], 'NZ', 'only flags is enough');
  assert.equal(T.normalizeTag({ name: 'none', terms: '', flags: [] }), null);
  const kiwi = { no: 1, country: 'NZ', country_name: 'New Zealand', com: 'hello' };
  const templar = { no: 2, board_flag: 'TM', flag_name: 'Templar', com: 'deus vult' };
  const plain = { no: 3, com: 'hello' };
  const flags = T.normalizeTag({ name: 'f', terms: '', flags: ['nz', 'Templar'] });
  assert.deepEqual([kiwi, templar, plain].filter((p) => T.matchesPost(flags, p)).map((p) => p.no), [1, 2]);
  const both = T.normalizeTag({ name: 'b', terms: 'hello, -vult', flags: ['Templar'] });
  assert.deepEqual([kiwi, templar, plain].filter((p) => T.matchesPost(both, p)).map((p) => p.no), [1, 3], 'a -word leaves out a flag match too');
  const hide = { ...flags, mode: 'hide', on: true, board: 'int' };
  assert.deepEqual([...T.hiddenByTags([hide], 'int', [kiwi, templar, plain], (x) => x)], [1, 2]);
});

test('tag stats: finds recorded per day, kept 30 days, gone with their tag', () => {
  const tags = [T.normalizeTag({ id: 'a', name: 'a', terms: 'rust' }), T.normalizeTag({ id: 'b', name: 'b', terms: 'go', board: 'v' })];
  const day = Date.UTC(2026, 10, 16, 12);
  let hist = T.recordFinds({}, tags, 'g', [{ no: 1, com: 'rust' }, { no: 2, com: 'go' }], (x) => x, day);
  hist = T.recordFinds(hist, tags, 'g', [{ no: 1, com: 'rust' }, { no: 3, com: 'rust too' }], (x) => x, day);
  assert.deepEqual(hist, { a: { [T.dayKey(day)]: ['g/1', 'g/3'] } }, 'the /v/ tag looks in /g/ not at all; the same thread counts once');
  hist = T.recordFinds(hist, tags, 'g', [{ no: 4, com: 'rust' }], (x) => x, day + 86400000);
  const { days, total } = T.dailyFinds(hist, 'a', 3, day + 86400000);
  assert.deepEqual(days.map((d) => d.n), [0, 2, 1]);
  assert.equal(total, 3);
  const later = T.recordFinds(hist, tags, 'g', [], (x) => x, day + 40 * 86400000);
  assert.deepEqual(later.a, {}, 'older than 30 days: dropped');
  assert.deepEqual(Object.keys(T.recordFinds(hist, [tags[1]], 'g', [], (x) => x, day)), [], 'a deleted tag’s days go');
  assert.deepEqual(T.normalizeHistory({ a: { '2026-11-16': ['g/1', 'bad', 5] }, 'Bad Id': {} }), { a: { '2026-11-16': ['g/1'] } });
});

test('the per-post and per-tag caches give the same answers as a fresh match', () => {
  const plain = (s) => s.replace(/<[^>]*>/g, '');
  const tags = [
    T.normalizeTag({ id: 'a', name: 'a', terms: 'rust, -crab' }),
    T.normalizeTag({ id: 'b', name: 'b', terms: '/bo+rrow/i' }),
    T.normalizeTag({ id: 'c', name: 'c', terms: 'art', whole: true }),
    T.normalizeTag({ id: 'd', name: 'd', terms: 'café' }),
    T.normalizeTag({ id: 'e', name: 'e', flags: ['NZ'] }),
  ];
  const posts = [
    { no: 1, com: '<b>Rust</b> is fine' },
    { no: 2, com: 'rust and a crab' },
    { no: 3, sub: 'BOOORROW checker' },
    { no: 4, com: 'start of the art' },
    { no: 5, com: 'start only' },
    { no: 6, com: 'un CAFE noir' },
    { no: 7, com: 'kia ora', country: 'NZ' },
  ];
  const expect = { 1: ['a'], 2: [], 3: ['b'], 4: ['c'], 5: [], 6: ['d'], 7: ['e'] };
  for (let round = 0; round < 3; round++) {
    const labels = T.labelThreads(tags, posts, plain);
    for (const p of posts) assert.deepEqual((labels.get(p.no) || []).map((t) => t.id), expect[p.no], `round ${round}, No. ${p.no}`);
  }
  // a post changed in place is read again
  posts[4].com = 'art gallery';
  assert.deepEqual(T.labelThreads(tags, posts, plain).get(5).map((t) => t.id), ['c']);
  // another plain function gives its own text
  assert.equal(T.matchesPost(tags[0], { no: 9, com: 'R<i>u</i>st' }, plain), true);
  const p9 = { no: 9, com: 'R<i>u</i>st' };
  assert.equal(T.matchesPost(tags[0], p9, plain), true);
  assert.equal(T.matchesPost(tags[0], p9, (s) => s), false);
  // an edited tag (a new object) is folded again
  assert.equal(T.matchesPost(T.normalizeTag({ id: 'a', name: 'a', terms: 'fine' }), posts[0], plain), true);
  assert.deepEqual(T.findAcross(tags[3], new Map([['g', posts]]), plain).map((f) => f.thread.no), [6]);
});
