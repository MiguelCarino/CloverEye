import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../ui/js/pasta-model.js';
import * as M from '../ui/js/setup-model.js';
import { insertAtCaret } from '../ui/js/compose-model.js';
import RAW from '../ui/data/pastas.js';

const base = () => M.normalizeSettings({ setupVersion: 3 });
const own = (id, text, extra = {}) => ({ id, title: '', text, at: 1, ...extra });

test('the built-in list: 25 to 40 entries, unique slugs, every field, lengths that match', () => {
  assert.equal(P.BUILT_IN.length, RAW.length, 'no entry is dropped as bad');
  assert.ok(P.BUILT_IN.length >= 25 && P.BUILT_IN.length <= 40, `${P.BUILT_IN.length} entries`);
  const ids = new Set();
  for (const p of RAW) {
    assert.match(p.id, /^[a-z0-9][a-z0-9-]*$/, p.id);
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
    ids.add(p.id);
    assert.ok(p.title.trim(), p.id);
    assert.ok(p.text.trim() && p.text.length <= P.MAX_TEXT, p.id);
    assert.equal(p.text, P.cleanText(p.text), `${p.id}: no trailing spaces`);
    assert.ok(Array.isArray(p.tags) && p.tags.length, p.id);
    assert.ok(p.tags.every((t) => ['bump', 'reaction', 'classic', 'greentext', 'tech'].includes(t)), p.id);
    assert.equal(p.length, P.lengthOf(p.text), `${p.id}: length`);
  }
  assert.ok(ids.has('bump'), 'the default pin is built in');
  assert.ok(RAW.some((p) => p.tags.includes('greentext') && p.text.split('\n').every((l) => l.startsWith('>'))), 'greentext kept');
  assert.ok(Object.isFrozen(P.BUILT_IN) && Object.isFrozen(P.BUILT_IN[0]));
});

test('lengthOf: short up to 40, medium up to 300, long past that', () => {
  assert.equal(P.lengthOf('x'.repeat(40)), 'short');
  assert.equal(P.lengthOf('x'.repeat(41)), 'medium');
  assert.equal(P.lengthOf('x'.repeat(300)), 'medium');
  assert.equal(P.lengthOf('x'.repeat(301)), 'long');
});

test('settings: defaults pin bump, older settings get them, junk falls back', () => {
  assert.deepEqual(M.defaults().pastas, { pinned: ['bump'], own: [] });
  assert.deepEqual(M.normalizeSettings({ theme: 'dark' }).pastas, { pinned: ['bump'], own: [] });
  assert.deepEqual(M.normalizeSettings({ pastas: 'nope' }).pastas, { pinned: ['bump'], own: [] });
  assert.deepEqual(M.normalizeSettings({ pastas: { pinned: 'x', own: 3 } }).pastas, { pinned: ['bump'], own: [] });
  // an empty pin list stays empty (all unpinned by hand)
  assert.deepEqual(M.normalizeSettings({ pastas: { pinned: [], own: [] } }).pastas, { pinned: [], own: [] });
});

test('normalise: pins keep built-in and own ids in order, unique; unknown ones go', () => {
  const p = P.normalizePastas({
    pinned: ['kek', 'own-a', 'gone', 'kek', 7, 'bump', 'own-z'],
    own: [own('own-a', 'mine')],
  });
  assert.deepEqual(p.pinned, ['kek', 'own-a', 'bump']);
  assert.deepEqual(p.own, [{ id: 'own-a', title: 'mine', text: 'mine', at: 1 }]);
});

