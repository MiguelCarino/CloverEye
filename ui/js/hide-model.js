// Which posts of a thread are hidden, and why (SCOPE §3.2). A post is
// hidden by hand (the post's … menu, kept in settings.hiddenPosts), by a
// hide filter (filter-model.js), or, when "Also hide replies to hidden
// posts" is on, because every post it quotes in the thread is hidden. No
// DOM, so it runs under `node --test`.

import { quotedPosts } from './render.js';

/** Why a post is hidden: by hand, by a filter, or as a reply to hidden posts. */
export const HIDE_REASONS = Object.freeze(['hidden', 'filter', 'reply']);

/**
 * Post No. → { reason, via? } for every hidden post of a thread.
 *
 * - `marks` comes from filter-model.js markPosts(): 'hidden' (by hand),
 *   'hide' (a filter) or 'highlight'.
 * - With `replies` on, a post whose quotes (of other posts in this thread)
 *   are all hidden is hidden too, and so on down the chain; `via` is the
 *   first hidden post it quotes. Quotes of the opening post do not count
 *   (a hidden OP would otherwise hide most of its thread), quotes of posts
 *   not in the thread are ignored, and a post that quotes nothing stays.
 * - Posts in `keep` (your own) and highlighted posts are never hidden as
 *   replies.
 *
 * @param {object[]} posts  a thread's posts, in order
 * @param {Map<number, string>} [marks]
 * @param {{ replies?: boolean, keep?: Set<number> }} [o]
 * @returns {Map<number, { reason: 'hidden'|'filter'|'reply', via?: number }>}
 */
export function hiddenPosts(posts, marks = new Map(), { replies = true, keep = new Set() } = {}) {
  const out = new Map();
  const list = (Array.isArray(posts) ? posts : []).filter((p) => p && Number.isSafeInteger(p.no));
  for (const p of list) {
    const m = marks.get(p.no);
    if (m === 'hidden') out.set(p.no, { reason: 'hidden' });
    else if (m === 'hide') out.set(p.no, { reason: 'filter' });
  }
  if (!replies || !out.size) return out;
  const op = list.find((p) => !p.resto)?.no ?? null;
  const present = new Set(list.map((p) => p.no));
  const quotes = new Map();
  for (const p of list) {
    if (out.has(p.no) || keep.has(p.no) || marks.get(p.no) === 'highlight' || !p.com) continue;
    const q = quotedPosts(p.com).filter((n) => n !== p.no && n !== op && present.has(n));
    if (q.length) quotes.set(p.no, q);
  }
  // Posts come in order, so one pass settles nearly everything; repeat only
  // while something changed (a quote of a later post).
  let changed = true;
  while (changed) {
    changed = false;
    for (const [no, q] of quotes) {
      if (out.has(no) || !q.every((n) => out.has(n))) continue;
      out.set(no, { reason: 'reply', via: q[0] });
      quotes.delete(no);
      changed = true;
    }
  }
  return out;
}

/** How many hidden posts there are of each reason. */
export function hiddenCounts(hidden) {
  const counts = { hidden: 0, filter: 0, reply: 0, total: 0 };
  for (const { reason } of hidden?.values?.() || []) {
    if (reason in counts) counts[reason] += 1;
    counts.total += 1;
  }
  return counts;
}
