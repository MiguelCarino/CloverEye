// The reply form's own state, apart from the DOM: replies being written
// shared by several windows, Later's limit, the captcha running out, and the
// composer's window listeners ending with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as C from '../ui/js/compose-model.js';

const d = (com, at, extra = {}) => ({ com, sub: '', email: '', file: null, at, ...extra });
const gone = (at) => d('', at);

// ------------------------------------------------- drafts in storage

const live = (m) => [...m].filter(([, e]) => C.hasContent(e)).map(([k]) => k).sort();

test('parseDrafts keeps well-formed entries only', () => {
  const m = C.parseDrafts(JSON.stringify({ 'g/10': { com: 'hi', at: 5, file: { name: 'a.png', size: 3 }, posting: 4 }, 'BAD KEY': { com: 'x' }, 'g/11': 'nope', 'v/0': { sub: 's', at: '7' }, 'g/12': { at: 9, base: 8 } }));
  assert.deepEqual([...m.keys()], ['g/10', 'v/0', 'g/12']);
  assert.equal(m.get('g/10').file.name, 'a.png');
  assert.equal(m.get('g/10').posting, 4);
  assert.equal(m.get('v/0').at, 7);
  assert.deepEqual(m.get('g/12'), C.goneDraft(9, 8), 'a delete, kept with what it deleted');
  assert.equal(C.parseDrafts('{oops').size, 0);
  assert.equal(C.parseDrafts(null).size, 0);
});

test('mergeDrafts writes only this window’s changes, the newer write winning per reply', () => {
  const stored = new Map([
    ['g/10', d('from window 1', 100)],
    ['g/20', d('other', 50)],
  ]);
  // window 2 changed g/30 and g/20 (newer), and deleted its copy of g/10
  // (written at 80) after window 1 wrote a newer one
  const out = C.mergeDrafts(stored, new Map([
    ['g/30', d('new here', 120)],
    ['g/20', d('edited', 110)],
    ['g/10', { ...gone(130), base: 80 }],
  ]));
  assert.equal(out.get('g/10').com, 'from window 1', 'a delete never removes a reply written after the copy it deleted');
  assert.equal(out.get('g/20').com, 'edited');
  assert.equal(out.get('g/30').com, 'new here');
  assert.deepEqual([...out.keys()], ['g/30', 'g/20', 'g/10'], 'newest first');
  // a delete of the copy stored removes it; an older write does not bring back what is stored newer
  const out2 = C.mergeDrafts(out, new Map([['g/10', { ...gone(130), base: 100 }], ['g/20', d('older', 60)]]));
  assert.equal(C.hasContent(out2.get('g/10')), false);
  assert.equal(out2.get('g/20').com, 'edited');
  // the cap keeps the newest replies
  const many = new Map(Array.from({ length: 5 }, (_, i) => [`g/${i}`, d(`r${i}`, i + 1)]));
  assert.deepEqual(live(C.mergeDrafts(many, new Map([['g/9', d('  ', 99)]]), { max: 3 })), ['g/2', 'g/3', 'g/4']);
});

test('a delete is remembered: an older copy written back does not bring the reply back', () => {
  const now = 1000;
  // posted (deleted) at 200, the copy sent written at 150
  const stored = C.mergeDrafts(new Map([['g/10', d('hello', 150)]]), new Map([['g/10', { ...gone(200), base: 150 }]]), { now });
  assert.deepEqual(stored.get('g/10'), C.goneDraft(200, 150));
  // another window's copy (150, or older), written back on its way out
  for (const at of [100, 150, 200]) {
    const back = C.mergeDrafts(stored, new Map([['g/10', d('hello', at)]]), { now });
    assert.equal(C.hasContent(back.get('g/10')), false, `a copy written at ${at} stays deleted`);
  }
  // typed into after the delete: a reply again
  assert.equal(C.mergeDrafts(stored, new Map([['g/10', d('hello again', 201)]]), { now }).get('g/10').com, 'hello again');
  // a delete with nothing stored is still remembered; old deletes are let go
  assert.equal(C.mergeDrafts(new Map(), new Map([['g/1', gone(now - 10)]]), { now }).has('g/1'), true);
  const old = new Map([['g/1', gone(5)]]);
  assert.equal(C.mergeDrafts(old, new Map([['g/2', d('x', 6)]]), { now: 5 + C.DRAFT_GONE_MS + 1 }).has('g/1'), false);
});

