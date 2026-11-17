// Boot: load settings, apply the look, then setup (first launch, an upgrade
// with new steps, or #setup) or the shell.

import { createBridge, safeStorage, mockOptionsFromSearch } from './bridge.js';
import { defaults, fitSettings, needsSetup, normalizeSettings, setupOnto } from './setup-model.js';
import { applyLook } from './look.js';
import { startSetup } from './setup.js';
import { openShell } from './shell.js';
import { toast } from './dom.js';
import { installHoverPreview } from './hover.js';
import { installQuotePreview } from './quotes.js';
import { decodePanes } from './tabs-model.js';
import { tr } from './i18n.js';
import { titleWithCount } from './unread-model.js';

const bridge = createBridge({
  tauri: window.__TAURI__ ?? null,
  storage: safeStorage(window),
  fetchImpl: window.fetch.bind(window),
  mock: mockOptionsFromSearch(location.search),
});

// Errors the page did not handle go in the diagnostics report (Settings ›
// Diagnostics), with where they happened; never post text or settings.
window.addEventListener('error', (e) => bridge.noteError([e.message, 'at', [String(e.filename || '').split('/').pop(), e.lineno].join(':')].join(' ')));
window.addEventListener('unhandledrejection', (e) => bridge.noteError(['unhandled:', e.reason?.message ?? e.reason].join(' ')));

const titleEl = document.getElementById('titlebarTitle');
// The title is often a thread's name: only the app's own titles ("Settings",
// "Setup · Look"...) are translated, here, and the page translator keeps out.
titleEl.setAttribute('translate', 'no');
// `unread`: the focused thread's unread posts, put in front: "(3) /g/ · …".
const setTitle = (t, unread = 0) => {
  const shown = titleWithCount(t ? tr(t) : t, unread);
  titleEl.textContent = shown;
  const full = shown ? `${shown} · CloverEye` : 'CloverEye';
  if (document.title === full) return;
  document.title = full;
  bridge.window.setTitle?.(full);
};

function wireWindowControls() {
  const box = document.getElementById('windowControls');
  if (!bridge.window.available) return;
  // macOS draws its own traffic lights over the title bar (the main window:
  // tauri.macos.conf.json; extra windows: extra.rs open_window, both with
  // titleBarStyle Overlay), so the drawn buttons stay hidden there and the
  // bar leaves room on the left for the native ones.
  if (/Mac/.test(navigator.platform || navigator.userAgent)) {
    document.documentElement.dataset.platform = 'macos';
    return;
  }
  box.hidden = false;
  box.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.action;
    if (act === 'minimize') bridge.window.minimize();
    else if (act === 'maximize') bridge.window.toggleMaximize();
    else if (act === 'close') bridge.window.close();
  });
}

// Closing: the window fades and shrinks a little first. The app (main.rs)
// holds the close request and calls this; the close that follows goes
// through. Meanwhile the shell stores what it still held back (read marks,
// watched threads): the close waits for that, but never past FLUSH_WAIT_MS,
// well inside the second main.rs gives a window before it destroys it.
const FLUSH_WAIT_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let closingNow = false;
window.__ceClosing = () => {
  if (closingNow) return;
  closingNow = true;
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('is-closing');
  let stored;
  try {
    stored = Promise.resolve(shell?.flush?.()).catch(() => {});
  } catch {
    stored = Promise.resolve();
  }
  Promise.all([Promise.race([stored, sleep(FLUSH_WAIT_MS)]), sleep(quick ? 80 : 230)]).finally(() => bridge.window?.close?.());
};
// A page going away some other way (a reload, a browser tab): the same,
// as far as it gets.
window.addEventListener('pagehide', () => {
  if (!closingNow) shell?.flush?.();
});

let shell = null;
let boardsCache = null;
let current = null; // settings the shell is running with
let currentSig = ''; // `current` as stableJson

/** JSON with every object's keys sorted: the app hands settings back with
 *  its own key order, so this is what tells two settings apart. */
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

// Settings go to the app one write at a time, in order (two at once could
// land out of order and leave the older in the file); when several pile up
// only the newest goes. The app tells every window about each write, this
// one too: its own writes are known by their content and not taken again.
let saving = null;
let queued = null;
const ownSaves = []; // stableJson of this window's writes not echoed yet
const OWN_SAVES_KEPT = 8;

async function drainSaves() {
  try {
    while (queued) {
      const { s, sig } = queued;
      queued = null;
      ownSaves.push(sig);
      if (ownSaves.length > OWN_SAVES_KEPT) ownSaves.shift();
      try {
        await bridge.setSettings(s);
      } catch (e) {
        // never written, so it never comes back: not waited for
        const at = ownSaves.lastIndexOf(sig);
        if (at >= 0) ownSaves.splice(at, 1);
        if (!ownSaves.length) releaseHeld();
        toast(`Settings were not saved: ${e?.message || e}`);
      }
    }
  } finally {
    saving = null;
  }
}

