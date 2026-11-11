// Poster IDs (boards with user_ids): a stable colour per ID, with text that
// stays readable on it, and how many posts each ID has in a thread.
// DOM-free (tested with node --test).

/** A 32-bit hash of the ID's characters (the same ID always gets the same
 *  colour, on every board and every computer). */
export function idHash(id) {
  let hash = 0;
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i++) hash = (Math.imul(hash, 31) + s.charCodeAt(i)) | 0;
  // Spread the bits so IDs differing in one letter differ in colour too.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** WCAG relative luminance of an [r, g, b] colour (0–255 each). */
export function luminance([r, g, b]) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two [r, g, b] colours (1 to 21). */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

/**
 * The colours of a poster ID: `bg` from its hash, `fg` black or white,
 * whichever reads better on it (always ≥ 4.5:1).
 * @returns {{bg: string, fg: string}}
 */
export function idColour(id) {
  const hash = idHash(id);
  const rgb = [(hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff];
  const fg = contrastRatio(rgb, BLACK) >= contrastRatio(rgb, WHITE) ? '#000000' : '#ffffff';
  return { bg: `#${rgb.map(hex2).join('')}`, fg };
}

/** Poster ID → number of posts with it in the list. Posts without an ID
 *  (boards without user_ids) are not counted. */
export function idCounts(posts) {
  const out = new Map();
  for (const p of Array.isArray(posts) ? posts : []) {
    if (typeof p?.id !== 'string' || !p.id) continue;
    out.set(p.id, (out.get(p.id) || 0) + 1);
  }
  return out;
}

/** Post numbers with this poster ID, in thread order. */
export function postsWithId(posts, id) {
  if (!id) return [];
  return (Array.isArray(posts) ? posts : []).filter((p) => p?.id === id).map((p) => p.no);
}

/** Clicking an ID: highlight it, or clear the highlight when it is the one
 *  already highlighted. */
export const toggleIdHighlight = (current, id) => (!id || current === id ? null : id);
