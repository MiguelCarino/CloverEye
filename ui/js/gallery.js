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
  const name = h('span', { class: 'gallery__name', translate: 'no' });
  const saveLabel = h('span', { class: 'gallery__save-label', text: 'Save (D)' });
  const saveBtn = h(
    'button',
    { type: 'button', class: 'btn btn--sm gallery__save', 'data-key': 'gallery-save', onclick: () => save() },
    h('span', { class: 'gallery__save-icon', 'aria-hidden': 'true' }, icon('download'), icon('check')),
    saveLabel,
    h('span', { class: 'gallery__save-bar', 'aria-hidden': 'true' }),
  );
  let saving = false;
  let saveReset = 0;
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
      saveBtn,
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

  // The save button shows the download: an arrow dropping into the tray and
  // a sweeping bar while it runs, the file flying down to the button and a
  // check when it lands, a shake when it fails. Saved files get a mark in
  // the strip.
  function saveState(state, label) {
    clearTimeout(saveReset);
    saveBtn.dataset.state = state;
    saveLabel.textContent = label;
    saveBtn.setAttribute('aria-busy', String(state === 'saving'));
    if (state === 'saved' || state === 'failed') {
      saveReset = setTimeout(() => saveState('idle', 'Save (D)'), 1800);
    }
  }

  function flyToSave() {
    const media = stage.querySelector('.gallery__media');
    if (!media || !media.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = media.getBoundingClientRect();
    const to = saveBtn.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const it = items[index];
    const size = Math.min(from.width, from.height, 160);
    const ghost = h('img', { class: 'gallery__fly', src: it.thumb || it.full, alt: '', 'aria-hidden': 'true' });
    ghost.style.left = `${from.left + from.width / 2 - size / 2}px`;
    ghost.style.top = `${from.top + from.height / 2 - size / 2}px`;
    ghost.style.width = `${size}px`;
    ghost.style.height = `${size}px`;
    root.append(ghost);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const anim = ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1)', opacity: 0.95 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) scale(0.55)`, opacity: 0.9, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0.15 },
      ],
      { duration: 650, easing: 'cubic-bezier(.45,0,.7,.45)' },
    );
    anim.onfinish = anim.oncancel = () => ghost.remove();
  }

  function markSaved(i) {
    const t = strip.querySelector(`[data-index="${i}"]`);
    if (t && !t.querySelector('.gallery__saved')) {
      t.append(h('span', { class: 'gallery__saved', 'aria-hidden': 'true' }, icon('check')));
      t.setAttribute('aria-label', `${items[i].name} (saved)`);
    }
  }

  async function save() {
    if (saving) return;
    const at = index;
    const it = items[at];
    saving = true;
    saveState('saving', 'Saving…');
    flyToSave();
    try {
      const where = await onSave({ ...it, name: saveName(it) });
      saveState('saved', 'Saved');
      markSaved(at);
      toast(`Saved: ${where}`);
    } catch (e) {
      saveState('failed', 'Not saved');
      toast(`Couldn’t save: ${e?.message || e}`);
    } finally {
      saving = false;
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
    clearTimeout(saveReset);
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
  saveState('idle', 'Save (D)');
  show(index);
  root.focus();
  return { close, show, index: () => index };
}
