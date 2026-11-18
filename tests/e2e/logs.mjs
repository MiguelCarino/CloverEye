// The diagnostics lines the UI writes (ui/js/log.js, log-model.js), with
// the mock bridge, which keeps them in memory (globalThis.__ceLogs): tabs,
// a refresh, a post attempt (a wrong captcha, then a right one), pastas
// (search, a new one, pin, pick, Save as pasta), a setting changed, the
// gallery and the assistant. Every area that ran has lines, and no line
// holds the reply's text, a pasta's text or title, a filter or tag term,
// a search or the question asked (distinctive markers, looked for in
// every line). Then a window left idle with Detailed logs off: polls add
// no line.
// usage: PLAYWRIGHT=…/playwright/index.mjs node tests/e2e/logs.mjs
const pw = await import(process.env.PLAYWRIGHT || 'playwright');
import { BASE, serveUi } from './serve.mjs';

const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ` (${extra})` : ''}`);
  if (!cond) failures++;
}

// What the test types: none of it may reach a log line.
const MARK = {
  reply: 'Zqxreplymarker77',
  pastaText: 'Zqxpastatextmarker88',
  pastaTitle: 'Zqxpastatitlemarker55',
  savedTitle: 'Zqxsavedtitlemarker33',
  term: 'zqxtagterm99',
  tagName: 'Zqxtagname11',
  search: 'zqxsearchmarker44',
  question: 'Zqxquestionmarker66',
  name: 'Zqxnamemarker22',
};

const BASE_SETTINGS = {
  schema: 1,
  setupVersion: 3,
  completedAt: '2026-11-11T00:00:00.000Z',
  favourites: ['g'],
  theme: 'dark',
  filters: [{ id: 'f1', field: 'com', pattern: MARK.term, action: 'hide' }],
  tags: [{ id: 'tg1', name: MARK.tagName, terms: [MARK.term], mode: 'hide' }],
  ai: { enabled: true, kind: 'ollama', port: 11434, model: 'llama3.1:8b' },
};

function seed(settings) {
  try {
    localStorage.setItem('clovereye.settings', JSON.stringify(settings));
  } catch {}
  const c = (window.__rb = { full: 0 });
  new MutationObserver((list) => {
    for (const m of list) for (const n of m.removedNodes) if (n.nodeType === 1 && n.matches('nav.rail')) c.full++;
  }).observe(document, { childList: true, subtree: true });
}

const browser = await pw.chromium.launch();

async function open(hash, settings, query = 'mock-delay=0') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const outside = await serveUi(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(seed, settings);
  await page.goto(`${BASE}index.html?${query}${hash}`);
  return { ctx, page, outside, errors };
}

const panesHash = (list) => `#panes=${encodeURIComponent(JSON.stringify(list))}`;
const settle = (page, ms = 200) => page.waitForTimeout(ms);
const logs = (page) => page.evaluate(() => (globalThis.__ceLogs || []).map((l) => ({ level: l.level, area: l.area, msg: l.msg, fields: l.fields || null })));
/** Waits for the logger's batch (500 ms) to reach the bridge. */
const flushed = (page) => page.waitForTimeout(650);
const has = (lines, area, msg, pred = () => true) => lines.some((l) => l.area === area && l.msg === msg && pred(l.fields || {}));

