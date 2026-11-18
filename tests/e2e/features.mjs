// The reply keys and buttons (shell.js, browse.js, compose.js), with the
// mock bridge: R opens the reply form of the thread shown (or a new thread
// on the board shown) and never while typing; right-click (or Shift+F10)
// on Reply / New thread opens the pre-written posts (pasta-view.js), whose
// pick goes into the form; the form's own Pre-written posts button works by
// keyboard; the clover on Update / Refresh spins for a manual update (a
// click, F5) and never for polling. Then the reply form with that button
// at 360, 390 and 1280 px in both themes (no page scroll sideways). Then
// the pastas panel's grid (columns, the arrow keys by column, P, Enter, the
// tag chips), New pasta, Save as pasta from the form and a post's menu, the
// caps, and the panel at 360, 390 and 1280 px in both themes. Then
// the thread in columns (columns.js): the toggle and L, the wheel and keys
// sideways, U, new replies in place, back to the list's place, Settings'
// default, a saved copy, and 360 / 390 / 1280 px in both themes.
// usage: SHOTS_DIR=dir node tests/e2e/features.mjs
// Playwright is not a dependency of this repo: point PLAYWRIGHT at its index.mjs.
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
import { BASE, serveUi } from './serve.mjs';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS_DIR || '';
if (OUT) mkdirSync(OUT, { recursive: true });

const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ` (${extra})` : ''}`);
  if (!cond) failures++;
}

const SETTINGS = { schema: 1, setupVersion: 3, completedAt: '2026-11-11T00:00:00.000Z', favourites: ['g'], theme: 'dark', watch: { intervalSec: 10 } };

// Counts full redraws (nav.rail torn down) and, for the clover, every
// class a refresh button ever carried (it is drawn anew on updates).
function probe(settings) {
  try {
    localStorage.setItem('clovereye.settings', JSON.stringify(settings));
  } catch {}
  const c = (window.__rb = { full: 0, panes: 0, clover: [] });
  const note = (el) => {
    if (el?.nodeType === 1 && /refresh$/.test(el.dataset?.key || '') && /clover-(anim|done)/.test(el.className)) c.clover.push(`${el.dataset.key}:${el.className.match(/clover-(anim|done)/)[0]}`);
  };
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') note(m.target);
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        note(n);
        for (const b of n.querySelectorAll?.('[data-key$="refresh"]') || []) note(b);
      }
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('nav.rail')) c.full++;
        else if (n.matches('section[data-pane]')) c.panes++;
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

const browser = await pw.chromium.launch();

async function open(hash, { viewport = { width: 1280, height: 800 }, settings = SETTINGS, query = 'mock-delay=0' } = {}) {
  const ctx = await browser.newContext({ viewport });
  const outside = await serveUi(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(probe, settings);
  await page.goto(`${BASE}index.html?${query}${hash}`);
  return { ctx, page, outside, errors };
}

const panesHash = (list) => `#panes=${encodeURIComponent(JSON.stringify(list))}`;
const settle = (page, ms = 150) => page.waitForTimeout(ms);
const active = (page) => page.evaluate(() => document.activeElement?.dataset?.key || document.activeElement?.tagName || '');
const composerLabel = (page) => page.evaluate(() => document.querySelector('.composer')?.getAttribute('aria-label') || '');
const comValue = (page) => page.evaluate(() => document.querySelector('[data-key="compose-com"]')?.value ?? null);
const hScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1);
const toastText = (page) => page.evaluate(() => (document.getElementById('toast')?.hasAttribute('data-show') ? document.getElementById('toast').textContent : ''));
const pastasOpen = (page) => page.locator('.pastas').count().then((n) => n === 1);
/** Something in the pane to put the focus on that is not a field. */
const focusPane = (page) => page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });

// ------------------------------------------------------------ R on a thread
{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  check('Reply says its key in its title', (await page.getAttribute('[data-key="thread-reply"]', 'title')) === 'Reply (R)');
  check('Reply says right-click opens the pre-written posts', /Shift\+F10/.test((await page.getAttribute('[data-key="thread-reply"]', 'aria-description')) || ''));
  await focusPane(page);
  await page.keyboard.press('r');
  await page.waitForSelector('.composer');
  await settle(page);
  check('R on a thread opens its reply form', (await composerLabel(page)) === 'Reply to No. 500010', await composerLabel(page));
  check('R puts the focus in the comment', (await active(page)) === 'compose-com', await active(page));
  check('R typed nothing into the comment', (await comValue(page)) === '');
  await page.keyboard.type('right');
  check('R while typing in the form is just a letter', (await comValue(page)) === 'right' && (await page.locator('.composer').count()) === 1, await comValue(page));
  // the focus away from the form; R again: the same form, its comment focused
  await focusPane(page);
  check('the focus left the form', (await active(page)) !== 'compose-com');
  await page.keyboard.press('Shift+R');
  await settle(page);
  check('Shift+R on the thread again: the same form, the comment focused', (await active(page)) === 'compose-com' && (await comValue(page)) === 'right' && (await page.locator('.composer').count()) === 1);

  // right-click Reply: the pre-written posts
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas');
  check('right-click on Reply opens the pre-written posts', await pastasOpen(page));
  check('its search box has the focus', (await active(page)) === 'pastas-search');
  const all = await page.locator('.pastas .pastas__pick').count();
  await page.keyboard.type('gentoo');
  await settle(page, 200);
  const rows = await page.locator('.pastas .pastas__pick').count();
  check('the search filters the list', rows >= 1 && rows < all, `${rows} of ${all}`);
  check('R in the search box is typed, no form opened', (await page.locator('.pastas__search').inputValue()) === 'gentoo');
  await page.keyboard.press('Enter');
  await settle(page, 300);
  check('Enter picks: the popup closes', !(await pastasOpen(page)));
  const v = await comValue(page);
  check('the post goes into the reply’s comment, after what was there', v === 'right\nInstall Gentoo.', JSON.stringify(v));
  check('the comment has the focus after a pick', (await active(page)) === 'compose-com');

  // a pin is kept: close, open again, still pinned (and stored)
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas');
  const pin = page.locator('.pastas [data-pasta-id="arch-btw"] .pastas__pin').first();
  await pin.click();
  await settle(page);
  check('a pin is pressed', (await page.locator('.pastas [data-pasta-id="arch-btw"] .pastas__pin').first().getAttribute('aria-pressed')) === 'true');
  await page.keyboard.press('Escape');
  await settle(page);
  check('Escape closes the popup', !(await pastasOpen(page)));
  check('Escape gives the focus back to Reply', (await active(page)) === 'thread-reply');
  check('the reply form stays open after Escape in the popup', (await page.locator('.composer').count()) === 1);
  // the ContextMenu key's twin, Shift+F10, on the focused Reply button
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('.pastas');
  check('Shift+F10 on Reply opens the popup', await pastasOpen(page));
  const pinnedIds = await page.$$eval('.pastas .pastas__rows', (uls) => (uls[0] ? [...uls[0].querySelectorAll('[data-pasta-id]')].map((r) => r.dataset.pastaId) : []));
  check('the pin is still there when opened again', pinnedIds.includes('arch-btw'), pinnedIds.join(','));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200); // the grouped save
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings') || '{}').pastas?.pinned || []);
  check('the pin is saved with the settings', stored.includes('arch-btw'), stored.join(','));

  // the form's own button, by keyboard
  await page.locator('[data-key="compose-pastas"]').focus();
  check('the form has a Pre-written posts button', (await page.getAttribute('[data-key="compose-pastas"]', 'aria-label')) === 'Pre-written posts');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pastas');
  check('Enter on it opens the popup', await pastasOpen(page));
  await page.keyboard.type('checked');
  await settle(page, 200);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settle(page, 300);
  const v2 = await comValue(page);
  check('a pick from the form’s button goes into that form', v2.startsWith('right\nInstall Gentoo.') && /Checked/i.test(v2) && v2.length > 'right\nInstall Gentoo.'.length, JSON.stringify(v2));

  // the clover: a click on Update spins it, then the pop, then nothing
  await page.evaluate(() => (window.__rb.clover = [], window.__rb.full = 0));
  await page.click('[data-key="thread-refresh"]');
  const spin = await page.evaluate(() => document.querySelector('[data-key="thread-refresh"]')?.className || '');
  check('Update spins the clover when clicked', /clover-anim/.test(spin) || (await page.evaluate(() => window.__rb.clover.some((x) => x.endsWith('clover-anim')))), spin);
  check('Update draws the clover icon', (await page.locator('[data-key="thread-refresh"] svg.icon--clover').count()) === 1);
  check('Update keeps its label and title', ((await page.textContent('[data-key="thread-refresh"]')) || '').trim() === 'Update' && /F5/.test((await page.getAttribute('[data-key="thread-refresh"]', 'title')) || ''));
  await page.waitForTimeout(1300);
  const after = await page.evaluate(() => ({ seen: window.__rb.clover.slice(), cls: document.querySelector('[data-key="thread-refresh"]')?.className || '' }));
  check('the spin ends with the pop', after.seen.some((x) => x.endsWith('clover-done')), after.seen.join(','));
  check('and then the button is back at rest', !/clover-/.test(after.cls), after.cls);
  check('a manual update redraws no window', (await page.evaluate(() => window.__rb.full)) === 0);

  // F5 spins it too (the focus off the form)
  await focusPane(page);
  await page.evaluate(() => (window.__rb.clover = []));
  await page.waitForTimeout(200);
  await page.keyboard.press('F5');
  await settle(page, 100);
  const f5 = await page.evaluate(() => window.__rb.clover.slice());
  check('F5 spins the clover', f5.some((x) => x === 'thread-refresh:clover-anim'), f5.join(','));
  await page.waitForTimeout(1300);
  const f5b = await page.evaluate(() => ({ seen: window.__rb.clover.slice(), cls: document.querySelector('[data-key="thread-refresh"]')?.className || '' }));
  check('F5’s spin ends with the pop and stops', f5b.seen.includes('thread-refresh:clover-done') && !/clover-/.test(f5b.cls), f5b.cls);

  check('no console errors (thread)', errors.length === 0, errors.join(' | '));
  check('no outside requests (thread)', outside.length === 0, outside.join(' '));
  await ctx.close();
}