test('adoptDrafts takes in the others’ replies but keeps the open form and unsaved changes', () => {
  const local = new Map([
    ['g/1', d('posted elsewhere', 1)],
    ['g/2', d('open here', 2)],
    ['g/3', d('typed, not stored yet', 3)],
    ['g/5', d('deleted elsewhere', 3)],
  ]);
  const stored = new Map([['g/4', d('from the other window', 4)], ['g/2', d('older copy', 1)], ['g/5', gone(9)]]);
  C.adoptDrafts(local, stored, new Set(['g/2', 'g/3']));
  assert.deepEqual([...local.keys()].sort(), ['g/2', 'g/3', 'g/4'], 'a delete is no reply');
  assert.equal(local.get('g/2').com, 'open here');
});

test('postingNow and deletedSince', () => {
  const now = 1_000_000;
  assert.equal(C.postingNow(d('x', 1, { posting: now - 1000 }), now), true);
  assert.equal(C.postingNow(d('x', 1, { posting: now - C.POSTING_MS }), now), false, 'a crash mid-post: shown again after a while');
  assert.equal(C.postingNow(d('x', 1), now), false);
  const stored = new Map([['g/1', C.goneDraft(300, 200)], ['g/2', d('x', 300)]]);
  assert.equal(C.deletedSince(stored, 'g/1', 200), true, 'the copy shown was deleted');
  assert.equal(C.deletedSince(stored, 'g/1', 150), true, 'an older copy too');
  assert.equal(C.deletedSince(stored, 'g/1', 250), false, 'changed here after the copy deleted');
  assert.equal(C.deletedSince(stored, 'g/1', 0), false, 'nothing written from that form');
  assert.equal(C.deletedSince(stored, 'g/2', 200), false);
});

