import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as M from '../ui/js/setup-model.js';

const boards = JSON.parse(readFileSync(new URL('../ui/data/boards.sample.json', import.meta.url))).boards;
const now = new Date('2026-11-04T12:00:00Z');

test('nine steps: seven from version 1, Your stats from 2, Assistant from 3; NSFW is not one of them', () => {
  assert.deepEqual(
    M.STEPS.map((s) => s.id),
    ['welcome', 'look', 'boards', 'video', 'watching', 'files', 'stats', 'assistant', 'done'],
  );
  const since = { stats: 2, assistant: 3 };
  assert.ok(M.STEPS.every((s) => s.label && s.since === (since[s.id] || 1)));
  assert.equal(M.SETUP_VERSION, 3);
});

test('upgrading: only the steps added since, then Done, once', () => {
  const v1done = M.completeSetup(M.defaults(), { now, version: 1 });
  assert.equal(M.needsSetup(v1done), true);
  assert.deepEqual(M.stepsToShow(v1done).map((s) => s.id), ['stats', 'assistant', 'done']);
  const v2done = M.completeSetup(M.defaults(), { now, version: 2 });
  assert.deepEqual(M.stepsToShow(v2done).map((s) => s.id), ['assistant', 'done']);
  const v3done = M.completeSetup(v1done, { now });
  assert.equal(v3done.setupVersion, 3);
  assert.equal(M.needsSetup(v3done), false);
  assert.deepEqual(M.stepsToShow(v3done), [], 'not shown again');
  // never finished: the whole flow, the new steps included
  assert.deepEqual(M.stepsToShow(M.defaults()).map((s) => s.id).slice(-3), ['stats', 'assistant', 'done']);
  // the answers given in version 1 are kept
  const old = M.completeSetup({ ...M.defaults(), favourites: ['g'], theme: 'light' }, { now, version: 1 });
  const up = M.completeSetup({ ...old, stats: { ...old.stats, mine: true } }, { now });
  assert.deepEqual(up.favourites, ['g']);
  assert.equal(up.theme, 'light');
  assert.equal(up.stats.mine, true);
});

test('stats settings: everything off by default, junk falls back', () => {
  assert.deepEqual(M.defaults().stats, { track: false, scope: 'favourites', intervalMin: 5, mine: false });
  assert.deepEqual(M.normalizeSettings({}).stats, M.defaults().stats);
  assert.deepEqual(M.normalizeSettings({ stats: { track: true, scope: 'visible', intervalMin: 30, mine: true } }).stats, { track: true, scope: 'visible', intervalMin: 30, mine: true });
  assert.deepEqual(M.normalizeSettings({ stats: { track: 'yes', scope: 'nsfw', intervalMin: 1, mine: 1, samples: [1, 2] } }).stats, M.defaults().stats);
  assert.deepEqual(M.normalizeSettings({ stats: 'on' }).stats, M.defaults().stats);
  assert.ok(!('samples' in M.normalizeSettings({ stats: { samples: [1] } }).stats), 'no samples in settings');
});

test('defaults: worksafe only, no favourites, 10 s, metadata stripped, memory cache, system theme', () => {
  const d = M.defaults();
  assert.equal(d.setupVersion, 0);
  assert.equal(d.theme, 'system');
  assert.equal(d.density, 'comfortable');
  assert.equal(d.textScale, 1);
  assert.deepEqual(d.nsfw, { enabled: false, confirmedAdultAt: null });
  assert.deepEqual(d.favourites, []);
  assert.equal(d.watch.intervalSec, 10);
  assert.equal(d.watch.notifyReplies, false);
  assert.equal(d.files.stripMetadata, true);
  assert.equal(d.files.cache, 'memory');
  assert.notEqual(M.defaults(), M.defaults(), 'a fresh object each time');
});

test('normalizeSettings repairs garbage and unknown values', () => {
  assert.deepEqual(M.normalizeSettings(null), M.defaults());
  assert.deepEqual(M.normalizeSettings('nope'), M.defaults());
  const s = M.normalizeSettings({
    theme: 'neon',
    density: 'cosy',
    textScale: 1.13,
    favourites: ['g', 'g', '../etc', 'VIP', 'diy', 7],
    watch: { intervalSec: 3, notifyReplies: 'yes', keepInTray: true },
    files: { downloadDir: '  /home/me/dl  ', stripMetadata: false, cache: 'disk', cacheCapMB: 999 },
    extra: 'dropped',
  });
  assert.equal(s.theme, 'system');
  assert.equal(s.density, 'comfortable');
  assert.equal(s.textScale, 1.125);
  assert.deepEqual(s.favourites, ['g', 'diy']);
  assert.equal(s.watch.intervalSec, 10, 'below the API floor is raised to 10 s');
  assert.equal(s.watch.notifyReplies, false);
  assert.equal(s.watch.keepInTray, true);
  assert.equal(s.files.downloadDir, '/home/me/dl');
  assert.equal(s.files.stripMetadata, false);
  assert.equal(s.files.cache, 'memory');
  assert.equal(s.files.cacheCapMB, 256);
  assert.equal('extra' in s, false);
});

