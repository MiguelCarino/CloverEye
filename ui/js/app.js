// Boot: load settings, apply the look, then setup (first launch, an upgrade
// with new steps, or #setup) or the shell.

import { createBridge, safeStorage, mockOptionsFromSearch } from './bridge.js';
import { defaults, fitSettings, needsSetup, normalizeSettings } from './setup-model.js';
import { applyLook } from './look.js';
import { startSetup } from './setup.js';
import { openShell } from './shell.js';
import { toast } from './dom.js';
import { installHoverPreview } from './hover.js';
import { installQuotePreview } from './quotes.js';
import { panesFromHash } from './browse-model.js';
import { tr } from './i18n.js';
import { titleWithCount } from './unread-model.js';

const bridge = createBridge({
  tauri: window.__TAURI__ ?? null,
  storage: safeStorage(window),
  fetchImpl: window.fetch.bind(window),
  mock: mockOptionsFromSearch(location.search),
});

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

let shell = null;
let boardsCache = null;
let current = null; // settings the shell is running with

const extraPanes = panesFromHash(location.hash);

function showShell(settings) {
  current = settings;
  shell?.close();
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
      shell?.close();
      shell = null;
      runSetup(current, true);
    },
    onSave: async (next) => {
      // Kept under the size the app agrees to store (old read marks and
      // hidden posts go first), so a long list never blocks every save.
      current = fitSettings(next);
      try {
        await bridge.setSettings(current);
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
  // the language's table loads before anything is drawn
  await applyLook(settings);
  // Settings saved in another window: this one follows.
  bridge.onSettingsChanged?.((raw) => {
    const next = normalizeSettings(raw);
    if (!shell || JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    applyLook(next);
    shell.applySettings(next);
  });
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
