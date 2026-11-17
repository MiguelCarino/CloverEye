import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as T from '../ui/js/tabs-model.js';
import { panesFromHash } from '../ui/js/browse-model.js';

let seq = 0;
const tab = (name, opener) => ({ id: ++seq, name, opener });
const names = (s) => s.tabs.map((t) => t.name);
const enc = (v) => `#panes=${encodeURIComponent(JSON.stringify(v))}`;

test('addTab: a background tab goes after the active one, which stays shown', () => {
  const a = tab('a');
  const b = tab('b');
  const s0 = { tabs: [a, b], active: 0 };
  const s1 = T.addTab(s0, tab('c', a.id), { background: true });
  assert.deepEqual(names(s1), ['a', 'c', 'b']);
  assert.equal(s1.active, 0);
  assert.equal(s1.index, 1);
  // the next one opened from the same tab goes after it (in the order opened)
  const s2 = T.addTab(s1, tab('d', a.id), { background: true });
  assert.deepEqual(names(s2), ['a', 'c', 'd', 'b']);
  assert.equal(s2.active, 0);
});

test('addTab: a foreground tab is shown; the pane keeps at most 20', () => {
  const a = tab('a');
  const s = T.addTab({ tabs: [a], active: 0 }, tab('b', a.id), { background: false });
  assert.deepEqual(names(s), ['a', 'b']);
  assert.equal(s.active, 1);
  const full = { tabs: Array.from({ length: T.MAX_TABS }, (_, i) => tab(`t${i}`)), active: 3 };
  assert.equal(T.MAX_TABS, 20);
  assert.equal(T.addTab(full, tab('x')), null);
  // a place of its own (a closed tab coming back) before the active tab
  const back = T.addTab({ tabs: [tab('p'), tab('q')], active: 1 }, tab('r'), { background: true, at: 0 });
  assert.deepEqual(names(back), ['r', 'p', 'q']);
  assert.equal(back.active, 2);
});

test('closeTab: closing another tab keeps the active one', () => {
  const s = { tabs: [tab('a'), tab('b'), tab('c')], active: 1 };
  const r = T.closeTab(s, 0);
  assert.deepEqual(names(r), ['b', 'c']);
  assert.equal(r.active, 0);
  assert.equal(r.closed.name, 'a');
  const r2 = T.closeTab(s, 2);
  assert.deepEqual(names(r2), ['a', 'b']);
  assert.equal(r2.active, 1);
});

test('closeTab: the active tab closed: right neighbour, else left; never the last tab', () => {
  const s = { tabs: [tab('a'), tab('b'), tab('c')], active: 1 };
  const r = T.closeTab(s, 1);
  assert.deepEqual(names(r), ['a', 'c']);
  assert.equal(r.active, 1); // c
  const last = T.closeTab({ tabs: s.tabs, active: 2 }, 2);
  assert.equal(last.active, 1); // b
  assert.equal(T.closeTab({ tabs: [tab('only')], active: 0 }, 0), null);
  assert.equal(T.closeTab(s, 7), null);
});

test('closeTab: a tab opened from another goes back to it, or to its next sibling', () => {
  const a = tab('a');
  const x = tab('x');
  const c1 = tab('c1', a.id);
  const c2 = tab('c2', a.id);
  // a, c1, c2, x with c1 shown: closing it shows c2 (opened from a too)
  const r = T.closeTab({ tabs: [a, c1, c2, x], active: 1 }, 1);
  assert.equal(r.tabs[r.active].name, 'c2');
  // closing c2 then (no sibling after it) goes back to a
  const r2 = T.closeTab({ tabs: r.tabs, active: r.active }, r.active);
  assert.equal(r2.tabs[r2.active].name, 'a');
});

test('closed tabs: kept newest last, ten at most, reopened newest first', () => {
  let stack = [];
  for (let i = 0; i < 12; i++) stack = T.pushClosed(stack, { n: i });
  assert.equal(stack.length, T.CLOSED_KEEP);
  assert.equal(stack[0].n, 2);
  const p = T.popClosed(stack);
  assert.equal(p.entry.n, 11);
  assert.equal(p.stack.length, 9);
  assert.equal(T.popClosed([]), null);
});