// Several windows, one store, written the way compose.js does it: every
// change in a form is written as typed (typed()), stash() only writes what
// is waiting, a delete names the copy it deletes (`base`), Post stores a
// marker. Each window's `form` is its open form.
function windowOn(storage) {
  const drafts = C.adoptDrafts(new Map(), C.parseDrafts(storage.value));
  const dirty = new Map();
  const posting = new Set();
  const win = {
    drafts,
    form: null,
    files: storage.files,
    keep: () => new Set([...dirty.keys(), ...posting, ...(win.form ? [win.form.k] : [])]),
    set(k, entry, base = 0) {
      if (C.hasContent(entry)) drafts.set(k, entry);
      else drafts.delete(k);
      dirty.set(k, base ? { ...entry, base } : entry);
    },
    persist() {
      if (!dirty.size) return null;
      const changes = new Map(dirty);
      const merged = C.mergeDrafts(C.parseDrafts(storage.value), changes, { now: storage.now });
      storage.value = JSON.stringify(Object.fromEntries(merged));
      dirty.clear();
      C.adoptDrafts(drafts, merged, win.keep());
      for (const [k, e] of changes) if (!C.hasContent(e) && !C.hasContent(merged.get(k))) storage.files.delete(k);
      return merged;
    },
    reload() {
      const stored = C.parseDrafts(storage.value);
      C.adoptDrafts(drafts, stored, win.keep());
      // followStored
      const f = win.form;
      if (f && !dirty.has(f.k) && C.hasContent(f) && C.deletedSince(stored, f.k, f.base)) {
        Object.assign(f, { com: '', file: null, base: stored.get(f.k).at });
        drafts.delete(f.k);
      }
      return stored;
    },
    open(k) {
      if (C.postingNow(win.reload().get(k), storage.now)) return false;
      win.persist(); // stash
      const e = drafts.get(k) || {};
      win.form = { k, com: e.com || '', sub: '', email: '', file: e.file || null, base: e.at || 0 };
      win.reload(); // the form left is a pill of what is stored for it
      return true;
    },
    type(com, file = win.form.file) {
      const f = win.form;
      // another window is posting it: nothing written (compose.js typed())
      if (!posting.has(f.k) && C.postingNow(C.parseDrafts(storage.value).get(f.k), storage.now)) {
        Object.assign(f, { com, file });
        return false;
      }
      const at = ++storage.now;
      const entry = d(com, at, { file });
      const was = f.base;
      Object.assign(f, { com, file });
      if (C.hasContent(entry)) {
        f.base = at;
        win.set(f.k, entry);
      } else if (was) {
        f.base = at;
        win.set(f.k, C.goneDraft(at, was), was);
      }
      if (file) storage.files.add(f.k);
      return true;
    },
    stash: () => win.persist(),
    forget(k, base) {
      win.set(k, C.goneDraft(++storage.now, base), base);
      win.persist();
    },
    press() {
      const f = win.form;
      if (C.postingNow(win.reload().get(f.k), storage.now)) return null;
      const at = ++storage.now;
      win.set(f.k, { ...d(f.com, at, { file: f.file }), posting: at }, f.base);
      if (win.persist()?.get(f.k)?.posting === at) f.base = at;
      posting.add(f.k);
      return f;
    },
    posted(f) {
      posting.delete(f.k);
      win.forget(f.k, f.base);
      if (win.form === f) win.form = null;
    },
    failed(f) {
      posting.delete(f.k);
      const at = ++storage.now;
      win.set(f.k, d(f.com, at, { file: f.file }), f.base);
      if (win.persist()?.get(f.k)?.at === at) f.base = at;
    },
    pills: () => [...drafts].filter(([k, e]) => k !== win.form?.k && !posting.has(k) && !C.postingNow(e, storage.now) && C.hasContent(e)).map(([k]) => k).sort(),
  };
  return win;
}
const store = (value = '{}') => ({ value, now: 1_000_000, files: new Set() });

test('two windows: neither loses the other’s reply, and a posted one stays gone', () => {
  const storage = store(JSON.stringify({ 'g/5': d('posted later', 1) }));
  const one = windowOn(storage);
  const two = windowOn(storage); // a popped-out window, same store
  one.open('g/10');
  one.type('reply in window 1');
  two.open('g/20');
  two.type('reply in window 2');
  two.persist();
  one.open('g/5'); // g/10 becomes a pill
  one.posted(one.press());
  // quitting: both windows' pagehide, window 2 last; it changed nothing more
  one.stash();
  assert.equal(two.stash(), null, 'nothing unsaved: nothing written');
  two.type('reply in window 2, more');
  two.stash();
  assert.deepEqual(live(C.parseDrafts(storage.value)), ['g/10', 'g/20']);
  one.reload();
  assert.deepEqual(one.pills(), ['g/10', 'g/20']);
});

test('a reply posted in one window does not come back from another window’s open form', () => {
  // review: B has the form open, untouched; A posts it; B quits
  const storage = store();
  const a = windowOn(storage);
  const b = windowOn(storage);
  b.open('g/10');
  b.type('hello', { name: 'cat.png', size: 3 });
  b.stash();
  a.open('g/10'); // the reply B wrote
  assert.equal(a.form.com, 'hello');
  a.posted(a.press());
  assert.equal(storage.files.has('g/10'), false, 'its file went with it');
  // B's form, folded, still open: B quits
  b.stash();
  assert.deepEqual(live(C.parseDrafts(storage.value)), [], 'not a pill after a restart');
  // even B's copy written back (as stash() used to) stays out: the delete is newer
  b.set('g/10', d('hello', b.form.base, { file: { name: 'cat.png', size: 3 } }));
  b.persist();
  assert.deepEqual(live(C.parseDrafts(storage.value)), []);
  // without the storage event in between, B's copy written back stays out too
  const later = windowOn(storage);
  assert.deepEqual(later.pills(), []);
});

