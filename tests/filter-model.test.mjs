import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as F from '../ui/js/filter-model.js';

const post = (o) => ({ no: 1, resto: 0, name: 'Anonymous', com: '', ...o });

test('parseBoards: codes with or without slashes, commas or spaces; bad ones reported', () => {
  assert.deepEqual(F.parseBoards('g, /v/ diy  G'), { boards: ['g', 'v', 'diy'], bad: [] });
  assert.deepEqual(F.parseBoards(''), { boards: [], bad: [] });
  assert.deepEqual(F.parseBoards('g wayTooLongBoardCode b-d'), { boards: ['g'], bad: ['wayTooLongBoardCode', 'b-d'] });
});

test('normalizeFilter keeps valid fields, defaults the rest, drops what is not a filter', () => {
  const f = F.normalizeFilter({ field: 'com', pattern: 'spam', boards: ['g', 'BAD', 'g'], action: 'weird', junk: 1, id: 'abc' });
  assert.deepEqual(f, { id: 'abc', field: 'com', pattern: 'spam', regex: false, matchCase: false, boards: ['g'], action: 'hide', enabled: true });
  assert.equal(F.normalizeFilter({ field: 'nope', pattern: 'x' }), null);
  assert.equal(F.normalizeFilter({ field: 'com', pattern: '   ' }), null);
  assert.equal(F.normalizeFilter(null), null);
  assert.equal(F.normalizeFilter([]), null);
  assert.equal(F.normalizeFilter({ field: 'sub', pattern: 'x', boards: 'g v' }).boards.join(), 'g,v');
  assert.equal(F.normalizeFilter({ field: 'sub', pattern: 'x'.repeat(900) }).pattern.length, F.MAX_PATTERN);
  assert.match(F.normalizeFilter({ field: 'sub', pattern: 'x', id: 'has spaces!' }).id, /^[a-z0-9]{1,24}$/);
  // a bad regex is kept so it can be fixed, and an off filter stays off
  const bad = F.normalizeFilter({ field: 'com', pattern: '(', regex: true, enabled: false, action: 'highlight' });
  assert.equal(bad.regex, true);
  assert.equal(bad.enabled, false);
  assert.equal(bad.action, 'highlight');
});

test('normalizeFilters: valid entries, unique ids, capped', () => {
  const list = F.normalizeFilters([{ field: 'com', pattern: 'a', id: 'x' }, { field: 'com', pattern: 'b', id: 'x' }, 'junk', { field: 'id', pattern: 'c' }]);
  assert.equal(list.length, 3);
  assert.equal(new Set(list.map((f) => f.id)).size, 3);
  assert.deepEqual(F.normalizeFilters('nope'), []);
  const many = Array.from({ length: F.MAX_FILTERS + 20 }, (_, i) => ({ field: 'com', pattern: `p${i}` }));
  assert.equal(F.normalizeFilters(many).length, F.MAX_FILTERS);
});

test('filterProblem validates without throwing', () => {
  assert.equal(F.filterProblem({ pattern: 'ok' }), '');
  assert.equal(F.filterProblem({ pattern: '(', regex: false }), '', 'plain text may contain anything');
  assert.match(F.filterProblem({ pattern: '' }), /Write the text/);
  assert.match(F.filterProblem({ pattern: '(', regex: true }), /^Not a valid regular expression: /);
  assert.match(F.filterProblem({ pattern: '[a-', regex: true }), /^Not a valid regular expression/);
  assert.match(F.filterProblem({ pattern: 'a*', regex: true }), /every post/);
  assert.match(F.filterProblem({ pattern: 'x|', regex: true }), /every post/);
  assert.equal(F.filterProblem({ pattern: '^buy\\s+now', regex: true }), '');
  assert.match(F.filterProblem({ pattern: 'x'.repeat(F.MAX_PATTERN + 1) }), /At most/);
  assert.equal(F.compileRegex('(').re, undefined);
  assert.ok(F.compileRegex('(').error);
});

test('fieldValue reads each field as text', () => {
  const p = post({ com: 'Hello<br><span class="quote">&gt;green</span>', sub: 'A &amp; B', name: 'Mo&#039;', trip: '!!abc', id: 'Ab12Cd34', filename: 'cat&amp;dog', ext: '.png', md5: 'Q2xvdmVyRXllCg==' });
  assert.equal(F.fieldValue(p, 'com'), 'Hello\n>green');
  assert.equal(F.fieldValue(p, 'sub'), 'A & B');
  assert.equal(F.fieldValue(p, 'name'), "Mo'");
  assert.equal(F.fieldValue(p, 'trip'), '!!abc');
  assert.equal(F.fieldValue(p, 'id'), 'Ab12Cd34');
  assert.equal(F.fieldValue(p, 'filename'), 'cat&dog.png');
  assert.equal(F.fieldValue(p, 'md5'), 'Q2xvdmVyRXllCg==');
  assert.equal(F.fieldValue(post({}), 'filename'), '');
  assert.equal(F.fieldValue(null, 'com'), '');
  assert.equal(F.fieldValue(p, 'nope'), '');
});

