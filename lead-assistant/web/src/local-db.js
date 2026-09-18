/**
 * The device's own copy of everything. The app reads from here and never waits
 * on the network, which is what makes it usable in a car park with one bar.
 */
const DB_NAME = 'lead-assistant';
const DB_VERSION = 1;
export const TABLES = ['leads', 'interactions', 'tasks'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('This browser has no local storage available.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const table of TABLES) {
        if (!db.objectStoreNames.contains(table)) {
          db.createObjectStore(table, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close the app in other tabs and reload.'));
  });
  return dbPromise;
}

function run(storeNames, mode, work) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'));
    try {
      result = work(tx);
    } catch (err) {
      tx.abort();
      reject(err);
    }
  }));
}

function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadEverything() {
  const db = await openDb();
  const names = [...TABLES, 'meta', 'outbox'];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readonly');
    const out = { meta: {}, outbox: [] };
    for (const table of TABLES) {
      toPromise(tx.objectStore(table).getAll()).then((rows) => { out[table] = rows; });
    }
    // Keys and values are requested in the same transaction turn: issuing a
    // follow-up request from a promise callback would find the transaction
    // already closed.
    const metaStore = tx.objectStore('meta');
    let metaKeys = [];
    let metaValues = [];
    toPromise(metaStore.getAllKeys()).then((keys) => { metaKeys = keys; });
    toPromise(metaStore.getAll()).then((values) => { metaValues = values; });
    toPromise(tx.objectStore('outbox').getAll()).then((rows) => { out.outbox = rows; });
    tx.oncomplete = () => {
      metaKeys.forEach((key, i) => { out.meta[key] = metaValues[i]; });
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export function setMeta(key, value) {
  return run(['meta'], 'readwrite', (tx) => {
    tx.objectStore('meta').put(value, key);
  });
}

/** Writes rows and records them as needing to be sent to the server. */
export function saveLocal(table, rows, { queue = true } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return Promise.resolve();
  return run([table, 'outbox'], 'readwrite', (tx) => {
    const store = tx.objectStore(table);
    const outbox = tx.objectStore('outbox');
    for (const row of list) {
      store.put(row);
      if (queue) outbox.put({ key: `${table}:${row.id}`, table, id: row.id, updatedAt: row.updated_at });
    }
  });
}

/** Applies rows that came down from the server; these are already in sync. */
export function applyRemote(changes) {
  const names = Object.keys(changes).filter((t) => TABLES.includes(t));
  if (!names.length) return Promise.resolve();
  return run(names, 'readwrite', (tx) => {
    for (const table of names) {
      const store = tx.objectStore(table);
      for (const row of changes[table]) store.put(row);
    }
  });
}

export function clearOutbox(entries) {
  if (!entries.length) return Promise.resolve();
  return run(['outbox'], 'readwrite', (tx) => {
    const store = tx.objectStore('outbox');
    for (const entry of entries) store.delete(entry.key);
  });
}

/** Wipes the device copy. Used on sign-out so nothing is left behind. */
export function wipeLocal() {
  return run([...TABLES, 'meta', 'outbox'], 'readwrite', (tx) => {
    for (const name of [...TABLES, 'meta', 'outbox']) tx.objectStore(name).clear();
  });
}
