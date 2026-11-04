/**
 * Thin promisified wrapper over the raw browser IndexedDB API — no `idb` npm package. Mirrors
 * the shape `cloudtak-plugin-incident-manager/src/lib/fileTarget.ts` already uses for a similar
 * reason (a small, dependency-free store), generalized to multiple object stores and key ranges.
 */

export function openDatabase(name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`could not open IndexedDB database: ${name}`));
    });
}

/**
 * Opens a database, runs `fn`, and always closes the connection afterward — including on
 * failure. Without this, connections accumulate (nothing else in this file closes what it
 * opens), and a later `indexedDB.deleteDatabase(...)` — the plugin never calls this itself, but
 * tests need it to reset state between cases — blocks forever waiting for them to close.
 */
export async function withDatabase<T>(
    name: string,
    version: number,
    upgrade: (db: IDBDatabase) => void,
    fn: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
    const db = await openDatabase(name, version, upgrade);
    try {
        return await fn(db);
    } finally {
        db.close();
    }
}

export function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error ?? new Error(`get failed on ${store}`));
    });
}

export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readonly").objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error ?? new Error(`getAll failed on ${store}`));
    });
}

export function idbPut(db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey): Promise<void> {
    return new Promise((resolve, reject) => {
        const objectStore = db.transaction(store, "readwrite").objectStore(store);
        const req = key === undefined ? objectStore.put(value) : objectStore.put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error(`put failed on ${store}`));
    });
}

export function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readwrite").objectStore(store).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error(`delete failed on ${store}`));
    });
}

/** Deletes every record whose key falls within `range` (used to drop a dataset's sections by prefix). */
export function idbDeleteRange(db: IDBDatabase, store: string, range: IDBKeyRange): Promise<void> {
    return new Promise((resolve, reject) => {
        const req = db.transaction(store, "readwrite").objectStore(store).delete(range);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error(`delete range failed on ${store}`));
    });
}

/** A key range covering every string key starting with `prefix` (relies on IndexedDB's lexicographic string key ordering). */
export function prefixRange(prefix: string): IDBKeyRange {
    return IDBKeyRange.bound(prefix, prefix + "￿", false, false);
}
