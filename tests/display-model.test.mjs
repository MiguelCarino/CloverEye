// Display switches (Settings → Posts): times, spoilers, work mode, images
// expanded in threads, gallery preloading, anonymised names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as D from '../ui/js/display-model.js';
import { ago } from '../ui/js/browse-model.js';

const T = 1762300000; // 4 November 2025, 23:46:40 UTC
const post = { no: 1, time: T, now: '11/04/25(Tue)18:46:40', name: 'Anon<b>', trip: '!!abc', id: 'Ab3dE9xQ', country: 'NZ' };

test('defaults: local time, spoilers hidden, files shown, nothing expanded, gallery preloads, real names', () => {
  assert.deepEqual(D.displayDefaults(), {
    time: 'local',
    revealSpoilers: false,
    hideImages: false,
    autoExpand: false,
    galleryPreload: true,
    anonymize: false,
  });
  assert.deepEqual(D.TIME_MODES, ['local', 'relative', 'board']);
});

test('normalizeDisplay keeps good values and repairs the rest', () => {
  assert.deepEqual(D.normalizeDisplay(undefined), D.displayDefaults());
  assert.deepEqual(D.normalizeDisplay([]), D.displayDefaults());
  assert.deepEqual(D.normalizeDisplay('relative'), D.displayDefaults());
  const all = { time: 'relative', revealSpoilers: true, hideImages: true, autoExpand: true, galleryPreload: false, anonymize: true };
  assert.deepEqual(D.normalizeDisplay(all), all);
  assert.deepEqual(D.normalizeDisplay({ ...all, junk: 1 }), all, 'unknown keys dropped');
  assert.deepEqual(D.normalizeDisplay({ time: 'utc', revealSpoilers: 'yes', hideImages: 1, autoExpand: null, galleryPreload: 'no', anonymize: 0 }), D.displayDefaults());
  assert.equal(D.normalizeDisplay({ time: 'board' }).time, 'board');
});

test('local time: the full date and time in the given language and zone', () => {
  assert.equal(D.localTime(T, 'en-GB', 'UTC'), '4 Nov 2025, 23:46:40');
  assert.match(D.localTime(T, 'ja', 'Asia/Tokyo'), /2025.*11.*5.*08:46:40/);
  assert.equal(D.localTime(NaN), '');
  assert.equal(D.localTime(0), '');
  assert.ok(D.localTime(T, 'not a locale!!', 'UTC'), 'a bad locale falls back to the default one');
});

test('postTime: local, relative (with the full time on hover) and the site’s own text', () => {
  const opts = { locale: 'en-GB', timeZone: 'UTC', now: (T + 180) * 1000 };
  assert.deepEqual(D.postTime(post, 'local', opts), { text: '4 Nov 2025, 23:46:40', title: post.now, relative: false, unix: T });
  assert.deepEqual(D.postTime(post, 'relative', opts), { text: '3 min ago', title: '4 Nov 2025, 23:46:40', relative: true, unix: T });
  assert.equal(D.postTime(post, 'relative', opts).text, ago(T, opts.now), 'the same wording as the rest of the app');
  assert.deepEqual(D.postTime(post, 'board', opts), { text: post.now, title: '4 Nov 2025, 23:46:40', relative: false, unix: T });
  assert.equal(D.postTime(post, 'nonsense', opts).text, '4 Nov 2025, 23:46:40', 'an unknown mode reads as local');
});

test('postTime falls back when the post lacks a time or the site text', () => {
  const opts = { locale: 'en-GB', timeZone: 'UTC' };
  assert.deepEqual(D.postTime({ now: 'site text' }, 'relative', opts), { text: 'site text', title: '', relative: false, unix: null });
  assert.deepEqual(D.postTime({ now: 'site text' }, 'local', opts), { text: 'site text', title: '', relative: false, unix: null });
  assert.equal(D.postTime({ time: T, now: '' }, 'board', opts).text, '4 Nov 2025, 23:46:40', 'no site text: local');
  assert.equal(D.postTime({ time: T, now: '' }, 'local', opts).title, '', 'no site text: no tooltip');
  assert.deepEqual(D.postTime(null, 'local', opts), { text: '', title: '', relative: false, unix: null });
});

test('posterName: the post’s own, or Anonymous with no tripcode', () => {
  assert.deepEqual(D.posterName(post), { name: 'Anon<b>', trip: '!!abc' });
  assert.deepEqual(D.posterName({}), { name: 'Anonymous', trip: '' });
  assert.deepEqual(D.posterName(post, true), { name: 'Anonymous', trip: '' });
  assert.equal(post.name, 'Anon<b>', 'the post itself is untouched, so filters still read the real name');
});