test('cycling: round the ends both ways', () => {
  const s = { tabs: [1, 2, 3], active: 2 };
  assert.equal(T.cycleIndex(s, 1), 0);
  assert.equal(T.cycleIndex(s, -1), 1);
  assert.equal(T.cycleIndex({ tabs: [1, 2, 3], active: 0 }, -1), 2);
  assert.equal(T.cycleIndex({ tabs: [1], active: 0 }, 1), 0);
});

test('Ctrl+1…8 pick that tab, Ctrl+9 the last', () => {
  assert.equal(T.pickIndex(1, 3), 0);
  assert.equal(T.pickIndex(3, 3), 2);
  assert.equal(T.pickIndex(4, 3), null);
  assert.equal(T.pickIndex(9, 3), 2);
  assert.equal(T.pickIndex(9, 12), 11);
  assert.equal(T.pickIndex(8, 12), 7);
  assert.equal(T.pickIndex(0, 3), null);
});

test('tab keys', () => {
  const k = (key, o = {}) => T.tabKeyAction({ key, ctrlKey: true, ...o });
  assert.deepEqual(k('t'), { kind: 'new' });
  assert.deepEqual(k('T', { shiftKey: true }), { kind: 'reopen' });
  assert.deepEqual(k('w'), { kind: 'close' });
  assert.equal(k('W', { shiftKey: true }), null);
  assert.deepEqual(k('Tab'), { kind: 'next' });
  assert.deepEqual(k('Tab', { shiftKey: true }), { kind: 'prev' });
  assert.deepEqual(k('PageDown'), { kind: 'next' });
  assert.deepEqual(k('PageUp'), { kind: 'prev' });
  assert.deepEqual(k('3', { code: 'Digit3' }), { kind: 'pick', digit: 3 });
  assert.deepEqual(k('9'), { kind: 'pick', digit: 9 });
  // a keyboard layout whose digits need Shift: the key's place counts
  assert.deepEqual(k('ç', { code: 'Digit9' }), { kind: 'pick', digit: 9 });
  // ⌘ on a Mac, except with Tab
  assert.deepEqual(T.tabKeyAction({ key: 't', metaKey: true }), { kind: 'new' });
  assert.equal(T.tabKeyAction({ key: 'Tab', metaKey: true }), null);
  // other layouts: the key's place
  assert.deepEqual(T.tabKeyAction({ key: 'е', code: 'KeyT', ctrlKey: true }), { kind: 'new' });
  assert.equal(T.tabKeyAction({ key: 't' }), null);
  assert.equal(T.tabKeyAction({ key: 't', ctrlKey: true, altKey: true }), null);
  assert.equal(k('r'), null);
  assert.equal(k('0'), null);
});

test('tab keys: a Latin layout’s own letter wins over the key’s place', () => {
  const k = (key, code) => T.tabKeyAction({ key, code, ctrlKey: true });
  assert.equal(k('z', 'KeyW'), null); // Ctrl+Z (undo) on AZERTY
  assert.equal(k('y', 'KeyT'), null); // Ctrl+Y (redo) on Dvorak
  assert.equal(k(',', 'KeyW'), null); // Ctrl+, on Dvorak
  assert.deepEqual(k('w', 'Comma'), { kind: 'close' }); // Ctrl+W on Dvorak
  assert.deepEqual(k('t', 'KeyY'), { kind: 'new' }); // Ctrl+T on Dvorak
  // Cyrillic: no Latin letter typed, so the key's place counts
  assert.deepEqual(k('ц', 'KeyW'), { kind: 'close' });
  assert.deepEqual(T.tabKeyAction({ key: 'Е', code: 'KeyT', ctrlKey: true, shiftKey: true }), { kind: 'reopen' });
});

test('clicks: Ctrl/⌘ or middle opens a background tab, with Shift in front', () => {
  assert.equal(T.clickTab({ button: 0 }), null);
  assert.deepEqual(T.clickTab({ button: 0, ctrlKey: true }), { background: true });
  assert.deepEqual(T.clickTab({ button: 0, metaKey: true, shiftKey: true }), { background: false });
  assert.deepEqual(T.clickTab({ button: 1 }), { background: true });
  assert.deepEqual(T.clickTab({ button: 1, shiftKey: true }), { background: false });
});