test('normalise: own posts checked, cut to the reply limit, duplicates and built-in ids dropped', () => {
  const p = P.normalizePastas({
    pinned: [],
    own: [
      own('own-a', '  >line one   \r\n>line two  \n\n\n', { title: '  My   title ', at: 5.4 }),
      own('own-a', 'again'),
      own('bump', 'not over the built-in one'),
      own('BAD ID', 'x'),
      own('own-empty', '   \n  '),
      { id: 'own-long', text: 'y'.repeat(2500), at: -3 },
      null,
      'text',
    ],
  });
  assert.deepEqual(
    p.own.map((x) => x.id),
    ['own-a', 'own-long'],
  );
  assert.deepEqual(p.own[0], { id: 'own-a', title: 'My title', text: '  >line one\n>line two', at: 5 });
  assert.equal(p.own[1].text.length, P.MAX_TEXT);
  assert.equal(p.own[1].at, 0);
  assert.equal(p.own[1].title.length, 60, 'no title: its first line, cut');
});

test('normalise: at most MAX_OWN own posts and OWN_BYTES of them, the first (newest) kept', () => {
  const many = Array.from({ length: 260 }, (_, i) => own(`own-${i}`, `post ${i}`));
  const p = P.normalizePastas({ pinned: ['own-0', 'own-250'], own: many });
  assert.equal(p.own.length, P.MAX_OWN);
  assert.equal(p.own[0].id, 'own-0');
  assert.deepEqual(p.pinned, ['own-0'], 'a pin of a post dropped goes too');
  const big = Array.from({ length: 100 }, (_, i) => own(`own-${i}`, 'z'.repeat(2000)));
  const q = P.normalizePastas({ own: big });
  assert.ok(q.own.length < 100 && q.own.length > 30, `${q.own.length} kept`);
  assert.ok(new TextEncoder().encode(JSON.stringify(q.own)).length <= P.OWN_BYTES);
  // the whole settings file stays under what the app stores
  const s = M.normalizeSettings({ pastas: { own: Array.from({ length: 200 }, (_, i) => own(`own-${i}`, 'ж'.repeat(2000))) } });
  assert.ok(M.settingsBytes(s) <= M.SETTINGS_BUDGET);
});

test('search: case and accents folded, every word must match, in title, text or tags', () => {
  const list = [
    { id: 'a', title: 'Pokémon thread', text: 'Gotta bump them all', tags: ['bump'] },
    { id: 'b', title: 'Café', text: 'Second post', tags: ['reaction'] },
    { id: 'c', title: 'Other', text: 'A POKEMON bump here', tags: [] },
  ];
  assert.deepEqual(P.search('pokemon', list).map((p) => p.id), ['a', 'c']);
  assert.deepEqual(P.search('POKÉMON', list).map((p) => p.id), ['a', 'c']);
  assert.deepEqual(P.search('cafe', list).map((p) => p.id), ['b']);
  assert.deepEqual(P.search('pokemon bump', list).map((p) => p.id), ['a', 'c'], 'words anywhere');
  assert.deepEqual(P.search('pokemon second', list).map((p) => p.id), [], 'every word must match');
  assert.deepEqual(P.search('reaction', list).map((p) => p.id), ['b'], 'tags');
  assert.deepEqual(P.search('   ', list).map((p) => p.id), ['a', 'b', 'c'], 'no query: all, in order');
});

