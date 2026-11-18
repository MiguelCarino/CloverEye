// ui/js/log-model.js (what the features put in their log lines) and a look
// over every log call in ui/js: areas and event names in the log's shape,
// and no field that carries what people write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { errorKind, viewFields, postResultKind, fileKind, changedKeys, keysFields, createTally, onlyDiagnosticsDiffer, createErrorGate } from '../ui/js/log-model.js';
import { contentKey, sanitizeFields, AREAS } from '../ui/js/log.js';
import { parsePostResponse } from '../ui/js/compose-model.js';

const UI = new URL('../ui/js/', import.meta.url).pathname;

test('errorKind: codes as they are, HTTP statuses, words; never the text', () => {
  assert.equal(errorKind(new Error('not-found')), 'not-found');
  assert.equal(errorKind('check-needed'), 'check-needed');
  assert.equal(errorKind(new Error('HTTP 503 from the site')), 'http-503');
  assert.equal(errorKind(new Error('The site is busy: next try in 30 s')), 'waiting');
  assert.equal(errorKind(new Error('request timed out')), 'timeout');
  assert.equal(errorKind(new TypeError('Failed to fetch')), 'network');
  assert.equal(errorKind(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), 'QuotaExceededError');
  assert.equal(errorKind(new Error('Permission denied (os error 13)')), 'denied');
  assert.equal(errorKind(new Error('No such file or directory: /home/me/Secret pics/a.png')), 'not-found');
  assert.equal(errorKind(new Error('Unexpected token < in JSON')), 'parse');
  assert.equal(errorKind(null), 'none');
  assert.equal(errorKind(new Error('Something odd about my secret thread')), 'other');
  // a sentence is never passed through, whatever it says
  for (const e of ['my password is hunter2', 'Install Gentoo now please', '/home/me/a b.png broke']) {
    const k = errorKind(new Error(e));
    assert.ok(/^[A-Za-z0-9-]{2,32}$/.test(k), k);
    assert.ok(!e.includes(k) || k.length < 8, `${k} from ${e}`);
  }
});

test('viewFields: kind, board, thread; never a search or a tag id', () => {
  assert.deepEqual(viewFields({ kind: 'thread', board: 'g', no: 123, layout: 'columns' }), { view: 'thread', board: 'g', thread: 123, layout: 'columns' });
  assert.deepEqual(viewFields({ kind: 'board', board: 'g', search: 'secret' }), { view: 'board', board: 'g' });
  assert.deepEqual(viewFields({ kind: 'tag', id: 'tag-123' }), { view: 'tag' });
  assert.deepEqual(viewFields(null), { view: 'none' });
});

test('postResultKind: what became of a post, from the site’s answer', () => {
  assert.equal(postResultKind(parsePostResponse('<!-- thread:0,no:5 -->', 200)), 'posted');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: You seem to have mistyped the CAPTCHA.</span>')), 'captcha');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: You must wait 60 seconds before posting.</span>')), 'cooldown');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: Duplicate file exists.</span>')), 'duplicate');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: You are banned.</span>')), 'banned');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: Comment too long.</span>')), 'too-long');
  assert.equal(postResultKind(parsePostResponse('', 403)), 'check');
  assert.equal(postResultKind(parsePostResponse('<html></html>', 502)), 'http');
  assert.equal(postResultKind(parsePostResponse('<span id="errmsg">Error: Something new.</span>')), 'site-error');
  assert.equal(postResultKind(null), 'none');
});

test('fileKind: the type or the extension, never the name', () => {
  assert.equal(fileKind({ name: 'my holiday.png', type: 'image/png' }), 'png');
  assert.equal(fileKind({ name: 'clip.WEBM', type: '' }), 'webm');
  assert.equal(fileKind({ name: 'no extension', type: '' }), 'unknown');
  assert.equal(fileKind(null), 'unknown');
});