test('normalizeSettings never turns NSFW on without the 18+ date', () => {
  assert.equal(M.normalizeSettings({ nsfw: { enabled: true } }).nsfw.enabled, false);
  assert.equal(M.normalizeSettings({ nsfw: { enabled: true, confirmedAdultAt: '' } }).nsfw.enabled, false);
  const ok = M.normalizeSettings({ nsfw: { enabled: true, confirmedAdultAt: now.toISOString() } });
  assert.equal(ok.nsfw.enabled, true);
});

test('interval clamps to 10..3600 and rounds', () => {
  assert.equal(M.clampInterval(0), 10);
  assert.equal(M.clampInterval(9.6), 10);
  assert.equal(M.clampInterval(12.4), 12);
  assert.equal(M.clampInterval(99999), 3600);
  assert.equal(M.clampInterval('abc'), 10);
});

test('watching step: under 10 s, fractions and empty values are refused', () => {
  const s = M.defaults();
  for (const [v, msg] of [
    [9, /minimum is 10/],
    [0, /minimum is 10/],
    [10.5, /whole number/],
    [NaN, /whole number/],
    [4000, /maximum/],
  ]) {
    s.watch.intervalSec = v;
    const r = M.validateStep('watching', s);
    assert.equal(r.ok, false, String(v));
    assert.match(r.errors.intervalSec, msg);
  }
  s.watch.intervalSec = 10;
  assert.equal(M.validateStep('watching', s).ok, true);
  s.watch.intervalSec = 60;
  assert.equal(M.validateStep('watching', s).ok, true);
});

test('content step: NSFW on without confirmation is invalid', () => {
  const s = M.defaults();
  assert.equal(M.validateStep('content', s).ok, true);
  s.nsfw.enabled = true;
  assert.equal(M.validateStep('content', s).ok, false);
  s.nsfw.confirmedAdultAt = now.toISOString();
  assert.equal(M.validateStep('content', s).ok, true);
});

test('files step: bad paths and cache sizes are refused', () => {
  const s = M.defaults();
  assert.equal(M.validateStep('files', s).ok, true);
  s.files.downloadDir = 'a\0b';
  assert.equal(M.validateStep('files', s).ok, false);
  s.files.downloadDir = '';
  s.files.cache = 'temp';
  s.files.cacheCapMB = 300;
  assert.equal(M.validateStep('files', s).errors.cacheCapMB, 'Pick a cache size.');
  s.files.cacheCapMB = 512;
  assert.equal(M.validateStep('files', s).ok, true);
});

test('steps with nothing to validate are always ok', () => {
  for (const id of ['welcome', 'look', 'video', 'done']) assert.equal(M.validateStep(id, M.defaults()).ok, true);
});

test('setNsfw needs the explicit 18+ confirmation', () => {
  const s = M.defaults();
  assert.equal(M.setNsfw(s, true), s, 'no confirmation: unchanged');
  assert.equal(M.setNsfw(s, true, { confirmedAdult: false }).nsfw.enabled, false);
  const on = M.setNsfw(s, true, { confirmedAdult: true, now });
  assert.deepEqual(on.nsfw, { enabled: true, confirmedAdultAt: '2026-11-04T12:00:00.000Z' });
  assert.equal(M.nsfwVisible(on), true);
});

test('turning NSFW off forgets the confirmation and drops NSFW favourites', () => {
  let s = M.setNsfw(M.defaults(), true, { confirmedAdult: true, now });
  s = M.toggleFavourite(M.toggleFavourite(s, 'g'), 'gif');
  assert.deepEqual(s.favourites, ['g', 'gif']);
  const off = M.setNsfw(s, false, { boards });
  assert.deepEqual(off.nsfw, { enabled: false, confirmedAdultAt: null });
  assert.deepEqual(off.favourites, ['g'], '/gif/ is ws_board 0');
});

test('visible boards: worksafe only by default, all with the opt-in', () => {
  const d = M.defaults();
  const ws = M.visibleBoards(boards, d);
  assert.ok(ws.length > 0 && ws.length < boards.length);
  assert.ok(ws.every((b) => b.ws_board === 1));
  assert.ok(ws.some((b) => b.board === 'g'));
  assert.ok(!ws.some((b) => b.board === 'gif'));
  assert.equal(M.hiddenBoardCount(boards, d), boards.length - ws.length);
  const on = M.setNsfw(d, true, { confirmedAdult: true, now });
  assert.equal(M.visibleBoards(boards, on).length, boards.length);
  assert.equal(M.hiddenBoardCount(boards, on), 0);
  // enabled flag without the date (tampered storage) still hides them
  assert.equal(M.visibleBoards(boards, { nsfw: { enabled: true, confirmedAdultAt: null } }).length, ws.length);
  assert.deepEqual(M.visibleBoards(null, d), []);
});