// ------------------------------------- R on a catalog; R while typing there
{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'board', board: 'g' }]));
  await page.waitForSelector('[data-pane="0"] .catalog .catalog-card');
  await settle(page, 300);
  check('New thread says its key in its title', (await page.getAttribute('[data-key="new-thread"]', 'title')) === 'New thread (R)');
  check('Refresh draws the clover icon', (await page.locator('[data-key="catalog-refresh"] svg.icon--clover').count()) === 1);
  await page.locator('[data-key="catalog-search"]').focus();
  await page.keyboard.press('r');
  await settle(page);
  check('R while typing in the catalog search does nothing', (await page.locator('.composer').count()) === 0 && (await page.locator('[data-key="catalog-search"]').inputValue()) === 'r');
  await page.locator('[data-key="catalog-search"]').fill('');
  await settle(page);
  await focusPane(page);
  await page.keyboard.press('r');
  await page.waitForSelector('.composer');
  await settle(page);
  check('R on a catalog opens the new thread form', (await composerLabel(page)) === 'New thread on /g/', await composerLabel(page));
  check('R on a catalog focuses its comment', (await active(page)) === 'compose-com');
  // right-click New thread: a pick goes into the new thread's form
  await page.click('[data-key="new-thread"]', { button: 'right' });
  await page.waitForSelector('.pastas');
  check('right-click on New thread opens the pre-written posts', await pastasOpen(page));
  await page.keyboard.type('year of the linux');
  await settle(page, 200);
  await page.keyboard.press('Enter');
  await settle(page, 300);
  check('the pick goes into the new thread’s comment', (await comValue(page)) === 'This is the year of the Linux desktop.', await comValue(page));
  check('the form is still the new thread one', (await composerLabel(page)) === 'New thread on /g/');
  // Refresh by click, and a catalog fetch that takes a while (the spin lasts)
  await page.evaluate(() => (window.__rb.clover = []));
  await page.click('[data-key="catalog-refresh"]');
  await settle(page, 50);
  check('Refresh spins the clover when clicked', (await page.evaluate(() => window.__rb.clover.slice())).includes('catalog-refresh:clover-anim'));
  await page.waitForTimeout(1300);
  const done = await page.evaluate(() => ({ seen: window.__rb.clover.slice(), cls: document.querySelector('[data-key="catalog-refresh"]')?.className || '' }));
  check('Refresh’s spin ends with the pop and stops', done.seen.includes('catalog-refresh:clover-done') && !/clover-/.test(done.cls), done.seen.join(','));
  check('no console errors (catalog)', errors.length === 0, errors.join(' | '));
  check('no outside requests (catalog)', outside.length === 0, outside.join(' '));
  await ctx.close();
}

// ------------------------------------------- a closed thread: R says why
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500001 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  check('a closed thread has no Reply button', (await page.locator('[data-key="thread-reply"]').count()) === 0);
  await focusPane(page);
  await page.keyboard.press('r');
  await settle(page, 100);
  check('R on a closed thread opens no form', (await page.locator('.composer').count()) === 0);
  check('R on a closed thread says why', /closed/i.test(await toastText(page)), await toastText(page));
  check('no console errors (closed thread)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------ polling never spins the clover (mock-grow)
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { query: 'mock-delay=0&mock-grow' });
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  const before = await page.locator('[data-pane="0"] .thread .post').count();
  await page.evaluate(() => (window.__rb.clover = []));
  await page.waitForFunction((n) => document.querySelectorAll('[data-pane="0"] .thread .post').length > n, before, { timeout: 20000 }).catch(() => {});
  await settle(page, 300);
  const grew = (await page.locator('[data-pane="0"] .thread .post').count()) > before;
  check('the thread was polled (a new post came)', grew);
  check('polling never spins the clover', (await page.evaluate(() => window.__rb.clover.length)) === 0, await page.evaluate(() => window.__rb.clover.join(',')));
  check('no console errors (polling)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ---------------------- the form with its button at 360, 390 and 1280 px
for (const theme of ['dark', 'light']) {
  for (const width of [360, 390, 1280]) {
    const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { viewport: { width, height: width < 800 ? 780 : 800 }, settings: { ...SETTINGS, theme } });
    await page.waitForSelector('[data-pane="0"] .thread .post');
    await settle(page, 300);
    await page.locator('[data-pane="0"] .thread .post').first().click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('r');
    await page.waitForSelector('.composer [data-key="compose-pastas"]');
    await settle(page, 400);
    const box = await page.evaluate(() => {
      const c = document.querySelector('.composer').getBoundingClientRect();
      const b = document.querySelector('[data-key="compose-pastas"]').getBoundingClientRect();
      const post = document.querySelector('[data-key="compose-submit"]').getBoundingClientRect();
      const W = document.documentElement.clientWidth;
      return { inside: c.left >= 0 && c.right <= W + 0.5, btn: b.left >= c.left - 0.5 && b.right <= c.right + 0.5 && b.width > 0, post: post.right <= c.right + 0.5 && post.width > 0 };
    });
    const tag = `${width} ${theme}`;
    check(`${tag}: the reply form fits the window`, box.inside);
    check(`${tag}: its Pre-written posts button is inside it`, box.btn);
    check(`${tag}: Post is inside it`, box.post);
    check(`${tag}: no page scroll sideways`, !(await hScroll(page)));
    await page.click('[data-key="compose-pastas"]');
    await page.waitForSelector('.pastas');
    await settle(page, 250);
    const pop = await page.evaluate(() => {
      const r = document.querySelector('.pastas').getBoundingClientRect();
      return r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5;
    });
    check(`${tag}: the popup from the form fits the window`, pop);
    check(`${tag}: no page scroll sideways with the popup`, !(await hScroll(page)));
    if (OUT) await page.screenshot({ path: `${OUT}/features-${width}-${theme}.png` });
    await page.keyboard.press('Escape');
    check(`${tag}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${tag}: no outside requests`, outside.length === 0, outside.join(' '));
    await ctx.close();
  }
}