test('the posted reply leaves the other window’s open form, so it is not posted twice', () => {
  const storage = store();
  const a = windowOn(storage);
  const b = windowOn(storage);
  a.open('g/10');
  a.type('hello');
  a.stash();
  b.open('g/10');
  a.posted(a.press());
  b.reload(); // the storage event
  assert.equal(b.form.com, '', 'B’s form empties');
  assert.deepEqual(b.pills(), []);
  // edited in B meanwhile: B’s words stay (they are not what was posted)
  const c = windowOn(storage);
  a.open('g/11');
  a.type('first');
  a.stash();
  c.open('g/11');
  c.type('first, then more');
  c.stash();
  a.posted(a.press());
  c.reload();
  assert.equal(c.form.com, 'first, then more');
  assert.deepEqual(live(C.parseDrafts(storage.value)), ['g/11']);
});

test('an untouched empty form deletes nothing, file and all', () => {
  // review: the main window has an empty form for g/10; a popped-out window
  // writes a reply with a picture there and leaves it as a pill
  const storage = store();
  const main = windowOn(storage);
  const pop = windowOn(storage);
  main.open('g/10');
  pop.open('g/10');
  pop.type('from the pop-out', { name: 'p.png', size: 3 });
  pop.open('g/99'); // g/10 is a pill there now
  // main: × on its empty form, Reply elsewhere, or quit
  assert.equal(main.stash(), null, 'nothing written');
  main.open('g/1');
  assert.equal(C.parseDrafts(storage.value).get('g/10').com, 'from the pop-out');
  assert.equal(storage.files.has('g/10'), true, 'its picture stays');
  assert.deepEqual(main.pills(), ['g/10']);
  // emptied by hand: that is a delete of the copy the form had
  main.open('g/10');
  assert.equal(main.form.com, 'from the pop-out');
  main.type('', null);
  main.stash();
  assert.deepEqual(live(C.parseDrafts(storage.value)), []);
  assert.equal(storage.files.has('g/10'), false);
});

test('a reply being posted in one window is no pill and no second form in another', () => {
  const storage = store();
  const one = windowOn(storage);
  const two = windowOn(storage);
  one.open('g/10');
  one.type('hello');
  one.stash();
  two.reload();
  assert.deepEqual(two.pills(), ['g/10']);
  const going = one.press();
  two.reload();
  assert.deepEqual(two.pills(), [], 'no pill while it is posted');
  assert.equal(two.open('g/10'), false, 'no second form');
  // the same reply already open in a third window: Post there is refused
  const three = windowOn(storage);
  three.form = { k: 'g/10', com: 'hello', sub: '', email: '', file: null, base: 1 };
  assert.equal(three.press(), null);
  // the post fails: a reply again, a pill in the other window
  one.failed(going);
  two.reload();
  assert.deepEqual(two.pills(), ['g/10']);
  assert.equal(C.parseDrafts(storage.value).get('g/10').posting, undefined);
  // a crash mid-post: the pill comes back after a while
  one.press();
  two.reload();
  assert.deepEqual(two.pills(), []);
  storage.now += C.POSTING_MS;
  assert.deepEqual(two.pills(), ['g/10']);
});