test('pruneFavourites drops invisible boards, keeps order, and is a no-op without a list or remembered codes', () => {
  const s = { ...M.defaults(), favourites: ['diy', 'gif', 'g', 'nosuch'] };
  assert.deepEqual(M.pruneFavourites(s, boards).favourites, ['diy', 'g']);
  assert.equal(M.pruneFavourites(s, null), s);
  assert.equal(M.pruneFavourites(s, []), s);
});

test('a loaded board list remembers its NSFW codes', () => {
  const s = M.pruneFavourites(M.defaults(), boards);
  const nsfw = boards.filter((b) => b.ws_board !== 1).map((b) => b.board);
  assert.ok(nsfw.length > 0);
  assert.deepEqual(s.nsfwBoards, nsfw);
  assert.ok(s.nsfwBoards.includes('b') && s.nsfwBoards.includes('gif') && !s.nsfwBoards.includes('g'));
});

test('NSFW off hides NSFW favourites even when the board list was never loaded', () => {
  // Opted in, favourited /b/ and /g/ with the list loaded, finished setup.
  let s = M.setNsfw(M.defaults(), true, { confirmedAdult: true, now });
  s = M.pruneFavourites(s, boards);
  s = M.toggleFavourite(M.toggleFavourite(s, 'b'), 'g');
  const saved = M.completeSetup(s, { now });
  assert.deepEqual(saved.favourites, ['b', 'g']);
  // Restart: settings come back through JSON, no board list this session.
  const loaded = M.normalizeSettings(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.favourites, ['b', 'g'], 'still opted in: /b/ stays');
  // Run setup again, NSFW off on step 3, no list: /b/ goes.
  const off = M.setNsfw(loaded, false, { boards: null });
  assert.deepEqual(off.favourites, ['g']);
  assert.deepEqual(M.completeSetup(off, { skipped: true, now }).favourites, ['g']);
  assert.deepEqual(M.firstDestination(off), { kind: 'board', board: 'g' });
  // Settings stored with the opt-in off but /b/ still listed (older data or
  // a hand edit) never show it: normalising and drawing both filter.
  const tampered = { ...JSON.parse(JSON.stringify(saved)), nsfw: { enabled: false, confirmedAdultAt: null } };
  assert.deepEqual(M.visibleFavourites(tampered), ['g']);
  assert.deepEqual(M.firstDestination(tampered), { kind: 'board', board: 'g' });
  assert.deepEqual(M.normalizeSettings(tampered).favourites, ['g']);
  assert.deepEqual(M.firstDestination({ ...tampered, favourites: ['b'] }), { kind: 'boards' });
});

test('nsfwBoards is normalised: codes only, unique, capped', () => {
  const n = M.normalizeSettings({ nsfwBoards: ['b', 'b', '../x', 7, 'gif'] });
  assert.deepEqual(n.nsfwBoards, ['b', 'gif']);
  const many = Array.from({ length: 500 }, (_, i) => 'b' + i);
  assert.equal(M.normalizeSettings({ nsfwBoards: many }).nsfwBoards.length, M.MAX_NSFW_BOARDS);
  assert.deepEqual(M.defaults().nsfwBoards, []);
});

test('toggleFavourite adds, removes, refuses bad codes and caps at 30', () => {
  let s = M.defaults();
  s = M.toggleFavourite(s, 'g');
  s = M.toggleFavourite(s, 'v');
  assert.deepEqual(s.favourites, ['g', 'v']);
  s = M.toggleFavourite(s, 'g');
  assert.deepEqual(s.favourites, ['v']);
  assert.equal(M.toggleFavourite(s, '/g/'), s);
  let big = M.defaults();
  for (let i = 0; i < 35; i++) big = M.toggleFavourite(big, `b${i}`);
  assert.equal(big.favourites.length, M.MAX_FAVOURITES);
  assert.equal(M.validateStep('boards', big).ok, true);
  assert.equal(M.validateStep('boards', { favourites: ['G'] }).ok, false);
});

test('filterBoards matches code with or without slashes and the title', () => {
  const ws = M.visibleBoards(boards, M.defaults());
  assert.ok(M.filterBoards(ws, '/g/').some((b) => b.board === 'g'));
  assert.ok(M.filterBoards(ws, 'TECHNO').some((b) => b.board === 'g'));
  assert.equal(M.filterBoards(ws, '').length, ws.length);
  assert.equal(M.filterBoards(ws, 'zzzzzz').length, 0);
});

