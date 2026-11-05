// The thread gallery (G): every file in a thread, in post order. No DOM.

const VIDEO = /^\.(webm|mp4)$/i;

/** Files of a thread as gallery items. `urls` gives thumb/full URLs (the
 *  bridge decides where they come from). */
export function galleryItems(posts, board, urls) {
  const out = [];
  for (const p of posts || []) {
    if (!p?.tim || p.filedeleted) continue;
    const full = urls.mediaUrl(board, p);
    if (!full) continue;
    out.push({
      no: p.no,
      full,
      thumb: urls.thumbUrl(board, p),
      name: `${p.filename || p.tim}${p.ext || ''}`,
      ext: p.ext || '',
      video: VIDEO.test(p.ext || ''),
      w: p.w || 0,
      h: p.h || 0,
      size: p.fsize || 0,
    });
  }
  return out;
}

/** Next index for a move (wraps around). */
export function step(index, delta, length) {
  if (!length) return 0;
  return (((index + delta) % length) + length) % length;
}

/** A safe file name for saving: the original name, or the post's tim. */
export function saveName(item) {
  const base = String(item.name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  return base || `file${item.ext || ''}`;
}