test('plain text: anywhere in comments, the whole value of names and IDs; case ignored unless asked', () => {
  const c = (f) => F.compileFilters([{ id: 'a', enabled: true, boards: [], regex: false, matchCase: false, action: 'hide', ...f }], 'g');
  const p = post({ com: 'Buy CHEAP watches', name: 'Bob', id: 'XyZ', md5: 'AbC==' });
  assert.equal(F.classifyPost(c({ field: 'com', pattern: 'cheap' }), p), 'hide');
  assert.equal(F.classifyPost(c({ field: 'com', pattern: 'cheap', matchCase: true }), p), null);
  assert.equal(F.classifyPost(c({ field: 'name', pattern: 'bob' }), p), 'hide');
  assert.equal(F.classifyPost(c({ field: 'name', pattern: 'bo' }), p), null, 'names match whole');
  assert.equal(F.classifyPost(c({ field: 'id', pattern: ' xyz ' }), p), 'hide');
  assert.equal(F.classifyPost(c({ field: 'md5', pattern: 'abc==' }), p), null, 'MD5 case always matters');
  assert.equal(F.classifyPost(c({ field: 'md5', pattern: 'AbC==' }), p), 'hide');
  assert.equal(F.classifyPost(c({ field: 'sub', pattern: 'x' }), p), null, 'no subject, no match');
});

test('regex filters, board scope, switched off, bad patterns skipped', () => {
  const filters = [
    { id: '1', field: 'com', pattern: '^buy\\b', regex: true, matchCase: false, boards: [], action: 'hide', enabled: true },
    { id: '2', field: 'sub', pattern: 'general', regex: true, matchCase: false, boards: ['v'], action: 'highlight', enabled: true },
    { id: '3', field: 'com', pattern: '(', regex: true, matchCase: false, boards: [], action: 'hide', enabled: true },
    { id: '4', field: 'com', pattern: 'anything', regex: false, matchCase: false, boards: [], action: 'hide', enabled: false },
    { id: '5', field: 'com', pattern: '.*', regex: true, matchCase: false, boards: [], action: 'hide', enabled: true },
  ];
  assert.deepEqual(F.compileFilters(filters, 'g').map((c) => c.id), ['1']);
  assert.deepEqual(F.compileFilters(filters, 'v').map((c) => c.id), ['1', '2']);
  const v = F.compileFilters(filters, 'v');
  assert.equal(F.classifyPost(v, post({ com: 'BUY now' })), 'hide');
  assert.equal(F.classifyPost(v, post({ com: 'buyer' })), null);
  assert.equal(F.classifyPost(v, post({ sub: '/xyz/ General' })), 'highlight');
  assert.equal(F.classifyPost(v, post({ sub: 'general', com: 'buy it' })), 'hide', 'hide wins');
  assert.deepEqual(F.compileFilters(null, 'g'), []);
});

test('markPosts: hidden by hand first, then filters; unmarked posts left out', () => {
  const posts = [post({ no: 1, com: 'op' }), post({ no: 2, com: 'spam here' }), post({ no: 3, com: 'nice', name: 'Star' }), post({ no: 4, com: 'spam too' })];
  const compiled = F.compileFilters(
    [
      { id: 'a', field: 'com', pattern: 'spam', boards: [], action: 'hide', enabled: true },
      { id: 'b', field: 'name', pattern: 'star', boards: [], action: 'highlight', enabled: true },
    ],
    'g',
  );
  const marks = F.markPosts(posts, compiled, new Set([4]));
  assert.deepEqual([...marks], [
    [2, 'hide'],
    [3, 'highlight'],
    [4, 'hidden'],
  ]);
  assert.ok(F.isHiddenMark('hide') && F.isHiddenMark('hidden') && !F.isHiddenMark('highlight') && !F.isHiddenMark(undefined));
  assert.equal(F.markPosts(null, compiled).size, 0);
});