test('boardHue is stable and never lands in the green band', () => {
  assert.equal(M.boardHue('g'), M.boardHue('g'));
  for (const b of boards) {
    const h = M.boardHue(b.board);
    assert.ok(h >= 0 && h < 360);
    assert.ok(h < 85 || h >= 165, `${b.board}: ${h}`);
  }
});

test('stepsToShow: first run and rerun show all; up to date shows none', () => {
  assert.equal(M.stepsToShow(M.defaults()).length, 9);
  assert.equal(M.stepsToShow(null).length, 9);
  const done = M.completeSetup(M.defaults(), { now });
  assert.deepEqual(M.stepsToShow(done), []);
  assert.equal(M.stepsToShow(done, { rerun: true }).length, 9);
  assert.equal(M.needsSetup(done), false);
  assert.equal(M.needsSetup(M.defaults()), true);
  assert.equal(M.needsSetup(null), true);
});

test('setupVersion migration: a later release shows only its new steps, then Done', () => {
  const v4steps = [...M.STEPS.slice(0, 8), { id: 'filters', label: 'Filters', since: 4 }, M.STEPS[8]];
  const v3done = M.completeSetup(M.defaults(), { now, version: 3 });
  const shown = M.stepsToShow(v3done, { steps: v4steps, version: 4 });
  assert.deepEqual(shown.map((s) => s.id), ['filters', 'done']);
  assert.equal(M.needsSetup(v3done, 4), true);
  const v4done = M.completeSetup(v3done, { now, version: 4 });
  assert.deepEqual(M.stepsToShow(v4done, { steps: v4steps, version: 4 }), []);
  // versions behind: every newer version's steps
  const v1done = M.completeSetup(M.defaults(), { now, version: 1 });
  assert.deepEqual(M.stepsToShow(v1done, { steps: v4steps, version: 4 }).map((s) => s.id), ['stats', 'assistant', 'filters', 'done']);
  // never finished: still the whole flow
  assert.equal(M.stepsToShow(M.defaults(), { steps: v4steps, version: 4 }).length, 10);
});

test('completeSetup stamps version and time, normalises, and records a skip', () => {
  const draft = { ...M.defaults(), watch: { ...M.defaults().watch, intervalSec: 4 } };
  const s = M.completeSetup(draft, { skipped: true, now });
  assert.equal(s.setupVersion, M.SETUP_VERSION);
  assert.equal(s.completedAt, '2026-11-04T12:00:00.000Z');
  assert.equal(s.skipped, true);
  assert.equal(s.watch.intervalSec, 10);
  assert.equal(draft.watch.intervalSec, 4, 'the draft is not mutated');
  assert.deepEqual(M.normalizeSettings(JSON.parse(JSON.stringify(s))), s, 'round-trips through JSON');
});

test('firstDestination: first favourite, else the board list', () => {
  assert.deepEqual(M.firstDestination(M.defaults()), { kind: 'boards' });
  assert.deepEqual(M.firstDestination({ favourites: ['diy', 'g'] }), { kind: 'board', board: 'diy' });
});

test('keyboard: Enter next, Esc skip, arrows move, fields keep their keys', () => {
  const k = (key, target, extra = {}) => M.keyAction({ key, target, ...extra });
  assert.equal(k('Enter', 'other'), 'next');
  assert.equal(k('Enter', 'text'), 'next', 'Enter in a field submits the step');
  assert.equal(k('Enter', 'radio'), 'next');
  assert.equal(k('Enter', 'toggle'), 'next');
  assert.equal(k('Enter', 'button'), null, 'buttons act on their own');
  assert.equal(k('Enter', 'link'), null);
  assert.equal(k('Enter', 'grid'), null);
  assert.equal(k('Escape', 'text'), 'skip');
  assert.equal(k('ArrowRight', 'other'), 'next');
  assert.equal(k('ArrowLeft', 'button'), 'back');
  for (const t of ['text', 'radio', 'range', 'select', 'grid', 'textarea']) {
    assert.equal(k('ArrowRight', t), null, t);
    assert.equal(k('ArrowLeft', t), null, t);
  }
  assert.equal(k('Escape', 'other', { dialogOpen: true }), 'close-dialog');
  assert.equal(k('Enter', 'other', { dialogOpen: true }), null);
  assert.equal(k('Enter', 'other', { mods: true }), null);
  assert.equal(k('Enter', 'text', { composing: true }), null, 'IME composition is left alone');
  assert.equal(k('a', 'other'), null);
});

test('clipReadiness: this machine (all present) is ready', () => {
  const r = M.clipReadiness({
    found: true,
    version: '8.1.3',
    encoders: { libvpx_vp9: true, libsvtav1: true, libopus: true },
    filters: { ass: true, subtitles: true, libplacebo: true },
  });
  assert.equal(r.ready, true);
  assert.equal(r.rows.length, 6);
  assert.ok(r.rows.every((x) => x.ok));
  assert.deepEqual(r.missingRequired, []);
  assert.equal(r.reason, '');
});

