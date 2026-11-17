// The confirm dialog's keys (offline.js confirmKey) and the clover icon and
// its update animation (dom.js icon('clover'), cloverBusy, cloverClass).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { confirmKey } = await import('../ui/js/offline.js');
const dom = await import('../ui/js/dom.js');

test('confirm keys: arrows, Home/End and Tab move between the two buttons, wrapping', () => {
  const k = (key, at, extra = {}) => confirmKey({ key, ...extra }, at, 2);
  assert.deepEqual(k('ArrowRight', 0), { move: 1 });
  assert.deepEqual(k('ArrowRight', 1), { move: 0 });
  assert.deepEqual(k('ArrowDown', 0), { move: 1 });
  assert.deepEqual(k('ArrowLeft', 1), { move: 0 });
  assert.deepEqual(k('ArrowLeft', 0), { move: 1 });
  assert.deepEqual(k('ArrowUp', 0), { move: 1 });
  assert.deepEqual(k('Home', 1), { move: 0 });
  assert.deepEqual(k('End', 0), { move: 1 });
  assert.deepEqual(k('Tab', 1), { move: 0 });
  assert.deepEqual(k('Tab', 0, { shiftKey: true }), { move: 1 });
  // focus on neither button: forward goes to the first, back to the last
  assert.deepEqual(k('ArrowRight', -1), { move: 0 });
  assert.deepEqual(k('ArrowLeft', -1), { move: 1 });
  assert.deepEqual(k('Tab', -1, { shiftKey: true }), { move: 1 });
  // a row of three wraps the same way
  assert.deepEqual(confirmKey({ key: 'ArrowRight' }, 2, 3), { move: 0 });
  assert.deepEqual(confirmKey({ key: 'ArrowLeft' }, 0, 3), { move: 2 });
});

test('confirm keys: Enter and Space pick the focused one, Escape cancels, the rest is left alone', () => {
  assert.equal(confirmKey({ key: 'Enter' }, 0, 2), 'press');
  assert.equal(confirmKey({ key: ' ' }, 1, 2), 'press');
  assert.equal(confirmKey({ key: 'Enter' }, -1, 2), null, 'nothing focused: nothing to press');
  assert.equal(confirmKey({ key: 'Escape' }, 0, 2), 'cancel');
  assert.equal(confirmKey({ key: 'Escape' }, -1, 2), 'cancel');
  for (const key of ['a', 'r', 'F5', 'Delete', 'Backspace']) assert.equal(confirmKey({ key }, 0, 2), null, key);
  // with a modifier the key is the page's (Alt+←, Ctrl+Tab…)
  for (const mod of ['altKey', 'ctrlKey', 'metaKey']) {
    assert.equal(confirmKey({ key: 'ArrowLeft', [mod]: true }, 0, 2), null, mod);
    assert.equal(confirmKey({ key: 'Enter', [mod]: true }, 0, 2), null, mod);
  }
  assert.equal(confirmKey({ key: 'ArrowRight' }, 0, 0), null, 'no buttons');
});

// globalThis.document for one test (node has none to mock).
function withDocument(t, doc) {
  globalThis.document = doc;
  t.after(() => delete globalThis.document);
}

// A small stand-in for the DOM: enough for icon() and cloverBusy().
function fakeDom() {
  const all = [];
  const node = (tag) => {
    const attrs = new Map();
    const classes = new Set();
    const el = {
      tagName: tag,
      children: [],
      isConnected: false,
      dataset: {},
      attrs,
      setAttribute(k, v) {
        if (k === 'class') {
          classes.clear();
          for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
        }
        attrs.set(k, String(v));
      },
      getAttribute: (k) => (k === 'class' && attrs.has(k) ? [...classes].join(' ') : (attrs.get(k) ?? null)),
      removeAttribute: (k) => attrs.delete(k),
      append(...c) {
        el.children.push(...c);
      },
      classList: {
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c), on),
        contains: (c) => classes.has(c),
      },
    };
    all.push(el);
    return el;
  };
  return {
    all,
    node,
    document: {
      createElementNS: (_ns, tag) => node(tag),
      querySelector: (sel) => {
        const m = /\[data-(key|clover)="([^"]+)"\]/.exec(sel);
        return all.find((el) => el.isConnected && m && el.dataset[m[1]] === m[2]) || null;
      },
    },
  };
}

test("icon('clover'): four classed leaves and a stem, on svg.icon.icon--clover", (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  const svg = dom.icon('clover');
  assert.equal(svg.getAttribute('class'), 'icon icon--clover');
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  const classes = svg.children.map((p) => p.getAttribute('class'));
  assert.deepEqual(classes, ['clover__stem', 'clover__leaf clover__leaf--1', 'clover__leaf clover__leaf--2', 'clover__leaf clover__leaf--3', 'clover__leaf clover__leaf--4']);
  for (const p of svg.children) assert.match(p.getAttribute('d'), /^M[\d.]+ [\d.]+/);
  // every coordinate stays inside the 24×24 box
  for (const p of svg.children) for (const n of p.getAttribute('d').match(/-?\d+(\.\d+)?/g).map(Number)) assert.ok(n >= -6 && n <= 24, `${n}`);
  assert.equal(dom.icon('clover', 'extra').getAttribute('class'), 'icon icon--clover extra');
  // the other icons are drawn as before: no own class, no classed paths
  const r = dom.icon('refresh', 'x');
  assert.equal(r.getAttribute('class'), 'icon x');
  assert.ok(r.children.every((p) => p.getAttribute('class') === null));
});