// ---------------------- fixes from the review: pins, drafts, the form's foot
// A pin is no reason to rebuild a thread pane: the next new post is added
// in place (shell.js growPane, setup-model.js onlyWatchedOrPastasDiffer).
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { query: 'mock-delay=0&mock-grow' });
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas');
  await page.locator('.pastas [data-pasta-id="arch-btw"] .pastas__pin').first().click();
  await settle(page);
  await page.keyboard.press('Escape');
  // the grouped save (800 ms) goes out before counting
  await settle(page, 1500);
  const before = await page.locator('[data-pane="0"] .thread .post').count();
  await page.evaluate(() => Object.assign(window.__rb, { full: 0, panes: 0 }));
  await page.waitForFunction((n) => document.querySelectorAll('[data-pane="0"] .thread .post').length > n, before, { timeout: 25000 }).catch(() => {});
  await settle(page, 300);
  const grew = (await page.locator('[data-pane="0"] .thread .post').count()) > before;
  const c = await page.evaluate(() => ({ ...window.__rb }));
  check('pin: a new post came after the pin', grew);
  check('pin: the post after a pin is added in place (no pane rebuilt)', grew && c.panes === 0 && c.full === 0, JSON.stringify({ panes: c.panes, full: c.full }));
  check('no console errors (pin, growth)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// Text typed in the popup's own-post editor is not lost to Escape, a click
// outside or the popup closing; Cancel drops it (pasta-view.js ownDraft).
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  const openPop = async () => {
    await page.click('[data-key="thread-reply"]', { button: 'right' });
    await page.waitForSelector('.pastas');
  };
  const text = '[data-key="pastas-own-text"]';
  await openPop();
  await page.click('[data-key="pastas-new"]');
  await page.fill(text, 'A long post I wrote by hand');
  await page.keyboard.press('Escape');
  await settle(page);
  check('draft: Escape in the editor closes the editor, not the popup', (await page.locator(text).count()) === 0 && (await pastasOpen(page)));
  await page.click('[data-key="pastas-new"]');
  check('draft: New post brings the text back after Escape', (await page.locator(text).inputValue()) === 'A long post I wrote by hand');
  await page.fill(text, 'A second try');
  await page.mouse.click(5, 790);
  await settle(page);
  check('draft: a click outside closes the popup', !(await pastasOpen(page)));
  await openPop();
  await page.click('[data-key="pastas-new"]');
  check('draft: the text is back after the popup closed', (await page.locator(text).inputValue()) === 'A second try');
  await page.click('[data-key="pastas-own-cancel"]');
  await page.click('[data-key="pastas-new"]');
  check('draft: Cancel drops it', (await page.locator(text).inputValue()) === '');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  check('no console errors (drafts)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------- the pastas grid, New pasta, Save as pasta
// The panel's cards in a grid (more than one column at 1280 px), the arrow
// keys across it by its column count, P pins, Enter inserts; New pasta
// saves under Your own; the reply form's Save as pasta and a post's menu
// Save as pasta keep the text as an own pasta (pasta-view.js).
const focusedCard = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const c = a?.closest?.('.pastas__card');
    return c ? { row: Number(c.querySelector('.pastas__pick').dataset.row), id: c.dataset.pastaId, pick: a.classList.contains('pastas__pick') } : null;
  });