test('addFilter, updateFilter, removeFilter', () => {
  let s = { filters: [] };
  s = F.addFilter(s, { field: 'com', pattern: 'x' });
  assert.equal(s.filters.length, 1);
  const same = F.addFilter(s, { field: 'com', pattern: 'x' });
  assert.equal(same, s, 'duplicates are refused');
  assert.equal(F.addFilter(s, { field: 'com', pattern: '' }), s, 'invalid is refused');
  const id = s.filters[0].id;
  const u = F.updateFilter(s, id, { enabled: false, pattern: 'y' });
  assert.equal(u.filters[0].enabled, false);
  assert.equal(u.filters[0].pattern, 'y');
  assert.equal(u.filters[0].id, id);
  assert.equal(F.updateFilter(s, id, { pattern: '' }), s, 'an edit that empties it is refused');
  assert.equal(F.updateFilter(s, 'nope', { enabled: false }), s);
  assert.equal(F.removeFilter(s, id).filters.length, 0);
  assert.equal(F.removeFilter(s, 'nope'), s);
  assert.equal(F.addFilter({}, { field: 'id', pattern: 'a' }).filters.length, 1, 'no list yet');
  const full = { filters: F.normalizeFilters(Array.from({ length: F.MAX_FILTERS }, (_, i) => ({ field: 'com', pattern: `p${i}` }))) };
  assert.equal(F.addFilter(full, { field: 'com', pattern: 'one more' }), full);
});

test('export and import round-trip; bad JSON and junk reported, duplicates skipped', () => {
  const filters = F.normalizeFilters([
    { field: 'com', pattern: 'spam', regex: true, boards: ['g'] },
    { field: 'md5', pattern: 'AbC==', matchCase: true, action: 'highlight', enabled: false },
  ]);
  const text = F.exportFilters(filters);
  const doc = JSON.parse(text);
  assert.equal(doc.clovereye, 'filters');
  assert.equal(doc.version, 1);
  assert.ok(doc.filters.every((f) => !('id' in f)));
  const back = F.parseFilterImport(text);
  assert.equal(back.error, '');
  assert.equal(back.skipped, 0);
  assert.deepEqual(back.filters.map(({ id, ...r }) => (void id, r)), doc.filters);
  // a bare list works, junk entries are counted
  const bare = F.parseFilterImport(JSON.stringify([{ field: 'name', pattern: 'Bob' }, { field: 'x' }, 5]));
  assert.equal(bare.filters.length, 1);
  assert.equal(bare.skipped, 2);
  assert.match(F.parseFilterImport('{nope').error, /not valid JSON/);
  assert.match(F.parseFilterImport('{"a":1}').error, /No list of filters/);
  assert.match(F.parseFilterImport('').error, /not valid JSON/);
  // merging leaves out what is already there
  const s = { filters };
  const { settings, added } = F.mergeFilters(s, [...back.filters, ...bare.filters]);
  assert.equal(added, 1);
  assert.equal(settings.filters.length, 3);
  assert.equal(F.mergeFilters(s, []).settings, s);
});

test('quickFilters offers what a post has; quickFilter scopes to the board', () => {
  assert.deepEqual(F.quickFilters(post({ name: 'Anonymous' })), []);
  const all = F.quickFilters(post({ name: 'Bob', trip: '!x', id: 'Id12', md5: 'm==' }));
  assert.deepEqual(all.map((q) => q.field), ['name', 'trip', 'id', 'md5']);
  assert.deepEqual(all.map((q) => q.label), ['Filter this name', 'Filter this tripcode', 'Filter this ID', 'Filter this file (MD5)']);
  assert.deepEqual(F.quickFilters(post({ md5: 'm==', filedeleted: 1 })), []);
  const f = F.quickFilter('g', all[3]);
  assert.deepEqual(f, { field: 'md5', pattern: 'm==', regex: false, matchCase: true, boards: ['g'], action: 'hide', enabled: true });
  assert.deepEqual(F.quickFilter('NOT A BOARD', all[2]).boards, []);
  // a quick filter matches the post it came from
  const s = F.addFilter({ filters: [] }, F.quickFilter('g', all[2]));
  assert.equal(F.classifyPost(F.compileFilters(s.filters, 'g'), post({ id: 'Id12' })), 'hide');
  assert.equal(F.classifyPost(F.compileFilters(s.filters, 'v'), post({ id: 'Id12' })), null);
});

test('posts hidden by hand: toggle, per board, capped, normalised', () => {
  let s = { hiddenPosts: [] };
  s = F.toggleHidden(s, 'g', 5);
  assert.ok(F.isHidden(s, 'g', 5));
  assert.ok(!F.isHidden(s, 'v', 5));
  assert.deepEqual([...F.hiddenSet(s.hiddenPosts, 'g')], [5]);
  assert.equal(F.hiddenSet(s.hiddenPosts, 'v').size, 0);
  s = F.toggleHidden(s, 'g', 5);
  assert.ok(!F.isHidden(s, 'g', 5));
  assert.equal(F.toggleHidden(s, 'BAD', 1), s);
  assert.equal(F.toggleHidden(s, 'g', -1), s);
  let big = { hiddenPosts: [] };
  for (let i = 1; i <= F.MAX_HIDDEN_POSTS + 3; i++) big = F.toggleHidden(big, 'g', i);
  assert.equal(big.hiddenPosts.length, F.MAX_HIDDEN_POSTS);
  assert.equal(big.hiddenPosts[0].no, 4, 'the oldest go first');
  assert.deepEqual(F.normalizeHiddenPosts([{ board: 'g', no: 1 }, { board: 'g', no: 1 }, { board: 'X', no: 2 }, { board: 'v', no: 0 }, 'x', { board: 'v', no: 3, junk: 1 }]), [
    { board: 'g', no: 1 },
    { board: 'v', no: 3 },
  ]);
  assert.deepEqual(F.normalizeHiddenPosts(null), []);
});

