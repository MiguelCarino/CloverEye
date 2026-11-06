import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../ui/js/compose-model.js';
import * as G from '../ui/js/gallery-model.js';
import { panesFromHash } from '../ui/js/browse-model.js';
import { paneRows, MAX_PANES } from '../ui/js/shell.js';

const g = { board: 'g', max_filesize: 4194304, max_webm_filesize: 4194304, max_comment_chars: 2000, cooldowns: { threads: 600, replies: 60, images: 60 } };
const wsg = { ...g, board: 'wsg', require_subject: true, spoilers: true, max_webm_filesize: 6291456 };

test('preflight: the site’s limits, before anything is sent', () => {
  assert.deepEqual(C.preflight({ board: g, com: 'hi', captcha: { state: 'ready', tasks: [{}], picks: [0] } }), []);
  const fields = (r) => r.map((p) => p.field);
  assert.deepEqual(fields(C.preflight({ board: g, com: '' })), ['com']);
  assert.deepEqual(fields(C.preflight({ board: g, com: 'x'.repeat(2001) })), ['com']);
  assert.deepEqual(fields(C.preflight({ board: wsg, isThread: true, com: 'x', file: { name: 'a.webm', size: 10 } })), ['sub']);
  assert.deepEqual(fields(C.preflight({ board: g, isThread: true, com: 'x' })), ['file']);
  assert.match(C.preflight({ board: g, com: 'x', file: { name: 'big.webm', size: 5 * 1024 * 1024 } })[0].message, /4\.0 MB for videos/);
  assert.deepEqual(C.preflight({ board: wsg, com: 'x', file: { name: 'ok.webm', size: 5 * 1024 * 1024 } }), []);
  assert.deepEqual(fields(C.preflight({ board: g, com: 'x', file: { name: 'x.exe', size: 5 } })), ['file']);
  assert.deepEqual(fields(C.preflight({ board: g, com: 'x', captcha: { state: 'ready', tasks: [{}, {}], picks: [1] } })), ['captcha']);
  assert.deepEqual(fields(C.preflight({ board: g, com: 'x', captcha: { state: 'loading' } })), ['captcha']);
  assert.deepEqual(C.preflight({ board: g, com: 'x', captcha: { state: 'none' } }), []);
  assert.deepEqual(fields(C.preflight({ board: g, com: 'x', now: 1000, cooldownUntil: 31000 })), ['submit']);
  assert.deepEqual(C.preflight({ com: 'x' }), [], 'no board info: generic checks only');
});

test('cooldowns come from boards.json', () => {
  assert.equal(C.cooldownSeconds(g, { isThread: true }), 600);
  assert.equal(C.cooldownSeconds(g, { hasFile: true }), 60);
  assert.equal(C.cooldownSeconds(null), 0);
});