// Another window's write that came while one of this window's was still on
// its way back (the app sends the events in the order it wrote the file):
// it was written before this window's, which holds everything this window
// knew, so it is not taken. Applied only if this window's write never comes
// back (failed, or its event was lost).
let heldForeign = null;
let heldTimer = 0;
const HELD_MAX_MS = 3000;

function releaseHeld() {
  clearTimeout(heldTimer);
  heldTimer = 0;
  const raw = heldForeign;
  heldForeign = null;
  if (raw) applyIncoming(raw);
}

/** Settings another window saved: this one follows (and, with no shell
 *  open, remembers them for setup's end: runSetup). */
function applyIncoming(raw) {
  const next = normalizeSettings(raw);
  const sig = stableJson(next);
  if (sig === currentSig) return;
  current = next;
  currentSig = sig;
  if (!shell) return;
  applyLook(next);
  shell.applySettings(next);
}

function settingsChanged(raw) {
  // this window's own write coming back (and any older one of its own
  // still on the way): nothing to take, and what was held is older
  const own = ownSaves.indexOf(stableJson(raw));
  if (own >= 0) {
    ownSaves.splice(0, own + 1);
    if (!ownSaves.length) {
      clearTimeout(heldTimer);
      heldTimer = 0;
      heldForeign = null;
    }
    return;
  }
  // The browser bridge never sends a window its own writes: nothing to wait for.
  if (bridge.kind === 'tauri' && ownSaves.length) {
    heldForeign = raw;
    clearTimeout(heldTimer);
    heldTimer = setTimeout(releaseHeld, HELD_MAX_MS);
    return;
  }
  applyIncoming(raw);
}

function storeSettings(s, sig) {
  queued = { s, sig };
  if (!saving) saving = drainSaves();
  return saving;
}

// An extra window's panes, each with its tabs (tabs-model.js): the older
// address (a list of views) opens one-tab panes.
const extraPanes = decodePanes(location.hash);

// Ends the open shell's say over the settings: its close() still stores
// what it held back, and anything it saves after that (a late fetch) goes
// nowhere, so it never writes over newer settings.
let retireShell = null;
function closeShell() {
  shell?.close();
  retireShell?.();
  retireShell = null;
  shell = null;
}

function showShell(settings) {
  closeShell();
  current = settings;
  currentSig = stableJson(settings);
  let live = true;
  retireShell = () => {
    live = false;
  };
  shell = openShell({
    settings,
    boards: boardsCache,
    bridge,
    panes: extraPanes,
    isMain: !extraPanes,
    onBoards: (list) => {
      boardsCache = list;
    },
    setTitle,
    // Closing the shell first stores its pending changes (watched, seen).
    onRunSetup: () => {
      closeShell();
      runSetup(current, true);
    },
    onSave: (next) => {
      if (!live) return undefined;
      // Kept under the size the app agrees to store (old read marks and
      // hidden posts go first), so a long list never blocks every save.
      current = fitSettings(next);
      currentSig = stableJson(current);
      return storeSettings(current, currentSig);
    },
  });
}

function runSetup(settings, rerun) {
  closeShell();
  if (location.hash === '#setup') history.replaceState(null, '', location.pathname + location.search);
  const start = settings;
  startSetup({
    bridge,
    settings,
    rerun,
    boards: boardsCache,
    setTitle,
    onBoards: (boards) => {
      boardsCache = boards;
    },
    onFinish: (final, { boards }) => {
      if (boards) boardsCache = boards;
      const s = setupOnto(start, final, current);
      showShell(s);
      if (stableJson(s) !== stableJson(start)) storeSettings(s, currentSig);
    },
  });
}

async function boot() {
  document.documentElement.dataset.host = bridge.kind;
  wireWindowControls();
  let stored = null;
  try {
    stored = await bridge.getSettings();
  } catch {
    stored = null;
  }
  const settings = stored ? normalizeSettings(stored) : defaults();
  // the language's table loads before anything is drawn
  await applyLook(settings);
  // Settings saved in another window: this one follows.
  bridge.onSettingsChanged?.(settingsChanged);
  if (extraPanes) {
    showShell(settings);
    return;
  }
  const rerun = location.hash === '#setup' && !needsSetup(settings);
  if (needsSetup(settings) || rerun) runSetup(settings, rerun);
  else showShell(settings);
}

// #setup while the app is already open (a link, or typed in a browser).
window.addEventListener('hashchange', () => {
  if (location.hash === '#setup' && current && document.getElementById('setup').hidden) runSetup(current, true);
});

/** The startup animation runs about 0.8 s, then fades; it never blocks
 *  input (pointer-events: none) and is skipped with reduced motion. */
function endSplash(started) {
  const splash = document.getElementById('splash');
  if (!splash) return;
  if (extraPanes || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    splash.remove();
    return;
  }
  const wait = Math.max(0, 820 - (performance.now() - started));
  setTimeout(() => {
    splash.classList.add('splash--done');
    setTimeout(() => splash.remove(), 320);
  }, wait);
}

installHoverPreview();
installQuotePreview();
const bootStarted = performance.now();
boot().finally(() => endSplash(bootStarted));