const gridCols = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.pastas .pastas__grid')).gridTemplateColumns.trim().split(/\s+/).length);
const storedOwn = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings') || '{}').pastas?.own || []);
const sectionIds = (page, key) =>
  page.evaluate((k) => {
    const ul = document.querySelector(`.pastas .pastas__grid[aria-labelledby$="-${k}"]`);
    return ul ? [...ul.querySelectorAll('[data-pasta-id]')].map((li) => li.dataset.pastaId) : [];
  }, key);
{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  await page.evaluate(() => (window.__rb.full = 0));
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas .pastas__card');
  await settle(page);
  const panel = await page.evaluate(() => document.querySelector('.pastas').getBoundingClientRect().width);
  check('grid: the panel is wide at 1280 px', panel >= 600 && panel <= 730, panel);
  const cols = await gridCols(page);
  check('grid: more than one column at 1280 px', cols > 1, cols);
  check('grid: sections have a heading with a count', /^Pinned\s*1$/.test(((await page.textContent('.pastas .pastas__section')) || '').replace(/\s+/g, ' ').trim()), await page.textContent('.pastas .pastas__section'));
  check('grid: the tag chips are there (All checked)', (await page.locator('.pastas [role="radio"]').count()) === 7 && (await page.getAttribute('[data-key="pastas-tag-all"]', 'aria-checked')) === 'true');
  check('grid: a greentext preview line is green', (await page.locator('.pastas .pastas__preview .pastas__green').count()) > 0);
  await page.keyboard.press('ArrowDown');
  const first = await focusedCard(page);
  check('grid: ↓ from the search goes into the grid', first?.row === 0 && first.pick, JSON.stringify(first));
  await page.keyboard.press('ArrowDown');
  const b0 = await focusedCard(page);
  check('grid: ↓ from Pinned goes to Built in at the same column', b0?.row === 1, JSON.stringify(b0));
  await page.keyboard.press('ArrowDown');
  const b1 = await focusedCard(page);
  check('grid: ↓ moves by the column count', b1?.row === 1 + cols, `${JSON.stringify(b1)} cols ${cols}`);
  await page.keyboard.press('ArrowRight');
  const b2 = await focusedCard(page);
  check('grid: → moves one card', b2?.row === 2 + cols, JSON.stringify(b2));
  await page.keyboard.press('ArrowUp');
  const b3 = await focusedCard(page);
  check('grid: ↑ moves back a row', b3?.row === 2, JSON.stringify(b3));
  check('grid: one tab stop (the focused card)', (await page.locator('.pastas .pastas__pick[tabindex="0"]').count()) === 1);
  await page.keyboard.press('End');
  const end = await focusedCard(page);
  await page.keyboard.press('Home');
  check('grid: End and Home', end?.row > 10 && (await focusedCard(page))?.row === 0, JSON.stringify(end));
  // P pins the focused card: it moves to Pinned and keeps the focus
  await page.keyboard.press('ArrowDown');
  const target = await focusedCard(page);
  await page.keyboard.press('p');
  await settle(page);
  const pinned = await sectionIds(page, 'pinned');
  const after = await focusedCard(page);
  check('grid: P pins the focused card', pinned.includes(target.id), `${target.id} in ${pinned.join(',')}`);
  check('grid: its pin button says so', (await page.getAttribute(`.pastas [data-pasta-id="${target.id}"] .pastas__pin`, 'aria-pressed')) === 'true');
  check('grid: the focus stays on that card', after?.id === target.id && after.pick, JSON.stringify(after));
  await page.keyboard.press('P');
  await settle(page);
  check('grid: P again unpins it', !(await sectionIds(page, 'pinned')).includes(target.id));
  // typing goes back to the search; the Tech chip filters
  await page.click('[data-key="pastas-tag-tech"]');
  await settle(page);
  check('grid: the Tech chip is checked', (await page.getAttribute('[data-key="pastas-tag-tech"]', 'aria-checked')) === 'true');
  const tech = await page.$$eval('.pastas .pastas__card', (cards) => cards.map((c) => [...c.querySelectorAll('.pastas__tag')].map((t) => t.textContent)));
  check('grid: the Tech chip shows only tech posts', tech.length > 0 && tech.every((t) => t.includes('Tech')), JSON.stringify(tech.slice(0, 3)));
  await page.keyboard.press('ArrowRight');
  check('grid: → on the chips moves the check along', (await page.getAttribute('[data-key="pastas-tag-own"]', 'aria-checked')) === 'true');
  check('grid: Yours with none of your own says how to write one', /New pasta/.test((await page.textContent('.pastas__empty')) || ''));
  await page.click('[data-key="pastas-tag-all"]');
  await settle(page);
  // Enter on a card inserts its text into the reply form
  await page.locator('[data-key="pastas-search"]').fill('gentoo');
  await settle(page, 200);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settle(page, 300);
  check('grid: Enter on a card closes the panel', !(await pastasOpen(page)));
  check('grid: and puts the post into the reply form', (await comValue(page)) === 'Install Gentoo.', JSON.stringify(await comValue(page)));
  // a click on a card's text inserts too
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas .pastas__card');
  await page.locator('.pastas [data-pasta-id="checked"] .pastas__preview').click();
  await settle(page, 300);
  check('grid: a click on a card picks it', !(await pastasOpen(page)) && /Checked\.$/.test((await comValue(page)) || ''), JSON.stringify(await comValue(page)));
  // the form's first open saves its post password (a full redraw, as R
  // does without any pasta); from here on, nothing pasta-related may
  await settle(page, 300);
  await page.evaluate(() => (window.__rb.full = 0));

  // New pasta in the header: saved, shown under Your own, stored
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas .pastas__card');
  check('new: the header has New pasta', ((await page.textContent('[data-key="pastas-new"]')) || '').trim() === 'New pasta');
  await page.click('[data-key="pastas-new"]');
  await page.fill('[data-key="pastas-own-title"]', 'My grid pasta');
  await page.fill('[data-key="pastas-own-text"]', '>be me\n>write a pasta');
  check('new: the counter counts', /^21 \/ 2000$/.test(((await page.textContent('.pastas__chars')) || '').trim()), await page.textContent('.pastas__chars'));
  await page.click('[data-key="pastas-own-save"]');
  await settle(page);
  const mine = await page.evaluate(() => [...document.querySelectorAll('.pastas .pastas__card--own')].map((c) => c.querySelector('.pastas__title').textContent));
  check('new: it shows under Your own', mine.includes('My grid pasta') && (await sectionIds(page, 'own')).length === 1, mine.join(','));
  check('new: its card has Edit and Delete', (await page.locator('.pastas .pastas__card--own .pastas__edit-btn').count()) === 1 && (await page.locator('.pastas .pastas__card--own .pastas__delete').count()) === 1);
  check('new: the focus is on its card', (await focusedCard(page))?.id?.startsWith('own-'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1200); // the grouped save
  check('new: it is saved with the settings', (await storedOwn(page)).some((p) => p.title === 'My grid pasta' && p.text === '>be me\n>write a pasta'));

  // the reply form's Save as pasta: off while the comment is empty
  await page.locator('[data-key="compose-com"]').fill('');
  check('form: Save as pasta is off with an empty comment', await page.isDisabled('[data-key="compose-save-pasta"]'));
  await page.locator('[data-key="compose-com"]').fill('  Saved from the form  \n>with greentext');
  check('form: Save as pasta is on with text', !(await page.isDisabled('[data-key="compose-save-pasta"]')));
  await page.click('[data-key="compose-save-pasta"]');
  await page.waitForSelector('dialog.pasta-save');
  check('form: the title prompt has the first line, trimmed', (await page.inputValue('[data-key="pasta-save-title"]')) === 'Saved from the form');
  check('form: the title has the focus', (await active(page)) === 'pasta-save-title');
  await page.keyboard.press('Enter');
  await settle(page);
  check('form: the prompt closes', (await page.locator('dialog.pasta-save').count()) === 0);
  check('form: a toast says it was saved', (await toastText(page)) === 'Saved to your pastas', await toastText(page));
  check('form: the focus is back on Save as pasta', (await active(page)) === 'compose-save-pasta');
  check('form: the comment is still there', (await comValue(page)) === '  Saved from the form  \n>with greentext');
  await page.waitForTimeout(1200);
  check('form: the pasta is saved', (await storedOwn(page)).some((p) => p.title === 'Saved from the form' && p.text === '  Saved from the form\n>with greentext'), JSON.stringify((await storedOwn(page)).map((p) => p.text)));
  // Escape in the prompt saves nothing
  await page.click('[data-key="compose-save-pasta"]');
  await page.waitForSelector('dialog.pasta-save');
  await page.keyboard.press('Escape');
  await settle(page);
  check('form: Escape in the prompt saves nothing', (await page.locator('dialog.pasta-save').count()) === 0 && (await storedOwn(page)).length === 2 && (await page.locator('.composer').count()) === 1);

  // a post's menu: Save as pasta with that post's plain text
  const no = await page.evaluate(() => {
    for (const p of document.querySelectorAll('[data-pane="0"] .thread .post')) {
      const body = p.querySelector('.post__com');
      if (body && body.textContent.trim().length > 3 && p.querySelector('.post__menu')) return p.querySelector('.post__menu').dataset.key;
    }
    return '';
  });
  check('menu: a post with text and a menu', Boolean(no), no);
  await page.click(`[data-key="${no}"]`);
  await page.waitForSelector('.menu [role="menuitem"]');
  const items = await page.$$eval('.menu [role="menuitem"]', (b) => b.map((x) => x.textContent));
  check('menu: it has Save as pasta', items.includes('Save as pasta'), items.join(' | '));
  await page.locator('.menu [role="menuitem"]', { hasText: 'Save as pasta' }).click();
  await page.waitForSelector('dialog.pasta-save');
  const title = await page.inputValue('[data-key="pasta-save-title"]');
  check('menu: the prompt has a title from its first line', title.trim().length > 0 && !/</.test(title), title);
  await page.fill('[data-key="pasta-save-title"]', 'From a post');
  await page.click('[data-key="pasta-save-ok"]');
  await settle(page);
  check('menu: a toast says it was saved', (await toastText(page)) === 'Saved to your pastas');
  check('menu: the focus is back on the post’s menu button', (await active(page)) === no, await active(page));
  await page.waitForTimeout(1200);
  const fromPost = (await storedOwn(page)).find((p) => p.title === 'From a post');
  check('menu: the post’s text is saved, without HTML', Boolean(fromPost) && fromPost.text.length > 0 && !/<[a-z]/i.test(fromPost.text) && !/&gt;|&amp;/.test(fromPost.text), JSON.stringify(fromPost));
  // it is in the panel under Your own
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas .pastas__card');
  check('menu: the panel shows all three of your own', (await sectionIds(page, 'own')).length === 3);
  await page.keyboard.press('Escape');
  check('pastas: New pasta and Save as pasta rebuild no window', (await page.evaluate(() => window.__rb.full)) === 0, await page.evaluate(() => window.__rb.full));
  check('no console errors (pastas grid)', errors.length === 0, errors.join(' | '));
  check('no outside requests (pastas grid)', outside.length === 0, outside.join(' '));
  await ctx.close();
}

// own pastas are capped: a clear message when full
{
  const own = Array.from({ length: 200 }, (_, i) => ({ id: `own-cap-${String(i).padStart(4, '0')}`, title: `Cap ${i}`, text: `cap ${i}`, at: i }));
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { settings: { ...SETTINGS, pastas: { pinned: ['bump'], own } } });
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  await focusPane(page);
  await page.keyboard.press('r');
  await page.waitForSelector('.composer');
  await page.locator('[data-key="compose-com"]').fill('one more');
  await page.click('[data-key="compose-save-pasta"]');
  await settle(page);
  check('full: no prompt when there is no room', (await page.locator('dialog.pasta-save').count()) === 0);
  check('full: a toast says to delete one first', /delete one first/.test(await toastText(page)), await toastText(page));
  await page.click('[data-key="thread-reply"]', { button: 'right' });
  await page.waitForSelector('.pastas .pastas__card');
  check('full: the panel draws at most 200 cards and says so', (await page.locator('.pastas .pastas__card').count()) === 200 && /Showing 200 of/.test((await page.textContent('.pastas__count')) || ''));
  await page.click('[data-key="pastas-new"]');
  await page.fill('[data-key="pastas-own-text"]', 'no room');
  await page.click('[data-key="pastas-own-save"]');
  check('full: New pasta says there is no room', /delete one first/.test((await page.textContent('.pastas__problem')) || ''));
  check('no console errors (pastas full)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// the panel at 360, 390 and 1280 px in both themes
for (const theme of ['dark', 'light']) {
  for (const width of [360, 390, 1280]) {
    const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), {
      viewport: { width, height: width < 800 ? 780 : 800 },
      settings: { ...SETTINGS, theme, pastas: { pinned: ['bump', 'arch-btw'], own: [{ id: 'own-shot-0001', title: 'My own pasta', text: '>be me\n>save a pasta\n>it shows up here', at: 1 }] } },
    });
    await page.waitForSelector('[data-pane="0"] .thread .post');
    await settle(page, 300);
    await page.locator('[data-pane="0"] .thread .post').first().click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('r');
    await page.waitForSelector('.composer [data-key="compose-pastas"]');
    await settle(page, 300);
    await page.click('[data-key="compose-pastas"]');
    await page.waitForSelector('.pastas .pastas__card');
    await settle(page, 300);
    const tag = `pastas ${width} ${theme}`;
    const cols = await gridCols(page);
    if (width < 480) check(`${tag}: one or two columns`, cols === 1 || cols === 2, cols);
    else check(`${tag}: more than one column`, cols > 1, cols);
    const fit = await page.evaluate(() => {
      const r = document.querySelector('.pastas').getBoundingClientRect();
      const W = document.documentElement.clientWidth;
      const cards = [...document.querySelectorAll('.pastas .pastas__card')].every((c) => {
        const b = c.getBoundingClientRect();
        return b.left >= r.left - 0.5 && b.right <= r.right + 0.5;
      });
      return { inside: r.left >= 0 && r.right <= W + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5, sheet: Math.round(r.width) === W, cards };
    });
    check(`${tag}: the panel fits the window`, fit.inside);
    if (width < 480) check(`${tag}: a full-width sheet`, fit.sheet);
    check(`${tag}: the cards stay inside the panel`, fit.cards);
    check(`${tag}: no page scroll sideways`, !(await hScroll(page)));
    if (OUT) await page.screenshot({ path: `${OUT}/pastas-${width}-${theme}.png` });
    await page.keyboard.press('Escape');
    await page.locator('[data-key="compose-com"]').fill('>keep this one\nfor later');
    await page.click('[data-key="compose-save-pasta"]');
    await page.waitForSelector('dialog.pasta-save');
    await settle(page, 400);
    const dlg = await page.evaluate(() => {
      const r = document.querySelector('dialog.pasta-save').getBoundingClientRect();
      return r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5;
    });
    check(`${tag}: the Save as pasta prompt fits`, dlg);
    if (OUT && width !== 1280) await page.screenshot({ path: `${OUT}/pastas-save-${width}-${theme}.png` });
    await page.keyboard.press('Escape');
    check(`${tag}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${tag}: no outside requests`, outside.length === 0, outside.join(' '));
    await ctx.close();
  }
}