// ------------------------------------------------- every feature, Detailed on
{
  const settings = { ...BASE_SETTINGS, diagnostics: { detailed: true } };
  const { ctx, page, outside, errors } = await open(
    panesHash([{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'board', board: 'g' }, { kind: 'ask' }]),
    settings,
  );
  await page.waitForSelector('[data-pane="0"] .thread .post');
  await page.waitForSelector('[data-pane="1"] .catalog .catalog-card');
  await settle(page, 400);

  // tabs: a background tab from the catalog, switch to it, close, reopen
  const card = page.locator('[data-pane="1"] .catalog-card').nth(3);
  await card.click({ modifiers: ['Control'] });
  await settle(page);
  await page.locator('[data-pane="1"] .pane__head').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+Tab');
  await page.waitForSelector('[data-pane="1"] .thread .post');
  await settle(page);
  await page.keyboard.press('Control+w');
  await settle(page);
  await page.keyboard.press('Control+Shift+T');
  await settle(page);
  await page.keyboard.press('Control+w');
  await settle(page);

  // a refresh by hand (F5 on the thread pane), and L
  await page.locator('[data-pane="0"] .pane__head').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('F5');
  await settle(page, 400);
  await page.keyboard.press('l');
  await settle(page);
  await page.keyboard.press('l');
  await settle(page);

  // the gallery: G, then Escape
  await page.keyboard.press('g');
  await settle(page, 300);
  const galleryOpen = (await page.locator('.gallery').count()) === 1;
  if (galleryOpen) await page.keyboard.press('Escape');
  await settle(page);

  // posting: R, a name and a comment, the pastas
  await page.keyboard.press('r');
  await page.waitForSelector('.composer .captcha__stage');
  await page.fill('[data-key="compose-name"]', MARK.name);
  await page.fill('[data-key="compose-com"]', `${MARK.reply} here\n`);
  await page.click('[data-key="compose-pastas"]');
  await page.waitForSelector('.pastas');
  await page.fill('[data-key="pastas-search"]', MARK.search);
  await settle(page);
  await page.fill('[data-key="pastas-search"]', '');
  await settle(page);
  await page.click('[data-key="pastas-new"]');
  await page.fill('[data-key="pastas-own-title"]', MARK.pastaTitle);
  await page.fill('[data-key="pastas-own-text"]', `>${MARK.pastaText}\n>be me`);
  await page.click('[data-key="pastas-own-save"]');
  await settle(page);
  // the new card has the focus: P pins it, Enter picks it
  await page.keyboard.press('p');
  await settle(page);
  await page.keyboard.press('Enter');
  await settle(page);
  const com = await page.inputValue('[data-key="compose-com"]');
  check('pastas: the picked pasta went into the reply', com.includes(MARK.pastaText) && com.includes(MARK.reply), JSON.stringify(com.slice(0, 80)));
  // Save as pasta, from the form
  await page.click('[data-key="compose-save-pasta"]');
  await page.waitForSelector('dialog.pasta-save');
  await page.fill('[data-key="pasta-save-title"]', MARK.savedTitle);
  await page.click('[data-key="pasta-save-ok"]');
  await settle(page);

  // a wrong captcha first, then the right one ("Pick the 3", "Pick the 7")
  const solve = async (picks) => {
    for (const n of picks) {
      await page.locator('[data-key="compose-slider"]').focus();
      await page.locator('[data-key="compose-slider"]').fill(String(n));
      await page.locator('[data-key="compose-captcha-next"]').click();
      await settle(page, 120);
    }
  };
  await page.click('[data-key="compose-submit"]');
  await settle(page);
  await solve([1, 1]);
  await page.click('[data-key="compose-submit"]');
  await page.waitForTimeout(700);
  await page.waitForSelector('[data-key="compose-slider"]');
  await solve([3, 2]);
  await page.click('[data-key="compose-submit"]');
  await page.waitForTimeout(900);
  check('post: the right captcha posts', (await page.locator('.composer').count()) === 0);

  // the assistant (pane 2): a question with a marker in it
  await page.fill('[data-key="p2-ask-input"]', `${MARK.question} what is said here?`);
  await page.locator('[data-key="p2-ask-input"]').press('Enter');
  await page.waitForFunction(() => (globalThis.__ceLogs || []).some((l) => l.msg === 'ai.answered') || document.querySelector('[data-pane="2"] .ask__sources, [data-pane="2"] .callout--warn'), null, { timeout: 8000 }).catch(() => {});
  await flushed(page);

  // a setting: Settings in the focused pane, a switch, back
  await page.locator('[data-pane="1"] .pane__head').click({ position: { x: 4, y: 4 } });
  await page.click('nav.rail [data-key="settings"]');
  await page.waitForSelector('[data-key="switch-hover"]');
  await page.click('[data-key="switch-hover"]');
  await settle(page, 300);

  // the page going away: what is held is sent (and the redraws summed up)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await flushed(page);

  const lines = await logs(page);
  const areas = new Set(lines.map((l) => l.area));
  for (const a of ['app', 'settings', 'tabs', 'catalog', 'thread', 'post', 'captcha', 'pasta', 'filters', 'watch', 'ai', 'ui', 'offline']) check(`area ${a} has lines`, areas.has(a), [...areas].join(','));
  check('app: started, with the window and the time it took', has(lines, 'app', 'app.started', (f) => f.window === 'extra' && f.ms >= 0));
  check('settings: loaded, with size and key count', has(lines, 'settings', 'settings.loaded', (f) => f.bytes > 0 && f.keys > 0));
  check('settings: a change names the key, not the value', has(lines, 'settings', 'settings.changed', (f) => /display|hover/i.test(String(f.keys))));
  check('settings: saves at debug, with the keys changed', has(lines, 'settings', 'settings.saved', (f) => f.ms >= 0 && typeof f.keys === 'string'));
  check('tabs: opened in the background, switched, closed, reopened', ['tab.opened', 'tab.switched', 'tab.closed', 'tab.reopened'].every((m) => has(lines, 'tabs', m)), lines.filter((l) => l.area === 'tabs').map((l) => l.msg).join(','));
  check('tabs: the shell says what it opened with', has(lines, 'tabs', 'shell.opened', (f) => f.panes === 3 && f.filters === 1 && f.tagCount === 1));
  check('tabs: a refresh by hand (F5)', has(lines, 'tabs', 'refresh', (f) => f.via === 'key' && f.view === 'thread' && f.thread === 500010));
  check('tabs: L switched the layout, both ways', lines.filter((l) => l.msg === 'layout.toggled' && l.fields?.via === 'key').length === 2);
  check('catalog: loaded with a count and a time', has(lines, 'catalog', 'catalog.loaded', (f) => f.board === 'g' && f.threads > 0 && f.ms >= 0));
  check('thread: loaded with posts and a time', has(lines, 'thread', 'thread.loaded', (f) => f.thread === 500010 && f.posts > 0));
  check('thread: polling at debug, with the delay', has(lines, 'thread', 'poll.scheduled', (f) => f.delay_ms > 0 && typeof f.why === 'string'));
  check('filters: applied with counts, at debug', has(lines, 'filters', 'filters.applied', (f) => f.filters === 1 && f.tagCount === 1 && f.posts > 0));
  check('gallery: opened and closed', !galleryOpen || (has(lines, 'gallery', 'gallery.opened', (f) => f.items >= 0) && has(lines, 'gallery', 'gallery.closed')));
  check('post: R opened the form', has(lines, 'post', 'key.reply') && has(lines, 'post', 'compose.opened', (f) => f.thread === 500010));
  check('captcha: shown, with its task count', has(lines, 'captcha', 'captcha.shown', (f) => f.state === 'ready' && f.tasks === 2));
  check('post: the unanswered captcha stopped it before sending', has(lines, 'post', 'post.blocked', (f) => /captcha/.test(f.problems)));
  check('post: the wrong answer: sent, then failed as captcha', has(lines, 'post', 'post.failed', (f) => f.result === 'captcha' && f.ms >= 0));
  check('post: the right one: sent with sizes only, then posted', has(lines, 'post', 'post.sending', (f) => f.chars > 0 && f.named === true && f.answered === true) && has(lines, 'post', 'post.sent', (f) => f.no > 0 && f.result === 'posted'));
  check('watch: the thread posted in is watched', has(lines, 'watch', 'watch.added', (f) => f.auto === true));
  check('pasta: panel opened, searched (length only), closed', has(lines, 'pasta', 'pasta.panel.opened') && has(lines, 'pasta', 'pasta.search', (f) => f.queryChars === MARK.search.length) && has(lines, 'pasta', 'pasta.panel.closed', (f) => f.reason === 'pick'));
  check('pasta: an own one saved, pinned and picked as "own"', has(lines, 'pasta', 'pasta.own.saved', (f) => f.from === 'panel' && f.chars > 0) && has(lines, 'pasta', 'pasta.pinned', (f) => f.id === 'own') && has(lines, 'pasta', 'pasta.picked', (f) => f.id === 'own'));
  check('pasta: Save as pasta from the form', has(lines, 'pasta', 'pasta.save.asked', (f) => f.from === 'reply') && has(lines, 'pasta', 'pasta.own.saved', (f) => f.from === 'reply' && f.titleChanged === true));
  const asked = lines.find((l) => l.msg === 'ai.asked');
  check('ai: the question: model, sizes, no text', Boolean(asked) && asked.fields.model === 'llama3.1:8b' && asked.fields.questionChars > MARK.question.length && asked.fields.promptChars > 0 && asked.fields.posts > 0, JSON.stringify(asked?.fields));
  check('ai: answered, with time to the first piece', has(lines, 'ai', 'ai.answered', (f) => f.first_ms >= 0 && f.ms >= f.first_ms && f.chars > 0));
  check('ai: detection logged', has(lines, 'ai', 'ai.detected', (f) => f.servers === 1));
  check('ui: the redraws summed up (not one line each)', has(lines, 'ui', 'redraw.summary', (f) => f.pane > 0) && lines.filter((l) => l.msg === 'redraw.summary').length <= 2);
  check('offline: the saved threads listed, at debug', has(lines, 'offline', 'saved.listed'));

  // privacy: no marker anywhere, in any case
  const all = JSON.stringify(lines).toLowerCase();
  for (const [what, m] of Object.entries(MARK)) check(`no line holds the ${what}`, !all.includes(m.toLowerCase()));
  check('no line holds the pasta text or the question by a piece of it', !/be me|what is said/.test(all));
  check('no field is a content name', !lines.some((l) => l.fields && Object.keys(l.fields).some((k) => /^(text|com|name|title|sub|subject|prompt|answer|query|terms|tags?|pattern|file|filename|captcha|token|password|pwd)$/i.test(k))));
  check('every line is short and has a known level', lines.every((l) => ['error', 'warn', 'info', 'debug'].includes(l.level) && l.msg.length <= 200 && (!l.fields || Object.keys(l.fields).length <= 16)));
  check('no error lines', !lines.some((l) => l.level === 'error'), lines.filter((l) => l.level === 'error').map((l) => `${l.area}:${l.msg}`).join(' '));
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('no outside requests', outside.length === 0, outside.slice(0, 3).join(' '));
  check('the log stays small (lines for all of that)', lines.length < 600, String(lines.length));
  console.error(`lines: ${lines.length} (${['error', 'warn', 'info', 'debug'].map((l) => `${l} ${lines.filter((x) => x.level === l).length}`).join(', ')})`);
  await ctx.close();
}

