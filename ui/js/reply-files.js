// Files attached to replies, kept across restarts: a reply being written
// (key "a:<board>/<thread>") or saved for later ("s:<id>"). In the app's
// own IndexedDB; where there is none (a private window), in memory.

const DB = 'clovereye-replies';
const STORE = 'files';
// Only what IndexedDB does not hold: every file where there is no database,
// else a write still under way (so a read right after it finds the file) or
// one the database refused. A file IndexedDB took is not kept here too.
const memory = new Map();
// Keys this window wrote: never swept (another window cannot know of them yet).
const touched = new Set();
let opening = null;

function db() {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

async function run(mode, fn) {
  const d = await db();
  if (!d) return fn(null);
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Keeps a file: { name, size, type, bytes (Uint8Array), randomName }. */
export async function putFile(key, file) {
  if (!file) return delFile(key);
  touched.add(key);
  const rec = { name: file.name, size: file.size, type: file.type || '', bytes: file.bytes, randomName: file.randomName || '' };
  memory.set(key, rec);
  if (!(await db())) return; // no database: memory is where it is kept
  const ok = await run('readwrite', (s) => s.put(rec, key)); // the key when stored
  if (memory.get(key) !== rec) return; // a newer write (or a delete) took over
  if (ok !== undefined) memory.delete(key);
  // refused (full, say): the copy in memory is the newest, and an older one
  // still stored must not be read in its place
  else await run('readwrite', (s) => s.delete(key));
}

export async function getFile(key) {
  const rec = memory.get(key) || (await run('readonly', (s) => s?.get(key)));
  if (!rec?.bytes) return null;
  return { ...rec, bytes: rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes) };
}

export async function delFile(key) {
  memory.delete(key);
  await run('readwrite', (s) => s?.delete(key));
}

/** Moves a file to another key (a reply saved for later, or opened again). */
export async function moveFile(from, to) {
  const f = await getFile(from);
  if (f) await putFile(to, f);
  await delFile(from);
  return f;
}

/** Every key kept, in the database and in memory. */
export async function listKeys() {
  const stored = await run('readonly', (s) => s?.getAllKeys());
  return [...new Set([...(Array.isArray(stored) ? stored.map(String) : []), ...memory.keys()])];
}

/** Deletes files no reply points at any more (a reply cut off a list, a
 *  window that wrote over another's): `live()` gives the keys in use (read
 *  fresh, from storage; null when it cannot tell: nothing is deleted). A key
 *  goes only when it was unused at two looks `wait` ms apart, so a file
 *  another window has just written, before it stores its reply, stays.
 *  Returns the keys deleted. */
export async function sweepFiles(live, { wait = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const unused = async () => {
    const used = live();
    if (!used) return null;
    return (await listKeys()).filter((k) => /^[as]:/.test(k) && !touched.has(k) && !used.has(k));
  };
  const first = await unused();
  if (!first?.length) return [];
  await sleep(wait);
  const again = await unused();
  if (!again) return [];
  const gone = first.filter((k) => again.includes(k));
  for (const k of gone) await delFile(k);
  return gone;
}