test('captchaState reads the site’s captcha shapes (tcaptcha.js)', () => {
  const now = 1_000_000;
  const ready = C.captchaState({ challenge: 'abc', ttl: 120, tasks: [{ str: 'Pick the &amp; one', items: ['AA', 'BB', 'CC'] }, { img: 'PP', items: ['DD', 'EE'] }] }, now);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.tasks[0].prompt, 'Pick the & one');
  // the site's real shape: the object to find is an <img> inside the question
  const real = C.captchaState({ challenge: 'x', ttl: 120, tasks: [{ str: '<img src="data:image/png;base64,QUJD" style="float:right">Find the object on the right', items: ['AA'] }] }, now);
  assert.equal(real.tasks[0].target, 'data:image/png;base64,QUJD');
  assert.equal(real.tasks[0].prompt, 'Find the object on the right');
  assert.equal(C.captchaState({ challenge: 'x', tasks: [{ str: '<img src="https://evil.example/x.png">Pick', items: ['AA'] }] }).tasks[0].target, null, 'only an inline picture');
  assert.equal(ready.tasks[1].promptImg, 'data:image/png;base64,PP');
  assert.equal(ready.tasks[0].items[2], 'data:image/png;base64,CC');
  assert.equal(ready.expires, now + 120000);
  assert.equal(C.captchaDone(ready), false);
  // the person slides to a choice and keeps it, task by task
  assert.equal(ready.current, 1, 'a question in words opens on the first choice, so a picture shows');
  let c = C.captchaNext(C.captchaShow(ready, 0));
  assert.equal(c.step, 0, 'on the question itself: no move');
  c = C.captchaNext(C.captchaShow(ready, 3));
  assert.deepEqual([c.step, c.picks, c.current], [1, [2], 0], 'a question that is a picture opens on it');
  c = C.captchaShow(c, 9);
  assert.equal(c.current, 2, 'clamped to the number of choices');
  c = C.captchaNext(c);
  assert.equal(C.captchaDone(c), true);
  assert.equal(C.captchaAnswer(c), '21');
  assert.equal(C.captchaNext(c), c, 'done: no more steps');
  assert.equal(C.captchaState({ challenge: 'noop' }).state, 'none');
  assert.equal(C.captchaDone({ state: 'none' }), true);
  const wait = C.captchaState({ pcd: 30, pcd_msg: 'Please wait a &amp; while.' }, now);
  assert.deepEqual([wait.state, wait.message, wait.until], ['wait', 'Please wait a & while.', now + 30000]);
  assert.equal(C.captchaState({ error: 'You have to wait', cd: 5 }, now).until, now + 5000);
  assert.equal(C.captchaState({ error: 'Something broke' }).state, 'error');
  const spur = C.captchaState({ error: 'Please unblock spur.us and mcl.io to proceed.' });
  assert.equal(spur.state, 'error');
  assert.match(spur.message, /New captcha/);
  assert.match(spur.message, /spur\.us/);
  assert.equal(C.captchaState({ mpcd: 1, sitekey: 'x' }).state, 'blocked');
  assert.equal(C.captchaState(null).state, 'error');
  assert.equal(C.captchaState({ weird: 1 }).state, 'error');
  assert.equal(C.captchaState({ challenge: 'x', tasks: [{ str: 'a', items: [] }] }).state, 'error');
});

test('parsePostResponse: success, the site’s error, a browser check', () => {
  assert.deepEqual(C.parsePostResponse('<html><!-- thread:123,no:456 --></html>'), { ok: true, thread: 123, no: 456 });
  assert.deepEqual(C.parsePostResponse('<!-- thread:0,no:789 -->'), { ok: true, thread: 789, no: 789 }, 'a new thread');
  assert.deepEqual(C.parsePostResponse('<span id="errmsg" style="color:red;">Error: You seem to have <b>mistyped</b> the CAPTCHA.</span>'), {
    ok: false,
    message: 'Error: You seem to have mistyped the CAPTCHA.',
  });
  assert.equal(C.parsePostResponse('<title>Just a moment...</title> cf-chl', 403).check, true);
  assert.match(C.parsePostResponse('', 500).message, /HTTP 500/);
});

test('postFields: what the site’s form sends', () => {
  const reply = C.postFields({ isThread: false, thread: 5, com: 'hi', challenge: 'c', response: ' ab12 ', pwd: 'p', spoiler: true });
  assert.deepEqual(reply, { mode: 'regist', name: '', email: '', com: 'hi', pwd: 'p', resto: '5', spoiler: 'on', 't-challenge': 'c', 't-response': 'ab12' });
  const thread = C.postFields({ isThread: true, sub: 'S', com: 'x', challenge: 'noop' });
  assert.equal(thread.resto, undefined);
  assert.equal(thread.sub, 'S');
  assert.equal(thread['t-challenge'], 'noop');
  assert.equal(thread['t-response'], undefined);
});

// a minimal JPEG: SOI, APP0 (JFIF), APP1 (Exif), COM, DQT, SOS, data, EOI
const seg = (marker, payload) => [0xff, marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
const jpeg = Uint8Array.from([
  0xff, 0xd8,
  ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]),
  ...seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3, 4]),
  ...seg(0xfe, [0x68, 0x69]),
  ...seg(0xdb, [0, 1, 2]),
  0xff, 0xda, 0, 4, 9, 9, 0x11, 0x22, 0x33,
  0xff, 0xd9,
]);

test('stripMetadata: JPEG loses EXIF and comments, keeps the picture', () => {
  const r = C.stripMetadata(jpeg);
  assert.equal(r.removed, 2);
  const s = Array.from(r.bytes);
  assert.ok(!s.includes(0xe1) || s.indexOf(0xe1) > 20, 'no APP1 marker');
  assert.deepEqual(s.slice(0, 2), [0xff, 0xd8]);
  assert.deepEqual(s.slice(-2), [0xff, 0xd9]);
  assert.ok(s.join(',').includes([0xff, 0xda, 0, 4, 9, 9, 0x11, 0x22, 0x33].join(',')), 'scan data intact');
  assert.equal(r.bytes.length, jpeg.length - 14 - 6);
});