test('a keystroke in another window does not let a reply being posted go out twice', () => {
  const storage = store();
  const a = windowOn(storage);
  const b = windowOn(storage);
  a.open('g/10');
  a.type('hello');
  a.stash();
  b.reload();
  b.form = { k: 'g/10', com: 'hello', sub: '', email: '', file: null, base: b.drafts.get('g/10').at }; // already open there
  const going = a.press();
  assert.equal(b.type('hello!'), false, 'refused: nothing written');
  b.stash();
  assert.equal(C.postingNow(C.parseDrafts(storage.value).get('g/10'), storage.now), true, 'the marker stays');
  assert.equal(b.press(), null, 'Post in B is still refused');
  a.posted(going);
  const stored = C.parseDrafts(storage.value);
  assert.equal(C.deletedSince(stored, 'g/10', b.form.base), true);
  b.reload(); // the storage event
  assert.equal(b.form.com, '', 'B’s form empties: no second post');
  assert.deepEqual(live(C.parseDrafts(storage.value)), []);
  const body2 = SRC.slice(SRC.indexOf('function typed()'), SRC.indexOf('addEventListener(', SRC.indexOf('function typed()')));
  assert.match(body2, /!posting\.has\(k\) && C\.postingNow\(reloadDrafts\(\)\?\.get\(k\)\)/, 'compose.js typed() refuses it too');
});

// ------------------------------------------------------------ Later

test('Later full: a new reply is refused, one already kept only moves up', () => {
  let list = [];
  for (let i = 0; i < C.MAX_SAVED_REPLIES; i++) list = C.saveReply(list, { board: 'g', thread: 1, com: `r${i}` }, { now: i + 1, id: `r${i}` });
  assert.equal(list.length, C.MAX_SAVED_REPLIES);
  assert.equal(C.savedFull(list, { board: 'g', thread: 1, com: 'new one' }), true);
  assert.equal(C.savedFull(list, { board: 'g', thread: 1, com: 'r0' }), false, 'the same reply again only moves up');
  assert.equal(C.savedFull(list.slice(1), { board: 'g', thread: 1, com: 'new one' }), false);
  const moved = C.saveReply(list, { board: 'g', thread: 1, com: 'r0' }, { now: 999 });
  assert.deepEqual(C.droppedIds(list, moved), []);
  // what saveReply cuts off a list stored over the limit is named, for its file
  const over = [...list, { id: 'extra', board: 'g', thread: 1, com: 'x', sub: '', email: '', file: null, at: 0 }];
  const cut = C.saveReply(over, { board: 'g', thread: 2, com: 'newest' }, { now: 1000, id: 'n' });
  assert.deepEqual(C.droppedIds(over, cut).sort(), ['extra', 'r0']);
});

// ---------------------------------------------------------- captcha

test('an expired captcha is caught before the post goes out', () => {
  const now = 1_000_000;
  const solved = { state: 'ready', tasks: [{}], picks: [0], expires: now + 60_000 };
  assert.equal(C.captchaExpired(solved, now), false);
  assert.equal(C.captchaExpired(solved, now + 58_000), true, 'the last 3 s count as expired: the post takes time');
  assert.equal(C.captchaExpired({ state: 'none' }, now), false);
  assert.equal(C.captchaExpired({ state: 'ready', tasks: [{}], picks: [] }, now), false, 'no time given: not expired');
  assert.deepEqual(C.preflight({ com: 'x', captcha: solved, now }), []);
  const late = C.preflight({ com: 'x', captcha: solved, now: now + 61_000 });
  assert.deepEqual(late, [{ field: 'captcha', message: 'The captcha expired: get a new one.' }]);
  const unsolved = C.preflight({ com: 'x', captcha: { ...solved, picks: [] }, now: now + 61_000 });
  assert.equal(unsolved.length, 1, 'expired, not also “finish the captcha”');
});

// ------------------------------------------------- compose.js itself

const SRC = readFileSync(new URL('../ui/js/compose.js', import.meta.url), 'utf8');