// The reply form's foot at 360 and 390 px in the longer languages: Post
// and the Pre-written posts button stay inside the form.
for (const lang of ['es', 'pt-BR', 'ru']) {
  for (const width of [360, 390]) {
    const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { viewport: { width, height: 780 }, settings: { ...SETTINGS, lang } });
    await page.waitForSelector('[data-pane="0"] .thread .post');
    await settle(page, 300);
    await page.locator('[data-pane="0"] .thread .post').first().click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('r');
    await page.waitForSelector('.composer [data-key="compose-submit"]');
    await settle(page, 400);
    const box = await page.evaluate(() => {
      const c = document.querySelector('.composer').getBoundingClientRect();
      const inside = (sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return Boolean(r && r.width > 0 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5);
      };
      const t = document.querySelector('.composer__head > strong');
      return { post: inside('[data-key="compose-submit"]'), pastas: inside('[data-key="compose-pastas"]'), label: document.querySelector('[data-key="compose-submit"]').textContent.trim(), W: document.documentElement.clientWidth, c: [c.left, c.right], title: t.scrollWidth <= t.clientWidth + 1 && t.scrollHeight <= t.clientHeight + 1, titleText: t.textContent };
    });
    const tag = `form ${lang} ${width}`;
    check(`${tag}: Post is inside the form`, box.post, `${box.label} ${JSON.stringify(box.c)}`);
    check(`${tag}: Pre-written posts is inside the form`, box.pastas);
    check(`${tag}: the form’s title is not cut (the thread's number shows)`, box.title && /500010/.test(box.titleText), box.titleText);
    check(`${tag}: the form fits the window`, box.c[0] >= 0 && box.c[1] <= box.W + 0.5);
    check(`${tag}: no page scroll sideways`, !(await hScroll(page)));
    if (OUT) await page.screenshot({ path: `${OUT}/form-${lang}-${width}.png` });
    check(`${tag}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${tag}: no outside requests`, outside.length === 0, outside.join(' '));
    await ctx.close();
  }
}

// ------------------------------------- the thread in columns (columns.js)
// The toggle in the thread's bar (and L) switches a tab's thread between a
// list and columns read sideways; only that pane is drawn again. In
// columns: posts in more than one column at 1280 px, the wheel and the
// keys move sideways, U jumps sideways to the first unread post, new
// replies keep the post in sight in place, switching back finds the list's
// place; Settings gives new threads their layout; a saved copy has the
// toggle too; at 360 and 390 px one column as wide as the pane, with no
// page scroll sideways.
const COLS = '[data-pane="0"] .thread--columns';
const BIG = 'mock-delay=0&mock-big=60';
/** The columns box now: scroll, size, column step, the posts' columns. */
const cols = (page) =>
  page.evaluate((sel) => {
    const sc = document.querySelector(sel);
    if (!sc) return null;
    const r = sc.getBoundingClientRect();
    const posts = [...sc.querySelectorAll(':scope > [data-no]')];
    const lefts = new Set(posts.map((p) => p.offsetLeft));
    const inView = new Set(
      posts
        .map((p) => p.getClientRects()[0])
        .filter((q) => q && q.left >= r.left - 1 && q.right <= r.right + 1)
        .map((q) => Math.round(q.left)),
    );
    // the first post in sight (columns.js scrollAnchor)
    const first = posts.find((p) => p.getBoundingClientRect().right > r.left + 1);
    const cs = getComputedStyle(sc);
    return {
      x: sc.scrollLeft,
      max: sc.scrollWidth - sc.clientWidth,
      width: sc.clientWidth,
      height: sc.clientHeight,
      left: r.left,
      right: r.right,
      columns: lefts.size,
      inView: inView.size,
      firstNo: first?.dataset.no || '',
      firstLeft: first ? first.getClientRects()[0].left : 0,
      colWidth: parseFloat(cs.columnWidth),
      gap: parseFloat(cs.columnGap),
      bodyTop: sc.closest('.centre__body').scrollTop,
    };
  }, COLS);