test('changedKeys: setting names that changed, one level in for named objects', () => {
  const a = { theme: 'dark', display: { workMode: false, density: 'cozy' }, filters: [{ pattern: 'secret' }], lastRead: { 'g/1': 3 }, post: { name: 'Anon', pwd: 'x' } };
  const b = { theme: 'dark', display: { workMode: true, density: 'cozy' }, filters: [{ pattern: 'other' }], lastRead: { 'g/1': 4 }, post: { name: 'Bob', pwd: 'x' }, ai: { enabled: true } };
  assert.deepEqual(changedKeys(a, b), ['ai', 'display.workMode', 'filters', 'lastRead', 'post.name']);
  assert.deepEqual(changedKeys(a, a), []);
  // the same content in a new object is no change
  assert.deepEqual(changedKeys(a, structuredClone(a)), []);
  const f = keysFields(changedKeys(a, b));
  assert.equal(f.changed, 5);
  assert.equal(f.keys, 'ai,display.workMode,filters,lastRead,post.name');
  // values never appear
  assert.ok(!JSON.stringify(f).includes('Bob') && !JSON.stringify(f).includes('other'));
  const many = keysFields(Array.from({ length: 40 }, (_, i) => `key${i}.sub${i}`));
  assert.ok(many.keys.length <= 118 && many.changed === 40);
});

test('createTally: adds up, gives the counts at most once a window', () => {
  let t = 0;
  const tally = createTally({ now: () => t, everyMs: 60_000 });
  assert.equal(tally.take(), null, 'nothing counted');
  tally.add('pane');
  tally.add('pane');
  tally.add('full');
  t = 30_000;
  assert.equal(tally.take(), null, 'too soon');
  t = 61_000;
  assert.deepEqual(tally.take(), { pane: 2, full: 1, span_s: 61 });
  assert.equal(tally.take(), null, 'started again');
  tally.add('grow', 3);
  assert.deepEqual(tally.take(true), { grow: 3, span_s: 0 });
});

// ------------------------------------------------------------ the calls

/** Every log call in a source: { area, msg, keys, values, at }. */
function calls(src, file) {
  const out = [];
  const re = /\blog\.(error|warn|info|debug)\(\s*'([^']*)',\s*([`'])((?:(?!\3).)*)\3\s*(,)?/g;
  const timeRe = /\blog\.time\(\s*'([^']*)',\s*'([^']*)'/g;
  for (const m of src.matchAll(timeRe)) out.push({ area: m[1], msg: m[2], keys: [], values: [], at: `${file}:${src.slice(0, m.index).split('\n').length}` });
  for (const m of src.matchAll(re)) {
    const at = `${file}:${src.slice(0, m.index).split('\n').length}`;
    const call = { area: m[2], msg: m[4], keys: [], values: [], at };
    out.push(call);
    if (!m[5]) continue;
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    if (src[i] !== '{') continue; // a variable: checked where it is built
    // the object literal, by brace depth
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        depth--;
        if (depth === 0) break;
      } else if (c === "'" || c === '`' || c === '"') {
        const q = c;
        j++;
        while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      }
    }
    const body = src.slice(i + 1, j);
    // split at top-level commas
    const parts = [];
    let d = 0;
    let start = 0;
    for (let k = 0; k < body.length; k++) {
      const c = body[k];
      if ('{(['.includes(c)) d++;
      else if ('})]'.includes(c)) d--;
      else if (c === "'" || c === '`' || c === '"') {
        const q = c;
        k++;
        while (k < body.length && body[k] !== q) k += body[k] === '\\' ? 2 : 1;
      } else if (c === ',' && d === 0) {
        parts.push(body.slice(start, k));
        start = k + 1;
      }
    }
    parts.push(body.slice(start));
    for (const raw of parts) {
      const p = raw.trim();
      if (!p || p.startsWith('...')) continue;
      const kv = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(p);
      if (kv) {
        call.keys.push(kv[1]);
        call.values.push(kv[2]);
      } else if (/^[A-Za-z_$][\w$]*$/.test(p)) {
        call.keys.push(p);
        call.values.push(p);
      }
    }
  }
  return out;
}

