import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeMenu } from '../ui/js/post-menu.js';

const rect = (left, top, w = 24, h = 24) => ({ left, top, right: left + w, bottom: top + h });
const view = { width: 800, height: 600 };
const size = { width: 200, height: 150 };

test('placeMenu: under the button, right edges lined up', () => {
  assert.deepEqual(placeMenu(rect(500, 100), size, view), { left: 324, top: 128 });
});

test('placeMenu: above the button when there is no room below', () => {
  assert.deepEqual(placeMenu(rect(500, 540), size, view), { left: 324, top: 386 });
});

test('placeMenu: never outside the window', () => {
  assert.deepEqual(placeMenu(rect(10, 100), size, view), { left: 8, top: 128 });
  const tall = placeMenu(rect(500, 300), { width: 200, height: 590 }, view);
  assert.ok(tall.top >= 8);
  const wide = placeMenu(rect(790, 10, 4, 4), { width: 900, height: 50 }, view);
  assert.equal(wide.left, 8);
});