/** The list's body: its scroll and the first post in sight. */
const listAt = (page) =>
  page.evaluate(() => {
    const body = document.querySelector('[data-pane="0"] .centre__body');
    const top = body.getBoundingClientRect().top;
    const first = [...body.querySelectorAll('.thread > [data-no]')].find((p) => p.getBoundingClientRect().bottom > top);
    return { y: body.scrollTop, firstNo: first?.dataset.no || '', offset: first ? first.getBoundingClientRect().top - top : 0 };
  });
const layoutBtn = '[data-pane="0"] [data-key="thread-layout"]';
const pressed = (page) => page.getAttribute(layoutBtn, 'aria-pressed');

{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { query: BIG });
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 600);
  check('columns: the thread’s bar has the layout toggle, off in a list', (await page.locator(layoutBtn).count()) === 1 && (await pressed(page)) === 'false');
  check('columns: its title says what it does', (await page.getAttribute(layoutBtn, 'title')) === 'Posts in columns, scroll sideways');
  check('columns: its key is L', (await page.getAttribute(layoutBtn, 'aria-keyshortcuts')) === 'L');
  await page.evaluate(() => (document.querySelector('[data-pane="0"] .centre__body').scrollTop = 2400));
  await settle(page, 300);
  // (by L: a click on the toggle would first scroll the tucked bar into sight)
  await focusPane(page);
  const list = await listAt(page);
  await page.evaluate(() => Object.assign(window.__rb, { full: 0, panes: 0 }));
  await page.keyboard.press('l');
  await page.waitForSelector(COLS);
  await settle(page, 300);
  const c = await cols(page);
  check('columns: L switches to columns, the toggle is on', (await pressed(page)) === 'true' && (await page.getAttribute(layoutBtn, 'title')) === 'Posts in a list');
  check('columns: switching redrew that pane alone', (await page.evaluate(() => window.__rb.full)) === 0);
  check('columns: the list is a region named after the thread (a keyboard stop)', (await page.getAttribute(COLS, 'role')) === 'region' && (await page.getAttribute(COLS, 'aria-label')) === 'Thread 500010');
  check('columns: posts sit in more than one column', c.columns > 1, `${c.columns} columns`);
  check('columns: at 1280 px more than one column is in sight', c.inView > 1, `${c.inView} in sight`);
  check('columns: a column is about 28rem wide', c.colWidth >= 400 && c.colWidth <= 500, String(c.colWidth));
  check('columns: the box is as high as the pane leaves it', c.height > 400 && c.height < 800, String(c.height));
  check('columns: the body does not scroll up and down', c.bodyTop === 0);
  const placed = await page.evaluate(
    ({ sel, no }) => {
      const sc = document.querySelector(sel);
      const r = sc.getBoundingClientRect();
      const q = sc.querySelector(`:scope > [data-no="${no}"]`)?.getClientRects()[0];
      return q ? q.left >= r.left - 1 && q.left < r.right : false;
    },
    { sel: COLS, no: list.firstNo },
  );
  check('columns: the post first in sight in the list is in sight in columns', placed && c.x > 0, `No. ${list.firstNo} at ${c.x}`);
  check('columns: no page scroll sideways (1280)', !(await hScroll(page)));

  // the wheel's up-down moves the columns sideways
  const box = await page.locator(COLS).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = (await cols(page)).x;
  await page.mouse.wheel(0, 200);
  await settle(page, 450);
  const wheeled = await cols(page);
  check('columns: the wheel scrolls sideways', wheeled.x > before + 100, `${before} → ${wheeled.x}`);
  check('columns: the wheel scrolled nothing up and down', wheeled.bodyTop === 0 && (await page.evaluate(() => document.scrollingElement.scrollTop)) === 0);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 200);
  await page.keyboard.up('Shift');
  await settle(page, 300);
  check('columns: Shift+wheel is left to the webview (it scrolls sideways itself)', (await cols(page)).x >= wheeled.x);

  // the keys: a column at a time, a page, either end
  await page.focus(COLS);
  await page.keyboard.press('Home');
  await settle(page, 450);
  check('columns: Home goes to the start', (await cols(page)).x === 0);
  await page.keyboard.press('ArrowRight');
  await settle(page, 450);
  const step = c.colWidth + c.gap;
  const one = (await cols(page)).x;
  check('columns: → moves one column', Math.abs(one - step) <= step * 0.2 + 2, `${one} vs step ${step}`);
  await page.keyboard.press('PageDown');
  await settle(page, 450);
  const paged = (await cols(page)).x;
  check('columns: PageDown moves the columns in sight', paged >= one + step - 2, `${one} → ${paged}`);
  await page.keyboard.press('ArrowLeft');
  await settle(page, 450);
  check('columns: ← moves back a column', (await cols(page)).x < paged);
  await page.keyboard.press('End');
  await settle(page, 450);
  const end = await cols(page);
  check('columns: End goes to the last column', Math.abs(end.x - end.max) <= 1, `${end.x} of ${end.max}`);
  check('columns: keys in the columns redrew nothing', (await page.evaluate(() => window.__rb.full)) === 0);

  // the toggle, clicked: back to a list
  await page.click(layoutBtn);
  await settle(page, 300);
  const back = await listAt(page);
  check('columns: the toggle switches back to a list', (await page.locator(COLS).count()) === 0 && (await pressed(page)) === 'false');
  check('columns: the focus stays on the toggle', (await active(page)) === 'thread-layout', await active(page));
  // (End moved the columns: the post first in sight there leads)
  check('columns: back in the list, the post first in sight in columns is at the top', Number(back.firstNo) >= Number(list.firstNo), `${list.firstNo} → ${back.firstNo}`);

  // L, twice: columns and back to the same place in the list (from the
  // middle of it: a fresh list near its end is short until its pictures
  // load, and no redraw can put it back past that end)
  await page.evaluate(() => (document.querySelector('[data-pane="0"] .centre__body').scrollTop = 3000));
  await settle(page, 300);
  await focusPane(page);
  const listNow = await listAt(page);
  await page.keyboard.press('l');
  await page.waitForSelector(COLS);
  await settle(page, 300);
  check('columns: L again: columns', (await pressed(page)) === 'true');
  await focusPane(page);
  await page.keyboard.press('L');
  await settle(page, 400);
  const again = await listAt(page);
  check(
    'columns: switched straight back, the list is where it was (the same post at the same place)',
    (await pressed(page)) === 'false' && again.firstNo === listNow.firstNo && Math.abs(again.offset - listNow.offset) <= 4,
    `No. ${listNow.firstNo} at ${Math.round(listNow.offset)} → No. ${again.firstNo} at ${Math.round(again.offset)}`,
  );
  // not while typing
  await page.keyboard.press('r');
  await page.waitForSelector('.composer');
  await settle(page);
  await page.keyboard.press('l');
  check('columns: l in the reply form is a letter, no switch', (await pressed(page)) === 'false' && (await comValue(page)) === 'l');
  check('no console errors (columns)', errors.length === 0, errors.join(' | '));
  check('no outside requests (columns)', outside.length === 0, outside.join(' '));
  await ctx.close();
}

