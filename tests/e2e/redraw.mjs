// What the shell redraws while nobody touches it, and what a redraw of one
// pane keeps (mock bridge, fake clock); a thread's new posts added in place
// match a pane drawn anew; then, on the real clock, how long the updates of
// a big thread take (reported, not checked).
// usage: node tests/e2e/redraw.mjs [--no-perf]
// Playwright is not a dependency of this repo: point PLAYWRIGHT at its index.mjs.
// The ui/ folder is served from disk at https://ce.test/ inside the browser;
// every other host is refused (and counted).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pw = await import(process.env.PLAYWRIGHT || 'playwright');
const UI = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui');
const HOST = 'https://ce.test/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ` (${extra})` : ''}`);
  if (!cond) failures++;
}

const BASE_SETTINGS = { schema: 1, setupVersion: 3, completedAt: '2026-11-11T00:00:00.000Z', favourites: ['g'], theme: 'dark' };

// Counts what the shell tears down: a full redraw drops the whole rail
// (nav.rail) and the workspace (main); a pane on its own drops its section;
// the sidebar's lists on their own drop .rail__scroll.
function probe(settings) {
  try {
    if (location.hostname === 'ce.test') localStorage.setItem('clovereye.settings', JSON.stringify(settings));
  } catch {}
  const c = (window.__rb = { full: 0, panes: 0, rail: 0 });
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('nav.rail')) c.full++;
        else if (n.matches('section[data-pane]')) c.panes++;
        else if (n.matches('.rail__scroll')) c.rail++;
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

const browser = await pw.chromium.launch();

async function open(settings, query, hash = '', viewport = { width: 1280, height: 800 }, { clock = true } = {}) {
  const ctx = await browser.newContext({ viewport });
  const outside = [];
  const errors = [];
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== HOST.slice(0, -1)) {
      outside.push(url.href);
      return route.abort();
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '') || 'index.html';
    const file = join(UI, rel);
    if (!file.startsWith(UI) || !existsSync(file) || statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(probe, settings);
  if (clock) await page.clock.install({ time: new Date('2026-11-17T12:00:00Z') });
  await page.goto(`${HOST}index.html${query}${hash}`);
  return { ctx, page, outside, errors };
}

const counts = (page) => page.evaluate(() => ({ ...window.__rb }));
const resetCounts = (page) => page.evaluate(() => Object.assign(window.__rb, { full: 0, panes: 0, rail: 0 }));