test('clipReadiness: no ffmpeg disables Clip with a reason; optional gaps do not', () => {
  const none = M.clipReadiness({ found: false });
  assert.equal(none.ready, false);
  assert.match(none.reason, /ffmpeg was not found/);
  assert.match(none.reason, /Everything else works/);
  assert.ok(none.rows.every((x) => !x.ok));
  const novp9 = M.clipReadiness({ found: true, encoders: { libopus: true }, filters: {} });
  assert.equal(novp9.ready, false);
  assert.deepEqual(novp9.missingRequired, ['libvpx_vp9']);
  assert.match(novp9.reason, /libvpx-vp9/);
  const partial = M.clipReadiness({ found: true, encoders: { libvpx_vp9: true, libopus: true }, filters: { subtitles: true } });
  assert.equal(partial.ready, true);
  assert.deepEqual(partial.missingOptional, ['libsvtav1', 'libplacebo']);
  assert.equal(partial.rows.find((x) => x.id === 'libass').ok, true, 'the subtitles filter counts as libass');
  assert.equal(M.clipReadiness(null).ready, false);
});

test('installHint on Fedora: ffmpeg-free first, then RPM Fusion', () => {
  const none = M.installHint({ os: 'linux', distro: 'fedora', package: null });
  assert.equal(none.command, 'sudo dnf install ffmpeg-free');
  assert.match(none.note, /RPM Fusion/);
  const free = M.installHint({ os: 'linux', distro: 'fedora', package: { name: 'ffmpeg-free', version: '8.1.3', vendor: 'Fedora Project', source: 'fedora' } });
  assert.equal(free.command, 'sudo dnf swap ffmpeg-free ffmpeg --allowerasing');
  const fusion = M.installHint({ os: 'linux', distro: 'fedora', package: { name: 'ffmpeg', version: '9.0.2', vendor: 'RPM Fusion', source: 'rpmfusion' } });
  assert.match(fusion.command, /^sudo dnf upgrade/);
  assert.match(fusion.note, /ffmpeg \(RPM Fusion\)/);
  assert.equal(M.packageLabel({ name: 'ffmpeg-free', source: 'fedora' }), 'ffmpeg-free (Fedora)');
  assert.equal(M.packageLabel({ name: 'ffmpeg', source: 'other', vendor: 'Someone' }), 'ffmpeg (Someone)');
  assert.equal(M.packageLabel(null), '');
});

test('installHint: a copyable command per OS, never run by the app', () => {
  assert.equal(M.installHint({ os: 'linux', distro: 'fedora' }).command, 'sudo dnf install ffmpeg-free');
  assert.equal(M.installHint({ os: 'linux', distro: 'ubuntu' }).command, 'sudo apt install ffmpeg');
  assert.equal(M.installHint({ os: 'linux', distro: 'arch' }).command, 'sudo pacman -S ffmpeg');
  assert.equal(M.installHint({ os: 'linux', distro: 'opensuse-tumbleweed' }).command, 'sudo zypper install ffmpeg');
  assert.equal(M.installHint({ os: 'macos' }).command, 'brew install ffmpeg');
  assert.match(M.installHint({ os: 'windows' }).command, /^winget install/);
  const unknown = M.installHint({ os: 'linux', distro: 'gentoo' });
  assert.equal(unknown.command, '');
  assert.match(unknown.note, /package manager/);
});

test('summary lists every setup answer and never mentions NSFW', () => {
  const s = M.completeSetup({ ...M.defaults(), favourites: ['g', 'diy'] }, { now });
  const rows = M.summary(s, { clip: M.clipReadiness({ found: false }) });
  assert.deepEqual(rows.map((r) => r.step), ['look', 'boards', 'video', 'watching', 'files', 'stats', 'assistant']);
  assert.equal(rows[5].value, 'Off');
  assert.equal(rows[6].value, 'Off');
  assert.equal(M.summary({ ...s, ai: { enabled: true, kind: 'ollama', port: 11434, model: 'llama3.1:8b', reach: 'normal' } })[6].value, 'llama3.1:8b · Ollama');
  assert.equal(M.summary({ ...s, stats: { ...s.stats, mine: true } })[5].value, 'Counted on this computer only');
  assert.equal(rows[0].value, 'System theme · Comfortable · Default text');
  assert.equal(rows[1].value, '/g/ /diy/');
  assert.match(rows[2].value, /Clip is off/);
  assert.match(rows[3].value, /every 10 s/);
  assert.match(rows[4].value, /memory only/);
  const on = M.setNsfw(s, true, { confirmedAdult: true, now });
  assert.ok(M.summary(on).every((r) => !/NSFW/i.test(r.value)));
  assert.equal(M.summary(on)[2].value, 'Not checked');
  assert.equal(M.summary({ ...s, theme: 'yotsuba-b' })[0].value.split(' · ')[0], 'Yotsuba B theme');
});

