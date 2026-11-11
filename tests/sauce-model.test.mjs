import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SAUCE_ENGINES, SAUCE_IDS, DEFAULT_SAUCE, normalizeSauce, sauceSource, sauceUrl, sauceLinks } from '../ui/js/sauce-model.js';

const pic = { no: 1, tim: 1745612650021207, ext: '.png' };
const vid = { no: 2, tim: 1745612650021208, ext: '.webm' };

test('sauceSource: the picture itself, a video’s thumbnail', () => {
  assert.equal(sauceSource('g', pic), 'https://i.4cdn.org/g/1745612650021207.png');
  assert.equal(sauceSource('g', { ...pic, ext: '.JPG' }), 'https://i.4cdn.org/g/1745612650021207.jpg');
  assert.equal(sauceSource('wsg', vid), 'https://i.4cdn.org/wsg/1745612650021208s.jpg');
  assert.equal(sauceSource('wsg', { ...vid, ext: '.mp4' }), 'https://i.4cdn.org/wsg/1745612650021208s.jpg');
  assert.equal(sauceSource('po', { tim: '123', ext: '.pdf' }), 'https://i.4cdn.org/po/123s.jpg');
});

test('sauceSource: nothing for no file, deleted files or odd parts', () => {
  assert.equal(sauceSource('g', { no: 3 }), null);
  assert.equal(sauceSource('g', { ...pic, filedeleted: 1 }), null);
  assert.equal(sauceSource('../x', pic), null);
  assert.equal(sauceSource('G', pic), null);
  assert.equal(sauceSource('g', { tim: '12/../3', ext: '.png' }), null);
  assert.equal(sauceSource('g', { tim: -4, ext: '.png' }), null);
  assert.equal(sauceSource('g', null), null);
});

test('sauceUrl: each engine, the address encoded', () => {
  const src = 'https://i.4cdn.org/g/1.png';
  const enc = encodeURIComponent(src);
  assert.equal(sauceUrl('saucenao', src), `https://saucenao.com/search.php?url=${enc}`);
  assert.equal(sauceUrl('lens', src), `https://lens.google.com/uploadbyurl?url=${enc}`);
  assert.equal(sauceUrl('yandex', src), `https://yandex.com/images/search?rpt=imageview&url=${enc}`);
  assert.equal(sauceUrl('iqdb', src), `https://iqdb.org/?url=${enc}`);
  assert.equal(sauceUrl('tineye', src), `https://tineye.com/search?url=${enc}`);
  assert.equal(sauceUrl('tracemoe', src), `https://trace.moe/?url=${enc}`);
  for (const e of SAUCE_ENGINES) assert.match(sauceUrl(e.id, src), /^https:\/\/[a-z.]+\//);
});

test('sauceUrl: unknown engines and non-web sources give nothing', () => {
  assert.equal(sauceUrl('bing', 'https://i.4cdn.org/g/1.png'), null);
  assert.equal(sauceUrl('iqdb', 'javascript:alert(1)'), null);
  assert.equal(sauceUrl('iqdb', 'file:///etc/passwd'), null);
  assert.equal(sauceUrl('iqdb', 'not a url'), null);
  assert.equal(sauceUrl('iqdb', null), null);
});

test('normalizeSauce: known ids once, in menu order; default when missing', () => {
  assert.deepEqual(normalizeSauce(undefined), [...DEFAULT_SAUCE]);
  assert.deepEqual(normalizeSauce('lens'), [...DEFAULT_SAUCE]);
  assert.deepEqual(normalizeSauce([]), []);
  assert.deepEqual(normalizeSauce(['tracemoe', 'lens', 'lens', 'bing', 3]), ['lens', 'tracemoe']);
  assert.deepEqual(normalizeSauce([...SAUCE_IDS].reverse()), [...SAUCE_IDS]);
  assert.deepEqual(DEFAULT_SAUCE, ['saucenao', 'lens', 'yandex', 'iqdb']);
});

test('sauceLinks: the chosen engines for a file, none without one', () => {
  const links = sauceLinks('g', pic);
  assert.deepEqual(links.map((l) => l.label), ['SauceNAO', 'Google Lens', 'Yandex', 'IQDB']);
  assert.ok(links.every((l) => l.url.includes(encodeURIComponent('https://i.4cdn.org/g/1745612650021207.png'))));
  assert.deepEqual(sauceLinks('g', vid, ['tracemoe']).map((l) => l.url), [`https://trace.moe/?url=${encodeURIComponent('https://i.4cdn.org/g/1745612650021208s.jpg')}`]);
  assert.deepEqual(sauceLinks('g', { no: 5 }), []);
  assert.deepEqual(sauceLinks('g', pic, []), []);
});

test('the desktop app may open every engine’s search address, and only those', () => {
  const cap = JSON.parse(readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
  const open = cap.permissions.find((p) => p?.identifier === 'opener:allow-open-url');
  const globs = open.allow.map((a) => new RegExp(`^${a.url.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  const src = 'https://i.4cdn.org/g/1.png';
  for (const e of SAUCE_ENGINES) assert.ok(globs.some((g) => g.test(sauceUrl(e.id, src))), e.id);
  assert.ok(!globs.some((g) => g.test('https://evil.example/?url=x')));
});