test('address: the old format (a list of views) still opens one-tab panes', () => {
  const groups = T.decodePanes(enc([{ kind: 'thread', board: 'g', no: 5, junk: 1 }, { kind: 'board', board: 'diy' }, { kind: 'settings' }]));
  assert.deepEqual(groups, [
    { tabs: [{ kind: 'thread', board: 'g', no: 5 }], active: 0 },
    { tabs: [{ kind: 'board', board: 'diy' }], active: 0 },
  ]);
  assert.equal(T.decodePanes('#setup'), null);
  assert.equal(T.decodePanes('#panes=%7Bbad'), null);
  assert.equal(T.decodePanes(enc({ tabs: [] })), null);
  assert.equal(T.decodePanes(enc(Array.from({ length: 9 }, () => ({ kind: 'boards' })))).length, 5);
});

test('address: panes with tabs round trip; unknown tabs drop, the active one follows', () => {
  const panes = [
    { tabs: [{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'tag', id: 'cats' }], active: 1 },
    { kind: 'boards' },
    { tabs: [{ kind: 'offline', board: 'diy', no: 7 }], active: 0 },
  ];
  const out = T.decodePanes(`#panes=${T.encodePanes(panes)}`);
  assert.deepEqual(out, [
    { tabs: panes[0].tabs, active: 1 },
    { tabs: [{ kind: 'boards' }], active: 0 },
    { tabs: [{ kind: 'offline', board: 'diy', no: 7 }], active: 0 },
  ]);
  // a one-tab pane is written as its view: an older reader opens it too
  assert.deepEqual(JSON.parse(decodeURIComponent(T.encodePanes([{ tabs: [{ kind: 'board', board: 'g' }], active: 0 }]))), [{ kind: 'board', board: 'g' }]);
  assert.deepEqual(panesFromHash(`#panes=${T.encodePanes(panes)}`), [{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'boards' }, { kind: 'offline', board: 'diy', no: 7 }]);
  // bad tabs before the active one move it
  const odd = T.decodePanes(enc([{ tabs: [{ kind: 'settings' }, { kind: 'board', board: '../x' }, { kind: 'board', board: 'a' }, { kind: 'board', board: 'b' }], active: 3 }]));
  assert.deepEqual(odd, [{ tabs: [{ kind: 'board', board: 'a' }, { kind: 'board', board: 'b' }], active: 1 }]);
  // more than 20 tabs: the first 20
  const many = T.decodePanes(enc([{ tabs: Array.from({ length: 30 }, (_, i) => ({ kind: 'thread', board: 'g', no: i + 1 })), active: 0 }]));
  assert.equal(many[0].tabs.length, T.MAX_TABS);
  // nothing known: All boards
  assert.deepEqual(JSON.parse(decodeURIComponent(T.encodePanes([{ kind: 'settings' }]))), [{ kind: 'boards' }]);
});

test('address: kept under the length the app takes; active tabs always stay', () => {
  const big = Array.from({ length: 5 }, (_, p) => ({ tabs: Array.from({ length: 20 }, (_, i) => ({ kind: 'thread', board: 'vg', no: 900000000 + p * 100 + i })), active: 10 }));
  const s = T.encodePanes(big, 2000);
  assert.ok(s.length <= 2000, String(s.length));
  const back = T.decodePanes(`#panes=${s}`);
  assert.equal(back.length, 5);
  back.forEach((g, p) => assert.deepEqual(g.tabs[g.active], { kind: 'thread', board: 'vg', no: 900000000 + p * 100 + 10 }));
  // the full set fits the default limit untouched when it is small
  const small = [{ tabs: [{ kind: 'board', board: 'g' }, { kind: 'board', board: 'v' }], active: 0 }];
  assert.deepEqual(T.decodePanes(`#panes=${T.encodePanes(small)}`), small);
  // only characters the app accepts in a window address
  assert.match(T.encodePanes(big), /^[A-Za-z0-9%._~*'()!-]+$/);
});

test('kindLabel names the other views', () => {
  assert.equal(T.kindLabel('settings'), 'Settings');
  assert.equal(T.kindLabel('boards'), 'All boards');
  assert.equal(T.kindLabel('nope'), '');
});