test('themes: every id is unique, grouped, labelled and kept by normalizeSettings', () => {
  const ids = M.THEMES;
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(M.THEME_GROUPS.map((g) => g.id), ['clovereye', 'classic', 'atrium']);
  for (const g of M.THEME_GROUPS) {
    for (const t of g.themes) {
      assert.ok(t.label && t.swatch.length === 4 && t.swatch.every((c) => /^#[0-9a-f]{6}$/.test(c)), t.id);
      assert.equal(M.normalizeSettings({ theme: t.id }).theme, t.id);
    }
  }
  assert.ok(ids.includes('yotsuba') && ids.includes('tomorrow') && ids.includes('cyberpunk') && ids.includes('orchard-dark'));
  assert.equal(M.normalizeSettings({ theme: 'neon' }).theme, 'system');
  assert.equal(M.themeLabel('win95'), 'Windows 95');
});

test('filters and posts hidden by hand: empty by default, normalised when read', () => {
  const d = M.defaults();
  assert.deepEqual(d.filters, []);
  assert.deepEqual(d.hiddenPosts, []);
  const s = M.normalizeSettings({
    filters: [{ id: 'a1', field: 'com', pattern: 'spam', boards: ['g', 'NOPE'], action: 'highlight' }, { field: 'bogus', pattern: 'x' }, { field: 'id', pattern: '' }, 'junk'],
    hiddenPosts: [{ board: 'g', no: 3 }, { board: 'g', no: 3 }, { board: 'g', no: 'x' }],
  });
  assert.deepEqual(s.filters, [{ id: 'a1', field: 'com', pattern: 'spam', regex: false, matchCase: false, boards: ['g'], action: 'highlight', enabled: true }]);
  assert.deepEqual(s.hiddenPosts, [{ board: 'g', no: 3 }]);
  assert.deepEqual(M.normalizeSettings({ filters: 'nope', hiddenPosts: {} }).filters, []);
});

test('hiding replies to hidden posts: on by default, kept when read, junk falls back', () => {
  assert.deepEqual(M.defaults().hide, { replies: true });
  assert.deepEqual(M.normalizeSettings({}).hide, { replies: true });
  assert.deepEqual(M.normalizeSettings({ hide: { replies: false } }).hide, { replies: false });
  assert.deepEqual(M.normalizeSettings({ hide: { replies: 'no', junk: 1 } }).hide, { replies: true });
  assert.deepEqual(M.normalizeSettings({ hide: 'off' }).hide, { replies: true });
});

test('quote links: open inline and preview by default, kept when read, junk falls back', () => {
  assert.deepEqual(M.defaults().quotes, { links: 'inline', preview: true });
  assert.deepEqual(M.normalizeSettings({}).quotes, { links: 'inline', preview: true });
  assert.deepEqual(M.normalizeSettings({ quotes: { links: 'jump', preview: false } }).quotes, { links: 'jump', preview: false });
  assert.deepEqual(M.normalizeSettings({ quotes: { links: 'teleport', preview: 'yes', junk: 1 } }).quotes, { links: 'inline', preview: true });
  assert.deepEqual(M.normalizeSettings({ quotes: [] }).quotes, { links: 'inline', preview: true });
});

test('poster ID colours: on by default, kept when read, junk falls back', () => {
  assert.deepEqual(M.defaults().ids, { colour: true });
  assert.deepEqual(M.normalizeSettings({ ids: { colour: false } }).ids, { colour: false });
  assert.deepEqual(M.normalizeSettings({ ids: { colour: 'no', junk: 1 } }).ids, { colour: true });
  assert.deepEqual(M.normalizeSettings({ ids: 'off' }).ids, { colour: true });
});

test('reverse image search: four sites by default, kept when read, junk dropped', () => {
  assert.deepEqual(M.defaults().sauce, { engines: ['saucenao', 'lens', 'yandex', 'iqdb'] });
  assert.deepEqual(M.normalizeSettings({}).sauce, { engines: ['saucenao', 'lens', 'yandex', 'iqdb'] });
  assert.deepEqual(M.normalizeSettings({ sauce: { engines: ['tracemoe', 'tineye', 'bing', 'tineye'] } }).sauce, { engines: ['tineye', 'tracemoe'] });
  assert.deepEqual(M.normalizeSettings({ sauce: { engines: [] } }).sauce, { engines: [] }, 'none chosen stays none');
  assert.deepEqual(M.normalizeSettings({ sauce: { engines: 'all', junk: 1 } }).sauce, { engines: ['saucenao', 'lens', 'yandex', 'iqdb'] });
  assert.deepEqual(M.normalizeSettings({ sauce: [] }).sauce, { engines: ['saucenao', 'lens', 'yandex', 'iqdb'] });
});

test('archive links: on, automatic for every board by default; choices checked when read', () => {
  assert.deepEqual(M.defaults().archives, { enabled: true, boards: {} });
  assert.deepEqual(M.normalizeSettings({}).archives, { enabled: true, boards: {} });
  assert.deepEqual(M.normalizeSettings({ archives: { enabled: false, boards: { g: 'b4k', v: 'off', sci: 'desuarchive', 'x/': 'off' }, junk: 1 } }).archives, {
    enabled: false,
    boards: { g: 'b4k', v: 'off' },
  });
  assert.deepEqual(M.normalizeSettings({ archives: 'off' }).archives, { enabled: true, boards: {} });
});

test('embeds: click to load by default; only off or click kept', () => {
  assert.deepEqual(M.defaults().embeds, { mode: 'click' });
  assert.deepEqual(M.normalizeSettings({}).embeds, { mode: 'click' });
  assert.deepEqual(M.normalizeSettings({ embeds: { mode: 'off', junk: 1 } }).embeds, { mode: 'off' });
  assert.deepEqual(M.normalizeSettings({ embeds: { mode: 'auto' } }).embeds, { mode: 'click' });
  assert.deepEqual(M.normalizeSettings({ embeds: 'off' }).embeds, { mode: 'click' });
});

test('read marks: empty by default, cleaned when read, NSFW ones dropped while NSFW is off', () => {
  assert.deepEqual(M.defaults().lastRead, {});
  assert.deepEqual(M.normalizeSettings({ lastRead: { 'g/1': 5, 'bad key': 2, 'g/2': 0 } }).lastRead, { 'g/1': 5 });
  assert.deepEqual(M.normalizeSettings({ lastRead: [] }).lastRead, {});
  assert.deepEqual(M.normalizeSettings({ nsfwBoards: ['b'], lastRead: { 'g/1': 5, 'b/2': 9 } }).lastRead, { 'g/1': 5 });
});

test('settings at every cap still fit what the app agrees to store', () => {
  const b = (i) => `b${i}`.padEnd(10, 'x').slice(0, 10);
  const big = Number.MAX_SAFE_INTEGER;
  const raw = {
    nsfw: { enabled: true, confirmedAdultAt: '2026-01-01T00:00:00Z' },
    filters: Array.from({ length: 500 }, (_, i) => ({ field: 'com', pattern: `${i}`.padEnd(500, 'é'), boards: Array.from({ length: 50 }, (_, j) => b(j)), regex: true })),
    hiddenPosts: Array.from({ length: 5000 }, (_, i) => ({ board: b(i), no: big - i })),
    lastRead: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`${b(i)}/${big - i}`, big - i])),
    yous: Array.from({ length: 1000 }, (_, i) => ({ board: b(i), no: big - i })),
    watched: Array.from({ length: M.MAX_WATCHED }, (_, i) => ({ board: b(i), no: big - i, title: 'あ'.repeat(200), seen: big })),
    favourites: Array.from({ length: 30 }, (_, i) => b(i)),
    nsfwBoards: Array.from({ length: 200 }, (_, i) => b(i + 100)),
    files: { downloadDir: 'あ'.repeat(1024) },
    post: { name: 'あ'.repeat(100) },
  };
  const s = M.normalizeSettings(raw);
  assert.ok(M.settingsBytes(s) <= M.SETTINGS_BUDGET, `${M.settingsBytes(s)} bytes`);
  assert.ok(M.SETTINGS_BUDGET < 256 * 1024);
  assert.equal(s.watched.length, M.MAX_WATCHED, 'watched threads are never dropped');
  assert.ok(s.filters.length > 0);
});

