// Threads saved for reading offline, and "Download all files": which files
// to fetch, in what order, one at a time and at least a second apart
// (SCOPE §3.1: download all, throttled to 1 request/s). No DOM.

import { saveName } from './gallery-model.js';

const BOARD = /^[a-z0-9]{1,10}$/;
const EXTS = new Set(['.jpg', '.png', '.gif', '.webm', '.mp4', '.pdf']);
/** At least this long between two downloads (the Rust side keeps it too). */
export const DOWNLOAD_GAP_MS = 1000;
/** A run stops after this many failures in a row (the site is unreachable). */
export const MAX_FAILURES_IN_ROW = 5;

const num = (n) => Number.isSafeInteger(n) && n > 0;
const timOf = (p) => (num(Number(p?.tim)) && /^\d{1,20}$/.test(String(p.tim)) ? Number(p.tim) : 0);

/** Whether a post has a file that can be saved: a number, a known kind. */
export function hasSavableFile(p) {
  return Boolean(p && !p.filedeleted && timOf(p) && EXTS.has(p.ext));
}

/**
 * The files of a thread to save offline: every thumbnail first (the saved
 * copy reads well soon), then every full file, in post order.
 * @returns {{no: number, tim: number, ext: string, kind: 'thumb'|'full', size: number}[]}
 */
export function fileJobs(posts) {
  const withFile = (posts || []).filter(hasSavableFile);
  const job = (p, kind) => ({ no: p.no, tim: timOf(p), ext: p.ext, kind, size: kind === 'full' && num(p.fsize) ? p.fsize : 0 });
  return [...withFile.map((p) => job(p, 'thumb')), ...withFile.map((p) => job(p, 'full'))];
}

/**
 * The files of a thread for "Download all files", under their original
 * names. Two files with one name: the later ones get their file number, so
 * a second run finds the same names (and skips what is there).
 * @param {(post: object) => string|null} urlOf  the file's address (the bridge's mediaUrl)
 */
export function downloadJobs(posts, urlOf) {
  const seen = new Set();
  const out = [];
  for (const p of posts || []) {
    if (!hasSavableFile(p)) continue;
    const url = urlOf(p);
    if (!url) continue;
    let name = saveName({ name: `${p.filename || p.tim}${p.ext}`, ext: p.ext });
    if (seen.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      name = `${dot > 0 ? name.slice(0, dot) : name}-${timOf(p)}${p.ext}`;
    }
    seen.add(name.toLowerCase());
    out.push({ no: p.no, url, name, size: num(p.fsize) ? p.fsize : 0 });
  }
  return out;
}

/**
 * A saved copy updated with a newer load: posts the site has since dropped
 * stay (the copy keeps what was saved), newer copies of the same post win,
 * in post order. The OP comes from the newer load (closed, archived…).
 */
export function mergePosts(saved, loaded) {
  const byNo = new Map();
  for (const p of saved || []) if (num(p?.no)) byNo.set(p.no, p);
  for (const p of loaded || []) if (num(p?.no)) byNo.set(p.no, p);
  return [...byNo.values()].sort((a, b) => a.no - b.no);
}

/**
 * Runs `jobs` one at a time. After a job that made a request (`worker`
 * resolves { status: 'saved' }), waits `gapMs` before the next; a skipped
 * one (already there) needs no wait. Stops when `isCancelled()` turns true
 * or after `maxFailures` failures in a row.
 * @returns {Promise<{done: number, saved: number, skipped: number, failed: number, cancelled: boolean, stopped: string|null}>}
 */
export async function runQueue(jobs, worker, { gapMs = DOWNLOAD_GAP_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), isCancelled = () => false, onProgress = () => {}, maxFailures = MAX_FAILURES_IN_ROW } = {}) {
  const r = { done: 0, saved: 0, skipped: 0, failed: 0, cancelled: false, stopped: null };
  let inRow = 0;
  let wait = false;
  for (const job of jobs) {
    if (isCancelled()) {
      r.cancelled = true;
      break;
    }
    if (wait) {
      await sleep(gapMs);
      if (isCancelled()) {
        r.cancelled = true;
        break;
      }
    }
    try {
      const res = await worker(job);
      wait = res?.status !== 'skipped';
      if (wait) r.saved += 1;
      else r.skipped += 1;
      inRow = 0;
    } catch (e) {
      r.failed += 1;
      inRow += 1;
      wait = true;
      if (inRow >= maxFailures) {
        r.done += 1;
        r.stopped = String(e?.message || e);
        onProgress(r.done, r);
        break;
      }
    }
    r.done += 1;
    onProgress(r.done, r);
  }
  return r;
}

