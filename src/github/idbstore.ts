// The persistent store of the response cache (cache.ts), in IndexedDB:
// bodies are stored as parsed values (no JSON string round trip, and
// no localStorage size limit), with their metadata in a store of their
// own, so a 304 rewrites a few fields rather than a megabyte of body.
//
// Anything here may fail: IndexedDB can be missing, blocked or full, and
// another tab can delete the database. Callers treat every failure as
// "not persisted".

import type { EntryMeta, Owner, PersistentStore } from "./cache.ts";

export const DB_NAME = "review-cache";
const DB_VERSION = 1;
const META = "meta";
const BODY = "body";
const OWNER = "owner";
const OWNER_KEY = "owner";
/** Don't hold up sign-out longer than this on a delete another tab blocks. */
const DELETE_TIMEOUT_MS = 2000;

function done(req: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** The browser's IndexedDB, or undefined where it is missing or blocked. */
export function browserIndexedDB(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

/** Delete the cache database, e.g. on a load without "remember"; never throws. */
export function deleteCacheDatabase(factory: IDBFactory | undefined = browserIndexedDB()): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, DELETE_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      if (!factory) return finish();
      const req = factory.deleteDatabase(DB_NAME);
      req.onsuccess = finish;
      req.onerror = finish;
    } catch {
      finish();
    }
  });
}

export class IdbStore implements PersistentStore {
  #db: IDBDatabase | undefined;
  readonly #factory: IDBFactory;

  private constructor(db: IDBDatabase, factory: IDBFactory) {
    this.#db = db;
    this.#factory = factory;
    // Another tab signing out deletes the database: let it, and stop
    // persisting here.
    db.onversionchange = () => this.#close();
  }

  /** Open (or create) the cache database; undefined if IndexedDB is unavailable. */
  static async open(factory: IDBFactory | undefined = browserIndexedDB()): Promise<IdbStore | undefined> {
    if (!factory) return undefined;
    try {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [META, BODY, OWNER]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, name === META ? { keyPath: "key" } : undefined);
        }
      };
      const db = (await done(req)) as IDBDatabase;
      return new IdbStore(db, factory);
    } catch {
      return undefined;
    }
  }

  #close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  #tx(stores: string[], mode: IDBTransactionMode): IDBTransaction {
    if (!this.#db) throw new Error("the cache database is closed");
    return this.#db.transaction(stores, mode);
  }

  async owner(): Promise<Owner | undefined> {
    const o = (await done(this.#tx([OWNER], "readonly").objectStore(OWNER).get(OWNER_KEY))) as Partial<Owner> | undefined;
    return typeof o?.login === "string" && typeof o.tokenHash === "string" ? { login: o.login, tokenHash: o.tokenHash } : undefined;
  }

  async setOwner(owner: Owner): Promise<void> {
    const tx = this.#tx([OWNER], "readwrite");
    tx.objectStore(OWNER).put(owner, OWNER_KEY);
    await committed(tx);
  }

  async metas(): Promise<EntryMeta[]> {
    return (await done(this.#tx([META], "readonly").objectStore(META).getAll())) as EntryMeta[];
  }

  async body(key: string): Promise<unknown> {
    return await done(this.#tx([BODY], "readonly").objectStore(BODY).get(key));
  }

  // The transactions below are created synchronously, so writes land in
  // the order they were made (IndexedDB orders overlapping readwrite
  // transactions by creation).

  put(meta: EntryMeta, body: unknown): Promise<void> {
    try {
      const tx = this.#tx([META, BODY], "readwrite");
      tx.objectStore(META).put(meta);
      tx.objectStore(BODY).put(body, meta.key);
      return committed(tx);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  putMeta(meta: EntryMeta): Promise<void> {
    try {
      const tx = this.#tx([META], "readwrite");
      tx.objectStore(META).put(meta);
      return committed(tx);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  delete(keys: readonly string[]): Promise<void> {
    try {
      const tx = this.#tx([META, BODY], "readwrite");
      for (const k of keys) {
        tx.objectStore(META).delete(k);
        tx.objectStore(BODY).delete(k);
      }
      return committed(tx);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  async clear(): Promise<void> {
    const tx = this.#tx([META, BODY, OWNER], "readwrite");
    for (const s of [META, BODY, OWNER]) tx.objectStore(s).clear();
    await committed(tx);
  }

  async destroy(): Promise<void> {
    this.#close();
    await deleteCacheDatabase(this.#factory);
  }
}