// ------------------------------------------------- three panes, nothing new
{
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }]));
  const { ctx, page, outside, errors } = await open(BASE_SETTINGS, '?mock-delay=0', `#panes=${panes}`);
  await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2 && document.querySelector('.catalog'));
  await page.clock.runFor(2000);
  await resetCounts(page);
  const statusBefore = await page.locator('[data-pane="1"] [data-status]').textContent();
  await page.clock.runFor(60_000);
  const idle = await counts(page);
  check('idle minute, unchanged threads: no full redraw', idle.full === 0, JSON.stringify(idle));
  check('idle minute: no pane redrawn either, nor the sidebar', idle.panes === 0 && idle.rail === 0, JSON.stringify(idle));
  const statusAfter = await page.locator('[data-pane="1"] [data-status]').textContent();
  check('the status line still moves (Updated time)', statusAfter !== statusBefore && /^Updated /.test(statusAfter), `${statusBefore} → ${statusAfter}`);
  check('the Update button is enabled again', await page.locator('[data-key="p1-thread-refresh"]').isEnabled());

  // the focus moves without a redraw: marker and workspace title follow
  await resetCounts(page);
  await page.locator('[data-pane="2"] .thread').first().click({ position: { x: 5, y: 5 } });
  check('a click moves the pane marker', (await page.locator('[data-pane="2"]').getAttribute('aria-current')) === 'true' && (await page.locator('[data-pane="0"]').getAttribute('aria-current')) === null);
  const title2 = await page.locator('[data-pane="2"]').getAttribute('aria-label');
  const h1 = await page.locator('.workspace__title').textContent();
  check('the workspace title follows the focus', title2.endsWith(h1), `${h1} / ${title2}`);
  check('without a redraw', (await counts(page)).full === 0);

  // resizing redraws only when the narrow layout comes or goes
  await resetCounts(page);
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.clock.runFor(100);
  check('resizing above 900 px: no redraw', (await counts(page)).full === 0, JSON.stringify(await counts(page)));
  // the media query's change event comes with the next frame
  const fullIs = (n) => page.waitForFunction((k) => window.__rb.full === k, n, { timeout: 3000 }).then(() => true, () => false);
  await page.setViewportSize({ width: 800, height: 700 });
  check('crossing 900 px: one redraw', await fullIs(1), JSON.stringify(await counts(page)));
  await page.setViewportSize({ width: 1280, height: 800 });
  check('and back: one more', await fullIs(2), JSON.stringify(await counts(page)));
  await page.waitForTimeout(300);
  check('and no more', (await counts(page)).full === 2, JSON.stringify(await counts(page)));

  // Japanese input: the search waits for the word to be composed
  await resetCounts(page);
  const search = page.locator('[data-key="catalog-search"]');
  await search.evaluate((el) => {
    el.focus();
    el.value = 'zzz';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: 'z' }));
  });
  check('composing: no redraw', (await counts(page)).full === 0);
  await search.evaluate((el) => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'zzz' })));
  const composed = await counts(page);
  check('composed: the search applies, in its own pane only', composed.full === 0 && composed.panes === 1 && (await page.locator('text=No thread matches that search.').count()) === 1, JSON.stringify(composed));
  check('the search box keeps the focus and the text', await page.evaluate(() => document.activeElement?.dataset.key === 'catalog-search' && document.activeElement.value === 'zzz'));

  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no outside request', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------------------- a thread that grows
{
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }]));
  const watched = [500010, 500055, 500094, 500256, 500151, 500067, 500184, 500118, 500133, 500061, 500049, 500028, 500043].map((no) => ({ board: 'g', no, title: `Watched ${no}`, seen: 0 }));
  const { ctx, page, errors } = await open({ ...BASE_SETTINGS, watched }, '?mock-delay=0&mock-grow', `#panes=${panes}`, { width: 1280, height: 520 });
  await page.waitForFunction(() => document.querySelectorAll('.thread').length === 1);
  await page.clock.runFor(1000);
  const max = await page.evaluate(() => {
    const r = document.querySelector('.rail__scroll');
    r.scrollTop = 120;
    return r.scrollHeight - r.clientHeight;
  });
  await resetCounts(page);
  await page.evaluate(() => {
    document.querySelector('section[data-pane="0"]').__mark = 'catalog';
    document.querySelector('section[data-pane="1"]').__mark = 'thread';
  });
  await page.clock.runFor(11_000);
  const c = await counts(page);
  check('a new reply is added in place: no pane redrawn, the sidebar is (its count)', c.full === 0 && c.panes === 0 && c.rail >= 1, JSON.stringify(c));
  check('the thread pane is the same element', await page.evaluate(() => document.querySelector('section[data-pane="1"]').__mark === 'thread'));
  check('the catalog pane is the same element', await page.evaluate(() => document.querySelector('section[data-pane="0"]').__mark === 'catalog'));
  check('the sidebar keeps its scroll position', (await page.evaluate(() => document.querySelector('.rail__scroll').scrollTop)) === Math.min(120, max), String(max));
  check('the new reply is there', (await page.locator('[data-pane="1"] .post--new').count()) === 1);

  // two panes: closing one leaves no close button on the other, which stays
  await page.locator('[data-key="pane-close"]').click();
  check('the last pane left has no close button', (await page.locator('[data-key="p1-pane-close"]').count()) === 0);
  await page.clock.runFor(400);
  check('one pane left', (await page.locator('section[data-pane]').count()) === 1);
  check('it is not fading out', (await page.locator('section.pane--closing').count()) === 0);
  check('no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------- what a pane redraw keeps
{
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }]));
  const { ctx, page, errors, outside } = await open(BASE_SETTINGS, '?mock-delay=0&mock-grow&mock-big=60', `#panes=${panes}`);
  await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2 && document.querySelector('.catalog'));
  await page.clock.runFor(1000);
  const p1 = '[data-pane="1"]';
  // an inline quote copy and an opened file in pane 1; pane 2 scrolled
  const quote = page.locator(`${p1} .thread > .post .seg-quotelink[aria-expanded="false"]`).first();
  await quote.evaluate((el) => el.click()); // (under the pane's sticky bar)
  check('an inline quote copy opens', (await page.locator(`${p1} .quote-inline`).count()) >= 1);
  const thumb = page.locator(`${p1} .thread > .post .post__thumb`).first();
  await thumb.evaluate((el) => el.click());
  const opened = await page.evaluate((sel) => {
    const fig = document.querySelector(`${sel} .post__file--open`);
    if (fig) fig.__mark = 'opened';
    return Boolean(fig);
  }, p1);
  check('a file opens', opened);
  // WebKitGTK (the Linux app's webview) has no CSS scroll anchoring: the
  // shell has to keep the place itself (growPane), so Chromium's is off here
  // (through the CSSOM: the page's CSP refuses a <style> added inline)
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.centre__body')) b.style.setProperty('overflow-anchor', 'none', 'important');
  });
  const y2 = await page.evaluate(() => {
    const b = document.querySelector('[data-pane="2"] .centre__body');
    b.scrollTop = Math.floor((b.scrollHeight - b.clientHeight) / 2);
    // the reply-link rows above the fold go, so the new reply's row on the
    // post it quotes (near the top) is added above what is in sight
    const top = b.getBoundingClientRect().top;
    for (const row of b.querySelectorAll('.thread > .post .post__backlinks')) if (row.closest('.post').getBoundingClientRect().bottom < top - 200) row.remove();
    return b.scrollTop;
  });
  await page.clock.runFor(100);
  // the post at the top of pane 2, and where
  const topPost = () =>
    page.evaluate(() => {
      const b = document.querySelector('[data-pane="2"] .centre__body');
      const top = b.getBoundingClientRect().top;
      const el = [...b.querySelectorAll('.thread > [data-no]')].find((x) => x.getBoundingClientRect().bottom > top + 80);
      return el ? `${el.dataset.no} @ ${Math.round(el.getBoundingClientRect().top - top)}` : '';
    });
  const top2 = await topPost();
  // typing in the catalog's search, the caret in the middle
  const search = page.locator('[data-key="catalog-search"]');
  await search.click();
  await search.pressSequentially('ab');
  await search.evaluate((el) => el.setSelectionRange(1, 1));
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('section[data-pane]')) s.__mark = `pane${s.dataset.pane}`;
    document.querySelector('nav.rail').__mark = 'rail';
  });
  const postsBefore = await page.locator('.thread > .post').count();
  await resetCounts(page);
  await page.clock.runFor(11_000);
  const c = await counts(page);
  check('both threads grew: the new posts added in place, nothing redrawn', c.full === 0 && c.panes === 0 && c.rail === 0, JSON.stringify(c));
  check('every pane is the same element', await page.evaluate(() => [...document.querySelectorAll('section[data-pane]')].every((s) => s.__mark === `pane${s.dataset.pane}`)));
  check('one more post in each thread', (await page.locator('.thread > .post').count()) === postsBefore + 2, `${postsBefore} → ${await page.locator('.thread > .post').count()}`);
  check('the catalog pane and the sidebar are the same elements', await page.evaluate(() => document.querySelector('section[data-pane="0"]').__mark === 'pane0' && document.querySelector('nav.rail').__mark === 'rail'));
  check(
    'the search keeps the focus, the text and the caret',
    await page.evaluate(() => {
      const el = document.activeElement;
      return el?.dataset.key === 'catalog-search' && el.value === 'ab' && el.selectionStart === 1 && el.selectionEnd === 1;
    }),
  );
  check('the inline quote copy is still open', (await page.locator(`${p1} .quote-inline`).count()) >= 1);
  check('the opened file is the same element, still open', await page.evaluate((sel) => document.querySelector(`${sel} .post__file--open`)?.__mark === 'opened', p1));
  const y2after = await page.evaluate(() => document.querySelector('[data-pane="2"] .centre__body').scrollTop);
  const top2after = await topPost();
  const [no2, at2] = top2.split(' @ ');
  const [no2after, at2after] = top2after.split(' @ ');
  check('pane 2 shows the same post at the same place', y2 > 0 && no2 && no2 === no2after && Math.abs(Number(at2) - Number(at2after)) <= 2, `${top2} → ${top2after}; scrollTop ${y2} → ${y2after}`);
  check('both have the new reply', (await page.locator('.thread .post--new').count()) === 2);

  // a menu open in pane 1 stays open while pane 2 is redrawn (and put
  // back where it was scrolled to)
  await page.locator(`${p1} .thread > .post .post__menu`).first().evaluate((el) => el.click());
  check('a post menu opens', (await page.locator('.menu[role="menu"]').count()) === 1);
  await resetCounts(page);
  await page.evaluate(() => document.querySelector('[data-key="p2-thread-refresh"]').click());
  await page.clock.runFor(200);
  const m = await counts(page);
  check('Update in pane 2: its new post added in place', m.full === 0 && m.panes === 0, JSON.stringify(m));
  check('the menu in pane 1 is still open', (await page.locator('.menu[role="menu"]').count()) === 1);
  await page.evaluate(() => window.__ceDebug.renderPane(2));
  const m2 = await counts(page);
  check('pane 2 drawn anew: it alone', m2.full === 0 && m2.panes === 1, JSON.stringify(m2));
  check('the menu in pane 1 is still open after that too', (await page.locator('.menu[role="menu"]').count()) === 1);
  await page.keyboard.press('Escape');
  check('Esc still closes it', (await page.locator('.menu[role="menu"]').count()) === 0);

  // a menu whose own pane is drawn anew follows the new button: it says so,
  // and a click on it closes the menu (not closed by the press, opened again)
  const menuBtn = page.locator(`${p1} .thread > .post .post__menu`).first();
  await menuBtn.evaluate((el) => el.click());
  await page.evaluate(() => window.__ceDebug.renderPane(1));
  check(
    'its pane drawn anew: the menu stays open and the new button says so',
    (await page.locator('.menu[role="menu"]').count()) === 1 && (await menuBtn.getAttribute('aria-expanded')) === 'true',
    String(await menuBtn.getAttribute('aria-expanded')),
  );
  await menuBtn.evaluate((el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    el.click();
  });
  check('a click on that new button closes it', (await page.locator('.menu[role="menu"]').count()) === 0 && (await menuBtn.getAttribute('aria-expanded')) === 'false');

  // the focus on pane 1's Watch button, pane 2 picked with the pointer:
  // pane 1 growing puts the focus back on its button, and pane 2 stays the
  // focused pane
  await page.locator('[data-key="p1-thread-watch"]').focus();
  await page.locator('[data-pane="2"] .pane__title').dispatchEvent('pointerdown');
  check('pane 2 picked, the focus still in pane 1', (await page.locator('[data-pane="2"]').getAttribute('aria-current')) === 'true' && (await page.evaluate(() => document.activeElement?.dataset.key)) === 'p1-thread-watch');
  await page.clock.runFor(11_000);
  check(
    'pane 1 grown: its button has the focus back, pane 2 is still the focused pane',
    (await page.evaluate(() => document.activeElement?.dataset.key)) === 'p1-thread-watch' && (await page.locator('[data-pane="2"]').getAttribute('aria-current')) === 'true',
    `${await page.evaluate(() => document.activeElement?.dataset.key)} / ${await page.locator('[data-pane="2"]').getAttribute('aria-current')}`,
  );

  // the focus moves to pane 2 and back: no redraw, the title follows
  await resetCounts(page);
  await page.locator('[data-pane="2"] .pane__title').click();
  await page.locator('[data-pane="1"] .pane__title').click();
  check('the focus moves between panes without a redraw', (await counts(page)).full === 0 && (await counts(page)).panes === 0 && (await page.locator('[data-pane="1"]').getAttribute('aria-current')) === 'true');

  // a hidden window draws nothing until it is seen (no frames): later
  // (hidden: what comes is not read, so the focused thread's count grows)
  await page.evaluate(() => {
    window.__rafHeld = [];
    window.__raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => window.__rafHeld.push(f);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  });
  await resetCounts(page);
  const heldBefore = await page.locator('.thread > .post').count();
  const titleBefore = await page.title();
  await page.clock.runFor(11_000);
  check('no frame, nothing drawn', (await counts(page)).panes === 0 && (await page.locator('.thread > .post').count()) === heldBefore, JSON.stringify(await counts(page)));
  const titleHidden = await page.title();
  check('the window title has the new unread count all the same', titleHidden !== titleBefore && /^\(\d+\) /.test(titleHidden), `${titleBefore} → ${titleHidden}`);
  await page.evaluate(() => {
    delete document.visibilityState;
    window.requestAnimationFrame = window.__raf;
    for (const f of window.__rafHeld.splice(0)) f(performance.now());
  });
  check('the next frame draws what came meanwhile', (await page.locator('.thread > .post').count()) === heldBefore + 2 && (await counts(page)).panes === 0, `${heldBefore} → ${await page.locator('.thread > .post').count()}`);

  // a reply posted in thread 1 (not watched): it is watched, and its Watch
  // button and the sidebar say so at once
  const watchBtn = page.locator('[data-key="p1-thread-watch"]');
  check('thread 1 is not watched yet', (await watchBtn.getAttribute('aria-pressed')) === 'false' && (await page.locator('[data-key="watched-g-500010"]').count()) === 0);
  await page.evaluate(() => window.__ceDebug.posted({ board: 'g', thread: 500010, no: 999999999 }));
  check(
    'posted: its Watch button says Watching, the sidebar lists it',
    (await watchBtn.getAttribute('aria-pressed')) === 'true' && (await page.locator('[data-key="watched-g-500010"]').count()) === 1,
    `${await watchBtn.getAttribute('aria-pressed')} / ${await page.locator('[data-key="watched-g-500010"]').count()}`,
  );

  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no outside request', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------------------- added in place = drawn anew