// -------------------------------------------- idle, Detailed logs off
{
  // two open threads polled every 10 s, a watched one by the watcher
  const settings = { ...BASE_SETTINGS, diagnostics: { detailed: false }, watch: { intervalSec: 10 }, watched: [{ board: 'g', no: 500055, title: 'Watched', seen: 0 }] };
  const { ctx, page, outside, errors } = await open(panesHash([{ kind: 'thread', board: 'g', no: 500010 }, { kind: 'thread', board: 'g', no: 500073 }]), settings, 'mock-delay=0&mock-grow');
  await page.waitForSelector('[data-pane="1"] .thread .post');
  await page.waitForTimeout(2500);
  const before = await logs(page);
  const postsBefore = await page.evaluate(() => document.querySelectorAll('[data-pane="0"] .thread > .post').length);
  check('idle: Detailed off writes no debug line', !before.some((l) => l.level === 'debug'));
  // 25 s: each open thread polled twice (one new reply each time: mock-grow)
  await page.waitForTimeout(25_000);
  const after = await logs(page);
  const added = after.slice(before.length);
  check('idle: polls add no line with Detailed off', added.length === 0, added.map((l) => `${l.level} ${l.area}:${l.msg}`).join(' | '));
  const polled = await page.evaluate(() => document.querySelectorAll('[data-pane="0"] .thread > .post').length);
  check('idle: the threads were polled meanwhile (they grew)', polled > postsBefore, `${postsBefore} → ${polled}`);
  check('idle: no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('idle: no outside requests', outside.length === 0);
  await ctx.close();
}

await browser.close();
for (const r of results) console.log(r);
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