/** What a running save shows in its pane: "Saving 12/48 files…". */
export function progressText(job) {
  if (!job) return '';
  if (!job.total) return job.kind === 'all' ? 'Getting the files ready…' : 'Saving the thread…';
  return job.kind === 'all' ? `Downloading ${job.done}/${job.total} files…` : `Saving ${job.done}/${job.total} files…`;
}

/** What a finished run says (a toast). */
export function doneText(kind, r) {
  if (r.stopped) return `Stopped after ${r.failed} failures in a row: ${r.stopped}`;
  const what = kind === 'all' ? 'Downloaded' : 'Saved offline';
  if (r.cancelled) return `${what}: stopped, ${r.saved} new, ${r.skipped} already there.`;
  if (r.failed) return `${what}: ${r.saved} new, ${r.skipped} already there, ${r.failed} failed.`;
  return `${what}: ${r.saved} new, ${r.skipped} already there.`;
}

/** The saved threads list from the bridge, checked, newest first. */
export function savedEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && BOARD.test(e.board) && num(e.no))
    .map((e) => ({
      board: e.board,
      no: e.no,
      title: typeof e.title === 'string' ? e.title.slice(0, 200) : '',
      folder: typeof e.folder === 'string' ? e.folder : '',
      savedAt: Number.isFinite(e.savedAt) && e.savedAt > 0 ? e.savedAt : 0,
      posts: Number.isSafeInteger(e.posts) && e.posts >= 0 ? e.posts : 0,
      files: Number.isSafeInteger(e.files) && e.files >= 0 ? e.files : 0,
      bytes: Number.isSafeInteger(e.bytes) && e.bytes >= 0 ? e.bytes : 0,
    }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

/** Whether a thread is in the saved list. */
export function isSaved(entries, board, no) {
  return (entries || []).some((e) => e.board === board && e.no === no);
}

/**
 * Where a saved file is served from, as a path for the app's `cesaved:`
 * scheme: "g/123/files/1700000000000.jpg" or "g/123/thumbs/1700000000000s.jpg".
 * Null for anything that is not a saved thread's file.
 */
export function savedFilePath(board, no, post, kind) {
  if (!BOARD.test(String(board || '')) || !num(no) || !hasSavableFile(post)) return null;
  const tim = String(post.tim);
  return kind === 'thumb' ? `${board}/${no}/thumbs/${tim}s.jpg` : `${board}/${no}/files/${tim}${post.ext}`;
}

/**
 * The URLs a saved thread draws with, from what is on disk (`have`: the
 * file names in its files/ and thumbs/ folders). A missing thumbnail falls
 * back to the full picture; a missing full file has no URL (no request is
 * ever made to the site for it).
 * @param {(path: string) => string} toUrl  path → URL (the bridge's)
 */
export function savedUrls(no, have, toUrl) {
  const files = new Set(have?.files || []);
  const thumbs = new Set(have?.thumbs || []);
  const full = (board, p) => {
    const path = savedFilePath(board, no, p, 'full');
    return path && files.has(`${p.tim}${p.ext}`) ? toUrl(path) : null;
  };
  return {
    mediaUrl: full,
    thumbUrl: (board, p) => {
      const path = savedFilePath(board, no, p, 'thumb');
      if (path && thumbs.has(`${p.tim}s.jpg`)) return toUrl(path);
      return /^\.(jpg|png|gif)$/.test(p?.ext || '') ? full(board, p) : null;
    },
  };
}

/** A file's place on disk, for the gallery's Save in a saved thread. */
export function savedFileOnDisk(folder, post) {
  if (!folder || !hasSavableFile(post)) return '';
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder}${sep}files${sep}${post.tim}${post.ext}`;
}
