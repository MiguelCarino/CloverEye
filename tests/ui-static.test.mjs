// Static checks on ui/ and src-tauri/: no outside requests, no fleet
// branding, every referenced file exists, fixtures stay in sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STEPS } from '../ui/js/setup-model.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(ROOT, 'ui');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'target' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const textFiles = (dir) => walk(dir).filter((p) => /\.(html|css|js|mjs|json|svg|rs|toml)$/.test(p));

test('the board fixture shipped with the UI mock equals the recorded one', () => {
  const a = readFileSync(join(UI, 'data/boards.sample.json'), 'utf8');
  const b = readFileSync(join(ROOT, 'crates/fetch/tests/fixtures/boards.json'), 'utf8');
  assert.equal(a, b);
});

test('the UI makes no outside requests: only allowed hosts appear', () => {
  const allowed = [
    'https://www.4chan.org/rules', // opened in the system browser, never fetched
    'https://4stats.io/', // Stats → Boards: opened in the system browser, never fetched
    // reverse image search (sauce-model.js): opened in the system browser, never fetched
    'https://saucenao.com/search.php',
    'https://lens.google.com/uploadbyurl',
    'https://yandex.com/images/search',
    'https://iqdb.org/',
    'https://tineye.com/search',
    'https://trace.moe/',
    'https://i.4cdn.org', // CSP: media for C1
    // embeds (link-model.js): CSP frame-src; a frame loads only after Embed is clicked
    'https://www.youtube-nocookie.com',
    'https://player.vimeo.com',
    'https://streamable.com',
    'https://w.soundcloud.com',
    'https://soundcloud.com/', // the page a SoundCloud player is asked for, never fetched
    'https://s.4cdn.org',
    'http://ipc.localhost', // Tauri IPC
    'http://cesaved.localhost', // saved threads' files, the app's own scheme (Windows form; offline.rs)
    'http://www.w3.org/2000/svg', // SVG namespace
  ];
  for (const f of textFiles(UI)) {
    if (f.endsWith('boards.sample.json')) continue; // recorded data, not loaded from anywhere
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`)<>]*/gi)) {
      const url = m[0];
      if (url.startsWith('//') && !/^\/\/[a-z0-9-]+\.[a-z0-9.-]+\//i.test(url)) continue; // comment text
      assert.ok(
        allowed.some((a) => url.startsWith(a)),
        `${relative(ROOT, f)}: unexpected URL ${url}`,
      );
    }
    assert.ok(!/fonts\.googleapis|cdnjs|jsdelivr|unpkg/.test(src), `${relative(ROOT, f)} loads from a CDN`);
  }
});

test('no fleet branding in the app', () => {
  for (const f of [...textFiles(UI), ...textFiles(join(ROOT, 'src-tauri'))]) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/carino/i.test(src), `${relative(ROOT, f)} mentions the fleet`);
  }
});

test('every file index.html references exists', () => {
  const html = readFileSync(join(UI, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const r of refs) assert.ok(existsSync(join(UI, r)), `missing ${r}`);
});

test('every ES module import resolves', () => {
  for (const f of walk(join(UI, 'js'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)) {
      assert.ok(existsSync(resolve(dirname(f), m[1])), `${relative(ROOT, f)} imports missing ${m[1]}`);
    }
  }
});

test('fonts are self-hosted with their licences', () => {
  const css = readFileSync(join(UI, 'css/tokens.css'), 'utf8');
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
  assert.equal(urls.length, 3);
  for (const u of urls) {
    const p = resolve(join(UI, 'css'), u);
    assert.ok(existsSync(p), u);
    assert.ok(statSync(p).size > 50_000, `${u} looks truncated`);
  }
  for (const lic of ['Inter-OFL.txt', 'NotoSansMono-OFL.txt']) {
    assert.match(readFileSync(join(UI, 'fonts', lic), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});

test('every setup step has a renderer', () => {
  const src = readFileSync(join(UI, 'js/setup.js'), 'utf8');
  const block = src.slice(src.indexOf('const RENDER = {'));
  for (const s of STEPS) assert.match(block, new RegExp(`\\n    ${s.id}\\(\\) \\{`), s.id);
});

test('tokens: dark default, light theme, system follow, density, reduced motion', () => {
  const css = readFileSync(join(UI, 'css/tokens.css'), 'utf8');
  assert.match(css, /:root \{[\s\S]*color-scheme: dark;/);
  assert.match(css, /:root\[data-theme='light'\]/);
  assert.match(css, /@media \(prefers-color-scheme: light\)[\s\S]*:root\[data-theme='system'\]/);
  assert.match(css, /:root\[data-density='compact'\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  for (const t of ['--radius-md', '--space-4', '--fs-base', '--accent', '--text-scale', '--post-bg', '--quotelink']) assert.ok(css.includes(t), t);
  assert.match(css, /--dur-fast: 150ms;/);
  assert.match(css, /--dur-slow: 200ms;/);
});

test('themes.css has a block for every theme the picker offers', async () => {
  const { THEMES } = await import('../ui/js/setup-model.js');
  const css = readFileSync(join(UI, 'css/themes.css'), 'utf8');
  for (const id of THEMES.filter((t) => !['system', 'dark', 'light'].includes(t))) {
    assert.ok(css.includes(`:root[data-theme='${id}']`), id);
  }
  const html = readFileSync(join(UI, 'index.html'), 'utf8');
  assert.ok(html.indexOf('css/tokens.css') < html.indexOf('css/themes.css') && html.indexOf('css/themes.css') < html.indexOf('css/app.css'));
});

test('the icon is a golden clover, never green', () => {
  const svg = readFileSync(join(UI, 'assets/icon.svg'), 'utf8');
  assert.match(svg, /id="ce-leaf"/, 'four leaves drawn from one leaf');
  assert.equal((svg.match(/href="#ce-leaf"/g) || []).length, 4);
  assert.match(svg, /id="ce-gold"/);
  for (const [, hex] of svg.matchAll(/#([0-9a-f]{6})\b/gi)) {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    assert.ok(!(g > r + 20 && g > b + 20), `green-dominant colour #${hex}`);
  }
  for (const name of ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns']) {
    assert.ok(existsSync(join(ROOT, 'src-tauri/icons', name)), name);
  }
});

test('tauri config: neutral id, custom title bar, UI from ../ui, CSP set', () => {
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(conf.productName, 'CloverEye');
  assert.equal(conf.build.frontendDist, '../ui');
  assert.equal(conf.app.windows[0].decorations, false);
  assert.equal(conf.app.withGlobalTauri, true);
  assert.match(conf.identifier, /^[a-z]+(\.[a-z]+)+$/);
  assert.ok(conf.app.security.csp);
  const cap = JSON.parse(readFileSync(join(ROOT, 'src-tauri/capabilities/default.json'), 'utf8'));
  const perms = cap.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const c of ['allow-get-settings', 'allow-set-settings', 'allow-check-ffmpeg', 'allow-fetch-boards', 'allow-fetch-catalog', 'allow-fetch-thread', 'allow-open-post-window']) {
    assert.ok(perms.includes(c), c);
  }
  const build = readFileSync(join(ROOT, 'src-tauri/build.rs'), 'utf8');
  for (const c of ['get_settings', 'set_settings', 'check_ffmpeg', 'fetch_boards', 'fetch_catalog', 'fetch_thread', 'open_post_window']) assert.ok(build.includes(`"${c}"`), c);
  const main = readFileSync(join(ROOT, 'src-tauri/src/main.rs'), 'utf8');
  for (const c of ['get_settings', 'set_settings', 'check_ffmpeg', 'fetch_boards', 'fetch_catalog', 'fetch_thread', 'open_post_window']) assert.match(main, new RegExp(`fn ${c}\\(`), c);
  assert.ok(!/Command::new\("(sudo|pkexec|dnf|apt|apt-get|brew|winget|pacman|zypper)"/.test(main), 'never runs a package manager');
});

test("every module that calls one of dom.js's helpers imports it", () => {
  // A missing import only fails when that line runs (the gallery's videos
  // once threw "Can't find variable: autoplay"), so it is checked here.
  const dom = readFileSync(join(UI, 'js/dom.js'), 'utf8');
  const helpers = [...dom.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  const missing = [];
  for (const file of walk(join(UI, 'js')).filter((p) => p.endsWith('.js') && !p.endsWith('/dom.js'))) {
    const src = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const imported = new Set(
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/dom\.js'/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())),
    );
    for (const name of helpers) {
      const called = new RegExp(`(^|[^\\w.$'"])${name}\\(`).test(src);
      const local = new RegExp(`(function|const|let|var)\\s+${name}\\b|[(,]\\s*${name}\\s*[,)=]`).test(src);
      if (called && !local && !imported.has(name)) missing.push(`${relative(ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
