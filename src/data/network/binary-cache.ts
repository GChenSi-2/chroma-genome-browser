/**
 * Binary blob cache backed by IndexedDB.
 *
 * Used today by the BAI filehandle to skip the 3-4 s `.bai` HTTP fetch
 * on session-2+ page loads. Generic on purpose so future use cases
 * (parsed FASTA `.fai`, BigWig zoom headers, etc.) can drop in without
 * a second store.
 *
 * Workers CAN open IndexedDB — same origin, same store. The opening
 * `IDBDatabase` is cached per realm so repeat callers don't pay the
 * upgrade-version handshake again.
 *
 * No size limit / eviction in v1: real-world Chroma sessions touch ≤ 10
 * BAI files (~5-15 MB each), well under any browser's IDB quota.
 * Eviction lands the day we add session-2 caching for BAM range chunks.
 */

const DB_NAME = 'chroma-binary-cache';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    // SSR / test environment without IDB — return a permanently rejecting
    // promise; callers should treat get/set as best-effort.
    dbPromise = Promise.reject(new Error('IndexedDB unavailable'));
    return dbPromise;
  }
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onblocked = () => reject(new Error('IDB open blocked'));
  });
  return dbPromise;
}

/**
 * Look up `key` in the binary cache. Returns `null` on miss, on IDB
 * failure (e.g. private-browsing quota), or on schema mismatch.
 */
export async function getCachedBinary(key: string): Promise<Uint8Array | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  return new Promise<Uint8Array | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE).get(key);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const v = req.result;
      if (v instanceof Uint8Array) {
        resolve(v);
      } else if (v instanceof ArrayBuffer) {
        // Older browsers / serialisers may give back ArrayBuffer.
        resolve(new Uint8Array(v));
      } else {
        resolve(null);
      }
    };
  });
}

/**
 * Store `value` under `key`. Fire-and-forget — failures don't bubble up
 * because the cache is purely advisory; on next miss the caller fetches
 * from network again.
 */
export async function setCachedBinary(key: string, value: Uint8Array): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Delete a single key. Idempotent. */
export async function deleteCachedBinary(key: string): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Test helper: nuke the whole store. */
export async function clearBinaryCache(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  return new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/** Test helper: drop the cached DB handle so the next open re-runs upgrade. */
export function _resetBinaryCacheState(): void {
  dbPromise = null;
}
