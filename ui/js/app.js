// Boot: load settings, apply the look, then setup (first launch, an upgrade
// with new steps, or #setup) or the shell.

import { createBridge, safeStorage, mockOptionsFromSearch } from './bridge.js';
import { defaults, needsSetup, normalizeSettings } from './setup-model.js';
import { applyLook } from './look.js';
import { startSetup } from './setup.js';
import { openShell } from './shell.js';
import { toast } from './dom.js';

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
    setTitle,
    onRunSetup: () => runSetup(current, true),
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

boot();