test('fileView: none, deleted, work mode line, spoiler box or thumbnail', () => {
  const d = D.displayDefaults();
  const img = { tim: 1, ext: '.jpg' };
  const spoiler = { tim: 2, ext: '.png', spoiler: 1 };
  assert.equal(D.fileView({}, d), 'none');
  assert.equal(D.fileView({ filedeleted: 1 }, d), 'gone');
  assert.equal(D.fileView({ filedeleted: 1 }, { ...d, hideImages: true }), 'gone');
  assert.equal(D.fileView(img, d), 'thumb');
  assert.equal(D.fileView(spoiler, d), 'spoiler');
  assert.equal(D.fileView(spoiler, { ...d, revealSpoilers: true }), 'thumb');
  assert.equal(D.fileView(img, { ...d, hideImages: true }), 'line');
  assert.equal(D.fileView(img, { ...d, hideImages: true }, { shown: true }), 'thumb', 'clicked: shown this time');
  assert.equal(D.fileView(spoiler, { ...d, hideImages: true }, { shown: true }), 'spoiler', 'shown from work mode, still a spoiler');
  assert.equal(D.fileView({ ext: '.jpg' }, d, { hasFile: true }), 'thumb', 'a file without a tim (the setup sample)');
  assert.equal(D.fileView(img, undefined), 'thumb');
});

test('catalogThumbView: placeholders in work mode and for spoilers', () => {
  const d = D.displayDefaults();
  assert.equal(D.catalogThumbView({ tim: 1 }, d), 'thumb');
  assert.equal(D.catalogThumbView({}, d), 'none');
  assert.equal(D.catalogThumbView({ tim: 1, filedeleted: 1 }, d), 'none');
  assert.equal(D.catalogThumbView({ tim: 1 }, { ...d, hideImages: true }), 'hidden');
  assert.equal(D.catalogThumbView({ tim: 1, spoiler: 1 }, d), 'spoiler');
  assert.equal(D.catalogThumbView({ tim: 1, spoiler: 1 }, { ...d, revealSpoilers: true }), 'thumb');
  assert.equal(D.catalogThumbView({ tim: 1, spoiler: 1 }, { ...d, hideImages: true, revealSpoilers: true }), 'hidden');
});

test('autoExpands: images only, never in work mode, never an unrevealed spoiler or a file closed by hand', () => {
  const on = { ...D.displayDefaults(), autoExpand: true };
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.JPG']) assert.equal(D.autoExpands({ tim: 1, ext }, on), true, ext);
  for (const ext of ['.webm', '.mp4', '.pdf', '.swf', '']) assert.equal(D.autoExpands({ tim: 1, ext }, on), false, ext);
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg' }, D.displayDefaults()), false, 'off by default');
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg' }, { ...on, hideImages: true }), false);
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg', spoiler: 1 }, on), false);
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg', spoiler: 1 }, { ...on, revealSpoilers: true }), true);
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg', filedeleted: 1 }, on), false);
  assert.equal(D.autoExpands({ tim: 1, ext: '.jpg' }, on, { closed: true }), false);
  assert.equal(D.autoExpands({ ext: '.jpg' }, on), false, 'no file');
});

test('preloadIndices: the next and previous images, wrapping, never videos or the one shown', () => {
  const img = (ext = '.jpg') => ({ ext, video: /webm|mp4/.test(ext) });
  const items = [img(), img('.png'), img('.webm'), img('.gif'), img('.pdf')];
  assert.deepEqual(D.preloadIndices(items, 1), [0], 'next is a video');
  assert.deepEqual(D.preloadIndices(items, 0), [1], 'previous (wrapped) is a PDF');
  assert.deepEqual(D.preloadIndices(items, 3), [], 'a PDF next, a video before');
  assert.deepEqual(D.preloadIndices([img(), img(), img()], 2), [0, 1]);
  assert.deepEqual(D.preloadIndices([img(), img()], 0), [1], 'two files: the other one once');
  assert.deepEqual(D.preloadIndices([img()], 0), []);
  assert.deepEqual(D.preloadIndices([], 0), []);
  assert.deepEqual(D.preloadIndices(null, 0), []);
  assert.deepEqual(D.preloadIndices([img(), img(), img()], 1, false), [], 'switched off');
});

test('isImageFile and isVideoFile', () => {
  assert.equal(D.isImageFile({ ext: '.png' }), true);
  assert.equal(D.isImageFile({ ext: '.webm' }), false);
  assert.equal(D.isVideoFile({ ext: '.mp4' }), true);
  assert.equal(D.isVideoFile({}), false);
});