// A thread's new posts added in place (browse.js updateThreadView) give the
// same thread as a pane drawn anew: reply links on the quoted post, ID
// counts, the "new" marks, open quote copies, a highlighted ID. Compared
// as HTML without the pop-in motion classes and with class lists sorted.
{
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }]));
  const { ctx, page, errors, outside } = await open(BASE_SETTINGS, '?mock-delay=0&mock-grow&mock-big=60', `#panes=${panes}`);
  await page.waitForFunction(() => document.querySelector('.thread') && document.querySelector('.catalog'));
  await page.clock.runFor(1000);
  const p1 = '[data-pane="1"]';
  const html = () =>
    page.evaluate((sel) => {
      const t = document.querySelector(`${sel} .thread`).cloneNode(true);
      for (const el of [t, ...t.querySelectorAll('*')]) {
        el.classList.remove('appear', 'appear--new', 'appear--you', 'post--flash');
        el.style?.removeProperty('--appear-delay');
        if (el.getAttribute('style') === '') el.removeAttribute('style');
        if (el.getAttribute('class') !== null) {
          const sorted = [...el.classList].sort().join(' ');
          if (sorted) el.setAttribute('class', sorted);
          else el.removeAttribute('class');
        }
      }
      return t.outerHTML;
    }, p1);
  const compare = async (label) => {
    const patched = await html();
    await page.evaluate(() => window.__ceDebug.renderPane(1));
    const fresh = await html();
    let at = 0;
    while (at < patched.length && patched[at] === fresh[at]) at++;
    check(label, patched === fresh, patched === fresh ? `${patched.length} chars` : `differs at ${at}: …${patched.slice(Math.max(0, at - 80), at + 80)}… vs …${fresh.slice(Math.max(0, at - 80), at + 80)}…`);
  };
  // an inline quote copy and a reply-link copy open
  await page.locator(`${p1} .thread > .post .post__com .seg-quotelink[aria-expanded="false"]`).first().evaluate((el) => el.click());
  await page.locator(`${p1} .thread > .post .post__backlinks .seg-quotelink[aria-expanded="false"]`).first().evaluate((el) => el.click());
  // and a copy of the post the first new reply quotes (No. 600010): it gets
  // a new reply link, so it is drawn again in place
  const quotedLink = page.locator(`${p1} .thread > .post .seg-quotelink[data-target="600010"][aria-expanded="false"]`).first();
  const quotedOpen = (await quotedLink.count()) === 1;
  if (quotedOpen) await quotedLink.evaluate((el) => el.click());
  check('a copy of the post the next reply quotes is open', quotedOpen && (await page.locator(`${p1} .quote-inline > .post--copy[data-inline-no="600010"]`).count()) >= 1);
  const copies = await page.locator(`${p1} .quote-inline`).count();
  check('three quote copies open', copies >= 3, String(copies));
  const quotedNo = await page.evaluate((sel) => {
    const last = [...document.querySelectorAll(`${sel} .thread > .post`)].pop();
    return Number(last.dataset.no);
  }, p1);
  for (let round = 1; round <= 2; round++) {
    await page.evaluate((sel) => (document.querySelector(`section${sel}`).__mark = 'same'), p1);
    // each open copy, marked: one of a post that gets no new reply link
    // stays the same element (a video playing in it goes on)
    await page.evaluate((sel) => {
      for (const box of document.querySelectorAll(`${sel} .quote-inline`)) box.__kept = true;
    }, p1);
    await resetCounts(page);
    const before = await page.locator(`${p1} .thread > .post`).count();
    // round 1: the focus on a reply link of the post the new one quotes
    // (the mock's first new reply quotes its first big reply, No. 600010)
    const focusedKey =
      round === 1
        ? await page.evaluate((sel) => {
            const b = document.querySelector(`${sel} .thread > .post[data-no="600010"] > .post__backlinks .seg-quotelink`);
            b?.focus();
            return document.activeElement === b ? b.dataset.key : null;
          }, p1)
        : null;
    await page.clock.runFor(11_000);
    const c = await counts(page);
    const same = await page.evaluate((sel) => document.querySelector(`section${sel}`).__mark === 'same', p1);
    check(`round ${round}: the new post added in place`, same && c.panes === 0 && c.full === 0 && (await page.locator(`${p1} .thread > .post`).count()) === before + 1, JSON.stringify(c));
    if (round === 1) check('the reply link that had the focus has it again', Boolean(focusedKey) && (await page.evaluate(() => document.activeElement?.dataset.key)) === focusedKey, String(focusedKey));
    const newest = await page.evaluate((sel) => {
      const card = [...document.querySelectorAll(`${sel} .thread > .post`)].pop();
      const target = Number(card.querySelector('.post__com .seg-quotelink')?.dataset.target);
      const quoted = document.querySelector(`${sel} .thread > .post[data-no="${target}"]`);
      return { no: Number(card.dataset.no), target, back: [...(quoted?.querySelectorAll(':scope > .post__backlinks .seg-quotelink') || [])].map((b) => Number(b.dataset.target)), path: Boolean(card.querySelector('.seg-quotelink[data-quote-path]')) };
    }, p1);
    check(`round ${round}: the post it quotes has its reply link, wired`, newest.no > quotedNo && newest.back.includes(newest.no) && newest.path, JSON.stringify(newest));
    check(`round ${round}: the quote copies are open again`, (await page.locator(`${p1} .quote-inline`).count()) === copies);
    const kept = await page.evaluate(
      ([sel, target]) => {
        const boxes = [...document.querySelectorAll(`${sel} .quote-inline`)];
        // a copy of the quoted post (or one inside it) is drawn again, with its new reply link
        const redrawn = (box) => Boolean(box.closest(`.quote-inline:has(> .post--copy[data-inline-no="${target}"])`));
        return { untouched: boxes.filter((b) => !redrawn(b)).length, same: boxes.filter((b) => !redrawn(b) && b.__kept).length };
      },
      [p1, newest.target],
    );
    check(`round ${round}: open copies of untouched posts are the same elements`, kept.untouched >= 1 && kept.same === kept.untouched, JSON.stringify(kept));
    await compare(`round ${round}: the same thread as a pane drawn anew`);
    // round 2: with a poster's posts highlighted
    if (round === 1) await page.locator(`${p1} .thread > .post .post__id`).first().evaluate((el) => el.click());
  }
  check('the highlighted ID is on the newest post too', (await page.locator(`${p1} .thread > .post.post--id-hl`).count()) >= 2);
  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no outside request', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------------------- spoilers in the catalog
{
  const { ctx, page, errors } = await open(BASE_SETTINGS, '?mock-delay=0', `#panes=${encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }]))}`);
  await page.waitForSelector('.catalog');
  const r = await page.evaluate(() => {
    const spoiler = document.querySelector('.catalog-card__title .seg-spoiler, .catalog-card__text .seg-spoiler');
    return { n: document.querySelectorAll('.catalog-card .seg-spoiler').length, hidden: spoiler ? getComputedStyle(spoiler).color === 'rgba(0, 0, 0, 0)' : null };
  });
  check('spoiler text on a card is drawn hidden', r.n >= 1 && r.hidden === true, JSON.stringify(r));
  check('the cards in sight are drawn', await page.evaluate(() => [...document.querySelectorAll('.catalog-card__title')].slice(0, 4).every((t) => t.getBoundingClientRect().height > 0)));

  // a catalog that comes back changed is redrawn at the same card (cards
  // out of sight have an estimated size)
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.clock.runFor(100);
  const firstCard = () =>
    page.evaluate(() => {
      const b = document.querySelector('[data-pane="0"] .centre__body');
      const top = b.getBoundingClientRect().top;
      const items = [...b.querySelectorAll('.catalog > .catalog__item')];
      const i = items.findIndex((x) => x.getBoundingClientRect().bottom > top);
      return { i, at: Math.round(items[i].getBoundingClientRect().top - top), y: b.scrollTop, max: b.scrollHeight - b.clientHeight };
    });
  await page.evaluate(() => {
    const b = document.querySelector('[data-pane="0"] .centre__body');
    b.scrollTop = b.scrollHeight - b.clientHeight - 40;
  });
  // (real frames: the cards come into sight at their real size)
  await page.waitForTimeout(300);
  // the mock's catalog moves with the clock: in 90 s it has news
  await page.clock.runFor(90_000);
  const before = await firstCard();
  await resetCounts(page);
  await page.locator('[data-key="catalog-refresh"]').evaluate((el) => el.click());
  // drawn in the next frame; the real frames that follow lay the cards out
  // (the fake clock's frames are not real ones)
  await page.clock.runFor(20);
  await page.waitForTimeout(300);
  await page.clock.runFor(200);
  const after = await firstCard();
  const rc = await counts(page);
  check('Refresh: the catalog pane alone is redrawn', rc.full === 0 && rc.panes === 1, JSON.stringify(rc));
  check('at the same card, at the same place', before.y > 0 && before.i === after.i && Math.abs(before.at - after.at) <= 2, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------- the watcher (main window)
{
  const watched = [{ board: 'g', no: 500055, title: 'Watched', seen: 0 }];
  const { ctx, page, errors } = await open({ ...BASE_SETTINGS, watched }, '?mock-delay=0');
  await page.waitForSelector('nav.rail');
  await page.clock.runFor(3000);
  const badge = page.locator('[data-key="watched-g-500055"] [data-unread-badge]');
  check('the watcher gives a watched thread its unread badge', (await badge.count()) === 1 && Number(await badge.textContent()) > 0, String(await badge.count()));
  await resetCounts(page);
  await page.clock.runFor(65_000);
  check('watched thread with nothing new: no redraw', (await counts(page)).full === 0, JSON.stringify(await counts(page)));
  check('no console errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------- the sidebar's edge; a tag page
// A drag whose capture is lost ends like one let go: later full redraws
// happen. A tag page's Refresh shows "Still loading" at once, then what
// came, even when the catalog came back the same.
{
  const settings = { ...BASE_SETTINGS, tags: [{ id: 'tx', name: 'Tx', terms: ['the'], board: 'g' }] };
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'tag', id: 'tx' }, { kind: 'board', board: 'g' }]));
  const { ctx, page, errors, outside } = await open(settings, '?mock-delay=0', `#panes=${panes}`);
  await page.waitForFunction(() => document.querySelector('.tag-page') && document.querySelector('.catalog'));
  await page.clock.runFor(1000);

  const grip = page.locator('.rail__grip');
  const box = await grip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  check('a drag on the sidebar edge', await page.evaluate(() => document.getElementById('shell').classList.contains('shell--resizing')));
  await grip.dispatchEvent('lostpointercapture');
  check('its capture lost: the drag is over', !(await page.evaluate(() => document.getElementById('shell').classList.contains('shell--resizing'))));
  await page.mouse.up();
  await resetCounts(page);
  await page.evaluate(() => window.__ceDebug.render());
  check('a full redraw after it happens', (await counts(page)).full === 1, JSON.stringify(await counts(page)));
  // a redraw asked for during a real drag waits for its end
  const box2 = await grip.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + 40);
  await page.mouse.down();
  await resetCounts(page);
  await page.evaluate(() => window.__ceDebug.render());
  check('during a drag a full redraw waits', (await counts(page)).full === 0, JSON.stringify(await counts(page)));
  await page.mouse.up();
  check('and comes at its end', (await counts(page)).full === 1, JSON.stringify(await counts(page)));

  const stateLine = () => page.evaluate(() => document.querySelector('[data-pane="0"] .tag-page .state-line')?.textContent || '');
  check('the tag page has loaded', !/Still loading/.test(await stateLine()), await stateLine());
  const during = await page.evaluate(() => {
    document.querySelector('[data-key="p0-tagpage-refresh"]').click();
    return document.querySelector('[data-pane="0"] .tag-page .state-line')?.textContent || '';
  });
  check('Refresh on a tag page: "Still loading" at once', /Still loading: 1/.test(during), during);
  await page.clock.runFor(500);
  check('then what came, the same catalog or not', !/Still loading/.test(await stateLine()), await stateLine());

  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no outside request', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------------------- widths and themes
