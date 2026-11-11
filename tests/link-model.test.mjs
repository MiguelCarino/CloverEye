import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { findLinks, linkHref, trimTrailing, parseStart, embedFor, EMBED_HOSTS, EMBED_MODES } from '../ui/js/link-model.js';
import { parseComment } from '../ui/js/render.js';

const links = (text) => findLinks(text).filter((p) => p.href);

test('plain http and https addresses become links; the rest stays text', () => {
  assert.deepEqual(findLinks('see https://example.org/a?b=1#c now'), [
    { text: 'see ' },
    { text: 'https://example.org/a?b=1#c', href: 'https://example.org/a?b=1#c' },
    { text: ' now' },
  ]);
  assert.deepEqual(findLinks('http://example.org'), [{ text: 'http://example.org', href: 'http://example.org/' }]);
  assert.deepEqual(findLinks('no links here'), [{ text: 'no links here' }]);
  assert.deepEqual(findLinks(''), [{ text: '' }]);
  assert.deepEqual(findLinks(undefined), [{ text: '' }]);
});

test('the parts always add up to the whole text', () => {
  for (const s of ['a https://x.org/ b www.y.com c z.net/q d', '(https://x.org/a), and.', 'https://a.com https://b.com', '>https://g.org/x']) {
    assert.equal(findLinks(s).map((p) => p.text).join(''), s);
  }
});

test('bare www. and domain.tld/… forms are taken as https', () => {
  assert.deepEqual(links('go to www.example.com today'), [{ text: 'www.example.com', href: 'https://www.example.com/' }]);
  assert.deepEqual(links('github.com/4chan/4chan-API'), [{ text: 'github.com/4chan/4chan-API', href: 'https://github.com/4chan/4chan-API' }]);
  // a bare name without a path is not a link: "e.g." or "file.txt" in a sentence
  assert.deepEqual(links('read file.txt or example.com later'), []);
  assert.deepEqual(links('version 1.2/3'), []);
});

test('trailing punctuation goes, balanced brackets stay', () => {
  assert.equal(trimTrailing('https://a.org/x).'), 'https://a.org/x');
  assert.equal(trimTrailing('https://a.org/(x).'), 'https://a.org/(x)');
  assert.equal(trimTrailing('...'), '');
  assert.deepEqual(links('(see https://a.org/x).'), [{ text: 'https://a.org/x', href: 'https://a.org/x' }]);
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Foo_(bar), ok'), [
    { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
  ]);
  assert.deepEqual(links('"https://a.org/q?x=1"!'), [{ text: 'https://a.org/q?x=1', href: 'https://a.org/q?x=1' }]);
  assert.deepEqual(links('[https://a.org/b]'), [{ text: 'https://a.org/b', href: 'https://a.org/b' }]);
  assert.deepEqual(links('look: https://a.org/b?!'), [{ text: 'https://a.org/b', href: 'https://a.org/b' }]);
  assert.deepEqual(links('動画https://a.org/b、これ'), [], 'glued to a word: not a link');
  assert.deepEqual(links('動画 https://a.org/b、これ'), [{ text: 'https://a.org/b', href: 'https://a.org/b' }]);
});

test('an address split by <wbr> in the site HTML comes out whole', () => {
  const [line] = parseComment('check https://www.example.org/very/long/pa<wbr>th/to/a/page.html ok');
  const parts = findLinks(line.map((s) => s.text).join(''));
  assert.deepEqual(parts.filter((p) => p.href), [
    { text: 'https://www.example.org/very/long/path/to/a/page.html', href: 'https://www.example.org/very/long/path/to/a/page.html' },
  ]);
});

