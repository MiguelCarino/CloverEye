import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as M from '../ui/js/setup-model.js';

const boards = JSON.parse(readFileSync(new URL('../ui/data/boards.sample.json', import.meta.url))).boards;
const now = new Date('2026-11-04T12:00:00Z');

test('seven steps, all introduced in version 1; NSFW is not one of them', () => {
  assert.deepEqual(
    M.STEPS.map((s) => s.id),
    ['welcome', 'look', 'boards', 'video', 'watching', 'files', 'done'],
  );
  assert.ok(M.STEPS.every((s) => s.since === 1 && s.label));
  assert.equal(M.SETUP_VERSION, 1);
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
  assert.equal(M.stepsToShow(M.defaults()).length, 7);
  assert.equal(M.stepsToShow(null).length, 7);
  const done = M.completeSetup(M.defaults(), { now });
  assert.deepEqual(M.stepsToShow(done), []);
  assert.equal(M.stepsToShow(done, { rerun: true }).length, 7);
  assert.equal(M.needsSetup(done), false);
  assert.equal(M.needsSetup(M.defaults()), true);
  assert.equal(M.needsSetup(null), true);
});

test('setupVersion migration: a later release shows only its new steps, then Done', () => {
  const v2steps = [...M.STEPS.slice(0, 6), { id: 'filters', label: 'Filters', since: 2 }, M.STEPS[6]];
  const v1done = M.completeSetup(M.defaults(), { now, version: 1 });
  const shown = M.stepsToShow(v1done, { steps: v2steps, version: 2 });
  assert.deepEqual(shown.map((s) => s.id), ['filters', 'done']);
  assert.equal(M.needsSetup(v1done, 2), true);
  const v2done = M.completeSetup(v1done, { now, version: 2 });
  assert.deepEqual(M.stepsToShow(v2done, { steps: v2steps, version: 2 }), []);
  // never finished: still the whole flow
  assert.equal(M.stepsToShow(M.defaults(), { steps: v2steps, version: 2 }).length, 8);
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
  assert.deepEqual(rows.map((r) => r.step), ['look', 'boards', 'video', 'watching', 'files']);
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
