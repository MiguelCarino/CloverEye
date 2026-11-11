// Hover preview: resting the mouse on a thumbnail shows the file at full
// quality, scaled down only as far as needed to fit inside the window.
// Any element with data-preview="<url>" takes part; data-preview-w/-h give
// the file's size so the box is placed before the file arrives, and
// data-preview-video marks WebM/MP4 (played muted, looping). Mouse only:
// touch and pen never trigger it. Off when <html data-hover-preview="off">.
//
// The app redraws whole panes (thread updates, the watcher, unread marks,
// a window resize) and puts the scroll back, so the thumbnail under a
// resting pointer is often swapped for an identical new one. The preview
// follows the new element instead of closing and opening again, which made
// it blink each time something redrew.

const DELAY_MS = 120;
const GAP = 16; // from the pointer
const MARGIN = 12; // from the window edges

/** Where the preview goes: beside the pointer on the side with more room,
 *  fitted to the window. Pure, so it can be tested. */
export function placePreview({ x, y, w, h, vw, vh }) {
  const roomRight = vw - x - GAP - MARGIN;
  const roomLeft = x - GAP - MARGIN;
  const right = roomRight >= roomLeft;
  const maxW = Math.max(80, right ? roomRight : roomLeft);
  const maxH = Math.max(80, vh - 2 * MARGIN);
  const scale = Math.min(1, maxW / (w || maxW), maxH / (h || maxH));
  const width = Math.round((w || maxW) * scale);
  const height = Math.round((h || maxH) * scale);
  const left = right ? x + GAP : x - GAP - width;
  const top = Math.min(Math.max(MARGIN, y - height / 2), vh - MARGIN - height);
  return { left: Math.round(left), top: Math.round(top), width, height };
}

/** Is `t` the same file as the one `was` stood for (a redrawn copy)? */
export const sameFile = (t, was) => Boolean(t && was && t.dataset.preview && t.dataset.preview === was.dataset.preview);

export function installHoverPreview(doc = document) {
  const box = doc.createElement('div');
  box.className = 'hover-preview';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  doc.body.append(box);
  let target = null;
  let timer = null;
  let last = { x: 0, y: 0 };
  let frame = 0;

  const size = () => ({
    w: Number(target?.dataset.previewW) || 0,
    h: Number(target?.dataset.previewH) || 0,
  });

  /** The previewable element under the pointer now (the box itself takes
   *  no pointer events, so it is never the answer). */
  const under = () => doc.elementFromPoint?.(last.x, last.y)?.closest?.('[data-preview]') || null;

  /** After a redraw or a scroll: keeps the preview if the same file is still
   *  under the pointer (adopting the new element), else closes it. */
  function follow() {
    if (!target) return false;
    const t = under();
    if (t === target || (sameFile(t, target) && !t.closest('.post__file--open'))) {
      target = t;
      return true;
    }
    hide();
    return false;
  }

  function place() {
    if (!target || box.hidden) return;
    if (!target.isConnected && !follow()) return;
    const { w, h } = size();
    const p = placePreview({ x: last.x, y: last.y, w, h, vw: doc.documentElement.clientWidth, vh: doc.documentElement.clientHeight });
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
  }

  // Redraws happen while the pointer rests: check once a frame after one.
  const watcher = typeof MutationObserver === 'function'
    ? new MutationObserver(() => {
        if (frame || !target) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (target && !target.isConnected) {
            if (follow()) place();
          }
        });
      })
    : null;

  function show() {
    timer = null;
    if (!target || doc.documentElement.dataset.hoverPreview === 'off') return;
    if (!target.isConnected && !follow()) return;
    // An expanded file (or one already open) needs no preview.
    if (target.closest('.post__file--open')) return;
    box.replaceChildren();
    const url = target.dataset.preview;
    if (target.dataset.previewVideo === 'true') {
      const v = doc.createElement('video');
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      v.src = url;
      box.append(v);
    } else {
      const img = doc.createElement('img');
      img.decoding = 'async';
      img.alt = '';
      img.src = url;
      box.append(img);
    }
    box.hidden = false;
    place();
    // Stats → You counts files viewed (stats.js; nothing while that is off)
    doc.dispatchEvent(new CustomEvent('clovereye:file-view', { detail: { how: 'hover' } }));
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    target = null;
    watcher?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!box.hidden) {
      box.hidden = true;
      box.replaceChildren(); // stops a video and drops the full-size file
    }
  }

  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target.closest?.('[data-preview]');
    if (!t || t === target) return;
    last = { x: e.clientX, y: e.clientY };
    // a redrawn copy of the file already shown (or about to be): keep it
    if (target && !target.isConnected && sameFile(t, target)) {
      target = t;
      return;
    }
    hide();
    target = t;
    watcher?.observe(doc.body, { childList: true, subtree: true });
    timer = setTimeout(show, DELAY_MS);
  });
  doc.addEventListener('pointermove', (e) => {
    if (!target) return;
    last = { x: e.clientX, y: e.clientY };
    place();
  });
  doc.addEventListener('pointerout', (e) => {
    if (!target) return;
    if (e.relatedTarget && target.contains(e.relatedTarget)) return;
    // the element was taken out from under the pointer by a redraw: the
    // copy that replaced it decides (watcher, pointerover)
    if (!target.isConnected) return;
    hide();
  });
  doc.addEventListener('pointerdown', hide, true);
  // A scroll the app makes (putting a redrawn pane back where it was) keeps
  // the preview; one that moves another file under the pointer closes it.
  doc.addEventListener(
    'scroll',
    () => {
      if (target && follow()) place();
    },
    true,
  );
  doc.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  return { hide };
}
