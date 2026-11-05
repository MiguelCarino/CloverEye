// Layout pass: every setup step + dialogs + shell at 360/800/1280/1920 in
// dark and light. Checks horizontal scroll, off-screen elements, clipped text,
// overlapping controls and console errors; saves screenshots.
// usage: SHOTS_DIR=dir node tests/e2e/layout.mjs [chromium|firefox] [widths comma list]
// Playwright is not a dependency of this repo: point PLAYWRIGHT at its index.mjs.
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
import { mkdirSync } from 'node:fs';

const which = process.argv[2] || 'chromium';
const widths = (process.argv[3] || '360,800,1280,1920').split(',').map(Number);
const HEIGHT = { 360: 740, 800: 600, 1280: 800, 1920: 1080 };
const BASE = process.env.BASE_URL || 'http://127.0.0.1:7397/';
const OUT = process.env.SHOTS_DIR || 'shots';
mkdirSync(OUT, { recursive: true });

const problems = [];
let screens = 0;

async function audit(page, label) {
  const r = await page.evaluate(() => {
    const out = { hscroll: false, offscreen: [], clipped: [], overlap: [] };
    const de = document.documentElement;
    out.hscroll = de.scrollWidth > de.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1;
    const W = window.innerWidth;
    const vis = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}${el.dataset?.key ? `[${el.dataset.key}]` : ''}`;
    // Is el inside a horizontally scrolling/clipping ancestor? Then ignore viewport overflow.
    const clippedByAncestor = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true;
      }
      return false;
    };
    const all = [...document.querySelectorAll('body *')].filter((el) => !el.closest('[hidden]') && !el.closest('dialog:not([open])') && vis(el));
    for (const el of all) {
      const b = el.getBoundingClientRect();
      if ((b.right > W + 1 || b.left < -1) && !clippedByAncestor(el)) out.offscreen.push(`${desc(el)} ${Math.round(b.left)}..${Math.round(b.right)}`);
      const s = getComputedStyle(el);
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText && /(hidden|clip)/.test(s.overflowX + s.overflow) && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis') out.clipped.push(`${desc(el)} "${el.textContent.trim().slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
    }
    // Overlap between interactive controls and text blocks that are not nested.
    const ctl = all.filter((el) => el.matches('button, a, input:not([type=radio]):not([type=checkbox]), select, .segmented label, h1, h2, p, .pill, kbd, .progress__label, .check__state, dt, dd'));
    // Visible part of an element: its box cut by every clipping ancestor.
    const visibleRect = (el) => {
      const b = el.getBoundingClientRect();
      let r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
          const q = p.getBoundingClientRect();
          r = { left: Math.max(r.left, q.left), top: Math.max(r.top, q.top), right: Math.min(r.right, q.right), bottom: Math.min(r.bottom, q.bottom) };
        }
      }
      return r;
    };
    const boxes = ctl.map((el) => [el, visibleRect(el)]).filter(([, r]) => r.right - r.left > 0 && r.bottom - r.top > 0);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, ra] = boxes[i];
        const [b, rb] = boxes[j];
        if (a.contains(b) || b.contains(a)) continue;
        // Elements in different stacking layers (an open dialog over the page) are fine.
        const da = a.closest('dialog[open]');
        const db = b.closest('dialog[open]');
        if (da !== db) continue;
        const ix = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const iy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ix > 2 && iy > 2) {
          // Only count it if both are actually painted there (not scrolled out of a container).
          const cx = Math.max(ra.left, rb.left) + ix / 2;
          const cy = Math.max(ra.top, rb.top) + iy / 2;
          const hit = document.elementFromPoint(cx, cy);
          if (hit && (a.contains(hit) || b.contains(hit))) out.overlap.push(`${desc(a)} × ${desc(b)}`);
        }
      }
    }
    out.offscreen = out.offscreen.slice(0, 6);
    out.clipped = out.clipped.slice(0, 6);
    out.overlap = [...new Set(out.overlap)].slice(0, 8);
    return out;
  });
  const issues = [];
  if (r.hscroll) issues.push('horizontal scroll');
  if (r.offscreen.length) issues.push(`offscreen: ${r.offscreen.join('; ')}`);
  if (r.clipped.length) issues.push(`clipped: ${r.clipped.join('; ')}`);
  if (r.overlap.length) issues.push(`overlap: ${r.overlap.join('; ')}`);
  if (page._errors.length) issues.push(`console: ${page._errors.splice(0).join(' | ')}`);
  if (issues.length) problems.push(`${label}: ${issues.join(' || ')}`);
  await page.screenshot({ path: `${OUT}/${label}.png` });
  screens++;
}

