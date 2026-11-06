// Functional end-to-end pass of the CloverEye first-time setup (mock bridge).
// usage: node tests/e2e/setup-flow.mjs [chromium|firefox]
// Playwright is not a dependency of this repo: point PLAYWRIGHT at its index.mjs.
const pw = await import(process.env.PLAYWRIGHT || 'playwright');

const which = process.argv[2] || 'chromium';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:7397/';
const results = [];
let failures = 0;
function check(name, cond, extra = '') {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures++;
}

const browser = await pw[which].launch();

async function newPage(viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page._errors = [];
  page._outside = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') page._errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => page._errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) page._outside.push(r.url()); });
  return { ctx, page };
}

const stepLabel = (page) => page.locator('#progressCount').textContent();
const nextBtn = (page) => page.locator('#nextBtn');
const settled = (page) => page.waitForTimeout(300);

// ---------------------------------------------------------------- mouse run
{
  const { ctx, page } = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('#setup:not([hidden]) .step__title');
  check('setup shown on first launch', await page.locator('#setup').isVisible());
  check('step 1 is Welcome', (await stepLabel(page)).includes('Step 1 of 7 · Welcome'), await stepLabel(page));
  check('Back disabled on step 1', await page.locator('#backBtn').isDisabled());
  check('welcome says no request made', (await page.locator('.fact').first().textContent()).includes('in step 3'));
  check('7 progress steps, no Content step', (await page.locator('#progress li').count()) === 7 && (await page.locator('#progress button:has-text("Content")').count()) === 0);

  await nextBtn(page).click(); await settled(page);
  check('step 2 Look', (await stepLabel(page)).includes('Look'));
  await page.waitForSelector('.preview .post');
  check('sample thread rendered', (await page.locator('.preview .post').count()) >= 3);
  await page.locator('label:has(input[name="theme"][value="light"])').click();
  check('Light applies data-theme', (await page.getAttribute('html', 'data-theme')) === 'light');
  await page.locator('label:has(input[name="density"][value="compact"])').click();
  check('Compact applies data-density', (await page.getAttribute('html', 'data-density')) === 'compact');
  await page.locator('#backBtn').click(); await settled(page);
  check('Back returns to Welcome', (await stepLabel(page)).includes('Welcome'));
  await nextBtn(page).click(); await settled(page);
  check('Look remembers Light after Back', await page.locator('input[name="theme"][value="light"]').isChecked());
  await page.locator('label:has(input[name="theme"][value="yotsuba"])').click();
  check('Classic theme applies (Yotsuba)', (await page.getAttribute('html', 'data-theme')) === 'yotsuba');
  await settled(page); // the post colour transition
  const replyBg = await page.locator('.preview .post:not(.post--op)').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  check('Yotsuba replies are the classic colour', replyBg === 'rgb(240, 224, 214)', replyBg);
  await page.locator('label:has(input[name="theme"][value="cyberpunk"])').click();
  check('Atrium theme applies (Cyberpunk)', (await page.getAttribute('html', 'data-theme')) === 'cyberpunk');
  check('19 themes offered in 3 groups', (await page.locator('input[name="theme"]').count()) === 19 && (await page.locator('.theme-picker__group').count()) === 3);
  await page.locator('label:has(input[name="theme"][value="dark"])').click();
  await page.locator('label:has(input[name="density"][value="comfortable"])').click();
  check('setup never shows an NSFW switch', (await page.locator('#setup [data-key="switch-nsfw"]').count()) === 0);

  check('no outside request before Boards', page._outside.length === 0, page._outside.join(','));
  await nextBtn(page).click();
  await page.waitForSelector('.board-tile');
  check('step 3 Boards', (await stepLabel(page)).includes('Boards'));
  const tiles = await page.locator('.board-tile').count();
  check('only worksafe boards listed (53)', tiles === 53, String(tiles));
  check('/b/ hidden while NSFW off', (await page.locator('[data-board="b"]').count()) === 0);
  check('hidden-count hint points to Settings', (await page.locator('text=Settings → Content can show them').count()) === 1);
  await page.locator('[data-board="g"]').click();
  await page.locator('[data-board="diy"]').click();
  check('two favourites selected', (await page.locator('.boards-tools .pill').textContent()).includes('2 selected'));
  await page.fill('[data-key="board-filter"]', 'techno');
  check('filter narrows grid', (await page.locator('.board-tile').count()) < 10);
  await page.fill('[data-key="board-filter"]', '');

  await nextBtn(page).click();
  await page.waitForSelector('.check');
  check('step 5 Video with 6 rows', (await page.locator('.check').count()) === 6);
  await nextBtn(page).click(); await settled(page);
  check('step 6 Watching', (await stepLabel(page)).includes('Watching'));
  await page.fill('#intervalInput', '5');
  await nextBtn(page).click(); await settled(page);
  check('interval < 10 s blocked', (await stepLabel(page)).includes('Watching') && (await page.locator('.field__error').count()) === 1);
  check('error message in view', await page.locator('.field__error').evaluate((el) => { const b = el.getBoundingClientRect(); const h = document.getElementById('stepHost').getBoundingClientRect(); return b.top >= h.top && b.bottom <= h.bottom; }));
  await page.fill('#intervalInput', '15');
  check('typing 15 presses the 15 s preset', (await page.locator('[data-key="preset-15"]').getAttribute('aria-pressed')) === 'true' && (await page.locator('[data-key="preset-10"]').getAttribute('aria-pressed')) === 'false');
  await nextBtn(page).click(); await settled(page);
  check('step 7 Files', (await stepLabel(page)).includes('Files'));
  check('strip metadata on by default', (await page.locator('[data-key="switch-strip"]').getAttribute('aria-checked')) === 'true');
  await nextBtn(page).click(); await settled(page);
  check('step 7 Done', (await stepLabel(page)).includes('Done'));
  check('Skip hidden on Done', !(await page.locator('#skipBtn').isVisible()));
  await page.keyboard.press('Escape'); await settled(page);
  check('Esc on Done does not open Skip dialog', !(await page.locator('#skipDialog').isVisible()));
  check('Esc hint hidden on Done', !(await page.locator('#escHint').isVisible()));
  check('Done button opens /g/', (await nextBtn(page).textContent()).includes('/g/'), await nextBtn(page).textContent());
  const sumText = await page.locator('.summary').textContent();
  check('summary mentions 15 s', /15\s*s/.test(sumText), sumText.slice(0, 200));
  await page.locator('[data-key="change-look"]').click(); await settled(page);
  check('Change link goes to Look', (await stepLabel(page)).includes('Look'));
  await page.locator('#progress button:has-text("Done")').click(); await settled(page);
  await nextBtn(page).click(); await page.waitForSelector('#shell:not([hidden])');
  check('shell opens after Done', await page.locator('#shell').isVisible());
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('clovereye.settings')));
  check('settings saved with setupVersion', stored && stored.setupVersion >= 1, JSON.stringify(stored?.setupVersion));
  check('saved favourites g,diy', JSON.stringify(stored?.favourites) === '["g","diy"]', JSON.stringify(stored?.favourites));
  check('saved interval 15', stored?.watch?.intervalSec === 15);
  check('saved NSFW off', stored?.nsfw && !stored.nsfw.enabled, JSON.stringify(stored?.nsfw));
  check('summary has no Content row', (await page.locator('[data-key="change-content"]').count()) === 0);

  // Settings → Content: the only place NSFW boards can be turned on
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  check('Settings opens in the shell', (await page.locator('.centre__title').textContent()).includes('Settings'));
  const sw = page.locator('[data-key="switch-nsfw"]');
  check('NSFW off by default', (await sw.getAttribute('aria-checked')) === 'false');
  await sw.click();
  check('18+ dialog opens', await page.locator('#adultDialog').isVisible());
  check('Turn on disabled until confirmed', await page.locator('#adultDialog [data-act="confirm"]').isDisabled());
  await page.locator('#adultDialog [data-act="cancel"]').click(); await settled(page);
  check('Cancel keeps NSFW off', (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'false');
  await page.locator('[data-key="switch-nsfw"]').click();
  await page.locator('#adultConfirm').check();
  await page.locator('#adultDialog [data-act="confirm"]').click(); await settled(page);
  check('confirm turns NSFW on', (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'true');
  check('NSFW on is saved with the 18+ date', await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('clovereye.settings')); return s.nsfw.enabled && Boolean(s.nsfw.confirmedAdultAt); }));
  await page.locator('[data-key="all-boards"]').click(); await settled(page);
  check('NSFW on: All boards lists 77', (await page.locator('.board-list .rail__item').count()) === 77, String(await page.locator('.board-list .rail__item').count()));
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('[data-key="switch-nsfw"]').click(); await settled(page);
  check('turning off needs no dialog', !(await page.locator('#adultDialog').isVisible()) && (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'false');
  await page.locator('[data-key="all-boards"]').click(); await settled(page);
  check('NSFW off: All boards back to 53', (await page.locator('.board-list .rail__item').count()) === 53);
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('label:has(input[name="theme"][value="tomorrow"])').click(); await settled(page);
  check('Settings theme applies and saves', (await page.getAttribute('html', 'data-theme')) === 'tomorrow' && (await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).theme)) === 'tomorrow');

  await page.reload(); await page.waitForSelector('#shell:not([hidden])');
  check('reload goes straight to shell', !(await page.locator('#setup').isVisible()));
  check('theme survives a reload', (await page.getAttribute('html', 'data-theme')) === 'tomorrow');
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('[data-key="rerun"]').click(); await page.waitForSelector('#setup:not([hidden])');
  check('Run setup again reopens all 7 steps', (await stepLabel(page)).includes('Step 1 of 7'));
  await page.locator('#skipBtn').click();
  check('Skip opens confirm dialog', await page.locator('#skipDialog').isVisible());
  await page.locator('#skipDialog [data-act="confirm"]').click(); await page.waitForSelector('#shell:not([hidden])');
  check('Skip returns to shell', await page.locator('#shell').isVisible());
  const stored2 = JSON.parse(await page.evaluate(() => localStorage.getItem('clovereye.settings')));
  check('Skip keeps earlier answers', JSON.stringify(stored2?.favourites) === '["g","diy"]', JSON.stringify(stored2?.favourites));

  await page.goto(BASE + '#setup'); await page.waitForSelector('#setup:not([hidden])');
  check('#setup reopens setup', (await stepLabel(page)).includes('Step 1 of 7'));
  check('mouse run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// -------------------------------------------------------------- keyboard run
{
  const { ctx, page } = await newPage();
  await page.goto(BASE);
  await page.waitForSelector('#setup:not([hidden]) .step__title');
  const k = (key) => page.keyboard.press(key);
  await k('Enter'); await settled(page);
  check('kb: Enter → Look', (await stepLabel(page)).includes('Look'));
  // Theme radios with arrows
  await page.locator('input[name="theme"]:checked').focus();
  await k('ArrowRight'); await settled(page);
  check('kb: arrows move theme radio, not step', (await stepLabel(page)).includes('Look') && (await page.getAttribute('html', 'data-theme')) === 'dark');
  await k('ArrowLeft'); await settled(page);
  await k('Enter');
  await page.waitForSelector('.board-tile');
  check('kb: Enter on radio → Boards', (await stepLabel(page)).includes('Boards'));
  // Tab into the grid
  let found = false;
  for (let i = 0; i < 10; i++) {
    await k('Tab');
    if (await page.evaluate(() => document.activeElement?.classList.contains('board-tile'))) { found = true; break; }
  }
  check('kb: Tab reaches board grid', found);
  const first = await page.evaluate(() => document.activeElement?.dataset?.board);
  await k('ArrowRight');
  const second = await page.evaluate(() => document.activeElement?.dataset?.board);
  await k('ArrowDown');
  const third = await page.evaluate(() => document.activeElement?.dataset?.board);
  check('kb: arrows move in grid', first && second && third && first !== second && second !== third, `${first} ${second} ${third}`);
  check('kb: arrows in grid keep the step', (await stepLabel(page)).includes('Boards'));
  check('kb: grid is a single Tab stop (roving tabindex)', await page.evaluate(() => document.querySelectorAll('.board-tile[tabindex="0"]').length === 1 && document.activeElement.classList.contains('board-tile') && document.activeElement.tabIndex === 0));
  await k('Space');
  check('kb: Space selects board', (await page.locator(`[data-board="${third}"]`).getAttribute('aria-checked')) === 'true');
  await k('Enter');
  check('kb: Enter in grid toggles, not next', (await stepLabel(page)).includes('Boards') && (await page.locator(`[data-board="${third}"]`).getAttribute('aria-checked')) === 'false');
  await k('Space');
  await k('Tab');
  check('kb: one Tab leaves the grid', await page.evaluate(() => !document.activeElement?.classList.contains('board-tile')), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)));
  await k('Shift+Tab');
  check('kb: Shift+Tab returns to the last tile', await page.evaluate(() => document.activeElement?.dataset?.board) === third);
  await k('Escape'); await settled(page);
  check('kb: Esc opens Skip dialog', await page.locator('#skipDialog').isVisible());
  check('kb: Skip dialog focuses Keep going', await page.evaluate(() => document.activeElement?.dataset?.act === 'cancel'));
  await k('Escape'); await settled(page);
  check('kb: Esc closes Skip dialog', !(await page.locator('#skipDialog').isVisible()) && (await stepLabel(page)).includes('Boards'));
  await page.evaluate(() => document.activeElement.blur());
  for (const want of ['Video', 'Watching', 'Files', 'Done']) {
    await k('ArrowRight');
    await settled(page);
    if (want === 'Video') await page.waitForSelector('.check');
    check(`kb: → ${want}`, (await stepLabel(page)).includes(want), await stepLabel(page));
  }
  // On Done, Enter on the focused heading finishes.
  await k('Enter');
  await page.waitForSelector('#shell:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('kb: Enter on Done opens shell', await page.locator('#shell').isVisible());
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('clovereye.settings')));
  check('kb: favourite saved', stored?.favourites?.length === 1, JSON.stringify(stored?.favourites));
  // Settings from the keyboard: the NSFW switch and its 18+ dialog
  const tabTo = async (key, max = 60) => {
    for (let i = 0; i < max; i++) {
      await k('Tab');
      if (await page.evaluate((want) => document.activeElement?.dataset?.key === want, key)) return true;
    }
    return false;
  };
  check('kb: Tab reaches Settings', await tabTo('settings'));
  await k('Enter'); await page.waitForSelector('.settings');
  found = await tabTo('switch-nsfw', 40);
  check('kb: Tab reaches NSFW switch', found);
  await k('Enter'); await settled(page);
  check('kb: Enter on switch opens 18+ dialog', await page.locator('#adultDialog').isVisible());
  check('kb: focus starts on 18+ checkbox', await page.evaluate(() => document.activeElement?.id === 'adultConfirm'));
  await k('Escape'); await settled(page);
  check('kb: Esc closes dialog only', !(await page.locator('#adultDialog').isVisible()) && (await page.locator('.settings').count()) === 1);
  check('kb: focus back on switch', await page.evaluate(() => document.activeElement?.dataset?.key === 'switch-nsfw'));
  await k('Space'); await settled(page);
  await k('Space'); // tick checkbox
  await k('Tab'); await k('Tab');
  const onConfirm = await page.evaluate(() => document.activeElement?.dataset?.act);
  await k('Enter'); await settled(page);
  check('kb: confirm via keyboard turns NSFW on', (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'true', `focus was ${onConfirm}`);
  check('kb: focus stays on the switch', await page.evaluate(() => document.activeElement?.dataset?.key === 'switch-nsfw'));
  await k('Space'); await settled(page); // off again
  check('kb: Space turns it off', (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'false');
  // Run setup again from keyboard
  found = await tabTo('rerun', 60);
  check('kb: Tab reaches Run setup again', found);
  await k('Enter');
  await page.waitForSelector('#setup:not([hidden])', { timeout: 3000 }).catch(() => {});
  check('kb: Run setup again opens setup', await page.locator('#setup').isVisible());
  await k('Escape'); await settled(page);
  await k('Tab'); // Keep going → Skip setup
  await k('Enter');
  await page.waitForSelector('#shell:not([hidden])', { timeout: 3000 }).catch(() => {});
  check('kb: Esc + Skip confirm returns to shell', await page.locator('#shell').isVisible());
  check('kb run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------------- failure mock states
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-boards=fail-once&mock-ffmpeg=missing');
  await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  await page.waitForSelector('[data-key="retry"]');
  check('boards failure shows Retry', await page.locator('[data-key="retry"]').isVisible());
  check('boards failure shows Skip this step', await page.locator('[data-key="skip-step"]').isVisible());
  await page.locator('[data-key="retry"]').click();
  await page.waitForSelector('.board-tile');
  check('Retry loads boards', (await page.locator('.board-tile').count()) === 53);
  await nextBtn(page).click(); await page.waitForSelector('.check');
  check('ffmpeg missing: all ✗', (await page.locator('.check[data-ok="false"]').count()) === 6);
  check('install command shown', (await page.locator('.command code').count()) === 1, await page.locator('.command code').textContent().catch(() => ''));
  check('Fedora without ffmpeg: ffmpeg-free first, RPM Fusion named', (await page.locator('.command code').textContent()) === 'sudo dnf install ffmpeg-free' && (await page.locator('.step').textContent()).includes('RPM Fusion'));
  check('fail run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-boards=fail');
  await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  await page.waitForSelector('[data-key="skip-step"]');
  await page.locator('[data-key="skip-step"]').click(); await settled(page);
  check('Skip this step → Video', (await stepLabel(page)).includes('Video'));
  for (let i = 0; i < 3; i++) { await nextBtn(page).click(); await settled(page); }
  check('Done offers the board list without favourites', (await nextBtn(page).textContent()).includes('board list'), await nextBtn(page).textContent());
  await nextBtn(page).click(); await page.waitForSelector('#shell:not([hidden])');
  check('shell after failed boards', await page.locator('#shell').isVisible());
  check('fail2 run: no console errors (expected none from mock)', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ------------------- NSFW off with no board list loaded (review finding 1)
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-delay=0');
  await page.waitForSelector('#setup:not([hidden])');
  // Skip setup, turn NSFW on in Settings, then pick /b/ in Run setup again.
  await page.keyboard.press('Escape'); await settled(page);
  await page.locator('#skipDialog [data-act="confirm"]').click(); await page.waitForSelector('#shell:not([hidden])');
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('[data-key="switch-nsfw"]').click();
  await page.locator('#adultConfirm').check();
  await page.locator('#adultDialog [data-act="confirm"]').click(); await settled(page);
  await page.locator('[data-key="rerun"]').click(); await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  await page.waitForSelector('.board-tile');
  check('nsfw: setup Boards shows all 77 once Settings allows it', (await page.locator('.board-tile').count()) === 77);
  await page.locator('[data-board="b"]').click();
  await page.locator('[data-board="g"]').click();
  for (let i = 0; i < 6 && !(await stepLabel(page)).includes('Done'); i++) { await nextBtn(page).click(); await settled(page); }
  await nextBtn(page).click(); await page.waitForSelector('#shell:not([hidden])');
  check('nsfw: opted-in /b/ favourite saved', JSON.stringify(JSON.parse(await page.evaluate(() => localStorage.getItem('clovereye.settings'))).favourites) === '["b","g"]');
  // Restart: no board list this session. Settings → NSFW off.
  await page.reload(); await page.waitForSelector('#shell:not([hidden])');
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('[data-key="switch-nsfw"]').click(); await settled(page);
  check('nsfw: switched off', (await page.locator('[data-key="switch-nsfw"]').getAttribute('aria-checked')) === 'false');
  const s = JSON.parse(await page.evaluate(() => localStorage.getItem('clovereye.settings')));
  check('nsfw: off drops /b/ without a board list', JSON.stringify(s.favourites) === '["g"]' && !s.nsfw.enabled, JSON.stringify(s.favourites));
  check('nsfw: rail has no /b/', (await page.locator('[data-key="fav-b"]').count()) === 0);
  await page.reload(); await page.waitForSelector('#shell:not([hidden])');
  check('nsfw: shell opens /g/, not /b/', (await page.locator('[data-key="fav-g"][aria-current="page"]').count()) === 1);
  check('nsfw run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ------------- a late board list after Skip leaves the shell alone (finding 2)
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-delay=1500');
  await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  check('late: Boards step loading', (await stepLabel(page)).includes('Boards') && (await page.locator('.board-grid--skeleton').count()) === 1);
  await page.keyboard.press('Escape'); await settled(page);
  await page.locator('#skipDialog [data-act="confirm"]').click(); await page.waitForSelector('#shell:not([hidden])');
  await page.locator('[data-key="settings"]').click(); await page.waitForSelector('.settings');
  await page.locator('[data-key="rerun"]').click(); await page.waitForSelector('#setup:not([hidden])');
  await page.waitForTimeout(2000); // the first wizard's fetch resolves now
  check('late: new wizard still on Welcome', (await stepLabel(page)).includes('Welcome'), await stepLabel(page));
  check('late: no stale Boards step drawn', (await page.locator('#stepHost .board-tile, #stepHost .board-grid').count()) === 0);
  check('late: title is the new wizard\'s', (await page.title()).startsWith('Setup · Welcome'), await page.title());
  check('late run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------- browsing: catalog and thread (C1)
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-delay=0');
  await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  await page.waitForSelector('.board-tile');
  await page.locator('[data-board="g"]').click();
  for (let i = 0; i < 6 && !(await stepLabel(page)).includes('Done'); i++) { await nextBtn(page).click(); await settled(page); }
  await nextBtn(page).click(); await page.waitForSelector('#shell:not([hidden])');
  await page.waitForSelector('.catalog-card');
  check('browse: /g/ catalog loads 15 threads', (await page.locator('.catalog-card').count()) === 15);
  check('browse: catalog cards show reply counts', /R \d+/.test(await page.locator('.catalog-card__counts').first().textContent()));
  check('browse: no placeholder text left', (await page.locator('text=arrives in the next phase').count()) === 0);
  await page.fill('[data-key="catalog-search"]', 'keyboard');
  await settled(page);
  const hits = await page.locator('.catalog-card').count();
  check('browse: search narrows the catalog', hits >= 1 && hits < 15, String(hits));
  check('browse: search box keeps focus while typing', await page.evaluate(() => document.activeElement?.dataset?.key === 'catalog-search'));
  await page.fill('[data-key="catalog-search"]', '');
  await settled(page);
  await page.selectOption('[data-key="catalog-sort"]', 'replies');
  await settled(page);
  const counts = await page.locator('.catalog-card__counts').allTextContents();
  const rs = counts.map((c) => Number((c.match(/R (\d+)/) || [])[1]));
  check('browse: sort by replies', rs.every((r, i) => i === 0 || rs[i - 1] >= r), rs.join(','));
  await page.selectOption('[data-key="catalog-sort"]', 'bump');
  await settled(page);
  // open the first thread that has replies listed
  const cards = page.locator('.catalog-card');
  let opened = false;
  for (let i = 0; i < 15 && !opened; i++) {
    await cards.nth(i).click();
    await page.waitForSelector('.thread .post', { timeout: 3000 }).catch(() => {});
    if ((await page.locator('.thread .post').count()) > 1 && (await page.locator('.thread .post__backlinks').count()) > 0) opened = true;
    else { await page.locator('[data-key="back-catalog"]').click(); await page.waitForSelector('.catalog-card'); }
  }
  check('browse: thread opens with OP and replies', opened);
  check('browse: OP is first', (await page.locator('.thread .post').first().getAttribute('class')).includes('post--op'));
  check('browse: title names the thread', ((await page.title()) || '').startsWith('/g/ · '), await page.title());
  const thumbs = page.locator('.thread .post__thumb');
  if (await thumbs.count()) {
    await thumbs.first().click(); await settled(page);
    check('browse: a file expands in place', (await page.locator('.thread .post__media').count()) === 1);
    await page.locator('.thread .post__media').first().evaluate((el) => { el.dataset.mark = 'kept'; });
    await page.waitForTimeout(11500); // past the thread's own 10 s update
    check('browse: an open file survives the auto-update (same element)', (await page.locator('.thread .post__media[data-mark="kept"]').count()) === 1);
    await page.locator('.thread .post__media').first().click(); await settled(page);
    check('browse: clicking it again collapses it', (await page.locator('.thread .post__media').count()) === 0);
  }
  const quote = page.locator('.thread .post__backlinks .seg-quotelink').first();
  check('browse: the thread has backlinks', (await quote.count()) === 1);
  if (await quote.count()) {
    await quote.click(); await page.waitForTimeout(400);
    check('browse: a backlink jumps to the replying post', (await page.locator('.post--flash').count()) >= 1);
  }
  await page.keyboard.press('Escape'); await page.waitForSelector('.catalog-card');
  check('browse: Esc goes back to the catalog', (await page.locator('.catalog-card').count()) === 15);
  await page.locator('[data-key="all-boards"]').click(); await page.waitForSelector('.board-list .rail__item');
  check('browse: All boards lists the worksafe boards', (await page.locator('.board-list .rail__item').count()) === 53);
  await page.locator('[data-key="list-diy"]').click(); await page.waitForSelector('.catalog-card');
  check('browse: another board opens its catalog', (await page.title()).startsWith('/diy/'));
  check('browse: mock made no outside request', page._outside.length === 0, page._outside.slice(0, 3).join(','));
  check('browse run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-delay=0&mock-catalog=fail');
  await page.waitForSelector('#setup:not([hidden])');
  await page.keyboard.press('Escape'); await settled(page);
  await page.locator('#skipDialog [data-act="confirm"]').click(); await page.waitForSelector('#shell:not([hidden])');
  await page.locator('[data-key="all-boards"]').click(); await page.waitForSelector('.board-list .rail__item');
  check('browse: board list loads from the shell when setup was skipped', (await page.locator('.board-list .rail__item').count()) === 53);
  await page.locator('[data-key="list-g"]').click();
  await page.waitForSelector('[data-key="retry-load"]');
  check('browse: a failed catalog says so and offers Try again', (await page.locator('.callout--danger').textContent()).includes('Couldn’t load the catalog'));
  check('browse fail run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ---------------- watcher, split view, sidebar, favourites, hover, posting
{
  const { ctx, page } = await newPage();
  await page.goto(BASE + '?mock-delay=0&mock-grow');
  await page.waitForSelector('#splash', { state: 'detached', timeout: 5000 });
  check('splash: startup animation removes itself', (await page.locator('#splash').count()) === 0);
  await page.waitForSelector('#setup:not([hidden])');
  for (let i = 0; i < 2; i++) { await nextBtn(page).click(); await settled(page); }
  await page.waitForSelector('.board-tile');
  await page.locator('[data-board="g"]').click();
  for (let i = 0; i < 6 && !(await stepLabel(page)).includes('Done'); i++) { await nextBtn(page).click(); await settled(page); }
  await nextBtn(page).click(); await page.waitForSelector('.catalog-card');
  // favourites from All boards
  await page.locator('[data-key="all-boards"]').click(); await page.waitForSelector('.board-list .star');
  await page.locator('[data-key="fav-toggle-diy"]').click(); await settled(page);
  check('fav: star adds /diy/ to the rail', (await page.locator('[data-key="fav-diy"]').count()) === 1);
  check('fav: star shows pressed', (await page.locator('[data-key="fav-toggle-diy"]').getAttribute('aria-pressed')) === 'true');
  await page.locator('[data-key="fav-toggle-g"]').click(); await settled(page);
  check('fav: star removes /g/', (await page.locator('[data-key="fav-g"]').count()) === 0);
  const favs = await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).favourites);
  check('fav: saved', JSON.stringify(favs) === '["diy"]', JSON.stringify(favs));
  await page.locator('[data-key="fav-toggle-g"]').click(); await settled(page);
  // sidebar
  await page.locator('[data-key="rail-toggle"]').click(); await settled(page);
  check('sidebar: hidden', !(await page.locator('.rail').isVisible()));
  await page.reload(); await page.waitForSelector('#shell:not([hidden])');
  check('sidebar: stays hidden after a reload', !(await page.locator('.rail').isVisible()));
  await page.locator('[data-key="rail-toggle"]').click(); await settled(page);
  check('sidebar: shown again', await page.locator('.rail').isVisible());
  // watcher
  await page.locator('[data-key="fav-g"]').click(); await page.waitForSelector('.catalog-card');
  const firstNo = await page.locator('.catalog-card').nth(1).getAttribute('data-key');
  await page.locator('.catalog-card').nth(1).click(); await page.waitForSelector('.thread .post');
  await page.locator('[data-key="thread-watch"]').click(); await settled(page);
  check('watch: thread listed in the rail', (await page.locator('[data-key^="watched-g-"]').count()) === 1);
  check('watch: button says Watching', (await page.locator('[data-key="thread-watch"]').textContent()).includes('Watching'));
  await page.locator('[data-key="back-catalog"]').click(); await page.waitForSelector('.catalog-card');
  // the watcher asks again after the interval (10 s): a new reply arrives
  await page.waitForSelector('[data-key^="watched-g-"] .badge', { timeout: 30000 }).catch(() => {});
  const badge = await page.locator('[data-key^="watched-g-"] .badge').textContent().catch(() => '');
  check('watch: unread badge after the watcher polls', Number(badge) >= 1, `badge "${badge}"`);
  await page.locator('[data-key^="watched-g-"]').click(); await page.waitForSelector('.thread .post');
  await settled(page);
  check('watch: opening the thread clears the badge', (await page.locator('[data-key^="watched-g-"] .badge').count()) === 0);
  check('watch: saved', await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).watched.length === 1));
  // replying from inside the app: the form, the captcha, a file
  await page.locator('[data-key="thread-reply"]').click();
  await page.waitForSelector('.composer .captcha__stage');
  check('post: Reply opens the in-app form with the site’s captcha', (await page.locator('.composer').count()) === 1 && (await page.locator('.captcha__prompt').textContent()) === 'Pick the 3');
  check('post: the object to find shows beside the choice', (await page.locator('[data-key="compose-target"] img').count()) === 1 && (await page.locator('.captcha__prompt').textContent()) === 'Pick the 3');
  check('post: a question in words opens on the first choice’s picture', (await page.locator('.captcha__stage img.captcha__img').count()) === 1 && (await page.locator('[data-key="compose-slider"]').inputValue()) === '1');
  await page.locator('.thread .post__no--reply').nth(1).click(); await settled(page);
  const quoted = await page.locator('[data-key="compose-com"]').inputValue();
  check('post: a post’s No. quotes it in the form', /^>>\d+\n/.test(quoted), JSON.stringify(quoted));
  await page.locator('[data-key="compose-com"]').fill('');
  await page.locator('[data-key="compose-submit"]').click(); await settled(page);
  check('post: an empty post is stopped before sending', (await page.locator('.composer__problems').textContent()).includes('Write a comment'));
  await page.locator('[data-key="compose-com"]').fill('Testing the reply form.');
  await page.locator('[data-key="compose-file"]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0]) });
  await settled(page);
  check('post: the attached file is listed', (await page.locator('.composer__filename').textContent()).includes('pic.png'));
  // a wrong answer: the 1st choice, then the 1st choice
  const solve = async (picks) => {
    for (const n of picks) {
      await page.locator('[data-key="compose-slider"]').focus();
      await page.locator('[data-key="compose-slider"]').fill(String(n));
      await page.locator('[data-key="compose-captcha-next"]').click();
      await settled(page);
    }
  };
  await page.locator('[data-key="compose-submit"]').click(); await settled(page);
  check('post: an unfinished captcha is stopped before sending', (await page.locator('.composer__problems').textContent()).includes('Finish the captcha'));
  await solve([1, 1]);
  check('post: each step is kept in the progress row', (await page.locator('.captcha__steps li.done').count()) === 2);
  await page.locator('[data-key="compose-submit"]').click(); await page.waitForTimeout(700);
  check('post: the site’s error comes back into the form', (await page.locator('.composer__msg').textContent()).includes('mistyped'));
  check('post: the text is kept after an error', (await page.locator('[data-key="compose-com"]').inputValue()) === 'Testing the reply form.');
  await page.waitForSelector('[data-key="compose-slider"]');
  // minimise: only the title bar shows, everything stays
  await page.locator('[data-key="compose-min"]').click(); await settled(page);
  check('post: the form minimises to its title bar', (await page.locator('.composer--min').count()) === 1 && !(await page.locator('.composer__body').isVisible()));
  await page.locator('[data-key="compose-restore"]').click(); await settled(page);
  check('post: it opens again with the text in place', (await page.locator('.composer__body').isVisible()) && (await page.locator('[data-key="compose-com"]').inputValue()) === 'Testing the reply form.');
  await page.waitForTimeout(500);
  check('post: the draft is saved as it is typed', await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('clovereye-drafts') || '{}')).some((d) => d.com === 'Testing the reply form.')));
  await page.waitForSelector('[data-key="compose-slider"]');
  // the keyboard way: arrows through the choices, Enter keeps one
  await page.locator('[data-key="compose-slider"]').focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowRight'); // a question in words opens on choice 1
  await page.keyboard.press('Enter'); await settled(page);
  check('post: ←/→ and Enter answer a step', (await page.locator('.captcha__steps li.done').count()) === 1);
  await solve([2]);
  await page.locator('[data-key="compose-submit"]').click(); await page.waitForTimeout(800);
  check('post: a solved captcha posts and closes the form', (await page.locator('.composer').count()) === 0);
  const sent = await page.evaluate(() => window.__ceLastPost || null);
  void sent;
  const youSaved = await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).yous.length === 1);
  check('post: the post is remembered as (You)', youSaved);
  // gallery: G opens every file of the thread
  await page.keyboard.press('g');
  await page.waitForSelector('.gallery .gallery__media', { timeout: 3000 }).catch(() => {});
  const total = await page.locator('.gallery__thumb').count();
  check('gallery: G opens the thread’s files', total >= 1, String(total));
  const c1 = await page.locator('.gallery__count').textContent();
  await page.keyboard.press('ArrowRight');
  const c2 = await page.locator('.gallery__count').textContent();
  check('gallery: → moves to the next file', total < 2 || c1 !== c2, `${c1} → ${c2}`);
  await page.locator('.gallery__stage').hover();
  await page.mouse.wheel(0, 120); await page.waitForTimeout(250);
  const c3 = await page.locator('.gallery__count').textContent();
  check('gallery: the mouse wheel moves too', total < 3 || c3 !== c2, `${c2} → ${c3}`);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), page.keyboard.press('d')]);
  check('gallery: D saves the file', Boolean(download));
  await page.waitForSelector('.gallery__save[data-state="saved"]', { timeout: 3000 }).catch(() => {});
  check('gallery: the save button shows the download landed', (await page.locator('.gallery__save').getAttribute('data-state')) === 'saved');
  check('gallery: the saved file is marked in the strip', (await page.locator('.gallery__thumb[aria-selected="true"] .gallery__saved').count()) === 1);
  await page.waitForSelector('.gallery__save[data-state="idle"]', { timeout: 4000 }).catch(() => {});
  check('gallery: the save button settles back', (await page.locator('.gallery__save').getAttribute('data-state')) === 'idle');
  await page.keyboard.press('Escape'); await settled(page);
  check('gallery: Esc closes it', (await page.locator('.gallery').count()) === 0);
  // panes: up to five, in one to three rows
  await page.locator('[data-key="back-catalog"]').click(); await page.waitForSelector('.catalog-card');
  await page.locator('.catalog__item [data-key^="beside-"]').nth(2).click();
  await page.waitForSelector('[data-pane="1"] .thread .post');
  check('panes: a thread opens in a second pane', (await page.locator('.pane').count()) === 2);
  await page.locator('[data-pane="0"] .catalog-card').nth(3).click({ modifiers: ['Control'] });
  await page.waitForSelector('[data-pane="1"] .thread .post');
  check('panes: Ctrl+click opens another pane beside', (await page.locator('.pane').count()) === 3);
  await page.locator('[data-key="panel-toggle"]').click(); await settled(page);
  await page.locator('[data-key="panel-toggle"]').click(); await settled(page);
  check('panes: five panes', (await page.locator('.pane').count()) === 5);
  await page.locator('[data-key="rows-2"]').click(); await settled(page);
  check('panes: two rows', (await page.locator('.workspace__row').count()) === 2);
  await page.locator('[data-key="rows-3"]').click(); await settled(page);
  check('panes: three rows', (await page.locator('.workspace__row').count()) === 3);
  check('panes: rows saved', await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).ui.rows === 3));
  const popup = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await page.locator('[data-key="panel-toggle"]').click(); // a sixth goes to a new window
  const win = await popup;
  check('windows: a sixth pane opens in a new window', Boolean(win) && (win?.url() || '').includes('#panes='), win?.url());
  if (win) {
    await win.waitForSelector('.pane', { timeout: 5000 }).catch(() => {});
    check('windows: the new window shows its pane, without setup', (await win.locator('.pane').count()) === 1 && !(await win.locator('#setup').isVisible()));
    await win.close();
  }
  const pop2 = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await page.locator('[data-key="p1-pane-popout"]').click();
  const win2 = await pop2;
  check('windows: a pane pops out into its own window', Boolean(win2) && (await page.locator('.pane').count()) === 4);
  await win2?.close();
  for (let i = 0; i < 6 && (await page.locator('[data-key="p1-pane-close"]').count()); i++) {
    await page.locator('[data-key="p1-pane-close"]').click(); await settled(page);
  }
  check('panes: closed back to one', (await page.locator('.pane').count()) === 1);
  // hover preview
  if (await page.locator('[data-key="back-catalog"]').count()) await page.locator('[data-key="back-catalog"]').click();
  await page.waitForSelector('.catalog-card');
  // scrolling hides a preview on purpose, so scroll first, then rest the mouse
  await page.locator('.catalog-card__thumb[data-preview]').first().scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1); await settled(page);
  await page.locator('.catalog-card__thumb[data-preview]').first().hover();
  await page.waitForSelector('.hover-preview:not([hidden])', { timeout: 2000 }).catch(() => {});
  const box = await page.locator('.hover-preview').evaluate((el) => (el.hidden ? null : el.getBoundingClientRect().toJSON()));
  const vp = page.viewportSize();
  check('hover: the full file shows beside the pointer', Boolean(box));
  check('hover: it fits inside the window', box && box.left >= 0 && box.top >= 0 && box.right <= vp.width && box.bottom <= vp.height, JSON.stringify(box));
  await page.mouse.move(1, 1); await settled(page);
  check('hover: leaving hides it', await page.locator('.hover-preview').evaluate((el) => el.hidden));
  check('watch/split run: mock made no outside request', page._outside.length === 0, page._outside.slice(0, 3).join(','));
  check('watch/split run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  void firstNo;
  await ctx.close();
}