function chunk(type, data) {
  const len = data.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  ...chunk('tEXt', [...'Comment'].map((c) => c.charCodeAt(0))),
  ...chunk('eXIf', [1, 2, 3]),
  ...chunk('IDAT', [7, 7, 7]),
  ...chunk('IEND', []),
]);

test('stripMetadata: PNG loses text and eXIf chunks only', () => {
  const r = C.stripMetadata(png);
  assert.equal(r.removed, 2);
  const text = String.fromCharCode(...r.bytes);
  assert.ok(text.includes('IHDR') && text.includes('IDAT') && text.includes('IEND'));
  assert.ok(!text.includes('tEXt') && !text.includes('eXIf'));
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.deepEqual(C.stripMetadata(gif), { bytes: gif, removed: 0 }, 'other files untouched');
});

test('toBase64 handles large files in chunks', () => {
  const big = new Uint8Array(100000).map((_, i) => i & 255);
  assert.equal(Buffer.from(C.toBase64(big), 'base64').equals(Buffer.from(big)), true);
});

test('(You): remembered once, capped', () => {
  let s = { yous: [] };
  s = C.addYou(s, 'g', 5);
  assert.equal(C.addYou(s, 'g', 5), s);
  assert.ok(C.isYou(s, 'g', 5) && !C.isYou(s, 'g', 6) && !C.isYou(s, 'v', 5));
});

test('gallery: files in post order, wrap-around steps, safe names', () => {
  const urls = { thumbUrl: (b, p) => `t/${b}/${p.tim}`, mediaUrl: (b, p) => `f/${b}/${p.tim}${p.ext}` };
  const posts = [
    { no: 1, tim: 11, ext: '.jpg', filename: 'a', w: 10, h: 10, fsize: 5 },
    { no: 2 },
    { no: 3, tim: 33, ext: '.webm', filename: 'b' },
    { no: 4, tim: 44, ext: '.png', filedeleted: 1 },
  ];
  const items = G.galleryItems(posts, 'g', urls);
  assert.deepEqual(items.map((i) => [i.no, i.video, i.full]), [[1, false, 'f/g/11.jpg'], [3, true, 'f/g/33.webm']]);
  assert.equal(G.step(0, -1, 2), 1);
  assert.equal(G.step(1, 1, 2), 0);
  assert.equal(G.step(0, 1, 0), 0);
  assert.equal(G.saveName({ name: 'a/b:c?.jpg' }), 'a_b_c_.jpg');
});

test('extra windows: only known pane shapes come in through the address', () => {
  const enc = (v) => `#panes=${encodeURIComponent(JSON.stringify(v))}`;
  assert.deepEqual(panesFromHash(enc([{ kind: 'thread', board: 'g', no: 5, junk: 1 }, { kind: 'board', board: 'diy' }, { kind: 'boards' }])), [
    { kind: 'thread', board: 'g', no: 5 },
    { kind: 'board', board: 'diy' },
    { kind: 'boards' },
  ]);
  assert.equal(panesFromHash(enc([{ kind: 'settings' }, { kind: 'board', board: '../x' }])), null);
  assert.equal(panesFromHash('#setup'), null);
  assert.equal(panesFromHash('#panes=%7Bbad'), null);
  assert.equal(panesFromHash(enc(Array.from({ length: 9 }, () => ({ kind: 'boards' })))).length, 5);
});

test('paneRows: up to three rows, the first rows take the extra pane', () => {
  assert.equal(MAX_PANES, 5);
  assert.deepEqual(paneRows(1, 3), [1]);
  assert.deepEqual(paneRows(2, 1), [2]);
  assert.deepEqual(paneRows(2, 2), [1, 1]);
  assert.deepEqual(paneRows(5, 2), [3, 2]);
  assert.deepEqual(paneRows(5, 3), [2, 2, 1]);
  assert.deepEqual(paneRows(4, 3), [2, 1, 1]);
  assert.deepEqual(paneRows(3, 9), [1, 1, 1]);
});
