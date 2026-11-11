import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseComment, commentText, quotedPosts, backlinks, decodeEntities, formatBytes } from '../ui/js/render.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`../crates/fetch/tests/fixtures/${name}`, import.meta.url)));

test('entities decode, unknown ones stay', () => {
  assert.equal(decodeEntities('&gt;&gt;1 &amp; &lt;b&gt; &quot;x&quot; &#039;y&#039; &#x41;'), `>>1 & <b> "x" 'y' A`);
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});

test('greentext, quote links, line breaks', () => {
  const lines = parseComment('<a href="#p123" class="quotelink">&gt;&gt;123</a><br><span class="quote">&gt;be me</span><br>plain');
  assert.deepEqual(lines, [
    [{ type: 'quotelink', text: '>>123', target: 123 }],
    [{ type: 'greentext', text: '>be me' }],
    [{ type: 'text', text: 'plain' }],
  ]);
});

test('cross-thread links keep the post number from the fragment', () => {
  const [line] = parseComment('<a href="/g/thread/999#p1000" class="quotelink">&gt;&gt;1000</a>');
  assert.equal(line[0].target, 1000);
});

test('cross-thread links also name their board and thread; same-thread ones do not', () => {
  const [line] = parseComment('<a href="/g/thread/999#p1000" class="quotelink">&gt;&gt;1000</a> <a href="#p5" class="quotelink">&gt;&gt;5</a>');
  assert.deepEqual(line[0], { type: 'quotelink', text: '>>1000', target: 1000, board: 'g', thread: 999 });
  assert.deepEqual(line[2], { type: 'quotelink', text: '>>5', target: 5 });
  const [slug] = parseComment('<a href="/v/thread/12/some-title#p13" class="quotelink">&gt;&gt;13</a>');
  assert.equal(slug[0].thread, 12);
  assert.equal(slug[0].board, 'v');
});

test('spoilers, code, dead links and wbr', () => {
  const lines = parseComment('<s>secret</s> and <pre class="prettyprint">let x = 1;<br>x += 1;</pre><span class="deadlink">&gt;&gt;5</span>long<wbr>word');
  assert.deepEqual(lines[0], [
    { type: 'spoiler', text: 'secret' },
    { type: 'text', text: ' and ' },
    { type: 'code', text: 'let x = 1;' },
  ]);
  assert.deepEqual(lines[1], [
    { type: 'code', text: 'x += 1;' },
    { type: 'deadlink', text: '>>5' },
    { type: 'text', text: 'longword' },
  ]);
});

test('unknown tags are dropped, text kept; no HTML survives', () => {
  const lines = parseComment('<b>bold</b> <img src=x onerror=alert(1)><script>alert(2)</script>');
  const text = lines.flat().map((s) => s.text).join('');
  assert.equal(text, 'bold alert(2)');
  assert.ok(lines.flat().every((s) => !s.text.includes('<')));
});

test('empty and missing comments', () => {
  assert.deepEqual(parseComment(''), [[]]);
  assert.deepEqual(parseComment(undefined), [[]]);
});

test('quotedPosts and backlinks on the synthetic thread', () => {
  const t = fx('synthetic-thread.json');
  assert.deepEqual(quotedPosts(t.posts[1].com), [900001]);
  const map = backlinks(t.posts);
  assert.deepEqual(map.get(900001), [900002]);
});

test('every comment in the /g/ catalog fixture parses to plain text', () => {
  const [page] = fx('g-catalog-page1.json');
  let n = 0;
  for (const t of page.threads) {
    for (const p of [t, ...(t.last_replies || [])]) {
      if (!p.com) continue;
      const text = commentText(p.com);
      assert.equal(typeof text, 'string');
      assert.ok(!/<\/?(a|span|br|wbr|s|pre)\b/i.test(text), `markup leaked in ${p.no}`);
      n++;
    }
  }
  assert.ok(n > 50, `${n} comments`);
});

test('the UI sample thread parses and its quotes resolve inside the thread', () => {
  const t = JSON.parse(readFileSync(new URL('../ui/data/sample-thread.json', import.meta.url)));
  const nos = new Set(t.posts.map((p) => p.no));
  for (const p of t.posts) for (const q of quotedPosts(p.com)) assert.ok(nos.has(q), `${p.no} quotes ${q}`);
  const map = backlinks(t.posts);
  assert.deepEqual(map.get(1201), [1204]);
  assert.deepEqual(map.get(1204), [1209]);
  assert.deepEqual(map.get(1207), [1212]);
  for (const p of t.posts) if (p._thumb) assert.match(p._thumb, /^assets\/[a-z-]+\.svg$/, 'local thumbnails only');
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(98000), '96 KB');
  assert.equal(formatBytes(4194304), '4.0 MB');
  assert.equal(formatBytes(-1), '');
});