// ---------------------------------------------------- the wait, and drafts
{
  const { ctx, page } = await newPage();
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'thread', board: 'g', no: 500073 }]));
  await page.goto(`${BASE}?mock-delay=0&mock-captcha=wait#panes=${panes}`);
  await page.waitForSelector('[data-key="thread-reply"]');
  await page.locator('[data-key="thread-reply"]').click();
  await page.waitForSelector('[data-captcha-wait]');
  const secs = async () => Number(((await page.locator('[data-captcha-wait]').textContent()) || '').replace(/\D+/g, '') || 0);
  const w1 = await secs();
  await page.waitForTimeout(2600);
  const w2 = await secs();
  check('wait: the site’s wait counts down live', w1 > 0 && w2 > 0 && w2 <= w1 - 2, `${w1} → ${w2}`);
  await page.locator('[data-key="compose-min"]').click(); await settled(page);
  const n1 = await page.locator('[data-compose-note]').textContent();
  await page.waitForTimeout(1200);
  const n2 = await page.locator('[data-compose-note]').textContent();
  check('wait: a minimised form shows the wait in its title bar, live', /^Wait \d+ s$/.test(n1) && n1 !== n2, `${n1} → ${n2}`);
  await page.locator('[data-key="compose-restore"]').click(); await settled(page);
  await page.locator('[data-key="compose-com"]').fill('A draft that survives closing.');
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('[data-key="thread-reply"]');
  await page.locator('[data-key="thread-reply"]').click();
  await page.waitForSelector('[data-key="compose-com"]');
  check('drafts: the text is back after the app was closed', (await page.locator('[data-key="compose-com"]').inputValue()) === 'A draft that survives closing.');
  // flags (/int/, /bant/): the preview shows the code, its name on hover
  const flags = await page.locator('.post__flag').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  check('flags: country and board flags show on posts', flags.includes('New Zealand') && flags.includes('Templar'), flags.join(','));
  // the reply form resizes from its corner grip, and keeps the size
  await page.waitForSelector('[data-captcha-wait]'); // the form has settled
  const before = await page.locator('.composer').boundingBox();
  const g = await page.locator('[data-key="compose-grip"]').boundingBox();
  await page.mouse.move(g.x + 5, g.y + 5);
  await page.mouse.down();
  await page.mouse.move(g.x - 115, g.y - 75, { steps: 5 });
  await page.mouse.up();
  const after = await page.locator('.composer').boundingBox();
  check('reply form: dragging the corner grip resizes it', after.width >= before.width + 100 && after.height >= before.height + 50, `${Math.round(before.width)}x${Math.round(before.height)} → ${Math.round(after.width)}x${Math.round(after.height)}`);
  check('reply form: the size is kept', await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('clovereye-composer-size') || 'null')?.w)));
  await page.locator('[data-key="compose-close"]').click(); await settled(page);
  // the thread's controls: tucked while scrolling down, back on the way up,
  // at the end, and when pointed at
  const body = page.locator('.centre__body').first();
  const bar = page.locator('[data-thread-tools]').first();
  const scrollTo = async (y) => {
    await body.evaluate((el, v) => {
      el.scrollTop = v === 'end' ? el.scrollHeight : v;
      el.dispatchEvent(new Event('scroll'));
    }, y);
    await page.waitForTimeout(250);
  };
  const tuckedNow = () => bar.evaluate((el) => el.classList.contains('is-tucked'));
  const room = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  check('thread tools: the thread is long enough to scroll', room > 250, String(room));
  await scrollTo(60); await scrollTo(220);
  check('thread tools: scrolling down tucks them away', await tuckedNow());
  check('thread tools: they stay at the top of the pane', (await bar.boundingBox()).y < (await body.boundingBox()).y + 10);
  // a plain pointer move: Playwright's hover() would scroll the pane first
  const bb = await bar.boundingBox();
  await page.mouse.move(bb.x + 40, bb.y + bb.height - 3); await page.waitForTimeout(300);
  check('thread tools: pointing at them brings them back', await bar.evaluate((el) => getComputedStyle(el).opacity === '1'));
  await page.mouse.move(640, 600);
  await scrollTo(140);
  check('thread tools: scrolling up brings them back', !(await tuckedNow()));
  await scrollTo(200); await scrollTo('end');
  check('thread tools: reaching the end brings them back', !(await tuckedNow()));
  check('wait/drafts run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

// ------------------------------------------------- languages and version
{
  const { ctx, page } = await newPage({ width: 360, height: 760 });
  const panes = encodeURIComponent(JSON.stringify([{ kind: 'thread', board: 'g', no: 500073 }]));
  await page.goto(`${BASE}?mock-delay=0#panes=${panes}`);
  await page.waitForSelector('[data-key="thread-reply"]');
  const comBefore = await page.locator('.post__com').first().textContent();
  if (await page.locator('[data-key="rail-toggle"]').isVisible()) await page.locator('[data-key="rail-toggle"]').click();
  await page.locator('[data-key="settings"]').click();
  await page.waitForSelector('[data-key="set-lang"]');
  check('version: Settings shows it', (await page.locator('[data-key="version"]').textContent()).trim() === 'CloverEye 0.1.1');
  const es = JSON.parse(await (await page.request.get(`${BASE}i18n/es.json`)).text());
  await page.locator('[data-key="set-lang"]').selectOption('es');
  await page.waitForFunction(() => document.documentElement.lang === 'es');
  await settled(page);
  check('languages: Settings turns Spanish', (await page.locator('#set-look').textContent()) === es.Look && (await page.locator('#set-about').textContent()) === es.About);
  check('languages: the setting is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('clovereye.settings')).lang === 'es'));
  for (const code of ['ja', 'ru', 'pt-BR']) {
    await page.locator('[data-key="set-lang"]').selectOption(code);
    await page.waitForFunction((c) => document.documentElement.lang === c, code);
    await settled(page);
    const table = JSON.parse(await (await page.request.get(`${BASE}i18n/${code}.json`)).text());
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`languages: ${code} at 360 px, translated and no sideways scroll`, (await page.locator('#set-look').textContent()) === table.Look && !wide);
  }
  // back to the thread: the app's words change, the posts never do
  await page.goto(`${BASE}?mock-delay=0&again=1#panes=${panes}`);
  await page.waitForSelector('[data-key="thread-reply"]');
  const pt = JSON.parse(await (await page.request.get(`${BASE}i18n/pt-BR.json`)).text());
  check('languages: the thread’s buttons follow the language', (await page.locator('[data-key="thread-reply"]').textContent()).trim() === pt.Reply);
  check('languages: posts keep their own words', (await page.locator('.post__com').first().textContent()) === comBefore);
  if (!(await page.locator('[data-key="settings"]').isVisible())) await page.locator('[data-key="rail-toggle"]').click();
  await page.locator('[data-key="settings"]').click();
  await page.waitForSelector('[data-key="set-lang"]');
  await page.locator('[data-key="set-lang"]').selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await settled(page);
  check('languages: back to English', (await page.locator('#set-look').textContent()) === 'Look');
  check('languages run: no console errors', page._errors.length === 0, page._errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(results.join('\n'));
console.log(`\n${which}: ${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