// U: the first unread post, sideways
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010, layout: 'columns' }]), { query: BIG });
  await page.waitForSelector(COLS);
  await settle(page, 700);
  check('columns: the window’s address can carry the layout', (await pressed(page)) === 'true');
  const n0 = Number(await page.locator('[data-pane="0"] [data-unread-count]').textContent());
  // read the first columns: a column on and back
  await page.focus(COLS);
  await page.keyboard.press('ArrowRight');
  await settle(page, 400);
  await page.keyboard.press('Home');
  await settle(page, 400);
  const n = Number(await page.locator('[data-pane="0"] [data-unread-count]').textContent());
  check('columns: what is in sight counts as read, the rest is unread', n > 0 && n < n0, `${n0} → ${n}`);
  await focusPane(page);
  await page.keyboard.press('u');
  await settle(page, 700);
  const jumped = await page.evaluate((sel) => {
    const sc = document.querySelector(sel);
    const el = sc.querySelector(':scope > .post--flash');
    const r = sc.getBoundingClientRect();
    const q = el?.getClientRects()[0];
    return { x: sc.scrollLeft, no: el?.dataset.no || '', at: q ? q.left - r.left : null, top: sc.closest('.centre__body').scrollTop };
  }, COLS);
  check('columns: U scrolls sideways to the first unread post, its column first', jumped.x > 0 && jumped.at !== null && Math.abs(jumped.at) <= 2, JSON.stringify(jumped));
  check('columns: U scrolled nothing up and down', jumped.top === 0);
  const after = Number(await page.locator('[data-pane="0"] [data-unread-count]').textContent());
  check('columns: what U brought in sight is read', after < n, `${n} → ${after}`);
  check('no console errors (columns, U)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// new replies (mock-grow) keep the post in sight in place
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010, layout: 'columns' }]), { query: `${BIG}&mock-grow` });
  await page.waitForSelector(COLS);
  await settle(page, 600);
  await page.focus(COLS);
  await page.keyboard.press('ArrowRight');
  await settle(page, 400);
  await page.keyboard.press('ArrowRight');
  await settle(page, 500);
  const before = await cols(page);
  await page.evaluate((sel) => {
    document.querySelector(sel).__same = true;
    Object.assign(window.__rb, { full: 0, panes: 0 });
  }, COLS);
  const count = await page.locator(`${COLS} > [data-no]`).count();
  await page.waitForFunction(({ sel, n }) => document.querySelectorAll(`${sel} > [data-no]`).length > n, { sel: COLS, n: count }, { timeout: 25000 }).catch(() => {});
  await settle(page, 500);
  const grown = await page.evaluate(
    ({ sel, no }) => {
      const sc = document.querySelector(sel);
      const q = sc.querySelector(`:scope > [data-no="${no}"]`).getClientRects()[0];
      return { same: sc.__same === true, n: sc.querySelectorAll(':scope > [data-no]').length, left: q.left, x: sc.scrollLeft };
    },
    { sel: COLS, no: before.firstNo },
  );
  check('columns: a new reply came (polling)', grown.n > count, `${count} → ${grown.n}`);
  check('columns: added in place (the same box, no pane redrawn)', grown.same && (await page.evaluate(() => window.__rb.full + window.__rb.panes)) === 0);
  check('columns: the post in sight stayed where it was', Math.abs(grown.left - before.firstLeft) <= 2, `No. ${before.firstNo}: ${before.firstLeft} → ${grown.left} (scroll ${before.x} → ${grown.x})`);
  check('no console errors (columns, growing)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// Settings: new threads open in columns; switching one pane leaves the other
{
  const settings = { ...SETTINGS, display: { threadLayout: 'columns' } };
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'board', board: 'g' }]), { query: BIG, settings });
  await page.waitForSelector(COLS);
  await settle(page, 600);
  check('columns: Settings → Thread layout: Columns opens new threads in columns', (await pressed(page)) === 'true');
  await page.evaluate(() => {
    document.querySelector('[data-pane="1"]').__same = true;
    Object.assign(window.__rb, { full: 0, panes: 0 });
  });
  await page.click(layoutBtn);
  await settle(page, 300);
  const kept = await page.evaluate(() => ({ other: document.querySelector('[data-pane="1"]').__same === true, full: window.__rb.full, panes: window.__rb.panes }));
  check('columns: switching one pane leaves the other pane and the sidebar as they were', kept.other && kept.full === 0 && kept.panes === 1, JSON.stringify(kept));
  check('columns: the tab chose a list over the default', (await pressed(page)) === 'false');
  check('no console errors (columns, Settings default)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// Settings → Posts has the choice
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'board', board: 'g' }]));
  await page.locator('[data-key="settings"]').click();
  await page.waitForSelector('[data-key="threadlayout-columns"]');
  check('columns: Settings has Thread layout: List / Columns, List by default', (await page.isChecked('[data-key="threadlayout-list"]')) && !(await page.isChecked('[data-key="threadlayout-columns"]')));
  await page.click('[data-key="threadlayout-columns"]');
  await settle(page, 1200);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings') || '{}').display?.threadLayout);
  check('columns: choosing Columns is stored', stored === 'columns', String(stored));
  check('no console errors (columns, Settings)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// a saved copy of a thread has the toggle too
{
  const posts = Array.from({ length: 40 }, (_, i) => ({ no: 700100 + i, resto: i ? 700100 : 0, time: 1762300000 + i * 60, name: 'Anonymous', sub: i ? undefined : 'Saved thread', com: `Saved post ${i}: ${'words to fill a line '.repeat(1 + (i % 5))}` }));
  const saved = [{ board: 'g', no: 700100, title: 'Saved thread', savedAt: Date.now(), thread: { posts }, files: [], thumbs: [] }];
  const { ctx, page, errors } = await open(panesHash([{ kind: 'offline', board: 'g', no: 700100 }]), { query: 'mock-delay=0' });
  await page.evaluate((s) => localStorage.setItem('clovereye.saved', JSON.stringify(s)), saved);
  await page.reload();
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 500);
  check('columns: a saved copy has the layout toggle', (await page.locator(layoutBtn).count()) === 1);
  await page.click(layoutBtn);
  await page.waitForSelector(COLS);
  await settle(page, 300);
  const c = await cols(page);
  check('columns: a saved copy in columns', c.columns > 1, `${c.columns} columns`);
  check('no console errors (columns, saved copy)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// 360, 390 and 1280 px, both themes: the screenshots, no page scroll sideways
for (const theme of ['dark', 'light']) {
  for (const width of [360, 390, 1280]) {
    const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010, layout: 'columns' }]), { viewport: { width, height: width < 800 ? 780 : 800 }, settings: { ...SETTINGS, theme }, query: BIG });
    await page.waitForSelector(COLS);
    await settle(page, 700);
    const tag = `columns ${width} ${theme}`;
    const c = await cols(page);
    if (width < 800) {
      check(`${tag}: one column, as wide as the pane`, c.inView === 1 && c.right <= width + 0.5, JSON.stringify({ inView: c.inView, right: c.right }));
    } else check(`${tag}: several columns in sight`, c.inView > 1, String(c.inView));
    check(`${tag}: the box is the pane’s height`, c.height >= 160, String(c.height));
    check(`${tag}: no page scroll sideways`, !(await hScroll(page)));
    const box = await page.locator(COLS).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await settle(page, 450);
    const moved = await cols(page);
    check(`${tag}: the wheel pages sideways inside the box`, moved.x > c.x && !(await hScroll(page)), `${c.x} → ${moved.x}`);
    if (width < 800) {
      await page.focus(COLS);
      await page.keyboard.press('Home');
      await settle(page, 400);
      await page.keyboard.press('PageDown');
      await settle(page, 450);
      const paged = await cols(page);
      check(`${tag}: PageDown shows the next column, whole`, Math.abs(paged.x - (c.width + c.gap)) <= 2 && !(await hScroll(page)), `${paged.x} vs ${c.width + c.gap}`);
    }
    if (OUT) await page.screenshot({ path: `${OUT}/flow-${width}-${theme}.png` });
    check(`${tag}: no console errors`, errors.length === 0, errors.join(' | '));
    check(`${tag}: no outside requests`, outside.length === 0, outside.join(' '));
    await ctx.close();
  }
}

