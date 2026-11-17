import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseComment, commentText, quotedPosts, backlinks, decodeEntities, formatBytes } from '../ui/js/render.js';
import { deadlinkRef } from '../ui/js/archive-model.js';

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
  // a <pre> is one code segment, its <br>s are lines of the code
  assert.deepEqual(lines, [
    [
      { type: 'spoiler', text: 'secret' },
      { type: 'text', text: ' and ' },
      { type: 'code', text: 'let x = 1;\nx += 1;' },
      { type: 'deadlink', text: '>>5' },
      { type: 'text', text: 'longword' },
    ],
  ]);
});

test('a code block with blank lines stays one block', () => {
  assert.deepEqual(parseComment('<pre class="prettyprint">int a;<br><br>int b;</pre>'), [[{ type: 'code', text: 'int a;\n\nint b;' }]]);
  // a <br> right before </pre> is not a blank last line; text after it continues
  assert.deepEqual(parseComment('<pre>a<br></pre>b'), [[{ type: 'code', text: 'a' }, { type: 'text', text: 'b' }]]);
  assert.deepEqual(parseComment('<pre><br>a</pre>'), [[{ type: 'code', text: '\na' }]]);
  assert.deepEqual(parseComment('<pre><br></pre>'), [[]]);
  // two blocks side by side stay two; a <br> outside code is still a new line
  assert.deepEqual(parseComment('<pre>a</pre><pre>b</pre>'), [[{ type: 'code', text: 'a' }, { type: 'code', text: 'b' }]]);
  assert.deepEqual(parseComment('<pre>a</pre><br>b'), [[{ type: 'code', text: 'a' }], [{ type: 'text', text: 'b' }]]);
  assert.equal(commentText('<pre>x<br><br>y</pre>'), 'x\n\ny');
});

test('what sits inside a spoiler is marked spoiler too', () => {
  // a multi-line [spoiler] whose second line is greentext
  assert.deepEqual(parseComment('<s>secret line<br><span class="quote">&gt;secret green</span></s>'), [
    [{ type: 'spoiler', text: 'secret line' }],
    [{ type: 'greentext', text: '>secret green', spoiler: true }],
  ]);
  assert.deepEqual(parseComment('<s><a href="#p123" class="quotelink">&gt;&gt;123</a> hidden</s>'), [
    [
      { type: 'quotelink', text: '>>123', target: 123, spoiler: true },
      { type: 'spoiler', text: ' hidden' },
    ],
  ]);
  assert.deepEqual(parseComment('<s><span class="deadlink">&gt;&gt;99</span></s>'), [[{ type: 'deadlink', text: '>>99', spoiler: true }]]);
  assert.deepEqual(parseComment('<s><pre>x</pre></s>'), [[{ type: 'code', text: 'x', spoiler: true }]]);
  // a spoiler inside greentext keeps the spoiler type; plain segments get no flag
  assert.deepEqual(parseComment('<span class="quote">&gt;a <s>b</s></span>'), [
    [
      { type: 'greentext', text: '>a ' },
      { type: 'spoiler', text: 'b' },
    ],
  ]);
  // marked and unmarked greentext do not join
  assert.deepEqual(parseComment('<span class="quote">&gt;a<s><span class="quote">b</span></s></span>'), [
    [
      { type: 'greentext', text: '>a' },
      { type: 'greentext', text: 'b', spoiler: true },
    ],
  ]);
});