test('fitSettings drops the oldest read marks, then hidden posts, then (You)s', () => {
  const small = M.defaults();
  assert.equal(M.fitSettings(small), small, 'already fits: the same object');
  const s = {
    ...M.defaults(),
    lastRead: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`g/${i + 1}`, i + 1])),
    hiddenPosts: Array.from({ length: 100 }, (_, i) => ({ board: 'g', no: i + 1 })),
  };
  const budget = M.settingsBytes(s) - 500;
  const fit = M.fitSettings(s, budget);
  assert.ok(M.settingsBytes(fit) <= budget);
  assert.equal(fit.hiddenPosts.length, 100, 'read marks went first');
  const keys = Object.keys(fit.lastRead);
  assert.ok(keys.length < 100 && keys.length > 0);
  assert.equal(keys[keys.length - 1], 'g/100', 'the newest stay');
  const tight = M.fitSettings(s, M.settingsBytes({ ...s, lastRead: {} }) - 300);
  assert.deepEqual(tight.lastRead, {});
  assert.ok(tight.hiddenPosts.length < 100);
  assert.deepEqual(tight.hiddenPosts[tight.hiddenPosts.length - 1], { board: 'g', no: 100 });
  assert.equal(M.fitSettings(null), null);
});

test('display switches (Settings → Posts): defaults, kept when read, junk falls back', () => {
  const d = { time: 'local', revealSpoilers: false, hideImages: false, autoExpand: false, galleryPreload: true, anonymize: false };
  assert.deepEqual(M.defaults().display, d);
  assert.deepEqual(M.normalizeSettings({}).display, d);
  const all = { time: 'relative', revealSpoilers: true, hideImages: true, autoExpand: true, galleryPreload: false, anonymize: true };
  assert.deepEqual(M.normalizeSettings({ display: all }).display, all);
  assert.deepEqual(M.normalizeSettings({ display: { time: 'board', anonymize: 'yes', junk: 1 } }).display, { ...d, time: 'board' });
  assert.deepEqual(M.normalizeSettings({ display: 'work' }).display, d);
});

