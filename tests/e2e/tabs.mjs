// Browser-like tabs inside a pane (shell.js, tabs-model.js), with the mock
// bridge: Ctrl+click and middle click open background tabs, Ctrl+Tab and
// Ctrl+1…9 switch, Ctrl+W closes, Ctrl+Shift+T reopens, the strip's own
// keys, the 20-tab limit, a window's address with tabs, and what switching
// redraws (one pane, never the window). Then the strip at 360, 390 and
// 1280 px in both themes (no page scroll sideways; screenshots).
// usage: SHOTS_DIR=dir node tests/e2e/tabs.mjs
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

const SETTINGS = { schema: 1, setupVersion: 3, completedAt: '2026-11-11T00:00:00.000Z', favourites: ['g'], theme: 'dark' };

// Counts what the shell tears down (as tests/e2e/redraw.mjs): a full
// redraw drops nav.rail; a pane on its own drops its section.
function probe(settings) {
  try {
    localStorage.setItem('clovereye.settings', JSON.stringify(settings));
  } catch {}
  const c = (window.__rb = { full: 0, panes: 0, rail: 0, removed: [] });
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('nav.rail')) c.full++;
        else if (n.matches('section[data-pane]')) {
          c.panes++;
          c.removed.push(n.dataset.pane);
        } else if (n.matches('.rail__scroll')) c.rail++;
      }
    }
  }).observe(document, { childList: true, subtree: true });
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
const counts = (page) => page.evaluate(() => ({ full: window.__rb.full, panes: window.__rb.panes, rail: window.__rb.rail, removed: window.__rb.removed.join(',') }));
const reset = (page) => page.evaluate(() => Object.assign(window.__rb, { full: 0, panes: 0, rail: 0, removed: [] }));
const tabs = (page) => page.evaluate(() => window.__ceDebug.tabs());
const settle = (page, ms = 150) => page.waitForTimeout(ms);
const strip = (page, i) => page.locator(`section[data-pane="${i}"] > .pane-tabs`);
const hScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1);

