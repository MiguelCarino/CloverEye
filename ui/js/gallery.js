// The thread gallery (G): every file of a thread, one at a time, as large
// as the window allows. Arrow keys, J/K, Home/End and the mouse wheel move;
// D saves; Esc or G closes. Lives outside the shell's redraws.

import { step, saveName } from './gallery-model.js';
import { h, icon, toast } from './dom.js';
import { formatBytes } from './render.js';

const WHEEL_GAP_MS = 180;

/**
 * @param {object} o
 * @param {Array} o.items          galleryItems(...)
 * @param {number} [o.start]       index to open on
 * @param {string} o.title         thread title, for the bar
 * @param {(item) => Promise<string>} o.onSave   saves one file; returns where
 * @param {(no: number) => void} [o.onClose]     the post shown last
 */
export function openGallery({ items, start = 0, title = '', onSave, onClose = () => {} }) {
  if (!items.length) {
    toast('This thread has no files.');
    return null;
  }
  let index = Math.max(0, Math.min(items.length - 1, start));
  let lastWheel = 0;
  const opener = document.activeElement;
  const strip = h('div', { class: 'gallery__strip', role: 'listbox', 'aria-label': 'Files in this thread' });
  const stage = h('div', { class: 'gallery__stage' });
  const counter = h('span', { class: 'gallery__count' });
  const name = h('span', { class: 'gallery__name' });
  const root = h(
    'div',
    { class: 'gallery', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Gallery: ${title}`, 'data-key': 'gallery', tabindex: '-1' },
    h(
      'div',
      { class: 'gallery__bar' },
      counter,
      name,
      h('span', { class: 'gallery__spacer' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous file (←)', 'data-key': 'gallery-prev', onclick: () => go(-1) }, icon('arrowLeft')),
      h('button', { type: 'button', class: 'icon-btn gallery__next', 'aria-label': 'Next file (→)', 'data-key': 'gallery-next', onclick: () => go(1) }, icon('arrowLeft')),
      h('button', { type: 'button', class: 'btn btn--sm', 'data-key': 'gallery-save', onclick: () => save() }, icon('copy'), 'Save (D)'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the gallery (Esc)', 'data-key': 'gallery-close', onclick: () => close() }, icon('x')),
    ),
    stage,
    strip,
  );

  items.forEach((it, i) =>
    strip.append(
      h(
        'button',
        { type: 'button', class: 'gallery__thumb', role: 'option', 'aria-label': it.name, 'data-index': String(i), onclick: () => show(i) },
        it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : h('span', { text: it.ext }),
        it.video ? h('span', { class: 'gallery__badge', 'aria-hidden': 'true', text: '▶' }) : null,
      ),
    ),
  );

  function show(i) {
    index = i;
    const it = items[index];
    for (const v of stage.querySelectorAll('video')) v.pause();
    stage.replaceChildren(
      it.video
        ? h('video', { class: 'gallery__media', src: it.full, controls: true, autoplay: true, loop: true, playsinline: true })
        : h('img', { class: 'gallery__media', src: it.full, alt: it.name, decoding: 'async' }),
    );
    counter.textContent = `${index + 1} / ${items.length}`;
    name.textContent = `${it.name}${it.w && it.h ? ` · ${it.w}×${it.h}` : ''}${it.size ? ` · ${formatBytes(it.size)}` : ''}`;
    for (const t of strip.children) {
      const on = Number(t.dataset.index) === index;
      t.setAttribute('aria-selected', String(on));
      if (on) t.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    // the next file starts loading now, so moving on is instant
    const nx = items[step(index, 1, items.length)];
    if (nx && !nx.video) {
      const pre = new Image();
      pre.src = nx.full;
    }
  }

  function go(delta) {
    show(step(index, delta, items.length));
  }

  async function save() {
    const it = items[index];
    try {
      const where = await onSave({ ...it, name: saveName(it) });
      toast(`Saved: ${where}`);
    } catch (e) {
      toast(`Couldn’t save: ${e?.message || e}`);
    }
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape' || k === 'g' || k === 'G') close();
    else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'j' || k === 'J' || k === 'PageDown') go(1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'k' || k === 'K' || k === 'PageUp') go(-1);
    else if (k === 'Home') show(0);
    else if (k === 'End') show(items.length - 1);
    else if (k === 'd' || k === 'D') save();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onWheel(e) {
    if (strip.contains(e.target)) return; // the strip scrolls itself
    e.preventDefault();
    const now = performance.now();
    if (now - lastWheel < WHEEL_GAP_MS || Math.abs(e.deltaY) < 4) return;
    lastWheel = now;
    go(e.deltaY > 0 ? 1 : -1);
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    for (const v of root.querySelectorAll('video')) v.pause();
    root.remove();
    for (const el of behind) el.inert = false;
    onClose(items[index]?.no);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', onKey, true);
  root.addEventListener('wheel', onWheel, { passive: false });
  // The page under the gallery is out of reach while it is open.
  const behind = [...document.body.children].filter((el) => !el.inert && el.id !== 'toast');
  for (const el of behind) el.inert = true;
  document.body.append(root);
  show(index);
  root.focus();
  return { close, show, index: () => index };
}
