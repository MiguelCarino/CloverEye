// The library's store: the index loaded from the library folder, kept in
// step with the files, written back a moment after each change. Saving
// from threads, importing from the disk, look-alike fingerprints and the
// assistant's tags all go through here. The view (library-view.js) only
// draws it.

import * as L from './library-model.js';
import { commentText } from './render.js';

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
  let loading = null;
  let saveTimer = 0;
  let hashing = false;
  const changed = () => onChange?.();
  const dir = () => getSettings().files?.libraryDir || '';
  const available = () => typeof bridge?.libraryLoad === 'function';

  function reindex() {
    ids = new Set(index.items.map((e) => e.id));
  }

  /** Reads the index from the folder (once; `force` reads it again). */
  function load(force = false) {
    if (!available()) return Promise.resolve();
    if (loading && !force) return loading;
    state = { ...state, status: 'loading', error: '' };
    loading = (async () => {
      try {
        const r = await bridge.libraryLoad(dir());
        index = L.normalizeIndex(r?.index);
        state = { status: 'ready', root: r?.root || '', error: '' };
      } catch (e) {
        state = { status: 'error', root: '', error: String(e?.message || e) };
      }
      reindex();
      changed();
      fingerprints();
    })();
    return loading;
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await bridge.librarySave(dir(), index);
      } catch (e) {
        state = { ...state, error: `Couldn’t save the library’s list: ${e?.message || e}` };
        changed();
      }
    }, 300);
  }

  const find = (id) => index.items.find((e) => e.id === id) || null;

  /** Whether a post's file is in the library (by the site's MD5). */
  function has(md5b64) {
    const id = L.md5Hex(md5b64);
    return Boolean(id && ids.has(id));
  }

  /** Saves a post's file into the library: { status: 'saved' | 'have', entry }. */
  async function addFromPost({ board, thread, post, subject = '' }) {
    await load();
    const id = L.md5Hex(post.md5);
    if (id && ids.has(id)) return { status: 'have', entry: find(id) };
    const url = bridge.mediaUrl(board, post);
    if (!url) throw new Error('This post has no file.');
    const name = `${post.filename || post.tim}${post.ext}`;
    const r = await bridge.libraryFetch(dir(), url, board, name);
    const entry = L.entryFromPost({ board, thread, post, subject: commentText(subject || ''), text: commentText(post.com || '').slice(0, 500), rel: r.rel, size: r.bytes });
    if (!entry) throw new Error('This file can’t go in the library.');
    index.items.unshift(entry);
    reindex();
    save();
    changed();
    fingerprints();
    return { status: 'saved', entry };
  }

  /** Brings files in from the disk. `known` (library-model knownFiles)
   *  gives files seen in threads their source back. Progress goes to
   *  `onProgress(done, total)`. { added, have, failed: [{ name, message }] } */
  async function importFiles(files, { known = null, onProgress = () => {} } = {}) {
    await load();
    const out = { added: 0, have: 0, failed: [] };
    const list = [...files].filter((f) => /\.(jpe?g|png|gif|webp|webm|mp4)$/i.test(f.name));
    const skipped = files.length - list.length;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      onProgress(i, list.length);
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const id = L.md5(bytes);
        if (ids.has(id)) {
          out.have += 1;
          continue;
        }
        const r = await bridge.libraryImport(dir(), f.name, bytes);
        const look = await looks(new Blob([bytes], { type: f.type || '' }), f.name);
        const entry = L.entryFromImport({ id, rel: r.rel, name: f.name, size: bytes.length, w: look.w, h: look.h, known });
        if (!entry) throw new Error('This file can’t go in the library.');
        entry.dhash = look.dhash;
        index.items.unshift(entry);
        ids.add(id);
        out.added += 1;
        changed();
      } catch (e) {
        out.failed.push({ name: f.name, message: String(e?.message || e) });
      }
    }
    onProgress(list.length, list.length);
    if (out.added) save();
    out.skipped = skipped;
    changed();
    return out;
  }

  /** Brings in a folder of the computer (sub-folders too when `deep`):
   *  the app copies its pictures and videos in, then each is checked
   *  against what is kept (a copy is taken back out) and fingerprinted.
   *  { added, have, failed, more } */
  async function importFolder(src, { deep = true, known = null, onProgress = () => {}, skip = [] } = {}) {
    await load();
    onProgress(0, 0);
    const r = await bridge.libraryImportDir(dir(), src, deep, skip);
    index.folders = { ...(index.folders || {}), [src]: { ...(index.folders?.[src] || {}), deep, at: Date.now() } };
    const out = { added: 0, have: 0, failed: [], more: Boolean(r?.more), skipped: 0 };
    const list = r?.items || [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      onProgress(i, list.length);
      try {
        const blob = await blobOf({ rel: it.rel });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const id = L.md5(bytes);
        if (ids.has(id)) {
          out.have += 1;
          await bridge.libraryDelete(dir(), it.rel);
          continue;
        }
        const look = await looks(blob, it.name);
        const entry = L.entryFromImport({ id, rel: it.rel, name: it.name, size: bytes.length, w: look.w, h: look.h, known, folder: src, from: it.from });
        if (!entry) throw new Error('This file can’t go in the library.');
        entry.dhash = look.dhash;
        index.items.unshift(entry);
        ids.add(id);
        out.added += 1;
        if (out.added % 25 === 0) changed();
      } catch (e) {
        out.failed.push({ name: it.name, message: String(e?.message || e) });
      }
    }
    onProgress(list.length, list.length);
    save();
    changed();
    return out;
  }

  /** Looks in an imported folder again: brings in what was added since
   *  (the files already brought in are not copied again). */
  function rescanFolder(src, o = {}) {
    const deep = index.folders?.[src]?.deep ?? true;
    const skip = [...index.items.filter((e) => e.folder === src && e.from).map((e) => e.from), ...(index.folders?.[src]?.removed || [])];
    return importFolder(src, { ...o, deep, skip });
  }

  /** Takes out every file imported from one folder (they are deleted from
   *  the library folder; the folder itself is not touched). */
  async function removeFolder(folder) {
    let removed = 0;
    for (const e of index.items.filter((x) => x.folder === folder)) {
      try {
        await bridge.libraryDelete(dir(), e.rel);
        index.items = index.items.filter((x) => x !== e);
        removed += 1;
      } catch {
        /* left in the list: it can be tried again */
      }
    }
    if (index.folders) delete index.folders[folder];
    reindex();
    save();
    changed();
    return removed;
  }

  /** Changes an entry: { tags, collections, ai }. */
  function update(id, patch) {
    const e = find(id);
    if (!e) return;
    const next = L.normalizeEntry({ ...e, ...patch });
    if (!next) return;
    Object.assign(e, next);
    if (patch.collections) index = L.normalizeIndex(index);
    save();
    changed();
  }

  async function remove(id, { quiet = false } = {}) {
    const e = find(id);
    if (!e) return;
    await bridge.libraryDelete(dir(), e.rel);
    index.items = index.items.filter((x) => x !== e);
    // taken out by hand: a rescan of its folder leaves it out
    const f = e.folder && index.folders?.[e.folder];
    if (f && e.from) f.removed = [...new Set([...(f.removed || []), e.from])].slice(-5000);
    if (quiet) return;
    reindex();
    save();
    changed();
  }

  function addCollection(name) {
    const n = String(name || '').trim().slice(0, 60);
    if (!n || index.collections.includes(n)) return n;
    index.collections = [...index.collections, n];
    save();
    changed();
    return n;
  }

  function removeCollection(name) {
    index.collections = index.collections.filter((c) => c !== name);
    for (const e of index.items) e.collections = e.collections.filter((c) => c !== name);
    save();
    changed();
  }

  const fileUrl = (e) => bridge.libraryFileUrl?.(e.rel) || '';

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
    } catch {
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
   *  the background. */
  async function fingerprints() {
    if (hashing) return;
    hashing = true;
    try {
      let done = 0;
      for (const e of index.items) {
        if (e.dhash || e.kind === 'video' || e.kind === 'pdf') continue;
        try {
          const look = await looks(await blobOf(e), e.name);
          if (look.dhash) {
            e.dhash = look.dhash;
            if (!e.w) Object.assign(e, { w: look.w, h: look.h });
            done += 1;
          }
        } catch {
          /* the file is missing or not a picture: no fingerprint */
        }
      }
      if (done) {
        save();
        changed();
      }
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
    const jpeg = await smallJpeg(e);
    const text = await new Promise((resolve, reject) => {
      let out = '';
      const onEvent = (ev) => {
        if (ev?.type === 'text') out += ev.text || '';
        else if (ev?.type === 'done') resolve(out);
        else if (ev?.type === 'error') reject(new Error(ev.message || 'The assistant failed.'));
      };
      Promise.resolve(bridge.aiChat({ id: `lib-${++aiSeq}`, kind: ai.kind, port: ai.port, model: ai.vision, messages: L.aiTagMessages(ai.kind, jpeg), numCtx: 4096 }, onEvent)).catch(reject);
    });
    const tags = L.parseAiTags(text).filter((t) => !e.tags.includes(t));
    update(id, { ai: tags });
    return tags;
  }

  return {
    load,
    state: () => state,
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
    /** Several at once: each deleted from the library folder. */
    async removeMany(idList) {
      let n = 0;
      for (const id of idList) {
        try {
          await remove(id, { quiet: true });
          n += 1;
        } catch {
          /* left in place */
        }
      }
      reindex();
      save();
      changed();
      return n;
    },
    /** The same change on several: tags added, a collection joined. */
    updateMany(idList, fn) {
      for (const id of idList) {
        const e = find(id);
        const next = e && L.normalizeEntry({ ...e, ...fn(e) });
        if (next) Object.assign(e, next);
      }
      index = L.normalizeIndex(index);
      save();
      changed();
    },
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
