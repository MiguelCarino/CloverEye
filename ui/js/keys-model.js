// SPDX-License-Identifier: AGPL-3.0-only
// Keys for replying (shell.js, browse.js): R opens the reply form of the
// thread shown (or a new thread on the board shown), and the menu keys
// (ContextMenu, Shift+F10) on a Reply or New thread button open the
// pre-written posts, as a right-click does. No DOM.

/** The Latin letter a key press means, lower case, or '': the letter it
 *  typed, or, when it typed none (a Cyrillic or Greek layout), the letter
 *  at its place on a US keyboard (e.code). A Latin layout's own letter
 *  always wins: Ctrl+Z on AZERTY sits where W is and stays Z. */
export function keyLetter(e) {
  const key = String(e?.key || '');
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if ([...key].length === 1 && /\p{L}/u.test(key)) return (/^Key([A-Z])$/.exec(e?.code || '')?.[1] || '').toLowerCase();
  return '';
}

const plain = (e) => Boolean(e) && !e.ctrlKey && !e.metaKey && !e.altKey;

/** R (or Shift+R) with no Ctrl, ⌘ or Alt: Ctrl+R / ⌘R is Update. */
export function isReplyKey(e) {
  return plain(e) && keyLetter(e) === 'r';
}

/** L (or Shift+L) with no Ctrl, ⌘ or Alt: a thread in a list or columns. */
export function isLayoutKey(e) {
  return plain(e) && keyLetter(e) === 'l';
}

/** The keyboard's menu key, or Shift+F10: a right-click from the keyboard. */
export function isMenuKey(e) {
  if (!e || e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key === 'ContextMenu' || (e.key === 'F10' && Boolean(e.shiftKey));
}

/** Why a thread takes no reply: '' when it does. `entry` is the shell's
 *  { posts, gone } for it (the first post says closed or archived). */
export function replyBlock(entry) {
  if (entry?.gone) return 'gone';
  const op = entry?.posts?.[0];
  if (op?.archived) return 'archived';
  if (op?.closed) return 'closed';
  return '';
}

/** What the R key says when the thread takes no reply. */
export const REPLY_BLOCKED = {
  gone: 'This thread is gone (404).',
  archived: 'This thread is archived: no new replies.',
  closed: 'This thread is closed: no new replies.',
};