test('post.randomName: off by default, only a real boolean turns it on', () => {
  assert.equal(M.defaults().post.randomName, false);
  assert.equal(M.normalizeSettings({ post: { randomName: true } }).post.randomName, true);
  assert.equal(M.normalizeSettings({ post: { randomName: 'yes' } }).post.randomName, false);
  assert.equal(M.normalizeSettings({ post: { name: 'x' } }).post.randomName, false);
  assert.equal(M.normalizeSettings({}).post.randomName, false);
});

test('files: the saved threads folder is a full path or empty (the default)', () => {
  assert.equal(M.defaults().files.savedDir, '');
  assert.equal(M.normalizeSettings({ files: { savedDir: '  /home/me/Saved  ' } }).files.savedDir, '/home/me/Saved');
  assert.equal(M.normalizeSettings({ files: { savedDir: 'C:\\Users\\me\\Saved' } }).files.savedDir, 'C:\\Users\\me\\Saved');
  assert.equal(M.normalizeSettings({ files: { savedDir: '\\\\server\\share' } }).files.savedDir, '\\\\server\\share');
  for (const bad of ['relative/dir', '~/Saved', 'a\u0000b', '/x\ny', 42, null, `/${'a'.repeat(1100)}`]) {
    assert.equal(M.normalizeSettings({ files: { savedDir: bad } }).files.savedDir, '', String(bad).slice(0, 20));
  }
  assert.equal(M.normalizeFolder('  '), '');
  assert.equal(M.normalizeFolder('/ok'), '/ok');
  assert.equal(M.normalizeSettings({ files: { downloadDir: '/d' } }).files.downloadDir, '/d', 'the download folder is unchanged');
});

test('NSFW off: Settings → Archives lists no NSFW boards and keeps no choices for them', () => {
  const off = { nsfw: { enabled: false, confirmedAdultAt: null }, nsfwBoards: ['b', 'h'] };
  const shown = M.visibleArchivedBoards(off);
  assert.ok(shown.includes('g'));
  assert.ok(!shown.includes('b') && !shown.includes('h'));
  // from a loaded board list too, without remembered codes
  const fromList = M.visibleArchivedBoards({ nsfw: { enabled: false } }, [{ board: 'b', ws_board: 0 }, { board: 'g', ws_board: 1 }]);
  assert.ok(!fromList.includes('b') && fromList.includes('g'));
  const on = { nsfw: { enabled: true, confirmedAdultAt: now.toISOString() }, nsfwBoards: ['b'] };
  assert.ok(M.visibleArchivedBoards(on).includes('b'));

  const n = M.normalizeSettings({ ...off, archives: { enabled: true, boards: { b: 'off', g: 'off' } } });
  assert.deepEqual(n.archives.boards, { g: 'off' });
  const kept = M.normalizeSettings({ ...on, archives: { enabled: true, boards: { b: 'off' } } });
  assert.deepEqual(kept.archives.boards, { b: 'off' });

  const s = M.normalizeSettings({ ...on, archives: { enabled: true, boards: { b: 'off', g: 'off' } } });
  assert.deepEqual(M.setNsfw(s, false).archives.boards, { g: 'off' });
});

test('boardHidden: NSFW boards only, and only while they are off', () => {
  const off = { nsfw: { enabled: false, confirmedAdultAt: null }, nsfwBoards: ['b'] };
  assert.equal(M.boardHidden(off, 'b'), true);
  assert.equal(M.boardHidden(off, 'g'), false);
  assert.equal(M.boardHidden({ nsfw: { enabled: false } }, 'h', [{ board: 'h', ws_board: 0 }]), true);
  assert.equal(M.boardHidden({ ...off, nsfw: { enabled: true, confirmedAdultAt: now.toISOString() } }, 'b'), false);
});
