// The thread gallery's items (gallery-model.js): spoilers and work mode as
// in the thread, file names as the poster gave them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { galleryItems, pictureShown, currentView, preloadable, saveName } from '../ui/js/gallery-model.js';
import { displayDefaults } from '../ui/js/display-model.js';
import { postFileName } from '../ui/js/render.js';

const urls = { thumbUrl: (b, p) => `t/${b}/${p.tim}`, mediaUrl: (b, p) => `f/${b}/${p.tim}${p.ext}` };
const posts = [
  { no: 1, tim: 11, ext: '.jpg', filename: 'plain' },
  { no: 2, tim: 22, ext: '.png', filename: 'secret', spoiler: 1 },
  { no: 3, tim: 33, ext: '.webm', filename: 'clip' },
];
const views = (items) => items.map((i) => i.view);

test('spoilers stay hidden unless Reveal spoilers is on', () => {
  // no settings passed: every file shows, as before (the caller opts in)
  assert.deepEqual(views(galleryItems(posts, 'g', urls)), [undefined, undefined, undefined]);
  assert.ok(galleryItems(posts, 'g', urls).every((it, i) => pictureShown(it, i)));
  assert.deepEqual(views(galleryItems(posts, 'g', urls, displayDefaults())), ['thumb', 'spoiler', 'thumb']);
  assert.deepEqual(views(galleryItems(posts, 'g', urls, { ...displayDefaults(), revealSpoilers: true })), ['thumb', 'thumb', 'thumb']);
});

test('work mode hides every picture except files already shown', () => {
  const work = { ...displayDefaults(), hideImages: true };
  assert.deepEqual(views(galleryItems(posts, 'g', urls, work)), ['line', 'line', 'line']);
  const items = galleryItems(posts, 'g', urls, work, { isShown: (p) => p.no === 3 });
  assert.deepEqual(views(items), ['line', 'line', 'thumb']);
});

test('pictureShown: hidden items show once revealed in the gallery', () => {
  const items = galleryItems(posts, 'g', urls, displayDefaults());
  assert.equal(pictureShown(items[0], 0), true);
  assert.equal(pictureShown(items[1], 1), false);
  assert.equal(pictureShown(items[1], 1, new Set([1])), true);
  // items made before views existed show as before
  assert.equal(pictureShown({ full: 'x' }, 0), true);
});

test('work mode: a spoiler moved to stays a spoiler until Show this file', () => {
  const work = { ...displayDefaults(), hideImages: true };
  const items = galleryItems(posts, 'g', urls, work);
  assert.deepEqual(items.map((i) => i.shownView), ['thumb', 'spoiler', 'thumb']);
  const opened = new Set([0, 1]);
  // a plain file shows once moved to; the spoiler does not
  assert.equal(pictureShown(items[0], 0, new Set(), opened), true);
  assert.equal(currentView(items[1], 1, new Set(), opened), 'spoiler');
  assert.equal(pictureShown(items[1], 1, new Set(), opened), false);
  // not moved to yet: still a line, no picture
  assert.equal(currentView(items[2], 2, new Set(), new Set()), 'line');
  assert.equal(pictureShown(items[2], 2), false);
  // Show this file reveals it
  assert.equal(pictureShown(items[1], 1, new Set([1]), opened), true);
  // with Reveal spoilers on, moving to it is enough
  const open = galleryItems(posts, 'g', urls, { ...work, revealSpoilers: true });
  assert.equal(pictureShown(open[1], 1, new Set(), new Set([1])), true);
  // shown earlier from its line in the thread: still a spoiler here
  const shown = galleryItems(posts, 'g', urls, work, { isShown: () => true });
  assert.deepEqual(views(shown), ['thumb', 'spoiler', 'thumb']);
});

test('preloadable: never a spoiler that is not revealed, in work mode too', () => {
  const work = galleryItems(posts, 'g', urls, { ...displayDefaults(), hideImages: true });
  assert.deepEqual(work.map((it, i) => preloadable(it, i)), [true, false, true]);
  assert.equal(preloadable(work[1], 1, new Set([1])), true);
  const plain = galleryItems(posts, 'g', urls, displayDefaults());
  assert.deepEqual(plain.map((it, i) => preloadable(it, i)), [true, false, true]);
  assert.ok(galleryItems(posts, 'g', urls).every((it, i) => preloadable(it, i)));
});

test('file names are decoded from the API, then cleaned for saving', () => {
  const p = { no: 9, tim: 99, ext: '.jpg', filename: 'don&#039;t &amp; &quot;do&quot;' };
  const [it] = galleryItems([p], 'g', urls);
  assert.equal(it.name, `don't & "do".jpg`);
  assert.equal(saveName(it), `don't & _do_.jpg`);
  // a decoded slash or angle bracket is still cleaned
  assert.equal(saveName({ name: postFileName({ filename: 'a&#47;b&lt;c', ext: '.png' }) }), 'a_b_c.png');
  assert.equal(postFileName({ tim: 123, ext: '.gif' }), '123.gif');
  assert.equal(postFileName({}), 'file');
});

test('saveName cuts the stem by code points and keeps the extension', () => {
  const long = { name: 'a'.repeat(200) + '.webm', ext: '.webm' };
  const cut = saveName(long);
  assert.equal(Array.from(cut).length, 120);
  assert.ok(cut.endsWith('.webm'));
  // an emoji (two UTF-16 units) is never split in half
  const emoji = saveName({ name: '😀'.repeat(130) + '.png', ext: '.png' });
  assert.equal(emoji, '😀'.repeat(116) + '.png');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoji), 'no lone high surrogate');
  // a suffix goes before the extension and still fits
  const twice = saveName(long, '-1234');
  assert.equal(Array.from(twice).length, 120);
  assert.ok(twice.endsWith('-1234.webm'));
  // the extension comes from item.ext; without one, from the last dot
  assert.equal(saveName({ name: 'x', ext: '.jpg' }), 'x.jpg');
  assert.equal(saveName({ name: 'a.b.gif' }), 'a.b.gif');
  assert.equal(saveName({ name: '', ext: '.jpg' }), 'file.jpg');
  assert.equal(saveName({}), 'file');
});
