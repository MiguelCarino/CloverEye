// The library's store: the index loaded from the library folder, kept in
// step with the files, written back a moment after each change. Saving
// from threads, importing from the disk, look-alike fingerprints and the
// assistant's tags all go through here. The view (library-view.js) only
// draws it.
//
// Several windows each hold a copy of the index. A write names the
// revision it was made from; when another window wrote first, it is
// refused (library.rs), and this window reads the file again, makes its
// own changes again on it (library-model mergeIndex) and writes that. A
// refresh does the same merge, so it never drops what an import or a
// fingerprint pass still running has added. Reads and writes of the index
// go one at a time.
//
// The index belongs to the folder it was read from (`loadedDir`): every
// write and delete goes there, even after Settings point the library
// somewhere else. The next load() then finishes the long jobs and the
// last write in the old folder, and only then reads the new one.

import * as L from './library-model.js';
import { commentText, postFileName } from './render.js';
import { log } from './log.js';
import { errorKind } from './log-model.js';

const CHANGED_ELSEWHERE = /changed in another window/i;

/**
 * @param {object} o
 * @param {object} o.bridge
 * @param {() => object} o.getSettings
 * @param {() => void} o.onChange   the index or its state changed
 */
export function createLibrary({ bridge, getSettings, onChange }) {
  let state = { status: 'idle', root: '', error: '' };
  let index = L.emptyIndex();
  let ids = new Set();
  let loading = null; // the load running or done
  let loadingDir = null; // the folder it reads
  let loadedDir = null; // the folder `index` was read from (null: none read)
  let base = null; // the file as last read or written (L.snapshotOf)
  let dirty = false; // changes not written yet
  let saveTimer = 0;
  let writingRev = 0; // the rev of this window's last write (its own 'library-changed')
  let chain = Promise.resolve(); // reads and writes of the index, in turn
  let hashing = false;
  let hashAgain = false;
  let jobs = 0; // imports, removals, fingerprints, saves from posts running
  let idleWaiters = [];
  let version = 0;
  const pending = new Map(); // id → a save from a post still running
  const changed = () => {
    version += 1;
    onChange?.();
  };
  const dir = () => getSettings().files?.libraryDir || '';
  /** A copy the library meant to delete and could not (left on disk). */
  const dropFailed = (e) => log.warn('library', 'library.copy.left', { kind: errorKind(e) });
  const available = () => typeof bridge?.libraryLoad === 'function';

  function reindex() {
    ids = new Set(index.items.map((e) => e.id));
  }

  /** Runs `fn` after every read or write of the index before it. */
  function queue(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function job(fn) {
    jobs += 1;
    try {
      return await fn();
    } finally {
      jobs -= 1;
      if (!jobs) for (const w of idleWaiters.splice(0)) w();
    }
  }

  const idle = () => (jobs ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve());

  /** Changes need an index read from a folder. */
  function need() {
    if (loadedDir === null) throw new Error(state.error ? `Couldn’t open the library: ${state.error}` : 'The library isn’t open yet.');
  }

  /** The file's index as this window now holds it: on a read again of the
   *  same folder, this window's unwritten changes are made again on it. */
  function adopt(d, theirs) {
    if (loadedDir === d && base) {
      const m = L.mergeIndex(base, index, theirs);
      index = m.index;
      // copies this window made of files the other window kept as well
      for (const e of m.dropped) bridge.libraryDelete(d, e.rel).catch(dropFailed);
      if (m.dropped.length) log.debug('library', 'library.merge.dropped', { files: m.dropped.length });
    } else {
      index = theirs;
      dirty = false;
    }
    base = L.snapshotOf(theirs);
    loadedDir = d;
    reindex();
  }

  /** Reads the index from the folder (once; `force` reads it again, keeping
   *  what this window changed). A new library folder in Settings is read
   *  on the next call. */
  function load(force = false) {
    if (!available()) return Promise.resolve();
    const want = dir();
    if (loading && !force && want === loadingDir) return loading;
    loadingDir = want;
    if (loadedDir === null) state = { ...state, status: 'loading', error: '' };
    // loads run in turn, the last one asked for last
    const p = queue(async () => {
      if (loadedDir !== null && loadedDir !== want) {
        // another folder: what runs, and the last change, finish in the old one
        await idle();
        clearTimeout(saveTimer);
        saveTimer = 0;
        await writeNow(loadedDir);
        state = { ...state, status: 'loading', error: '' };
        changed();
      }
      let r;
      const t0 = performance.now();
      try {
        r = await bridge.libraryLoad(want);
      } catch (e) {
        log.warn('library', 'library.load.failed', { kind: errorKind(e), custom: Boolean(want), ms: Math.round(performance.now() - t0) });
        if (loading === p) loading = null; // the next call reads again
        if (loadedDir !== want) {
          // never kept as an empty library: nothing is written until it reads
          index = L.emptyIndex();
          loadedDir = null;
          base = null;
          dirty = false;
          reindex();
        }
        state = { status: 'error', root: '', error: String(e?.message || e) };
        changed();
        return;
      }
      const again = loadedDir === want;
      adopt(want, L.normalizeIndex(r?.index));
      state = { status: 'ready', root: r?.root || '', error: '' };
      const fields = { items: index.items.length, collections: index.collections.length, folders: Object.keys(index.folders || {}).length, rev: index.rev, merged: again, unsaved: dirty, custom: Boolean(want), ms: Math.round(performance.now() - t0) };
      if (again) log.debug('library', 'library.loaded', fields);
      else log.info('library', 'library.loaded', fields);
      if (dirty) save();
      changed();
      fingerprints();
    });
    loading = p;
    return p;
  }

  /** Writes the index to `d` (the folder it came from), merging first when
   *  another window wrote since. */
  async function writeNow(d) {
    for (let tries = 0; dirty && d === loadedDir && tries < 5; tries++) {
      dirty = false;
      const out = { ...index, rev: index.rev + 1 };
      const snap = L.snapshotOf(out);
      writingRev = out.rev;
      const end = log.time('library', 'library.saved');
      try {
        await bridge.librarySave(d, out);
        end({ items: out.items.length, rev: out.rev, tries });
        if (d === loadedDir) {
          index.rev = out.rev;
          base = snap;
        }
        if (state.error) {
          state = { ...state, error: '' };
          changed();
        }
        return;
      } catch (e) {
        if (writingRev === out.rev) writingRev = 0; // a failed write emits no event of its own
        dirty = true;
        const message = String(e?.message || e);
        if (!CHANGED_ELSEWHERE.test(message)) {
          log.warn('library', 'library.save.failed', { kind: errorKind(e), rev: out.rev });
          state = { ...state, error: `Couldn’t save the library’s list: ${message}` };
          changed();
          return;
        }
        log.debug('library', 'library.save.conflict', { rev: out.rev, tries });
        try {
          const r = await bridge.libraryLoad(d);
          if (d !== loadedDir) return;
          adopt(d, L.normalizeIndex(r?.index));
          changed();
        } catch (e2) {
          log.warn('library', 'library.save.failed', { kind: errorKind(e2), rev: out.rev, reread: true });
          state = { ...state, error: `Couldn’t save the library’s list: ${e2?.message || e2}` };
          changed();
          return;
        }
      }
    }
  }

  function save() {
    if (loadedDir === null) return; // never over a library not read
    dirty = true;
    const d = loadedDir;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      queue(() => writeNow(d));
    }, 300);
  }

  /** Another window wrote the index ('library-changed', { root, rev }): read
   *  it again, keeping this window's unwritten changes (load(true) merges).
   *  Skipped for this window's own write, a revision already read, another
   *  folder, or a library this window never opened. */
  function otherWrote(ev) {
    if (loadedDir === null || !ev) return;
    if (ev.root && state.root && ev.root !== state.root) return;
    const rev = Number(ev.rev);
    if (Number.isFinite(rev) && rev > 0 && (rev === writingRev || rev <= index.rev)) return;
    log.debug('library', 'library.changed.elsewhere', { rev: Number.isFinite(rev) ? rev : -1, had: index.rev });
    load(true);
  }

  /** Writes now what waits to be written. */
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const d = loadedDir;
    return d === null ? Promise.resolve() : queue(() => writeNow(d));
  }

  const find = (id) => index.items.find((e) => e.id === id) || null;

  /** Whether a post's file is in the library (by the site's MD5). */
  function has(md5b64) {
    const id = L.md5Hex(md5b64);
    return Boolean(id && ids.has(id));
  }

  /** Saves a post's file into the library: { status: 'saved' | 'have', entry }.
   *  The same file asked for twice at once (two Download all) is fetched once. */
  async function addFromPost({ board, thread, post, subject = '' }) {
    await load();
    need();
    const id = L.md5Hex(post.md5);
    while (id && pending.has(id)) await pending.get(id).catch(() => {});
    if (id && ids.has(id)) return { status: 'have', entry: find(id) };
    const url = bridge.mediaUrl(board, post);
    if (!url) throw new Error('This post has no file.');
    const run = job(async () => {
      const d = loadedDir;
      const name = postFileName(post);
      const t0 = performance.now();
      const r = await bridge.libraryFetch(d, url, board, name);
      log.debug('library', 'library.fetched', { board, thread, no: post.no, bytes: Number(r?.bytes) || 0, ms: Math.round(performance.now() - t0) });
      const entry = L.entryFromPost({ board, thread, post, subject: commentText(subject || ''), text: commentText(post.com || '').slice(0, 500), rel: r.rel, size: r.bytes });
      if (!entry || ids.has(entry.id)) {
        // kept meanwhile (an import): this copy goes
        await bridge.libraryDelete(d, r.rel).catch(dropFailed);
        if (!entry) throw new Error('This file can’t go in the library.');
        return { status: 'have', entry: find(entry.id) };
      }
      index.items.unshift(entry);
      ids.add(entry.id);
      save();
      changed();
      fingerprints();
      return { status: 'saved', entry };
    });
    if (!id) return run;
    pending.set(id, run);
    try {
      return await run;
    } finally {
      if (pending.get(id) === run) pending.delete(id);
    }
  }

  /** Brings files in from the disk. `known` (library-model knownFiles)
   *  gives files seen in threads their source back. Progress goes to
   *  `onProgress(done, total)`. { added, have, failed: [{ name, message }] } */
  async function importFiles(files, { known = null, onProgress = () => {} } = {}) {
    await load();
    need();
    return job(async () => {
      const d = loadedDir;
      const t0 = performance.now();
      let bytesIn = 0;
      const out = { added: 0, have: 0, failed: [] };
      const list = [...files].filter((f) => /\.(jpe?g|png|gif|webp|webm|mp4)$/i.test(f.name));
      const skipped = files.length - list.length;
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        onProgress(i, list.length);
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          bytesIn += bytes.length;
          const id = L.md5(bytes);
          if (ids.has(id)) {
            out.have += 1;
            continue;
          }
          const r = await bridge.libraryImport(d, f.name, bytes);
          const look = await looks(new Blob([bytes], { type: f.type || '' }), f.name);
          // kept meanwhile (a save from a thread): this copy goes
          if (ids.has(id)) {
            await bridge.libraryDelete(d, r.rel).catch(dropFailed);
            out.have += 1;
            continue;
          }
          const entry = L.entryFromImport({ id, rel: r.rel, name: f.name, size: bytes.length, w: look.w, h: look.h, known });
          if (!entry) throw new Error('This file can’t go in the library.');
          entry.dhash = look.dhash;
          index.items.unshift(entry);
          ids.add(id);
          out.added += 1;
          if (out.added % 25 === 0) save();
          changed();
        } catch (e) {
          out.failed.push({ name: f.name, message: String(e?.message || e) });
        }
      }
      onProgress(list.length, list.length);
      if (out.added) save();
      out.skipped = skipped;
      changed();
      log.info('library', 'library.imported', { files: files.length, added: out.added, have: out.have, skipped, failed: out.failed.length, failKinds: [...new Set(out.failed.map((x) => errorKind(x.message)))].join(','), bytes: bytesIn, ms: Math.round(performance.now() - t0) });
      return out;
    });
  }

  /** The record of an imported folder, in the index as it is now. */
  function folderRecord(src) {
    if (!index.folders) index.folders = {};
    if (!index.folders[src]) index.folders[src] = L.normalizeFolder({});
    return index.folders[src];
  }

  /** Brings in a folder of the computer (sub-folders too when `deep`):
   *  the app copies its pictures and videos in, then each is checked
   *  against what is kept (a copy is taken back out, and left out of the
   *  next rescan) and fingerprinted. The folder itself is only read.
   *  { added, have, failed, more } */
  async function importFolder(src, { deep = true, known = null, onProgress = () => {}, skip = [] } = {}) {
    await load();
    need();
    return job(async () => {
      const d = loadedDir;
      onProgress(0, 0);
      const t0 = performance.now();
      let bytesIn = 0;
      let lookMs = 0;
      const r = await bridge.libraryImportDir(d, src, deep, skip);
      const copyMs = Math.round(performance.now() - t0);
      Object.assign(folderRecord(src), { deep, at: Date.now() });
      const out = { added: 0, have: 0, failed: [], more: Boolean(r?.more), skipped: 0 };
      const list = r?.items || [];
      const dropCopy = (it) => bridge.libraryDelete(d, it.rel).catch(dropFailed);
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        onProgress(i, list.length);
        try {
          const blob = await blobOf({ rel: it.rel });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          bytesIn += bytes.length;
          const id = L.md5(bytes);
          const l0 = performance.now();
          const look = ids.has(id) ? null : await looks(blob, it.name);
          lookMs += performance.now() - l0;
          if (ids.has(id)) {
            // a copy of one kept: taken back out, and not copied again
            out.have += 1;
            await dropCopy(it);
            if (it.from) L.addFolderPath(folderRecord(src), 'dupes', it.from);
            continue;
          }
          const entry = L.entryFromImport({ id, rel: it.rel, name: it.name, size: bytes.length, w: look.w, h: look.h, known, folder: src, from: it.from });
          if (!entry) throw new Error('This file can’t go in the library.');
          entry.dhash = look.dhash;
          index.items.unshift(entry);
          ids.add(id);
          out.added += 1;
          if (out.added % 25 === 0) {
            save();
            changed();
          }
        } catch (e) {
          // its copy is not left behind unlisted
          await dropCopy(it);
          out.failed.push({ name: it.name, message: String(e?.message || e) });
        }
      }
      onProgress(list.length, list.length);
      save();
      changed();
      log.info('library', 'library.folder.imported', { deep: Boolean(deep), rescan: skip.length > 0, copied: list.length, added: out.added, have: out.have, failed: out.failed.length, more: out.more, bytes: bytesIn, copy_ms: copyMs, look_ms: Math.round(lookMs), ms: Math.round(performance.now() - t0) });
      return out;
    });
  }

  /** Looks in an imported folder again: brings in what was added since,
   *  and the files past the last one's limit (the files already brought
   *  in, taken out, or dropped as copies are not copied again). `deep`
   *  defaults to how it was first imported. */
  async function rescanFolder(src, o = {}) {
    await load();
    const rec = index.folders?.[src];
    const deep = o.deep ?? rec?.deep ?? true;
    const skip = [...index.items.filter((e) => e.folder === src && e.from).map((e) => e.from), ...(rec?.removed || []), ...(rec?.dupes || [])];
    return importFolder(src, { ...o, deep, skip: [...new Set(skip)] });
  }

  /** Takes out every file imported from one folder (they are deleted from
   *  the library folder; the folder itself is not touched). */
  async function removeFolder(folder) {
    need();
    return job(async () => {
      const d = loadedDir;
      let removed = 0;
      for (const id of index.items.filter((x) => x.folder === folder).map((x) => x.id)) {
        const e = find(id);
        if (!e) continue;
        try {
          await bridge.libraryDelete(d, e.rel);
          index.items = index.items.filter((x) => x.id !== id);
          removed += 1;
        } catch (err) {
          /* left in the list: it can be tried again */
          log.warn('library', 'library.delete.failed', { kind: errorKind(err), from: 'folder' });
        }
      }
      log.info('library', 'library.folder.removed', { removed, items: index.items.length });
      if (index.folders) delete index.folders[folder];
      reindex();
      save();
      changed();
      return removed;
    });
  }

  /** Changes an entry: { tags, collections, ai }. */
  function update(id, patch) {
    if (loadedDir === null) return;
    const e = find(id);
    if (!e) return;
    const next = L.normalizeEntry({ ...e, ...patch });
    if (!next) return;
    Object.assign(e, next);
    // in place: the entries stay the ones running jobs hold
    if (patch.collections) index.collections = L.collectionsOf(index);
    save();
    changed();
  }

  async function remove(id, { quiet = false } = {}) {
    need();
    const e = find(id);
    if (!e) return;
    await bridge.libraryDelete(loadedDir, e.rel);
    index.items = index.items.filter((x) => x.id !== id);
    log.debug('library', 'library.deleted', { items: index.items.length, imported: Boolean(e.folder) });
    // taken out by hand: a rescan of its folder leaves it out
    const f = e.folder && index.folders?.[e.folder];
    if (f && e.from) L.addFolderPath(f, 'removed', e.from);
    if (quiet) return;
    reindex();
    save();
    changed();
  }

  function addCollection(name) {
    const n = String(name || '').trim().slice(0, 60);
    if (!n || loadedDir === null || index.collections.includes(n)) return n;
    index.collections = [...index.collections, n];
    save();
    changed();
    return n;
  }

  function removeCollection(name) {
    if (loadedDir === null) return;
    index.collections = index.collections.filter((c) => c !== name);
    for (const e of index.items) e.collections = e.collections.filter((c) => c !== name);
    save();
    changed();
  }

  /** The file's address. A `celib:` one names the file's content (its MD5),
   *  so the window may keep it: the same address is always the same file. */
  function fileUrl(e) {
    const u = bridge.libraryFileUrl?.(e.rel) || '';
    return /^(celib:|https?:\/\/celib\.localhost\/)/i.test(u) && /^[0-9a-f]{32}$/.test(e.id || '') ? `${u}${u.includes('?') ? '&' : '?'}v=${e.id}` : u;
  }

  /** Size and look-alike fingerprint of a picture (videos: neither). */
  async function looks(blob, name) {
    if (/\.(webm|mp4|pdf)$/i.test(name) || typeof createImageBitmap !== 'function') return { w: 0, h: 0, dhash: '' };
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      // 72×64 first, then each 8×8 block averaged (greyOf)
      c.width = 72;
      c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, 72, 64);
      const out = { w: bmp.width, h: bmp.height, dhash: L.dhash(L.greyOf(g.getImageData(0, 0, 72, 64).data, 72, 64)) };
      bmp.close?.();
      return out;
    } catch (e) {
      // not a picture the browser can read: no fingerprint (said at debug)
      log.debug('library', 'library.look.failed', { kind: errorKind(e) });
      return { w: 0, h: 0, dhash: '' };
    }
  }

  async function blobOf(e) {
    const own = await bridge.libraryRead?.(e.rel);
    if (own) return own;
    const res = await fetch(fileUrl(e));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  /** Fingerprints for the pictures that have none yet, one at a time, in
   *  the background. Each lands on the entry as the index holds it then
   *  (by id); asked again while running, it looks again when done. */
  async function fingerprints() {
    if (hashing) {
      hashAgain = true;
      return;
    }
    hashing = true;
    try {
      await job(async () => {
        do {
          hashAgain = false;
          let done = 0;
          let failed = 0;
          const t0 = performance.now();
          const todo = index.items.filter((e) => !e.dhash && e.kind !== 'video' && e.kind !== 'pdf').map((e) => e.id);
          for (const id of todo) {
            if (loadingDir !== loadedDir) return; // another folder is waiting
            const e = find(id);
            if (!e || e.dhash) continue;
            try {
              const look = await looks(await blobOf(e), e.name);
              const now = find(id);
              if (look.dhash && now && !now.dhash) {
                now.dhash = look.dhash;
                if (!now.w) Object.assign(now, { w: look.w, h: look.h });
                done += 1;
              }
            } catch {
              /* the file is missing or not a picture: no fingerprint */
              failed += 1;
            }
          }
          // the look-alike fingerprints made this pass, and how long they took
          if (todo.length) log.debug('library', 'library.fingerprints', { todo: todo.length, done, failed, ms: Math.round(performance.now() - t0) });
          if (done) {
            save();
            changed();
          }
        } while (hashAgain);
      });
    } finally {
      hashing = false;
    }
  }

  /** The file as a File, for the reply form. */
  async function asFile(e) {
    const blob = await blobOf(e);
    const type = blob.type || { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', webm: 'video/webm', mp4: 'video/mp4' }[e.ext] || '';
    return new File([blob], e.name, { type });
  }

  /** A small JPEG of the picture (base64), for the assistant to look at. */
  async function smallJpeg(e) {
    const bmp = await createImageBitmap(await blobOf(e));
    const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  }

  let aiSeq = 0;
  /** Asks the local assistant's picture model for tags; they are kept as
   *  suggestions (entry.ai) to accept one by one. Returns the tags. */
  async function aiTags(id, ai) {
    const e = find(id);
    if (!e || e.kind === 'video' || e.kind === 'pdf') return [];
    const t0 = performance.now();
    const jpeg = await smallJpeg(e);
    const jpegMs = Math.round(performance.now() - t0);
    const text = await new Promise((resolve, reject) => {
      let out = '';
      const onEvent = (ev) => {
        if (ev?.type === 'text') out += ev.text || '';
        else if (ev?.type === 'done') resolve(out);
        else if (ev?.type === 'error') reject(new Error(ev.message || 'The assistant failed.'));
      };
      Promise.resolve(bridge.aiChat({ id: `lib-${++aiSeq}`, kind: ai.kind, port: ai.port, model: ai.vision, messages: L.aiTagMessages(ai.kind, jpeg), numCtx: 4096 }, onEvent)).catch(reject);
    });
    const now = find(id);
    const tags = L.parseAiTags(text).filter((t) => !now?.tags.includes(t));
    // how many tags came, never which
    log.debug('library', 'library.ai.tagged', { server: String(ai.kind || ''), model: String(ai.vision || ''), jpegBytes: Math.round((jpeg.length * 3) / 4), suggested: tags.length, answerChars: text.length, jpeg_ms: jpegMs, ms: Math.round(performance.now() - t0) });
    update(id, { ai: tags });
    return tags;
  }

  return {
    load,
    /** Settings name another library folder than the one read: load() reads it. */
    stale: () => available() && loadingDir !== null && dir() !== loadingDir,
    state: () => state,
    /** Goes up by one on every change: a key for work done over the items. */
    version: () => version,
    items: () => index.items,
    collections: () => index.collections,
    find,
    has,
    addFromPost,
    importFiles,
    importFolder,
    removeFolder,
    rescanFolder,
    folderInfo: (path) => index.folders?.[path] || null,
    folders: () => Object.keys(index.folders || {}),
    /** Several at once: each deleted from the library folder; one redraw. */
    async removeMany(idList) {
      need();
      return job(async () => {
        let n = 0;
        for (const id of idList) {
          try {
            await remove(id, { quiet: true });
            n += 1;
          } catch (e) {
            /* left in place */
            log.warn('library', 'library.delete.failed', { kind: errorKind(e), from: 'many' });
          }
        }
        log.info('library', 'library.removed', { asked: idList.length, removed: n, items: index.items.length });
        reindex();
        save();
        changed();
        return n;
      });
    },
    /** The same change on several: tags added, a collection joined. */
    updateMany(idList, fn) {
      if (loadedDir === null) return;
      for (const id of idList) {
        const e = find(id);
        const next = e && L.normalizeEntry({ ...e, ...fn(e) });
        if (next) Object.assign(e, next);
      }
      index.collections = L.collectionsOf(index);
      save();
      changed();
    },
    /** Writes now what waits to be written (before a window closes). */
    flush,
    otherWrote,
    canBrowse: () => typeof bridge?.libraryBrowse === 'function',
    browse: (path) => bridge.libraryBrowse(path),
    update,
    remove,
    addCollection,
    removeCollection,
    fileUrl,
    asFile,
    aiTags,
    available,
  };
}
