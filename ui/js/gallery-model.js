// The thread gallery (G): every file in a thread, in post order. No DOM.

import { fileView } from './display-model.js';
import { postFileName } from './render.js';

const VIDEO = /^\.(webm|mp4)$/i;

/** Files of a thread as gallery items. `urls` gives thumb/full URLs (the
 *  bridge decides where they come from). `display` is Settings → Posts
 *  (display-model.js): each item's `view` is how the thread draws its file
 *  (fileView): 'thumb', 'spoiler' (a spoiler not revealed) or 'line' (work
 *  mode), so the gallery hides the same files; `shownView` is how it draws
 *  once shown from its work-mode line (a spoiler stays a spoiler). Without
 *  `display` items have no view and every file shows, as before Settings
 *  reached the gallery. `isShown(post)`: the person already opened that
 *  file from its work-mode line this session. */
export function galleryItems(posts, board, urls, display = undefined, { isShown = null } = {}) {
  const out = [];
  for (const p of posts || []) {
    if (!p?.tim || p.filedeleted) continue;
    const full = urls.mediaUrl(board, p);
    if (!full) continue;
    const item = {
      no: p.no,
      full,
      thumb: urls.thumbUrl(board, p),
      name: postFileName(p),
      ext: p.ext || '',
      video: VIDEO.test(p.ext || ''),
      w: p.w || 0,
      h: p.h || 0,
      size: p.fsize || 0,
    };
    if (display) {
      item.view = fileView(p, display, { shown: Boolean(isShown?.(p)) });
      if (item.view === 'line') item.shownView = fileView(p, display, { shown: true });
    }
    out.push(item);
  }
  return out;
}

/** How the gallery draws item `index` now: 'thumb', 'spoiler' or 'line'.
 *  `revealed`: items the person revealed in this gallery (Show this file);
 *  `opened`: work-mode items moved to, which then draw as their `shownView`
 *  (so a spoiler still waits for Show this file, as in the thread). */
export function currentView(item, index, revealed = new Set(), opened = new Set()) {
  if (!item?.view || revealed.has(index)) return 'thumb';
  if (item.view === 'line' && opened.has(index)) return item.shownView || 'thumb';
  return item.view;
}

/** Whether the gallery may show an item's picture (thumbnail or file)
 *  without the person asking. */
export function pictureShown(item, index, revealed = new Set(), opened = new Set()) {
  return currentView(item, index, revealed, opened) === 'thumb';
}

/** Whether a neighbour may be loaded ahead: only a file that shows once it
 *  is moved to (never a spoiler that is not revealed, also in work mode). */
export function preloadable(item, index, revealed = new Set()) {
  if (item?.view === 'line') return currentView(item, index, revealed, new Set([index])) === 'thumb';
  return pictureShown(item, index, revealed);
}

/** Next index for a move (wraps around). */
export function step(index, delta, length) {
  if (!length) return 0;
  return (((index + delta) % length) + length) % length;
}

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;
const SAVE_MAX = 120; // code points, the extension included

/** A file name's stem and extension: `item.ext` when the name ends with it
 *  (or there is one and the name lacks it), else from the last dot. */
function nameParts(item) {
  const name = String(item?.name || '');
  const ext = String(item?.ext || '');
  if (ext) return { stem: name.toLowerCase().endsWith(ext.toLowerCase()) ? name.slice(0, name.length - ext.length) : name, ext };
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/**
 * A safe file name for saving: the original name (or the post's tim), with
 * characters no system takes as '_'. The stem is cut, never the extension,
 * and by code points, so a character outside the BMP (an emoji) is never
 * split in half. `suffix` goes between the stem and the extension
 * ("name-1234.jpg", for a second file with one name).
 */
export function saveName(item, suffix = '') {
  const parts = nameParts(item);
  const ext = Array.from(parts.ext.replace(UNSAFE, '_')).slice(0, 16).join('');
  const tail = `${String(suffix).replace(UNSAFE, '_')}${ext}`;
  const room = Math.max(1, SAVE_MAX - Array.from(tail).length);
  const stem = Array.from(parts.stem.replace(UNSAFE, '_')).slice(0, room).join('');
  return `${stem || 'file'}${tail}`;
}
