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

await browser.close();
console.log(results.join('\n'));
console.log(`\n${which}: ${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