// ------------------------------------------------ open, switch, close, reopen
{
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="0"] .catalog .catalog-card');
  await page.waitForSelector('[data-pane="1"] .thread .post');
  await settle(page, 400);
  check('one tab: no strip', (await page.locator('.pane-tabs').count()) === 0);
  await page.evaluate(() => {
    window.__pane1 = document.querySelector('section[data-pane="1"]');
  });

  // Ctrl+click a catalog card: a background tab of that pane
  await reset(page);
  const card = page.locator('[data-pane="0"] .catalog-card').nth(2);
  const cardNo = Number((await card.getAttribute('data-key')).replace(/^.*thread-/, ''));
  await card.click({ modifiers: ['Control'] });
  await settle(page);
  let t = await tabs(page);
  check('Ctrl+click a card: a second tab in that pane', t.panes[0].views.length === 2 && t.panes[0].views[1].kind === 'thread' && t.panes[0].views[1].no === cardNo, JSON.stringify(t.panes[0]));
  check('in the background: the catalog still shows', t.panes[0].active === 0 && (await page.locator('[data-pane="0"] .catalog').count()) === 1);
  check('the strip shows, as a tablist with two tabs', (await strip(page, 0).getAttribute('role')) === 'tablist' && (await strip(page, 0).locator('[role="tab"]').count()) === 2);
  check('the selected tab says so', (await strip(page, 0).locator('[role="tab"]').first().getAttribute('aria-selected')) === 'true');
  const bgTitle = (await strip(page, 0).locator('.pane-tab__text').nth(1).textContent()) || '';
  const cardTitle = ((await card.locator('.catalog-card__title').textContent()) || '').trim();
  check('the background tab is named after its thread', bgTitle.length > 0 && cardTitle.startsWith(bgTitle.replace(/…$/, '')), `${bgTitle} / ${cardTitle}`);
  let c = await counts(page);
  check('a background tab redraws nothing (the strip alone)', c.full === 0 && c.panes === 0, JSON.stringify(c));
  check('a background tab is not polled', !(await page.evaluate(() => window.__ceDebug.timers())).includes(`g/${cardNo}`));
  check('a background tab the catalog lists is not fetched (its title comes from the catalog)', !(await page.evaluate((no) => Boolean(document.querySelector(`[data-pane] .thread[aria-label="Thread ${no}"]`)), cardNo)) && (await page.evaluate((no) => window.__ceDebug.loaded?.(`g/${no}`), cardNo)) === false);
  check('the tab strip has no page scroll', !(await hScroll(page)));

  // the catalog's place, kept for when the tab comes back
  await page.locator('[data-pane="0"] .centre__body').evaluate((b) => (b.scrollTop = 600));
  await settle(page);
  const yBefore = await page.locator('[data-pane="0"] .centre__body').evaluate((b) => b.scrollTop);

  // Ctrl+Tab: the next tab of the focused pane
  await page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });
  await reset(page);
  await page.keyboard.press('Control+Tab');
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  t = await tabs(page);
  c = await counts(page);
  check('Ctrl+Tab shows the next tab', t.panes[0].active === 1 && (await page.locator('[data-pane="0"] .catalog').count()) === 0);
  // (the thread was not fetched in the background: its catalog had its
  // title; it loads now, so its pane is drawn again once it comes)
  check('switching redraws that pane alone, never the window', c.full === 0 && c.panes >= 1 && c.panes <= 2 && c.removed.split(',').every((x) => x === '0'), JSON.stringify(c));
  check('the background tab was fetched once: shown at once, no loading line', (await page.locator('[data-pane="0"] .thread .post').count()) > 0);
  check('the other pane is the same element', await page.evaluate(() => document.querySelector('section[data-pane="1"]') === window.__pane1));
  const timers = await page.evaluate(() => window.__ceDebug.timers());
  check('the tab shown is polled now', timers.includes(`g/${cardNo}`), timers.join(','));

  // Ctrl+Shift+Tab: back to the catalog, where it was scrolled
  await reset(page);
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForSelector('[data-pane="0"] .catalog');
  await settle(page, 300);
  const yAfter = await page.locator('[data-pane="0"] .centre__body').evaluate((b) => b.scrollTop);
  check('Ctrl+Shift+Tab: the tab before', (await tabs(page)).panes[0].active === 0);
  check('the catalog tab comes back where it was scrolled', Math.abs(yAfter - yBefore) < 4, `${yBefore} → ${yAfter}`);
  check('its polling stopped with it hidden', !(await page.evaluate(() => window.__ceDebug.timers())).includes(`g/${cardNo}`));
  check('again one pane redrawn', (await counts(page)).full === 0 && (await counts(page)).panes === 1);

  // Ctrl+PageDown / Ctrl+PageUp too; Ctrl+2 and Ctrl+9, Ctrl+1
  await page.keyboard.press('Control+PageDown');
  await settle(page);
  check('Ctrl+PageDown: the next tab', (await tabs(page)).panes[0].active === 1);
  await page.keyboard.press('Control+PageUp');
  await settle(page);
  check('Ctrl+PageUp: the one before', (await tabs(page)).panes[0].active === 0);
  await page.keyboard.press('Control+9');
  await settle(page);
  check('Ctrl+9: the last tab', (await tabs(page)).panes[0].active === 1);
  await page.keyboard.press('Control+1');
  await settle(page);
  check('Ctrl+1: the first', (await tabs(page)).panes[0].active === 0);

  // Ctrl+W closes the active tab; the pane shows the one left; no strip
  await reset(page);
  await page.keyboard.press('Control+w');
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page);
  t = await tabs(page);
  check('Ctrl+W closes the active tab', t.panes.length === 2 && t.panes[0].views.length === 1 && t.panes[0].views[0].no === cardNo);
  check('one tab left: the strip goes', (await strip(page, 0).count()) === 0);
  check('closing redraws that pane alone', (await counts(page)).full === 0 && (await counts(page)).removed === '0', JSON.stringify(await counts(page)));

  // Ctrl+Shift+T: back where it was, in front, with its scroll
  await page.keyboard.press('Control+Shift+T');
  await page.waitForSelector('[data-pane="0"] .catalog');
  await settle(page, 300);
  t = await tabs(page);
  check('Ctrl+Shift+T reopens the closed tab, in its place, in front', t.panes[0].views.length === 2 && t.panes[0].views[0].kind === 'board' && t.panes[0].active === 0, JSON.stringify(t.panes[0]));
  const yReopened = await page.locator('[data-pane="0"] .centre__body').evaluate((b) => b.scrollTop);
  check('and where it was scrolled', Math.abs(yReopened - yBefore) < 4, `${yBefore} → ${yReopened}`);

  // the middle button on a tab closes it
  await reset(page);
  await strip(page, 0).locator('.pane-tab').nth(1).click({ button: 'middle' });
  await settle(page);
  t = await tabs(page);
  check('a middle click on a tab closes it', t.panes[0].views.length === 1 && t.panes[0].views[0].kind === 'board', JSON.stringify(t.panes[0]));
  check('a background tab closed: no pane redrawn', (await counts(page)).panes === 0, JSON.stringify(await counts(page)));

  // a middle click on a card: a background tab; Ctrl+Shift+click: in front
  const noOf = async (n) => Number((await page.locator('[data-pane="0"] .catalog-card').nth(n).getAttribute('data-key')).replace(/^.*thread-/, ''));
  const midNo = await noOf(4);
  const frontNo = await noOf(5);
  await page.locator('[data-pane="0"] .catalog-card').nth(4).click({ button: 'middle' });
  await settle(page);
  t = await tabs(page);
  check('a middle click on a card: a background tab', t.panes[0].views.length === 2 && t.panes[0].active === 0 && t.panes[0].views[1].no === midNo);
  await page.locator('[data-pane="0"] .catalog-card').nth(5).click({ modifiers: ['Control', 'Shift'] });
  await page.waitForSelector('[data-pane="0"] .thread .post');
  t = await tabs(page);
  check('Ctrl+Shift+click: a new tab in front', t.panes[0].views.length === 3 && t.panes[0].views[t.panes[0].active].no === frontNo, JSON.stringify(t.panes[0]));
  check('tabs opened from one tab stay in the order opened', t.panes[0].views[1].no === midNo && t.panes[0].views[2].no === frontNo, JSON.stringify(t.panes[0].views));

  // the strip's keys: arrows move along, Enter shows, Delete closes
  await strip(page, 0).locator('[aria-selected="true"]').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  const focusedAt = await page.evaluate(() => [...document.activeElement.closest('.pane-tabs').querySelectorAll('[role="tab"]')].indexOf(document.activeElement));
  check('Home, then ArrowRight: the focus moves along the strip', focusedAt === 1, String(focusedAt));
  check('moving the focus shows nothing yet', (await tabs(page)).panes[0].active === 2);
  await page.keyboard.press('Enter');
  await settle(page, 300);
  check('Enter shows that tab', (await tabs(page)).panes[0].active === 1);
  check('the focus stays on the strip', await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('Home');
  await page.keyboard.press('Delete');
  await settle(page, 300);
  check('Delete closes the focused tab', (await tabs(page)).panes[0].views.length === 2);

  // Ctrl+T: a new tab on the board's catalog
  await page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });
  const before = (await tabs(page)).panes[0].views.length;
  await page.keyboard.press('Control+t');
  await page.waitForSelector('[data-pane="0"] .catalog');
  t = await tabs(page);
  check('Ctrl+T: a new tab in front, on the board’s catalog', t.panes[0].views.length === before + 1 && t.panes[0].views[t.panes[0].active].kind === 'board');

  // never while typing
  await page.locator('[data-pane="0"] [data-key="catalog-search"]').focus();
  await page.keyboard.press('Control+w');
  await settle(page);
  check('Ctrl+W in a text box closes nothing', (await tabs(page)).panes[0].views.length === before + 1);
  await page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });

  // 20 tabs at most, then a toast
  for (let k = 0; k < 20; k++) await page.keyboard.press('Control+t');
  await settle(page, 300);
  t = await tabs(page);
  check('20 tabs at most in a pane', t.panes[0].views.length === 20, String(t.panes[0].views.length));
  check('a toast says so', ((await page.locator('#toast').textContent()) || '').includes('20 tabs'));
  check('a full strip scrolls inside itself, not the page', !(await hScroll(page)) && (await strip(page, 0).evaluate((s) => s.scrollWidth > s.clientWidth)));
  check('the shown tab is in sight in the strip', await strip(page, 0).evaluate((s) => {
    const a = s.querySelector('.pane-tab--on').getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return a.left >= r.left - 1 && a.right <= r.right + 1;
  }));
  // Ctrl+W down to one tab, then the pane closes with its last tab
  for (let k = 0; k < 19; k++) await page.keyboard.press('Control+w');
  await settle(page, 300);
  check('closing tabs one by one leaves one', (await tabs(page)).panes[0].views.length === 1);
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(500);
  t = await tabs(page);
  check('the last tab of a pane closes the pane (another pane stays)', t.panes.length === 1, JSON.stringify(t));
  await page.keyboard.press('Control+w');
  await settle(page, 300);
  check('the last tab of the last pane stays', (await tabs(page)).panes.length === 1 && (await tabs(page)).panes[0].views.length === 1);

  check('no console errors', errors.length === 0, errors.join(' | '));
  check('no outside request', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------- a cross-thread quote, rail entries
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500073 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  // a rail entry Ctrl+clicked: the focused pane gets a background tab
  await page.locator('[data-key="all-boards"]').click({ modifiers: ['Control'] });
  await settle(page);
  let t = await tabs(page);
  check('Ctrl+click in the sidebar: a background tab of the focused pane', t.panes[0].views.length === 2 && t.panes[0].views[1].kind === 'boards' && t.panes[0].active === 0, JSON.stringify(t.panes[0]));
  await page.locator('[data-key="fav-g"]').click({ button: 'middle' });
  await settle(page);
  t = await tabs(page);
  check('a middle click in the sidebar: the same', t.panes[0].views.length === 3 && t.panes[0].views.some((v) => v.kind === 'board'), JSON.stringify(t.panes[0]));
  // a plain click still navigates the pane
  await page.locator('[data-key="all-boards"]').click();
  await page.waitForSelector('[data-pane="0"] .board-list');
  t = await tabs(page);
  check('a plain click goes as before (in the tab shown)', t.panes[0].views.length === 3 && t.panes[0].views[t.panes[0].active].kind === 'boards');
  // Alt+← goes back in that tab's own history
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForSelector('[data-pane="0"] .thread .post');
  check('Alt+← goes back in the tab’s own history', (await tabs(page)).panes[0].views[0].kind === 'thread');
  check('no console errors (sidebar)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------- a window's address
{
  const hash = panesHash([{ tabs: [{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }], active: 1 }, { kind: 'boards' }]);
  const { ctx, page, errors } = await open(hash);
  await page.waitForSelector('[data-pane="0"] .thread .post');
  const t = await tabs(page);
  check('an address with tabs opens them, the active one shown', t.panes.length === 2 && t.panes[0].views.length === 2 && t.panes[0].active === 1, JSON.stringify(t));
  check('the other pane in the old format still opens', t.panes[1].views.length === 1 && t.panes[1].views[0].kind === 'boards');
  // a pane popped out carries its tabs
  const popup = ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await page.locator('[data-key="pane-popout"]').click();
  const win = await popup;
  const url = decodeURIComponent(win?.url() || '');
  check('a pane in a new window takes its tabs along', url.includes('"tabs":[{"kind":"board","board":"g"},{"kind":"thread","board":"g","no":500010}],"active":1'), url.slice(-160));
  await win?.close();
  check('no console errors (address)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------- fixes from the review
// Ctrl+W on a pane's last tab, then Ctrl+Shift+T: the pane comes back, at
// its place, and the other pane keeps what it showed.
{
  const { ctx, page, errors } = await open(panesHash([{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }]));
  await page.waitForSelector('[data-pane="1"] .thread .post');
  await settle(page, 300);
  await page.locator('[data-pane="1"] .pane__head').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+w');
  await page.waitForTimeout(600);
  let t = await tabs(page);
  check('review: Ctrl+W on a pane’s only tab closes the pane', t.panes.length === 1, JSON.stringify(t));
  await page.keyboard.press('Control+Shift+t');
  await page.waitForSelector('[data-pane="1"] .thread .post');
  await settle(page, 300);
  t = await tabs(page);
  check('review: Ctrl+Shift+T brings the pane back, at its place', t.panes.length === 2 && t.panes[1].views.length === 1 && t.panes[1].views[0].no === 500010 && t.focus === 1, JSON.stringify(t));
  check('review: the other pane still shows what it showed', t.panes[0].views.length === 1 && t.panes[0].views[0].kind === 'board', JSON.stringify(t.panes[0]));
  check('no console errors (pane back)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// The tab keys never drop the focus to <body>; the tab strip is tabs only,
// each tab names its panel; Ctrl+W does nothing while the pre-written
// posts are open.
{
  const { ctx, page, errors } = await open(panesHash([{ tabs: [{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }], active: 1 }]));
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await settle(page, 300);
  const where = () => page.evaluate(() => {
    const a = document.activeElement;
    return a === document.body || !a ? 'BODY' : `${a.tagName}${a.closest('section[data-pane]') ? ' in pane' : ''}${a.getAttribute('role') === 'tab' ? ' tab' : ''}`;
  });
  const aria = await page.evaluate(() => {
    const list = document.querySelector('.pane-tabs[role="tablist"]');
    const owned = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.getAttribute('aria-hidden') === 'true') continue;
        const r = c.getAttribute('role') || (c.tagName === 'BUTTON' ? 'button' : '');
        if (r && r !== 'presentation' && r !== 'none') owned.push(r);
        else walk(c);
      }
    };
    walk(list);
    const on = list.querySelector('[role="tab"][aria-selected="true"]');
    const panel = on && document.getElementById(on.getAttribute('aria-controls') || '');
    const close = document.querySelector('.pane-tab__close').getBoundingClientRect();
    return { owned: owned.join(','), panel: panel?.getAttribute('role') || '', labelled: panel?.getAttribute('aria-labelledby') === on?.id, close: [close.width, close.height] };
  });
  check('review: the tablist holds tabs only', /^(tab,)*tab$/.test(aria.owned), aria.owned);
  check('review: the shown tab controls its tabpanel, which it labels', aria.panel === 'tabpanel' && aria.labelled);
  check('review: a tab’s close button is 24 px at least', aria.close[0] >= 24 && aria.close[1] >= 24, aria.close.join('×'));
  await page.locator('[data-pane="0"] .post__id').first().focus();
  await page.keyboard.press('Control+Tab');
  await settle(page, 300);
  check('review: Ctrl+Tab keeps the focus in the pane', (await where()) !== 'BODY', await where());
  await page.locator('[data-pane="0"] .thread .post').first().click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+w');
  await settle(page, 300);
  check('review: Ctrl+W keeps the focus in the pane', (await where()) !== 'BODY', await where());
  await page.keyboard.press('Control+Shift+t');
  await settle(page, 300);
  check('review: Ctrl+Shift+T keeps the focus in the pane', (await where()) !== 'BODY', await where());
  await page.keyboard.press('Control+t');
  await settle(page, 300);
  check('review: Ctrl+T keeps the focus in the pane', (await where()) !== 'BODY', await where());
  // the pre-written posts open: the tab keys wait
  await page.keyboard.press('Control+1');
  await settle(page, 300);
  await page.keyboard.press('Control+2');
  await page.waitForSelector('[data-pane="0"] [data-key="thread-reply"]');
  await settle(page, 300);
  const n = (await tabs(page)).panes[0].views.length;
  await page.locator('[data-key="thread-reply"]').focus();
  await page.keyboard.press('Shift+F10');
  await page.waitForSelector('.pastas');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+w');
  await settle(page, 300);
  check('review: Ctrl+W with the pre-written posts open closes no tab', (await tabs(page)).panes[0].views.length === n && (await page.locator('.pastas').count()) === 1);
  await page.keyboard.press('Escape');
  check('no console errors (focus, aria)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// The clover spins for the work it was asked for: after Update on one tab,
// another tab of the pane shows its own Update at rest. Update keeps the
// focus while it loads (aria-disabled, not disabled).
{
  const { ctx, page, errors } = await open(panesHash([{ tabs: [{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }], active: 1 }]), { query: 'mock-delay=1500' });
  await page.waitForSelector('[data-pane="0"] .thread .post', { timeout: 10000 });
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForFunction(() => document.querySelector('[data-key="thread-refresh"]') && document.querySelector('[data-key="thread-refresh"]').getAttribute('aria-disabled') !== 'true' && document.querySelector('[data-pane="0"] .thread .post'), null, { timeout: 10000 });
  await settle(page, 300);
  await page.locator('[data-key="thread-refresh"]').focus();
  await page.keyboard.press('Enter');
  await settle(page, 200);
  const during = await page.evaluate(() => ({ key: document.activeElement?.dataset?.key || document.activeElement?.tagName, busy: document.querySelector('[data-key="thread-refresh"]').getAttribute('aria-disabled') }));
  check('review: Update keeps the focus while it loads', during.key === 'thread-refresh', JSON.stringify(during));
  await page.keyboard.press('Control+Tab');
  await settle(page, 200);
  const other = await page.evaluate(() => {
    const b = document.querySelector('[data-key="thread-refresh"]');
    return { view: document.querySelector('[data-pane="0"] .thread')?.getAttribute('aria-label'), cls: b.className, busy: b.getAttribute('aria-busy') };
  });
  check('review: the other tab’s Update is at rest while the first one updates', other.view === 'Thread 500073' && !/clover-/.test(other.cls) && other.busy === null, JSON.stringify(other));
  await page.waitForTimeout(3500);
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForFunction(() => document.querySelector('[data-pane="0"] .thread')?.getAttribute('aria-label') === 'Thread 500010', null, { timeout: 10000 });
  check('no console errors (clover by tab)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// An Ask answer that ends while its tab is in the background draws
// nothing: the tab shown in its pane (a thread) is not rebuilt.
{
  const ai = { enabled: true, kind: 'ollama', port: 11434, model: 'llama3.1:8b', vision: '', reach: 'normal' };
  const hash = panesHash([{ tabs: [{ kind: 'ask' }, { kind: 'thread', board: 'g', no: 500073 }], active: 0 }, { kind: 'thread', board: 'g', no: 500010 }]);
  const { ctx, page, errors, outside } = await open(hash, { settings: { ...SETTINGS, watch: { intervalSec: 600 }, ai }, query: 'mock-delay=300' });
  await page.waitForSelector('[data-pane="0"] .ask textarea', { timeout: 15000 });
  await page.waitForSelector('[data-pane="1"] .browse', { timeout: 15000 });
  await settle(page, 800);
  // pane 0 drawn again once its thread was in it: when, and whether the
  // answer had ended by then
  await page.evaluate(() => {
    window.__thr = [];
    new MutationObserver((list) => {
      for (const m of list)
        for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches('section[data-pane="0"]') && n.querySelector('.thread .post')) window.__thr.push(Math.round(performance.now()));
    }).observe(document, { childList: true, subtree: true });
  });
  await page.locator('[data-pane="0"] .ask textarea').first().fill('What is this thread about?');
  await page.locator('[data-pane="0"] [data-key$="ask-send"]').click();
  await page.waitForTimeout(50);
  await page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+Tab');
  await page.waitForSelector('[data-pane="0"] .thread .post', { timeout: 15000 });
  const shownAt = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForTimeout(4000);
  const again = await page.evaluate(() => window.__thr);
  // back on the Ask tab: the answer is there, drawn when shown
  await page.keyboard.press('Control+Shift+Tab');
  await page.waitForSelector('[data-pane="0"] .ask', { timeout: 5000 });
  const answered = await page.evaluate(() => (document.querySelector('[data-pane="0"] [data-ask-answer]')?.textContent || '').trim().length > 0);
  check('review: an answer ending in a background tab leaves the tab shown alone', again.length === 0, `thread shown at ${shownAt}, drawn again at ${again.join(',')}`);
  check('review: the answer shows when its tab is shown again', answered);
  check('no console errors (Ask in the background)', errors.length === 0, errors.join(' | '));
  check('no outside request (Ask in the background)', outside.length === 0, outside.join(','));
  await ctx.close();
}

// ------------------------------------------------- widths and themes
for (const theme of ['dark', 'light']) {
  for (const w of [360, 390, 1280]) {
    const hash = panesHash([{ tabs: [{ kind: 'board', board: 'g' }, { kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }, { kind: 'boards' }, { kind: 'settings' }, { kind: 'library' }], active: 1 }, { kind: 'board', board: 'g' }]);
    const { ctx, page, errors } = await open(hash, { viewport: { width: w, height: w < 900 ? 760 : 800 }, settings: { ...SETTINGS, theme } });
    await page.waitForSelector('[data-pane="0"] .thread .post, .pane .thread .post');
    await settle(page, 600);
    const s = page.locator('.pane-tabs').first();
    check(`${theme} ${w}px: the strip shows`, (await s.count()) === 1 && (await s.isVisible()));
    check(`${theme} ${w}px: no page scroll sideways`, !(await hScroll(page)));
    const fits = await s.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= -1 && r.right <= window.innerWidth + 1;
    });
    check(`${theme} ${w}px: the strip fits the window`, fits);
    if (w < 900) check(`${theme} ${w}px: the pane tabs and the strip under them`, (await page.locator('.workspace__tabs').count()) === 1);
    const tabBox = await s.locator('[aria-selected="true"]').boundingBox();
    check(`${theme} ${w}px: a tab is big enough to hit`, Boolean(tabBox) && tabBox.height >= 24, JSON.stringify(tabBox));
    const closeBox = await s.locator('.pane-tab__close').first().boundingBox();
    check(`${theme} ${w}px: a tab’s close button is 24 px at least`, Boolean(closeBox) && closeBox.width >= 24 && closeBox.height >= 24, JSON.stringify(closeBox));
    if (OUT) await page.screenshot({ path: `${OUT}/tabs-${w}-${theme}.png` });
    check(`${theme} ${w}px: no console errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

await browser.close();
console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