// ------------------------- review fixes: pastas panel, save prompt, log dialog
// The panel is placed again when its list changes height (a chip): opened
// above its button, it stays next to it and inside the window. The chips
// wrap on a phone-width sheet (Yours reachable with a mouse) and nothing
// clips their focus ring. The Save as pasta prompt says how much it saves.
{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  await focusPane(page);
  await page.keyboard.press('r');
  await page.waitForSelector('.composer [data-key="compose-pastas"]');
  await settle(page, 300);
  const placed = () =>
    page.evaluate(() => {
      const p = document.querySelector('.pastas').getBoundingClientRect();
      const a = document.querySelector('[data-key="compose-pastas"]').getBoundingClientRect();
      return { top: p.top, bottom: p.bottom, aTop: a.top, aBottom: a.bottom, H: innerHeight };
    });
  const nextTo = (r) => (r.bottom <= r.aTop + 0.5 ? r.aTop - r.bottom <= 16 : r.top >= r.aBottom - 0.5 ? r.top - r.aBottom <= 16 : false);
  await page.click('[data-key="compose-pastas"]');
  await page.waitForSelector('.pastas');
  await settle(page, 250);
  await page.click('[data-key="pastas-tag-own"]');
  await settle(page, 200);
  let r = await placed();
  check('pastas place: after a shorter chip it stays next to its button', nextTo(r) && r.top >= 0 && r.bottom <= r.H + 0.5, JSON.stringify(r));
  await page.keyboard.press('Escape');
  await settle(page, 200);
  await page.click('[data-key="compose-pastas"]');
  await page.waitForSelector('.pastas');
  await settle(page, 250);
  await page.click('[data-key="pastas-tag-all"]');
  await settle(page, 200);
  r = await placed();
  check('pastas place: after a taller chip it stays inside the window', r.top >= 0 && r.bottom <= r.H + 0.5 && nextTo(r), JSON.stringify(r));
  const ring = await page.evaluate(() => {
    const c = document.querySelector('.pastas__chips');
    const chip = c.querySelector('.pastas__chip').getBoundingClientRect();
    const cs = getComputedStyle(c);
    return { overflow: cs.overflowX + '/' + cs.overflowY, room: chip.top - c.getBoundingClientRect().top };
  });
  check('pastas chips: the focus ring is not clipped', ring.overflow === 'visible/visible' || ring.room >= 3, JSON.stringify(ring));
  await page.keyboard.press('Escape');
  await settle(page, 200);
  // the Save as pasta prompt: how much it saves, the box scrolls
  await page.locator('[data-key="compose-com"]').fill('>be me\n' + 'a long line that goes on and on '.repeat(5) + '\n>third\n>fourth\n>fifth\n>sixth');
  await page.click('[data-key="compose-save-pasta"]');
  await page.waitForSelector('dialog.pasta-save');
  const size = (await page.textContent('[data-key="pasta-save-size"]')) || '';
  check('save prompt: says how many lines and characters it saves', /^6 lines, \d+ characters$/.test(size), size);
  const box = await page.evaluate(() => {
    const t = document.querySelector('[data-key="pasta-save-text"]');
    return { scrolls: getComputedStyle(t).overflowY === 'auto', focusable: t.tabIndex === 0, label: Boolean(document.getElementById(t.getAttribute('aria-labelledby'))) };
  });
  check('save prompt: the text box scrolls, takes the focus and is labelled', box.scrolls && box.focusable && box.label, JSON.stringify(box));
  await page.keyboard.press('Escape');
  check('no console errors (place, prompt)', errors.length === 0, errors.join(' | '));
  check('no outside requests (place, prompt)', outside.length === 0, outside.join(' '));
  await ctx.close();
}

for (const theme of ['dark', 'light']) {
  for (const width of [360, 390]) {
    const tag = `review ${width} ${theme}`;
    const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { viewport: { width, height: 800 }, settings: { ...SETTINGS, theme } });
    await page.waitForSelector('[data-pane="0"] .thread .post');
    await settle(page, 300);
    await page.click('[data-key="thread-reply"]', { button: 'right' });
    await page.waitForSelector('.pastas');
    await settle(page, 300);
    const chips = await page.evaluate(() => {
      const panel = document.querySelector('.pastas').getBoundingClientRect();
      const own = document.querySelector('[data-key="pastas-tag-own"]').getBoundingClientRect();
      const hit = document.elementFromPoint(own.left + own.width / 2, own.top + own.height / 2);
      const all = [...document.querySelectorAll('.pastas__chip')].every((c) => {
        const b = c.getBoundingClientRect();
        return b.left >= panel.left - 0.5 && b.right <= panel.right + 0.5;
      });
      return { all, hit: hit?.dataset?.key || hit?.closest?.('[data-key]')?.dataset?.key || '' };
    });
    check(`${tag}: every chip is in the panel, Yours under the mouse`, chips.all && chips.hit === 'pastas-tag-own', JSON.stringify(chips));
    check(`${tag}: no page scroll sideways (chips)`, !(await hScroll(page)));
    if (OUT) await page.screenshot({ path: `${OUT}/review-chips-${width}-${theme}.png` });
    await page.keyboard.press('Escape');
    await ctx.close();

    // the log dialog: its actions in the window, an empty filter says so
    const s = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }]), { viewport: { width, height: 800 }, settings: { ...SETTINGS, theme } });
    await s.page.waitForSelector('[data-pane="0"] .thread .post');
    if (await s.page.locator('[data-key="rail-toggle"]').isVisible()) {
      await s.page.click('[data-key="rail-toggle"]');
      await settle(s.page, 250);
    }
    await s.page.click('[data-key="settings"]');
    await s.page.waitForSelector('[data-key="diag-show"]');
    await s.page.click('[data-key="diag-show"]');
    await s.page.waitForSelector('dialog.log-dialog .log-view');
    await settle(s.page, 400);
    const acts = await s.page.evaluate(() => {
      const a = document.querySelector('.log-dialog__actions').getBoundingClientRect();
      const body = document.querySelector('.log-dialog__body').getBoundingClientRect();
      const inside = [...document.querySelectorAll('.log-filters .input')].every((e) => e.getBoundingClientRect().right <= body.right + 0.5);
      return { bottom: inside ? a.bottom : Infinity, H: innerHeight, inside };
    });
    check(`${tag}: the log dialog's actions are in the window`, acts.bottom <= acts.H + 0.5, JSON.stringify(acts));
    await s.page.locator('[data-key="log-search"]').fill('zqxnothingmatches');
    await settle(s.page, 400);
    const empty = await s.page.evaluate(() => ({ view: document.querySelector('[data-key="log-view"]').textContent, live: document.querySelector('[data-key="log-count"]').getAttribute('aria-live') }));
    check(`${tag}: no match says so, and the count is announced`, empty.view === 'No lines match the filters.' && empty.live === 'polite', JSON.stringify(empty));
    check(`${tag}: no page scroll sideways (log dialog)`, !(await hScroll(s.page)));
    if (OUT) await s.page.screenshot({ path: `${OUT}/review-logdlg-${width}-${theme}.png` });
    check(`${tag}: no console errors`, errors.length === 0 && s.errors.length === 0, [...errors, ...s.errors].join(' | '));
    check(`${tag}: no outside requests`, outside.length === 0 && s.outside.length === 0, [...outside, ...s.outside].join(' '));
    await s.ctx.close();
  }
}

// Another window's Detailed logs switch alone redraws nothing here
// (shell.js applySettings, log-model.js onlyDiagnosticsDiffer).
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'catalog', board: 'g' }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 600);
  await page.evaluate(() => (window.__rb.full = 0));
  for (const on of [true, false, true]) {
    await page.evaluate((v) => {
      const s = JSON.parse(localStorage.getItem('clovereye.settings') || '{}');
      const next = JSON.stringify({ ...s, diagnostics: { detailed: v } });
      window.dispatchEvent(new StorageEvent('storage', { key: 'clovereye.settings', newValue: next, oldValue: JSON.stringify(s) }));
    }, on);
    await settle(page, 200);
  }
  const full = await page.evaluate(() => window.__rb.full);
  check('Detailed logs from another window: no whole-window redraw', full === 0, String(full));
  check('no console errors (detail switch)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
for (const r of results) console.log(r);
console.log(`${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