test('the composer’s window listeners end when it closes', () => {
  const calls = [];
  const re = /(?<![.\w])addEventListener\(\s*'(storage|pagehide|resize|DOMContentLoaded)'/g;
  for (let m; (m = re.exec(SRC)); ) {
    let depth = 0;
    let i = m.index + 'addEventListener'.length;
    const start = i;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '(') depth++;
      else if (SRC[i] === ')' && --depth === 0) break;
    }
    calls.push({ type: m[1], args: SRC.slice(start, i + 1) });
  }
  assert.ok(calls.length >= 5, `found ${calls.length}`);
  for (const c of calls) assert.match(c.args, /\bbound\b|signal: ac\.signal/, `${c.type} listener without the composer’s signal`);
  const close = SRC.slice(SRC.indexOf('function close()'), SRC.indexOf('async function closeAsked'));
  assert.match(close, /ac\.abort\(\)/);
  assert.match(close, /persistDrafts\(\)/, 'a write still waiting is not lost');
  assert.match(close, /clearTimeout\(fanTimer\)/);
});

test('the drafts are never written whole: only through the merge', () => {
  const writes = SRC.match(/localStorage\.setItem\(DRAFTS_KEY[^;]*;/g) || [];
  assert.equal(writes.length, 1);
  assert.match(writes[0], /merged/);
  assert.match(SRC, /e\.key !== DRAFTS_KEY/, 'other windows’ draft writes are taken in');
});

test('a folded form does not move or lose its place', () => {
  const startMove = SRC.slice(SRC.indexOf('function startMove('), SRC.indexOf('function currentPos('));
  assert.match(startMove, /st\?\.min/);
  const resetPos = SRC.slice(SRC.indexOf('function resetPos('), SRC.indexOf('function resetPos(') + 200);
  assert.match(resetPos, /st\?\.min/);
});

const body = (start, end) => SRC.slice(SRC.indexOf(start), SRC.indexOf(end, SRC.indexOf(start)));

test('a form writes only what was changed in it, and deletes only what it had', () => {
  const stash = body('function stash()', 'function forget(');
  assert.doesNotMatch(stash, /setDraft|dropDraft|draftOf|delFile/, 'stash only writes what typed() left waiting');
  const typed = body('function typed()', 'addEventListener(');
  assert.match(typed, /goneDraft\(d\.at, was\), was\)/, 'emptied by hand: a delete of the copy it had');
  assert.match(typed, /else return;/, 'an untouched empty form writes nothing');
  const persist = body('function persistDrafts()', 'function reloadDrafts()');
  assert.match(persist, /!C\.hasContent\(merged\?\.get\(k\)\)\) delFile/, 'a file goes only with a delete that went in');
  for (const call of SRC.match(/\bforget\([^)]*\)/g).filter((c) => !c.startsWith('forget(k, base)'))) assert.match(call, /,/, `${call} names the copy it deletes`);
});

test('a reply being posted elsewhere is no pill, no second form and not posted again', () => {
  assert.match(body('function activeList()', 'function pill('), /!C\.postingNow\(d\)/);
  assert.match(body('async function open(', 'async function loadCaptcha('), /C\.postingNow\(reloadDrafts\(\)\?\.get\(key\(board, thread\)\)\)/);
  assert.match(body('async function openSaved(', 'function openActive('), /C\.postingNow\(reloadDrafts\(\)\?\.get\(k\)\)/);
  const submit = body('async function submit()', 'function field(');
  assert.match(submit, /C\.postingNow\(reloadDrafts\(\)\?\.get\(k\)\)/);
  assert.match(submit, /posting: pressed/);
  assert.match(submit, /forget\(k, mine\.base\)/);
});

test('another window’s writes redraw the tray only when a pill changed, keeping the focus', () => {
  const handler = body("'storage',", 'bound,');
  assert.match(handler, /traySig\(\) === before\) return/);
  assert.match(handler, /if \(trayPress\) trayStale = true/);
  assert.match(handler, /followStored\(reloadDrafts\(\)\)/);
  assert.match(body('function drawTray(', 'const traySig'), /querySelector\(`\[data-key="\$\{CSS\.escape\(had\)\}"\]`\)\?\.focus/);
});
