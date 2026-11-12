// Tiny DOM helpers. Text always goes in through textContent.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('button', { class: 'btn', onclick }, 'Label', childNode) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val));
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Starts a video that should play by itself. WebKit lets a video with
 *  sound start on its own only right after a click: without one (a thread
 *  that expands its files by itself) the video starts muted rather than not
 *  at all, and its controls unmute it. Call before `src` is set. */
export function autoplay(v) {
  const act = globalThis.navigator?.userActivation;
  if (act && !act.isActive) v.muted = true;
  // where userActivation is missing: try with sound, then muted
  v.addEventListener(
    'loadeddata',
    () => {
      if (!v.paused || !v.isConnected) return;
      Promise.resolve(v.play()).catch((e) => {
        if (e?.name !== 'NotAllowedError') return;
        v.muted = true;
        Promise.resolve(v.play()).catch(() => {});
      });
    },
    { once: true },
  );
  return v;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const ICONS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  minus: ['M5 12h14'],
  square: ['M6 6h12v12H6z'],
  info: ['M12 8h.01', 'M11 12h1v5h1', 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z'],
  shield: ['M12 3l7 3v6c0 4.5-3 7.5-7 9c-4-1.5-7-4.5-7-9V6z'],
  wifiOff: ['M3 3l18 18', 'M8.5 16.5a5 5 0 0 1 7 0', 'M5 12.5a10 10 0 0 1 4.2-2.4', 'M12 20h.01', 'M2 8.8a15 15 0 0 1 4.3-2.6', 'M14.8 10.2A10 10 0 0 1 19 12.5', 'M10.7 5.1A15 15 0 0 1 22 8.8'],
  eye: ['M2 12s3.6-7 10-7s10 7 10 7s-3.6 7-10 7s-10-7-10-7z', 'M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z'],
  film: ['M4 4h16v16H4z', 'M8 4v16', 'M16 4v16', 'M4 8h4', 'M4 16h4', 'M16 8h4', 'M16 16h4'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 20a2 2 0 0 0 4 0'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12', 'M9 7V4h6v3'],
  download: ['M12 4v11', 'M7 10l5 5l5-5', 'M5 20h14'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  play: ['M8 5.5v13l10.5-6.5z'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13a6.5 6.5 0 0 0 0 13z', 'M15.2 15.2L20 20'],
  chart: ['M4 20h16', 'M7 16v-5', 'M12 16V6', 'M17 16v-8'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  panel: ['M4 4h16v16H4z', 'M15 4v16'],
  settings: ['M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3a1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  arrowLeft: ['M19 12H5', 'M11 6l-6 6l6 6'],
  arrowDown: ['M12 5v14', 'M6 13l6 6l6-6'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
  maximize: ['M6 6h12v12H6z'],
  star: ['M12 3.5l2.6 5.3l5.9.9l-4.3 4.1l1 5.8L12 16.9l-5.2 2.7l1-5.8l-4.3-4.1l5.9-.9z'],
  sidebar: ['M4 4h16v16H4z', 'M9 4v16'],
  swap: ['M7 7h12', 'M15 3l4 4l-4 4', 'M17 17H5', 'M9 13l-4 4l4 4'],
  reply: ['M10 8L5 12l5 4', 'M5 12h9a5 5 0 0 1 5 5v1'],
  plus: ['M12 5v14', 'M5 12h14'],
  splitOpen: ['M4 4h16v16H4z', 'M12 4v16', 'M15 10l2 2l-2 2'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  eyeOff: ['M3 3l18 18', 'M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4', 'M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
};

export function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

let toastTimer = 0;
export function toast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.show = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => delete el.dataset.show, 1800);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for webviews without the async clipboard.
    const ta = h('textarea', { 'aria-hidden': 'true', readonly: true });
    ta.value = text;
    ta.style.setProperty('position', 'fixed');
    ta.style.setProperty('opacity', '0');
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