test('board links name the board and the catalog search, not a post', () => {
  assert.deepEqual(parseComment('<a href="//boards.4chan.org/g/" class="quotelink">&gt;&gt;&gt;/g/</a>'), [[{ type: 'boardlink', text: '>>>/g/', board: 'g' }]]);
  assert.deepEqual(parseComment('<a href="//boards.4chan.org/g/catalog#s=fglt" class="quotelink">&gt;&gt;&gt;/g/fglt/</a>'), [
    [{ type: 'boardlink', text: '>>>/g/fglt/', board: 'g', search: 'fglt' }],
  ]);
  const [[enc]] = parseComment('<a href="https://boards.4channel.org/V/catalog#s=fgl+t%2F" class="quotelink">x</a>');
  assert.deepEqual(enc, { type: 'boardlink', text: 'x', board: 'v', search: 'fgl t/' });
  const [[rel]] = parseComment('<a href="/tv/" class="quotelink">&gt;&gt;&gt;/tv/</a>');
  assert.equal(rel.board, 'tv');
  // a broken escape keeps the raw term
  assert.equal(parseComment('<a href="/g/catalog#s=50%" class="quotelink">x</a>')[0][0].search, '50%');
  // two side by side stay two
  const [two] = parseComment('<a href="//boards.4chan.org/g/" class="quotelink">&gt;&gt;&gt;/g/</a><a href="//boards.4chan.org/v/" class="quotelink">&gt;&gt;&gt;/v/</a>');
  assert.deepEqual(
    two.map((s) => [s.type, s.board]),
    [
      ['boardlink', 'g'],
      ['boardlink', 'v'],
    ],
  );
  // an address that is neither a post nor a board is plain text, not a dead button
  assert.deepEqual(parseComment('<a href="https://example.com/x" class="quotelink">&gt;&gt;&gt;x</a>'), [[{ type: 'text', text: '>>>x' }]]);
  // board links are not quotes
  assert.deepEqual(quotedPosts('<a href="//boards.4chan.org/g/" class="quotelink">&gt;&gt;&gt;/g/</a>'), []);
});

test('links side by side stay separate; one link split by <wbr> stays one', () => {
  const [line] = parseComment('<a href="#p5" class="quotelink">&gt;&gt;5</a><a href="/a/thread/1#p5" class="quotelink">&gt;&gt;&gt;/a/5</a>');
  assert.deepEqual(line, [
    { type: 'quotelink', text: '>>5', target: 5 },
    { type: 'quotelink', text: '>>>/a/5', target: 5, board: 'a', thread: 1 },
  ]);
  assert.deepEqual(parseComment('<a href="#p5" class="quotelink">&gt;&gt;5</a><a href="#p5" class="quotelink">&gt;&gt;5</a>')[0].length, 2);
  // dead links each keep their own number, so each can get an archive button
  const [dead] = parseComment('<span class="deadlink">&gt;&gt;1</span><span class="deadlink">&gt;&gt;2</span>');
  assert.deepEqual(dead, [
    { type: 'deadlink', text: '>>1' },
    { type: 'deadlink', text: '>>2' },
  ]);
  assert.deepEqual(deadlinkRef(dead[0].text, 'g'), { board: 'g', post: 1 });
  assert.deepEqual(deadlinkRef(dead[1].text, 'g'), { board: 'g', post: 2 });
  assert.deepEqual(parseComment('<a href="#p123456" class="quotelink">&gt;&gt;123<wbr>456</a>'), [[{ type: 'quotelink', text: '>>123456', target: 123456 }]]);
  assert.deepEqual(parseComment('<span class="deadlink">&gt;&gt;12<wbr>34</span>'), [[{ type: 'deadlink', text: '>>1234' }]]);
  // ordinary links in text do not split it
  assert.deepEqual(parseComment('see <a href="https://x.org">x</a> ok'), [[{ type: 'text', text: 'see x ok' }]]);
});

test('parsed comments are cached by their HTML and frozen', () => {
  const html = '<a href="#p7" class="quotelink">&gt;&gt;7</a><br>cache me';
  const a = parseComment(html);
  const b = parseComment(html);
  assert.equal(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]) && Object.isFrozen(a[0][0]));
  assert.throws(() => {
    a[0][0].text = 'changed';
  }, TypeError);
  assert.equal(parseComment(null), parseComment(''));
  assert.equal(commentText(html), '>>7\ncache me');
  assert.equal(commentText(html), commentText(html));
  assert.equal(commentText(''), '');
  // quotedPosts gives a fresh array each time (callers may keep it)
  assert.notEqual(quotedPosts(html), quotedPosts(html));
  // many more comments than one generation holds: still right
  for (let i = 0; i < 9000; i++) assert.equal(commentText(`c${i}`), `c${i}`);
  assert.deepEqual(parseComment(html), [[{ type: 'quotelink', text: '>>7', target: 7 }], [{ type: 'text', text: 'cache me' }]]);
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