const browser = await pw[which].launch();
for (const width of widths) {
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] || 800 }, colorScheme: scheme });
    const page = await ctx.newPage();
    page._errors = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page._errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => page._errors.push(`pageerror: ${e.message}`));
    await page.goto(BASE + '?mock-delay=50&mock-ffmpeg=partial');
    await page.waitForSelector('#setup:not([hidden]) .step__title');
    await page.waitForTimeout(400);
    const tag = (s) => `${which}-${width}-${scheme}-${s}`;
    const steps = ['1-welcome', '2-look', '3-boards', '4-video', '5-watching', '6-files', '7-done'];
    for (let i = 0; i < steps.length; i++) {
      if (i === 1) await page.waitForSelector('.preview .post');
      if (i === 2) await page.waitForSelector('.board-tile');
      if (i === 3) await page.waitForSelector('.check');
      if (i === 2) { await page.locator('[data-board="g"]').click(); await page.locator('[data-board="diy"]').click(); }
      await page.waitForTimeout(350); // let the enter transition finish
      await audit(page, tag(steps[i]));
      if (i === 1) {
        for (const t of ['yotsuba', 'tomorrow', 'win95']) {
          await page.locator(`label:has(input[name="theme"][value="${t}"])`).click();
          await page.waitForTimeout(150);
          await audit(page, tag(`2b-look-${t}`));
        }
        await page.locator('label:has(input[name="theme"][value="system"])').click();
      }
      if (i === 4) {
        await page.fill('#intervalInput', '3');
        await page.locator('#nextBtn').click();
        await page.waitForTimeout(250);
        await audit(page, tag('5b-interval-error'));
        await page.fill('#intervalInput', '10');
      }
      if (i === 5) {
        await page.locator('label:has(input[name="cache"][value="temp"])').click();
        await page.waitForTimeout(150);
        await audit(page, tag('6b-files-temp'));
      }
      if (i < steps.length - 1) await page.locator('#nextBtn').click();
    }
    await page.keyboard.press('Escape'); // no skip on Done (Skip hidden) – make sure nothing breaks
    await page.waitForTimeout(200);
    if (await page.locator('#skipDialog').isVisible()) {
      await audit(page, tag('7b-skip-dialog'));
      await page.keyboard.press('Escape');
    }
    await page.locator('#nextBtn').click();
    await page.waitForSelector('#shell:not([hidden])');
    await page.waitForSelector('.catalog-card');
    await page.waitForTimeout(400);
    await audit(page, tag('8-catalog'));
    await page.locator('.catalog-card').nth(1).click();
    await page.waitForSelector('.thread .post');
    await page.waitForTimeout(300);
    await audit(page, tag('8b-thread'));
    if (await page.locator('.thread .post__thumb').count()) {
      await page.locator('.thread .post__thumb').first().click();
      await page.waitForTimeout(300);
      await audit(page, tag('8c-thread-file-open'));
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('.catalog-card');
    if (await page.locator('[data-key="rail-toggle"]').isVisible()) { await page.locator('[data-key="rail-toggle"]').click(); await page.waitForTimeout(250); }
    await page.locator('[data-key="settings"]').click();
    await page.waitForSelector('.settings');
    await page.waitForTimeout(300);
    await audit(page, tag('9-settings'));
    await page.locator('[data-key="switch-nsfw"]').click();
    await page.waitForTimeout(250);
    await audit(page, tag('9b-adult-dialog'));
    await page.locator('#adultDialog [data-act="cancel"]').click();
    for (const t of ['photon', 'matrix', 'moe']) {
      await page.locator(`label:has(input[name="theme"][value="${t}"])`).click();
      await page.waitForTimeout(150);
      await audit(page, tag(`9c-settings-${t}`));
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? problems.join('\n') : 'no layout problems found');
console.log(`\n${which}: ${screens} screens, ${problems.length} with problems`);