test('cloverBusy: spins at least 600 ms, pops, then clears; returns the work’s own result', async (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const btn = f.node('button');
  btn.dataset.key = 'p0-thread-refresh';
  btn.isConnected = true;
  let done;
  const p = dom.cloverBusy(btn, () => new Promise((r) => (done = r)));
  assert.ok(btn.classList.contains('clover-anim'));
  assert.equal(btn.getAttribute('aria-busy'), 'true');
  assert.equal(dom.cloverClass('p0-thread-refresh'), 'clover-anim');
  now += 100;
  done('fresh');
  assert.equal(await p, 'fresh');
  await Promise.resolve();
  t.mock.timers.tick(dom.CLOVER_MIN_MS - 101);
  assert.ok(btn.classList.contains('clover-anim'), 'still spinning before 600 ms');
  t.mock.timers.tick(1);
  assert.ok(!btn.classList.contains('clover-anim') && btn.classList.contains('clover-done'));
  assert.equal(btn.getAttribute('aria-busy'), null);
  assert.equal(dom.cloverClass('p0-thread-refresh'), 'clover-done');
  t.mock.timers.tick(dom.CLOVER_DONE_MS);
  assert.ok(!btn.classList.contains('clover-done'));
  assert.equal(dom.cloverClass('p0-thread-refresh'), '');
});

test('cloverBusy: a failed update still ends the animation and the error reaches the caller', async (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const btn = f.node('button');
  btn.dataset.key = 'catalog-refresh';
  btn.isConnected = true;
  await assert.rejects(dom.cloverBusy(btn, Promise.reject(new Error('offline'))), /offline/);
  await Promise.resolve();
  t.mock.timers.tick(dom.CLOVER_MIN_MS);
  assert.ok(btn.classList.contains('clover-done'));
  t.mock.timers.tick(dom.CLOVER_DONE_MS);
  assert.ok(!btn.classList.contains('clover-anim') && !btn.classList.contains('clover-done'));
  // a work function that throws at once
  await assert.rejects(
    dom.cloverBusy(btn, () => {
      throw new Error('bad');
    }),
    /bad/,
  );
});

test('cloverBusy: a button drawn anew mid-update takes the state, found by its data-key', async (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = f.node('button');
  old.dataset.key = 'p1-thread-refresh';
  old.isConnected = true;
  let done;
  const p = dom.cloverBusy(old, new Promise((r) => (done = r)));
  // the pane redraws: the old button leaves, a new one (without the class) comes
  old.isConnected = false;
  const fresh = f.node('button');
  fresh.dataset.key = 'p1-thread-refresh';
  fresh.isConnected = true;
  assert.equal(dom.cloverClass('p1-thread-refresh'), 'clover-anim', 'a renderer can ask');
  done();
  await p;
  await Promise.resolve();
  t.mock.timers.tick(dom.CLOVER_MIN_MS);
  assert.ok(fresh.classList.contains('clover-done'), 'the pop shows on the new button');
  t.mock.timers.tick(dom.CLOVER_DONE_MS);
  assert.ok(!fresh.classList.contains('clover-done'));
});

test('cloverBusy: overlapping calls on one button make one run that ends with the last', async (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const btn = f.node('button');
  btn.dataset.key = 'p2-catalog-refresh';
  btn.isConnected = true;
  let a;
  let b;
  const pa = dom.cloverBusy(btn, new Promise((r) => (a = r)));
  const pb = dom.cloverBusy(btn, new Promise((r) => (b = r)));
  a();
  await pa;
  await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.ok(btn.classList.contains('clover-anim'), 'the second is still running');
  b();
  await pb;
  await Promise.resolve();
  t.mock.timers.tick(dom.CLOVER_MIN_MS);
  assert.ok(btn.classList.contains('clover-done'));
  t.mock.timers.tick(dom.CLOVER_DONE_MS);
  assert.equal(dom.cloverClass('p2-catalog-refresh'), '');
});


test('cloverBusy: the run follows the work (data-clover), not another tab’s button with the same data-key', async (t) => {
  const f = fakeDom();
  withDocument(t, f.document);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = f.node('button');
  a.dataset.key = 'thread-refresh';
  a.dataset.clover = 'thread-refresh|g/500010';
  a.isConnected = true;
  let done;
  const p = dom.cloverBusy(a, new Promise((r) => (done = r)));
  assert.equal(dom.cloverClass('thread-refresh|g/500010'), 'clover-anim');
  // Ctrl+Tab: the pane shows another thread, its Update has the same data-key
  a.isConnected = false;
  const b = f.node('button');
  b.dataset.key = 'thread-refresh';
  b.dataset.clover = 'thread-refresh|g/500073';
  b.isConnected = true;
  assert.equal(dom.cloverClass('thread-refresh|g/500073'), '', 'the other tab draws its button at rest');
  assert.equal(dom.cloverClass('thread-refresh'), '', 'nothing runs under the bare data-key');
  done();
  await p;
  await Promise.resolve();
  t.mock.timers.tick(dom.CLOVER_MIN_MS);
  assert.ok(!b.classList.contains('clover-done') && !b.classList.contains('clover-anim'), 'no pop on the other tab’s button');
  assert.equal(b.getAttribute('aria-busy'), null);
  // back on the first tab mid-run, its new button takes the run
  const a2 = f.node('button');
  a2.dataset.key = 'thread-refresh';
  a2.dataset.clover = 'thread-refresh|g/500010';
  a2.isConnected = true;
  b.isConnected = false;
  const q = dom.cloverBusy(a2, Promise.resolve());
  await q;
  await Promise.resolve();
  assert.ok(a2.classList.contains('clover-anim') || a2.classList.contains('clover-done'));
  t.mock.timers.tick(dom.CLOVER_MIN_MS);
  t.mock.timers.tick(dom.CLOVER_DONE_MS);
  assert.equal(dom.cloverClass('thread-refresh|g/500010'), '');
});