test('other schemes and tricks never become links', () => {
  for (const s of [
    'javascript:alert(1)',
    'javascript://example.com/%0aalert(1)',
    'javascript:alert(1)//example.com/x',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/x',
    'mailto:a@example.com',
    'me@example.com/x',
    'https://user:pass@example.com/',
    'https://example.com@evil.org/',
    'http://',
    'https://localhost/x',
    'https://.com/x',
  ]) {
    for (const p of links(s)) {
      assert.ok(/^https?:\/\//.test(p.href), `${s} → ${p.href}`);
      assert.ok(!/javascript|data:|user|pass|@/.test(p.href), `${s} → ${p.href}`);
    }
  }
  assert.deepEqual(links('javascript:alert(1)//example.com/x'), []);
  assert.deepEqual(links('https://user:pass@example.com/'), []);
  assert.deepEqual(links('https://example.com@evil.org/'), []);
  assert.deepEqual(links('me@example.com/x'), []);
});

test('quotes and angle brackets end an address; the href is always encoded', () => {
  const [a] = links('https://a.org/x"onmouseover="alert(1)');
  assert.equal(a.text, 'https://a.org/x');
  const [b] = links("https://a.org/x'><img src=x>");
  assert.equal(b.text, 'https://a.org/x');
  const [q] = links("https://a.org/it's/x");
  assert.equal(q.href, "https://a.org/it's/x", 'set as an attribute and handed to the browser, never as markup');
  const [c] = links('https://a.org/<script>');
  assert.equal(c.href, 'https://a.org/');
  assert.ok(links('https://a.org/a b').every((p) => !/[\s"<>]/.test(p.href)));
});

test('linkHref checks scheme, host and length', () => {
  assert.equal(linkHref('https://EXAMPLE.org/A'), 'https://example.org/A');
  assert.equal(linkHref('http://192.168.1.1/x'), 'http://192.168.1.1/x');
  assert.equal(linkHref('192.168.1.1/x'), null, 'a bare IP is not taken as a link');
  assert.equal(linkHref('https://xn--n3h.com/'), 'https://xn--n3h.com/');
  assert.equal(linkHref(`https://a.org/${'x'.repeat(2100)}`), null);
  assert.equal(linkHref('https://a.org/\nx'), null);
  assert.equal(linkHref(''), null);
  assert.equal(linkHref(null), null);
});

test('parseStart reads the forms YouTube uses', () => {
  assert.equal(parseStart('90'), 90);
  assert.equal(parseStart('90s'), 90);
  assert.equal(parseStart('1m30s'), 90);
  assert.equal(parseStart('1h2m3s'), 3723);
  assert.equal(parseStart(''), 0);
  assert.equal(parseStart('abc'), 0);
  assert.equal(parseStart('0'), 0);
  assert.equal(parseStart(null), 0);
});

test('YouTube: watch, youtu.be, shorts, embed, live; privacy-enhanced player', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?feature=share&v=${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) {
    const e = embedFor(u);
    assert.equal(e?.kind, 'youtube', u);
    assert.equal(e.src, `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`);
    assert.equal(e.ratio, '16 / 9');
  }
  const s = embedFor(`https://www.youtube.com/shorts/${id}`);
  assert.equal(s.ratio, '9 / 16');
  assert.equal(embedFor(`https://youtu.be/${id}?t=1m5s`).src, `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&start=65`);
  assert.equal(embedFor(`https://www.youtube.com/watch?v=${id}&t=42`).src.endsWith('&start=42'), true);
  assert.equal(embedFor('https://www.youtube.com/watch?v=short'), null);
  assert.equal(embedFor(`https://www.youtube.com/watch?v=${id}"><x`), null);
  assert.equal(embedFor('https://www.youtube.com/channel/UCabc'), null);
  assert.equal(embedFor(`https://youtube.com.evil.org/watch?v=${id}`), null);
  assert.equal(embedFor(`https://notyoutu.be/${id}`), null);
});

test('Vimeo, Streamable and SoundCloud', () => {
  assert.equal(embedFor('https://vimeo.com/76979871').src, 'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1');
  assert.equal(embedFor('https://vimeo.com/76979871/abc123def').src, 'https://player.vimeo.com/video/76979871?dnt=1&autoplay=1&h=abc123def');
  assert.equal(embedFor('https://vimeo.com/channels/staffpicks/76979871').id, '76979871');
  assert.equal(embedFor('https://player.vimeo.com/video/76979871').id, '76979871');
  assert.equal(embedFor('https://vimeo.com/about'), null);

  assert.equal(embedFor('https://streamable.com/moo2x').src, 'https://streamable.com/e/moo2x?autoplay=1');
  assert.equal(embedFor('https://streamable.com/e/moo2x').id, 'moo2x');
  assert.equal(embedFor('https://streamable.com/login'), null);
  assert.equal(embedFor('https://streamable.com/'), null);

  const sc = embedFor('https://soundcloud.com/artist-name/a-track');
  assert.equal(sc.kind, 'soundcloud');
  assert.equal(sc.height, 166);
  assert.equal(sc.src, 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist-name%2Fa-track&auto_play=true&visual=false&show_comments=false');
  assert.equal(embedFor('https://soundcloud.com/artist-name/sets/an-album').height, 360);
  assert.equal(embedFor('https://soundcloud.com/artist-name'), null);
  assert.equal(embedFor('https://soundcloud.com/artist-name/likes'), null);
  assert.equal(embedFor('https://soundcloud.com/discover/sets/x'), null);
});

test('Twitter/X and other sites stay links; bad input is no embed', () => {
  assert.equal(embedFor('https://twitter.com/user/status/123'), null);
  assert.equal(embedFor('https://x.com/user/status/123'), null);
  assert.equal(embedFor('https://example.org/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(embedFor('javascript:alert(1)'), null);
  assert.equal(embedFor('not a url'), null);
  assert.equal(embedFor(undefined), null);
});

test('every embed loads from a host the CSP allows, and the CSP allows only those frames', () => {
  for (const u of ['https://youtu.be/dQw4w9WgXcQ', 'https://vimeo.com/1', 'https://streamable.com/abc', 'https://soundcloud.com/a/b']) {
    const e = embedFor(u);
    assert.ok(EMBED_HOSTS.some((h) => e.src.startsWith(`${h}/`)), e.src);
  }
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const meta = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1];
  for (const csp of [conf.app.security.csp, meta]) {
    const frame = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src '));
    assert.deepEqual(frame.split(/\s+/).slice(1), ["'self'", ...EMBED_HOSTS]);
    assert.match(csp, /script-src 'self';/, 'scripts stay local');
    assert.ok(!/frame-ancestors|unsafe/.test(csp));
  }
  assert.equal(conf.app.security.csp, meta, 'the page and the app carry the same policy');
  assert.deepEqual(EMBED_MODES, ['off', 'click']);
});