const SOURCES = readdirSync(UI)
  .filter((f) => f.endsWith('.js') && !['log.js', 'log-model.js'].includes(f))
  .map((f) => ({ f, src: readFileSync(join(UI, f), 'utf8') }));
const ALL = SOURCES.flatMap(({ f, src }) => calls(src, f));

test('the features log: every area of the log’s list is written somewhere', () => {
  assert.ok(ALL.length > 150, `${ALL.length} log calls`);
  const used = new Set(ALL.map((c) => c.area));
  // net is the app's request queue (Rust); files is the shell's job area
  // for downloads, picked by a variable (runJob)
  for (const a of AREAS) if (a !== 'net' && a !== 'files') assert.ok(used.has(a), `no line in area ${a}`);
});

test('log calls: known areas, short dotted lower-case event names', () => {
  for (const c of ALL) {
    assert.ok(AREAS.includes(c.area), `${c.at}: area ${c.area}`);
    assert.match(c.msg, /^[a-z][a-z0-9]*([._-][a-z0-9{}]+)*$/, `${c.at}: event ${c.msg}`);
  }
});

test('log calls: no field named after what people write (it would be dropped)', () => {
  for (const c of ALL) {
    for (const k of c.keys) {
      assert.ok(!contentKey(k), `${c.at}: field ${k} in ${c.msg}`);
      assert.notEqual(k, 'win', `${c.at}: win is the app's`);
    }
    assert.ok(c.keys.length <= 16, `${c.at}: ${c.keys.length} fields`);
  }
});

// Values that read what people wrote: only their length, a count, or
// whether there is any may be logged.
const CONTENT_REF = /(^|[^\w$.])(question|answer|com|text|title|sub|subject|email|pattern|terms|query|search|selection|snippet|name)\b(?!\s*(\.length|\.trim\(\)\.length|\.size|\)))/;
test('log calls: no value reads a post, a question, a name or a search', () => {
  for (const c of ALL) {
    c.values.forEach((v, i) => {
      const plain = v
        .replace(/'[^']*'|`[^`]*`/g, "''")
        .replace(/Boolean\([^)]*\)/g, '')
        .replace(/\b[\w$.?()]+\.length\b/g, '');
      assert.ok(!CONTENT_REF.test(plain), `${c.at}: ${c.keys[i]}: ${v}`);
    });
  }
});

test('a line with content fields loses them, keeps the rest', () => {
  assert.deepEqual(sanitizeFields({ board: 'g', text: 'secret', replyText: 'x', chars: 6, attached: true, hasFile: true }), { board: 'g', chars: 6, attached: true });
});

test('onlyDiagnosticsDiffer: the Detailed logs switch alone redraws nothing', () => {
  const a = { theme: 'dark', diagnostics: { detailed: false }, boards: ['g'] };
  assert.equal(onlyDiagnosticsDiffer(a, { ...a, diagnostics: { detailed: true } }), true);
  assert.equal(onlyDiagnosticsDiffer(a, { ...a }), true);
  assert.equal(onlyDiagnosticsDiffer(a, { ...a, theme: 'light', diagnostics: { detailed: true } }), false);
  assert.equal(onlyDiagnosticsDiffer(a, { ...a, boards: ['g', 'v'] }), false);
});

test('createErrorGate: an error in a loop is sent once a minute, and at most perMin lines', () => {
  let t = 0;
  const gate = createErrorGate({ perMin: 3, now: () => t });
  const sent = [];
  for (let i = 0; i < 600; i++) {
    const l = gate('TypeError: x is undefined at shell.js:12');
    if (l) sent.push(l);
    t += 16;
  }
  assert.equal(sent.length, 1, 'the same line once in ~10 s');
  assert.equal(gate('b'), 'b');
  assert.equal(gate('c'), 'c');
  assert.equal(gate('d'), null, 'past perMin');
  t += 60_000;
  assert.equal(gate('TypeError: x is undefined at shell.js:12'), 'TypeError: x is undefined at shell.js:12');
  assert.equal(gate('x'.repeat(1000)).length, 400);
});
