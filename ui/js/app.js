// Boot: load settings, apply the look, then setup (first launch, an upgrade
// with new steps, or #setup) or the shell.

import { createBridge, safeStorage, mockOptionsFromSearch } from './bridge.js';
import { defaults, needsSetup, normalizeSettings } from './setup-model.js';
import { applyLook } from './look.js';
import { startSetup } from './setup.js';
import { openShell } from './shell.js';
import { toast } from './dom.js';
import { installHoverPreview } from './hover.js';

const bridge = createBridge({
  tauri: window.__TAURI__ ?? null,
  storage: safeStorage(window),
  fetchImpl: window.fetch.bind(window),
  mock: mockOptionsFromSearch(location.search),
});

const titleEl = document.getElementById('titlebarTitle');
const setTitle = (t) => {
  titleEl.textContent = t;
  document.title = t ? `${t} · CloverEye` : 'CloverEye';
};

function wireWindowControls() {
  const box = document.getElementById('windowControls');
  if (!bridge.window.available) return;
  box.hidden = false;
  box.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.action;
    if (act === 'minimize') bridge.window.minimize();
    else if (act === 'maximize') bridge.window.toggleMaximize();
    else if (act === 'close') bridge.window.close();
  });
}

let shell = null;
let boardsCache = null;
let current = null; // settings the shell is running with

function showShell(settings) {
  current = settings;
  shell?.close();
  shell = openShell({
    settings,
    boards: boardsCache,
    bridge,
    onBoards: (list) => {
      boardsCache = list;
    },
    setTitle,
    // Closing the shell first stores its pending changes (watched, seen).
    onRunSetup: () => {
      shell?.close();
      shell = null;
      runSetup(current, true);
    },
    onSave: async (next) => {
      current = next;
      try {
        await bridge.setSettings(next);
      } catch (e) {
        toast(`Settings were not saved: ${e?.message || e}`);
      }
    },
  });
}

function runSetup(settings, rerun) {
  shell?.close();
  shell = null;
  if (location.hash === '#setup') history.replaceState(null, '', location.pathname + location.search);
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
      showShell(final);
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
  applyLook(settings);
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
const bootStarted = performance.now();
boot().finally(() => endSplash(bootStarted));
