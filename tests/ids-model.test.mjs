import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as I from '../ui/js/ids-model.js';

test('idColour: stable, a hex colour, and readable text on it', () => {
  const a = I.idColour('abcd1234');
  assert.deepEqual(I.idColour('abcd1234'), a, 'same ID, same colour');
  assert.match(a.bg, /^#[0-9a-f]{6}$/);
  assert.ok(a.fg === '#000000' || a.fg === '#ffffff');
  assert.notEqual(I.idColour('abcd1235').bg, a.bg, 'one letter apart, another colour');
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < 2000; i++) {
    const id = Math.random().toString(36).slice(2, 10);
    const c = I.idColour(id);
    assert.ok(I.contrastRatio(rgb(c.bg), rgb(c.fg)) >= 4.5, `${id}: ${c.bg} on ${c.fg}`);
  }
});

test('idColour: odd input does not throw', () => {
  assert.match(I.idColour('').bg, /^#[0-9a-f]{6}$/);
  assert.match(I.idColour(undefined).bg, /^#[0-9a-f]{6}$/);
  assert.match(I.idColour('Heaven').bg, /^#[0-9a-f]{6}$/);
});

test('contrastRatio and luminance follow WCAG', () => {
  assert.equal(I.contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(I.contrastRatio([12, 34, 56], [12, 34, 56]), 1);
  assert.equal(I.luminance([255, 255, 255]), 1);
});

test('idCounts counts posts per ID and skips posts without one', () => {
  const posts = [{ no: 1, id: 'a' }, { no: 2, id: 'b' }, { no: 3, id: 'a' }, { no: 4 }, { no: 5, id: '' }];
  assert.deepEqual([...I.idCounts(posts)], [['a', 2], ['b', 1]]);
  assert.equal(I.idCounts(null).size, 0);
  assert.deepEqual(I.postsWithId(posts, 'a'), [1, 3]);
  assert.deepEqual(I.postsWithId(posts, ''), []);
});

test('toggleIdHighlight: click to highlight, again to clear, another to switch', () => {
  assert.equal(I.toggleIdHighlight(null, 'a'), 'a');
  assert.equal(I.toggleIdHighlight('a', 'a'), null);
  assert.equal(I.toggleIdHighlight('a', 'b'), 'b');
  assert.equal(I.toggleIdHighlight('a', ''), null);
});
