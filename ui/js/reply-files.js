// Files attached to replies, kept across restarts: a reply being written
// (key "a:<board>/<thread>") or saved for later ("s:<id>"). In the app's
// own IndexedDB; where there is none (a private window), in memory.

const DB = 'clovereye-replies';
const STORE = 'files';
const memory = new Map();
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
  const rec = { name: file.name, size: file.size, type: file.type || '', bytes: file.bytes, randomName: file.randomName || '' };
  memory.set(key, rec);
  await run('readwrite', (s) => s?.put(rec, key));
}

export async function getFile(key) {
  const got = await run('readonly', (s) => s?.get(key));
  const rec = got || memory.get(key);
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
