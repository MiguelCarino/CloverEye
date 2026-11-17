// Source checks for fixes that live in DOM-bound modules (shell.js, app.js,
// compose.js, setup.js) and in main.rs: several windows sharing settings,
// drafts and reply files, and redraws that keep a pane's place and index.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SHELL = read('ui/js/shell.js');
const APP = read('ui/js/app.js');
const COMPOSE = read('ui/js/compose.js');
const SETUP = read('ui/js/setup.js');
const MAIN = read('src-tauri/src/main.rs');

const body = (src, start, end) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} is there`);
  return src.slice(at, src.indexOf(end, at + start.length));
};

test('a closed shell saves nothing: a late fetch never writes over newer settings', () => {
  const save = body(SHELL, 'function save(next', 'function flushSave(');
  assert.match(save.split('\n').slice(1, 5).join('\n'), /if \(closed\) return undefined;/);
  // app.js: a retired shell's onSave goes nowhere, its close() store still goes in
  assert.match(APP, /onSave: \(next\) => \{\s*if \(!live\) return undefined;/);
  const close = body(APP, 'function closeShell()', '\n}');
  assert.ok(close.indexOf('shell?.close()') < close.indexOf('retireShell?.()'), 'retired after its close() stored');
});

test('a thread grown in place keeps the post in sight where it was', () => {
  const grow = body(SHELL, 'function growPane(pane)', 'function renderPaneOf(');
  assert.ok(grow.indexOf('scrollAnchor(body)') < grow.indexOf('updateThreadView('), 'anchor taken before the update');
  assert.match(grow, /anchorEl\(body, a\)/);
  assert.match(grow, /restoreScroll\(body, body\.scrollTop \+ d\)/);
});

test('pane redraws wait while a full redraw waits for a sidebar drag', () => {
  assert.match(body(SHELL, 'function renderPane(i)', 'function keepDialogOpeners('), /if \(closed \|\| renderAfterDrag\) return;/);
  assert.match(body(SHELL, 'function growPane(pane)', 'function renderPaneOf('), /if \(i < 0 \|\| closed \|\| renderAfterDrag\) return true;/);
});

test('a board link opens beside the pane it was clicked in, found again after the await', () => {
  const fn = body(SHELL, 'async function openBoardLink(', 'function showJump(');
  assert.match(fn, /\{ board, search = '' \}, from\)/);
  assert.ok(fn.indexOf('await boardInfo(board)') < fn.indexOf('st.panes.indexOf(from)'));
  assert.match(fn, /openBeside\(\{ kind: 'board', board \}, at\)/);
  assert.equal((SHELL.match(/openBoardLink\(q, pane\)/g) || []).length, 2);
  assert.doesNotMatch(SHELL, /openBoardLink\(q, i\)/);
});

test('a change of active boards redraws the Stats panes too (their Tags tab)', () => {
  const at = SHELL.indexOf('activeBoardsKey() !== boardsBefore');
  assert.match(SHELL.slice(at, at + 300), /scheduleStats\(\)/);
});

test('settings: one write at a time in main.rs, through a unique synced temp file', () => {
  const fn = body(MAIN, 'async fn set_settings(', '\n}\n');
  assert.match(fn, /static SAVE: std::sync::Mutex<\(\)>/);
  assert.match(fn, /offline::write_atomic\(&path, &bytes\)\?/);
  assert.doesNotMatch(fn, /json\.tmp/);
  assert.ok(fn.indexOf('SAVE.lock()') < fn.indexOf('write_atomic') && fn.indexOf('write_atomic') < fn.indexOf('emit_filter'), 'the lock covers the write and its event');
  assert.doesNotMatch(fn.replace(/\/\/.*$/gm, ''), /\.await/, 'no await while the std Mutex is held');
});

test('app.js: another window’s write older than this window’s own unechoed write is held, not applied', () => {
  const changed = body(APP, 'function settingsChanged(raw)', '\n}\n');
  assert.match(changed, /bridge\.kind === 'tauri' && ownSaves\.length/);
  assert.match(changed, /heldForeign = raw/);
  assert.match(changed, /heldForeign = null/, 'dropped when this window’s own write comes back');
  const drain = body(APP, 'async function drainSaves()', '\n}\n');
  assert.match(drain, /ownSaves\.splice\(at, 1\)/, 'a failed write is not waited for');
  assert.match(drain, /releaseHeld\(\)/);
  assert.match(APP, /setTimeout\(releaseHeld, HELD_MAX_MS\)/, 'never held for ever');
  // with no shell (setup open) other windows' saves still update `current`
  const apply = body(APP, 'function applyIncoming(raw)', '\n}\n');
  assert.ok(apply.indexOf('currentSig = sig') < apply.indexOf('if (!shell) return;'));
});

test('setup’s end goes through app.js’s queue, laid over the latest settings', () => {
  const finish = body(SETUP, 'function finish(skipped)', 'let closed = false;');
  assert.doesNotMatch(finish, /setSettings/);
  const run = body(APP, 'function runSetup(', '\n}\n');
  assert.match(run, /setupOnto\(start, final, current\)/);
  assert.match(run, /storeSettings\(s, currentSig\)/);
});

test('compose: Later is read again after the files move, before it is written', () => {
  const fn = body(COMPOSE, 'async function openSaved(', 'function openActive(');
  const lastAwait = fn.lastIndexOf('await moveFile(`s:${entry.id}`');
  const reread = fn.indexOf('C.takeSaved(loadSaved(), entry.id)');
  assert.ok(lastAwait >= 0 && reread > lastAwait, 're-read after the last file move');
  assert.ok(reread < fn.indexOf('persistSaved()'));
  assert.doesNotMatch(fn, /saved = list;/);
});

test('compose: the reply-file sweep asks the other windows what they hold', () => {
  const live = body(COMPOSE, 'const liveFiles = () =>', 'const sweepTimer');
  assert.match(live, /if \(!filesChan\) return null;/, 'no channel: nothing is swept');
  assert.match(live, /for \(const k of othersFiles\) live\.add\(k\)/);
  const start = body(COMPOSE, 'const sweepTimer = setTimeout(', '}, 10_000);');
  assert.ok(start.indexOf('postMessage({ ask: true })') < start.indexOf('sweepFiles(liveFiles)'));
  assert.match(COMPOSE, /if \(e\.data\?\.ask\) filesChan\.postMessage\(\{ keys: \[\.\.\.ownFiles\(\)\] \}\)/);
  assert.match(COMPOSE, /ac\.signal\.addEventListener\('abort', \(\) => filesChan\?\.close\(\)\)/);
});

test('library.js: a failed write forgets the revision it hoped for', () => {
  const lib = read('ui/js/library.js');
  const fn = body(lib, 'async function writeNow(d)', 'function save()');
  const c = fn.indexOf('} catch (e) {');
  assert.match(fn.slice(c, c + 160), /if \(writingRev === out\.rev\) writingRev = 0;/);
});