test('repliesToYou: posts quoting yours, not your own; youSet per board', () => {
  const yous = [{ board: 'g', no: 2 }, { board: 'v', no: 3 }];
  const you = F.youSet(yous, 'g');
  assert.deepEqual([...you], [2]);
  const q = (n) => `<a href="#p${n}" class="quotelink">&gt;&gt;${n}</a>`;
  const posts = [post({ no: 1 }), post({ no: 2, com: q(1) }), post({ no: 3, com: `${q(2)}<br>yes` }), post({ no: 4, com: q(1) }), post({ no: 5, com: `${q(4)} ${q(2)}` }), post({ no: 6, com: '&gt;&gt;2 not a link' })];
  assert.deepEqual([...F.repliesToYou(posts, you)], [3, 5]);
  assert.equal(F.repliesToYou(posts, new Set()).size, 0);
  assert.equal(F.repliesToYou(null, you).size, 0);
  assert.equal(F.youSet(null, 'g').size, 0);
});

test('fieldLabel names each field', () => {
  assert.equal(F.fieldLabel('md5'), 'File MD5');
  assert.equal(F.fieldLabel('nope'), 'nope');
  assert.deepEqual(F.FILTER_ACTIONS.map((a) => a.value), ['hide', 'highlight']);
});

test('the filter list stays inside its share of the settings file', () => {
  const huge = (i) => ({ field: 'com', pattern: `${i}`.padEnd(F.MAX_PATTERN, 'é'), boards: Array.from({ length: F.MAX_FILTER_BOARDS }, (_, j) => `b${j}`) });
  const list = F.normalizeFilters(Array.from({ length: F.MAX_FILTERS }, (_, i) => huge(i)));
  assert.ok(list.length > 10 && list.length < F.MAX_FILTERS);
  assert.ok(F.filtersBytes(list) <= F.MAX_FILTERS_BYTES);
  const s = { filters: list };
  assert.equal(F.addProblem(s, huge('more')), 'size');
  assert.equal(F.addFilter(s, huge('more')), s);
  assert.equal(F.addProblemText('size'), 'The filter list is full. Remove some filters first.');
  // a small one may still fit; an edit that grows past the share is refused
  const small = { filters: list.slice(0, -1) };
  assert.equal(F.addProblem(small, { field: 'id', pattern: 'abc' }), '');
  assert.notEqual(F.updateFilter(s, list[0].id, { pattern: list[0].pattern }), s, 'same size is fine');
  const shortened = F.updateFilter(s, list[0].id, { pattern: 'x', boards: [] });
  assert.equal(shortened.filters[0].pattern, 'x');
  // small filters fill the room the shortened one left; then it cannot
  // grow back
  let filled = shortened;
  for (let k = 0; !F.addProblem(filled, { field: 'id', pattern: `f${k}` }); k++) filled = F.addFilter(filled, { field: 'id', pattern: `f${k}` });
  assert.ok(filled.filters.length > shortened.filters.length);
  assert.ok(F.filtersBytes(filled.filters) <= F.MAX_FILTERS_BYTES);
  assert.equal(F.updateFilter(filled, list[0].id, { pattern: huge(0).pattern, boards: huge(0).boards }), filled);
});

test('addProblem names why a filter is refused', () => {
  const s = F.addFilter({ filters: [] }, { field: 'com', pattern: 'x' });
  assert.equal(F.addProblem(s, { field: 'com', pattern: '' }), 'invalid');
  assert.equal(F.addProblem(s, { field: 'com', pattern: 'x' }), 'duplicate');
  assert.equal(F.addProblem(s, { field: 'com', pattern: 'y' }), '');
  const full = { filters: F.normalizeFilters(Array.from({ length: F.MAX_FILTERS }, (_, i) => ({ field: 'com', pattern: `p${i}` }))) };
  assert.equal(full.filters.length, F.MAX_FILTERS, '500 short filters fit');
  assert.equal(F.addProblem(full, { field: 'com', pattern: 'more' }), 'count');
  assert.equal(F.addProblemText('count'), `At most ${F.MAX_FILTERS} filters.`);
  assert.equal(F.addProblemText('duplicate'), 'That filter is already there.');
  assert.equal(F.addProblemText(''), '');
});