// Each width and theme: no sideways scroll; panes open (forward), go back,
// open beside and close, with their motion; the reply form opens; typing in
// the catalog's search keeps the focus and the caret; no console errors.
for (const theme of ['dark', 'light']) {
  for (const width of [360, 390, 1280]) {
    const at = `${theme} ${width}px`;
    const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }]));
    const { ctx, page, errors, outside } = await open({ ...BASE_SETTINGS, theme }, '?mock-delay=0', `#panes=${panes}`, { width, height: 760 });
    await page.waitForSelector('#shell:not([hidden]) section[data-pane]');
    await page.clock.runFor(3000);
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${at}: no sideways scroll`, (await over()) <= 0, String(await over()));
    const narrow = width < 900;
    // the catalog in front (a narrow window shows one pane: its tab)
    if (narrow) await page.locator('[data-key="pane-tab-0"]').click();
    await page.waitForSelector('[data-pane="0"] .catalog-card');
    // typing in the search: every key redraws the catalog pane
    const search = page.locator('[data-key="catalog-search"]');
    await search.click();
    await search.pressSequentially('abc');
    await search.evaluate((el) => el.setSelectionRange(1, 1));
    await page.keyboard.type('x');
    check(
      `${at}: typing in the search keeps the focus and the caret`,
      await page.evaluate(() => {
        const el = document.activeElement;
        return el?.dataset.key === 'catalog-search' && el.value === 'axbc' && el.selectionStart === 2;
      }),
    );
    await search.fill('');
    await page.waitForSelector('[data-pane="0"] .catalog-card');
    // forward: a thread opens in the pane, sliding in
    await page.locator('[data-pane="0"] .catalog-card').nth(2).click();
    check(`${at}: a thread opens with its motion`, (await page.locator('[data-pane="0"].pane--forward').count()) === 1);
    await page.waitForSelector('[data-pane="0"] .thread .post');
    // back: the catalog again, sliding back
    await page.locator('[data-key="back-catalog"]').click();
    check(`${at}: back to the catalog with its motion`, (await page.locator('[data-pane="0"].pane--back').count()) === 1);
    await page.waitForSelector('[data-pane="0"] .catalog-card');
    // and forward again (Alt+→)
    await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.keyboard.press('Alt+ArrowRight');
    await page.clock.runFor(50);
    check(`${at}: forward again to the thread`, (await page.locator('[data-pane="0"] .thread').count()) === 1 && (await page.locator('[data-pane="0"].pane--forward').count()) === 1);
    await page.keyboard.press('Alt+ArrowLeft');
    await page.clock.runFor(50);
    await page.waitForSelector('[data-pane="0"] .catalog-card');
    // a pane beside: comes in, then closes (fading out)
    const before = await page.locator('section[data-pane]').count();
    const tabsBefore = await page.locator('[data-key^="pane-tab-"]').count();
    await page.locator('[data-pane="0"] .catalog__item [data-key^="beside-"]').first().click();
    await page.clock.runFor(50);
    const opened = narrow ? (await page.locator('[data-key^="pane-tab-"]').count()) === tabsBefore + 1 : (await page.locator('section[data-pane]').count()) === before + 1 && (await page.locator('section.pane--enter').count()) === 1;
    check(`${at}: a pane opens beside${narrow ? ' (a new tab)' : ', coming in'}`, opened, `${before} → ${await page.locator('section[data-pane]').count()}`);
    // the new pane: the one coming in (a narrow window shows it alone)
    const idx = Number(await page.locator(narrow ? 'section[data-pane]' : 'section.pane--enter').first().getAttribute('data-pane'));
    check(`${at}: the new pane has the focus`, idx > 0 && (narrow || (await page.locator(`section[data-pane="${idx}"]`).getAttribute('aria-current')) === 'true'), String(idx));
    await page.locator(`[data-key="p${idx}-pane-close"]`).click();
    if (!narrow) check(`${at}: closing fades the pane out`, (await page.locator('section.pane--closing').count()) === 1);
    await page.clock.runFor(1000);
    const after = narrow ? await page.locator('[data-key^="pane-tab-"]').count() : await page.locator('section[data-pane]').count();
    check(`${at}: and it is gone`, after === (narrow ? tabsBefore : before), String(after));
    // the reply form opens on the thread
    if (narrow) await page.locator('[data-key="pane-tab-1"]').click();
    await page.locator('[data-key="p1-thread-reply"]').click();
    await page.waitForSelector('.composer');
    check(`${at}: the reply form opens`, await page.locator('.composer').isVisible());
    check(`${at}: still no sideways scroll`, (await over()) <= 0, String(await over()));
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/redraw-${theme}-${width}.png` });
    check(`${at}: no console errors, no outside request`, errors.length === 0 && outside.length === 0, [...errors, ...outside].join(' | '));
    await ctx.close();
  }
}