test('search: titles rank first, then the rest in list order; pinned first in pinned order', () => {
  const list = [
    { id: 'a', title: 'One', text: 'has bump inside', tags: [] },
    { id: 'b', title: 'Bump two', text: 'x', tags: [] },
    { id: 'c', title: 'Three', text: 'bump', tags: [] },
    { id: 'd', title: 'Bump four', text: 'y', tags: [] },
  ];
  assert.deepEqual(P.search('bump', list).map((p) => p.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(P.search('bump', list, ['c', 'x', 'b']).map((p) => p.id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(P.search('', list, ['d', 'a']).map((p) => p.id), ['d', 'a', 'b', 'c']);
  // the real list: built-in ones found by their tags and accents
  assert.ok(P.search('GNÚ linux', P.BUILT_IN).some((p) => p.id === 'gnu-interjection'));
});

test('sections: pinned, own, built in; capped with the total', () => {
  let s = P.addOwn(base(), { id: 'own-x', title: 'Mine', text: 'my bump', at: 2 });
  s = P.setPin(s, 'kek', true);
  const all = P.sections('', s);
  assert.deepEqual(all.pinned.map((p) => p.id), ['bump', 'kek']);
  assert.deepEqual(all.own.map((p) => p.id), ['own-x']);
  assert.equal(all.own[0].own, true);
  assert.equal(all.builtIn.length, P.BUILT_IN.length - 2);
  assert.equal(all.total, P.BUILT_IN.length + 1);
  const few = P.sections('', s, 5);
  assert.equal(few.shown, 5);
  assert.equal(few.total, all.total);
  assert.equal(few.pinned.length + few.own.length + few.builtIn.length, 5);
});

test('pins: toggle and set, at the end, same settings back when nothing changes', () => {
  const s = base();
  const a = P.togglePin(s, 'kek');
  assert.deepEqual(a.pastas.pinned, ['bump', 'kek']);
  assert.notEqual(a, s);
  assert.equal(s.pastas.pinned.length, 1, 'not changed in place');
  const b = P.togglePin(a, 'bump');
  assert.deepEqual(b.pastas.pinned, ['kek']);
  assert.equal(P.setPin(b, 'kek', true), b);
  assert.equal(P.setPin(b, 'nope', true), b, 'unknown id');
  assert.equal(P.isPinned(b, 'kek'), true);
  // settings from before the key
  const old = { theme: 'dark' };
  assert.deepEqual(P.togglePin(old, 'kek').pastas, { pinned: ['bump', 'kek'], own: [] });
});

test('own posts: add (newest first), edit in place, remove with its pin', () => {
  let s = base();
  s = P.addOwn(s, { id: 'own-1', title: 'First', text: 'one  \n', at: 10 });
  s = P.addOwn(s, { id: 'own-2', title: '', text: '>two\n>lines', at: 20 });
  assert.deepEqual(s.pastas.own.map((p) => p.id), ['own-2', 'own-1']);
  assert.equal(s.pastas.own[0].title, '>two');
  assert.equal(s.pastas.own[1].text, 'one');
  s = P.setPin(s, 'own-1', true);
  const e = P.editOwn(s, 'own-1', { title: 'Renamed', text: 'changed' }, 30);
  assert.deepEqual(e.pastas.own[1], { id: 'own-1', title: 'Renamed', text: 'changed', at: 30 });
  assert.deepEqual(e.pastas.own.map((p) => p.id), ['own-2', 'own-1'], 'stays where it was');
  assert.equal(P.editOwn(e, 'own-9', { text: 'x' }), e, 'unknown id');
  assert.equal(P.editOwn(e, 'own-1', { text: '  ' }), e, 'emptied: refused');
  const r = P.removeOwn(e, 'own-1');
  assert.deepEqual(r.pastas.own.map((p) => p.id), ['own-2']);
  assert.deepEqual(r.pastas.pinned, ['bump']);
  assert.equal(P.removeOwn(r, 'own-1'), r);
  // a made id is unique enough and valid
  const id = P.newOwnId(1700000000000, () => 0.5);
  assert.match(id, /^own-[a-z0-9]+-[a-z0-9]{4}$/);
  const made = P.addOwn(base(), { text: 'auto' });
  assert.match(made.pastas.own[0].id, /^own-/);
});

test('own posts: the caps refuse a new one, an edit still goes', () => {
  let s = base();
  const list = Array.from({ length: P.MAX_OWN }, (_, i) => own(`own-${i}`, `p${i}`));
  s = { ...s, pastas: P.normalizePastas({ pinned: [], own: list }) };
  assert.equal(P.ownProblem(s, { text: 'new' }), 'full');
  assert.equal(P.addOwn(s, { id: 'own-new', text: 'new' }), s);
  assert.equal(P.ownProblem(s, { id: 'own-3', text: 'edited' }), '');
  assert.equal(P.editOwn(s, 'own-3', { text: 'edited' }, 9).pastas.own[3].text, 'edited');
  assert.equal(P.ownProblem(base(), { text: '' }), 'empty');
  // bytes: big posts fill OWN_BYTES before MAX_OWN
  let b = base();
  let n = 0;
  for (; n < 100; n++) {
    const next = P.addOwn(b, { id: `own-b${n}`, text: 'q'.repeat(2000), at: n });
    if (next === b) break;
    b = next;
  }
  assert.ok(n > 30 && n < 100, `${n} fit`);
  assert.equal(P.ownProblem(b, { text: 'q'.repeat(2000) }), 'full');
  // a text past the limit is cut to it
  const long = P.addOwn(base(), { id: 'own-l', text: 'w'.repeat(2100) });
  assert.equal(long.pastas.own[0].text.length, P.MAX_TEXT);
});

test('merge across windows: each change replays on settings another window saved', () => {
  // this window pinned kek, added a post, removed nothing; the other
  // window meanwhile pinned saved and added a post of its own
  const start = base();
  const ops = [P.pastaOp('pin', 'kek', true), P.pastaOp('put', 'own-mine', { id: 'own-mine', title: 'Mine', text: 'mine', at: 3 })];
  let theirs = P.setPin(start, 'saved', true);
  theirs = P.addOwn(theirs, { id: 'own-theirs', text: 'theirs', at: 2 });
  const replayed = ops.map((o) => o[1]).reduce((s, f) => f(s), M.normalizeSettings(theirs));
  assert.deepEqual(replayed.pastas.pinned, ['bump', 'saved', 'kek']);
  assert.deepEqual(replayed.pastas.own.map((p) => p.id), ['own-mine', 'own-theirs']);
  // replaying twice changes nothing more (a pin is set, not toggled)
  const again = ops.map((o) => o[1]).reduce((s, f) => f(s), replayed);
  assert.deepEqual(again.pastas, replayed.pastas);
  // one key per post: an edit after the add replaces it and still adds
  const put = P.pastaOp('put', 'own-k', { id: 'own-k', text: 'v2', at: 5 });
  assert.equal(put[0], P.pastaOp('remove', 'own-k')[0]);
  assert.equal(put[1](start).pastas.own[0].text, 'v2');
  assert.equal(P.pastaOp('nope', 'x'), null);
  // unpinned here while the other window pinned something else
  const unpin = P.pastaOp('pin', 'bump', false);
  assert.deepEqual(unpin[1](P.setPin(start, 'kek', true)).pastas.pinned, ['kek']);
});

test('onlyPastasDiffer: true only when nothing else changed', () => {
  const a = base();
  const b = P.togglePin(a, 'kek');
  assert.equal(P.onlyPastasDiffer(a, b), true);
  assert.equal(P.onlyPastasDiffer(a, { ...b, theme: 'light' }), false);
  assert.equal(P.onlyPastasDiffer(a, JSON.parse(JSON.stringify(a))), true);
});

test('the text a pick inserts: newlines kept, trailing spaces gone', () => {
  assert.equal(P.pastaText({ text: '>be me  \r\n>bump\t\n\n  ' }), '>be me\n>bump');
  assert.equal(P.pastaText({ text: '\n\n  indented\nnext' }), '  indented\nnext');
  assert.equal(P.pastaText(null), '');
  const gnu = P.BUILT_IN.find((p) => p.id === 'gnu-interjection');
  assert.equal(P.pastaText(gnu), gnu.text);
});

test('preview: one or two lines, cut with an ellipsis', () => {
  assert.equal(P.preview('>be me\n>open\n>bump'), '>be me · >open …');
  assert.equal(P.preview('one\n\n two  words '), 'one · two words');
  assert.equal(P.preview('x'.repeat(200), 20), `${'x'.repeat(19)}…`);
});

test('insert into the comment (compose.js insertText): a new line first unless at a line start', () => {
  // what compose.js insertText does with the comment and its caret
  assert.deepEqual(insertAtCaret('', 0, 'bump'), { text: 'bump', caret: 4 });
  assert.deepEqual(insertAtCaret('>>123', 5, 'kek'), { text: '>>123\nkek', caret: 9 });
  assert.deepEqual(insertAtCaret('>>123\n', 6, 'kek'), { text: '>>123\nkek', caret: 9 });
  // in the middle of the text: on a line of its own, the rest after
  assert.deepEqual(insertAtCaret('ab', 1, 'X'), { text: 'a\nX\nb', caret: 4 });
  assert.deepEqual(insertAtCaret('a\nb', 2, '>be me\n>bump'), { text: 'a\n>be me\n>bump\nb', caret: 15 });
});

test('own posts: OWN_BYTES counts what they take in the saved, pretty-printed file', () => {
  // posts that fill the cap long before MAX_OWN
  const list = Array.from({ length: 400 }, (_, i) => own(`own-f${i}`, `${'é'.repeat(20)}${'x'.repeat(370)}`, { at: i }));
  const full = { ...base(), pastas: P.normalizePastas({ pinned: [], own: list }) };
  const empty = { ...base(), pastas: { pinned: [], own: [] } };
  const kept = full.pastas.own.length;
  assert.ok(kept > 20 && kept < 400, `${kept} kept`);
  const grew = M.settingsBytes(full) - M.settingsBytes(empty);
  assert.ok(grew <= P.OWN_BYTES, `the file grew ${grew} bytes, the cap is ${P.OWN_BYTES}`);
  // and the count is close, not a loose overestimate
  assert.ok(grew > P.OWN_BYTES - 1024, `the file grew ${grew} bytes, the cap is ${P.OWN_BYTES}`);
  // ownProblem measures the same way: no room for one more of them
  assert.equal(P.ownProblem(full, { text: 'x'.repeat(390) }), 'full');
  // the per-post count matches the file, one post in
  const one = { ...base(), pastas: { pinned: [], own: [P.normalizeOwn(own('own-one', 'a\nb'))] } };
  const two = { ...base(), pastas: { pinned: [], own: [P.normalizeOwn(own('own-one', 'a\nb')), P.normalizeOwn(own('own-two', 'c'))] } };
  assert.equal(M.settingsBytes(two) - M.settingsBytes(one), P.postBytes(P.normalizeOwn(own('own-two', 'c'))));
});

test('merge across windows: add, pin, edit, then another window saves: the pin stays', () => {
  // as shell.js save() keeps them: a replaced change moves to the end
  const pending = new Map();
  const queue = (op) => {
    pending.delete(op[0]);
    pending.set(op[0], op[1]);
  };
  let mine = base();
  const apply = (op) => {
    mine = op[1](mine);
    queue(op);
  };
  const entry = { id: 'own-abc-0001', title: '', text: 'hello', at: 1 };
  apply(P.pastaOp('put', entry.id, entry, { pinned: P.isPinned(mine, entry.id) }));
  apply(P.pastaOp('pin', entry.id, true));
  const edit = { ...entry, text: 'hello edited', at: 2 };
  apply(P.pastaOp('put', entry.id, edit, { pinned: P.isPinned(mine, entry.id) }));
  assert.deepEqual([...pending.keys()], ['pasta-pin:own-abc-0001', 'pasta-own:own-abc-0001']);
  assert.ok(P.isPinned(mine, entry.id));
  // the other window saved a read mark meanwhile: it has no own-abc-0001
  const theirs = M.normalizeSettings({ ...base(), lastRead: { 'g/1': 5 } });
  const replayed = [...pending.values()].reduce((s, f) => f(s), theirs);
  assert.deepEqual(replayed.pastas.own.map((p) => p.text), ['hello edited']);
  assert.ok(P.isPinned(replayed, entry.id), 'still pinned after the replay');
  // an edit of a post that is not pinned does not pin it
  const plain = P.pastaOp('put', 'own-x', { id: 'own-x', text: 'x', at: 1 }, { pinned: false });
  assert.equal(P.isPinned(plain[1](base()), 'own-x'), false);
});
