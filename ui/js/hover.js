// Hover preview: resting the mouse on a thumbnail shows the file at full
// quality, scaled down only as far as needed to fit inside the window.
// Any element with data-preview="<url>" takes part; data-preview-w/-h give
// the file's size so the box is placed before the file arrives, and
// data-preview-video marks WebM/MP4 (played muted, looping). Mouse only:
// touch and pen never trigger it. Off when <html data-hover-preview="off">.

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

export function installHoverPreview(doc = document) {
  const box = doc.createElement('div');
  box.className = 'hover-preview';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  doc.body.append(box);
  let target = null;
  let timer = null;
  let last = { x: 0, y: 0 };

  const size = () => ({
    w: Number(target?.dataset.previewW) || 0,
    h: Number(target?.dataset.previewH) || 0,
  });

  function place() {
    if (!target || box.hidden) return;
    if (!target.isConnected) {
      hide(); // the page was redrawn under the pointer
      return;
    }
    const { w, h } = size();
    const p = placePreview({ x: last.x, y: last.y, w, h, vw: doc.documentElement.clientWidth, vh: doc.documentElement.clientHeight });
    Object.assign(box.style, { left: `${p.left}px`, top: `${p.top}px`, width: `${p.width}px`, height: `${p.height}px` });
  }

  function show() {
    if (!target || doc.documentElement.dataset.hoverPreview === 'off') return;
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
    if (!box.hidden) {
      box.hidden = true;
      box.replaceChildren(); // stops a video and drops the full-size file
    }
  }

  doc.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target.closest?.('[data-preview]');
    if (!t || t === target) return;
    hide();
    target = t;
    last = { x: e.clientX, y: e.clientY };
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
    hide();
  });
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('scroll', hide, true);
  doc.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
  return { hide };
}