// ------------------------------------------------- how long redraws take
// Real clock: long tasks (over 50 ms) while two threads update themselves,
// small (the sample) and big (?mock-big=400), and how long one pane drawn
// anew takes at that size. Reported as they are.
const info = [];
if (!process.argv.includes('--no-perf')) {
  for (const [label, extra] of [['small', ''], ['big 400', '&mock-big=400']]) {
    const panes = encodeURIComponent(JSON.stringify([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }]));
    const { ctx, page, errors } = await open(BASE_SETTINGS, `?mock-delay=0&mock-grow${extra}`, `#panes=${panes}`, { width: 1920, height: 1080 }, { clock: false });
    await page.waitForFunction(() => document.querySelectorAll('.thread').length === 2 && document.querySelector('.catalog'), null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      window.__lt = [];
      new PerformanceObserver((l) => window.__lt.push(...l.getEntries().map((e) => Math.round(e.duration)))).observe({ type: 'longtask' });
      for (const b of document.querySelectorAll('.centre__body')) b.scrollTop = (b.scrollHeight - b.clientHeight) / 2;
    });
    await resetCounts(page);
    await page.waitForTimeout(22_000);
    const lt = await page.evaluate(() => window.__lt);
    const c = await counts(page);
    const posts = await page.locator('.thread > .post').count();
    // one thread pane drawn anew (and laid out), median of three
    const fresh = await page.evaluate(async () => {
      const t = [];
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        window.__ceDebug.renderPane(1);
        void document.body.offsetHeight;
        t.push(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 100));
      }
      return Math.round(t.sort((a, b) => a - b)[1]);
    });
    info.push(`INFO ${label}: ${posts} posts; 22 s: ${c.full} full redraws, ${c.panes} pane redraws, ${c.rail} sidebar redraws; long tasks ${lt.length}${lt.length ? ` (max ${Math.max(...lt)} ms, ${lt.join(', ')})` : ''}; one thread pane drawn anew: ${fresh} ms`);
    check(`${label}: no full redraw, no console errors`, c.full === 0 && errors.length === 0, [JSON.stringify(c), ...errors].join(' | '));
    await ctx.close();
  }
}

await browser.close();
console.log([...results, ...info].join('\n'));
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
