// Local persistence in IndexedDB. Storage is limited by the browser; export is the reliable backup.
import type { Project } from './types';

const DB = 'forking-paths';
const STORE = 'projects';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable'));
  });
}

export class StorageError extends Error {
  constructor(message: string, readonly quota: boolean) { super(message); }
}

export async function saveProject(p: Project): Promise<void> {
  let db: IDBDatabase;
  try { db = await open(); } catch (e) { throw new StorageError(`Local storage is unavailable (${(e as Error).message}). Export the project to keep it.`, false); }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(p, 'current');
    tx.oncomplete = () => resolve();
    const fail = () => {
      const err = tx.error;
      const quota = err?.name === 'QuotaExceededError';
      reject(new StorageError(quota ? 'The browser storage quota is full, so this project was not saved locally. Export the project bundle to keep it, or remove large results.' : `Saving failed: ${err?.message ?? 'unknown error'}`, quota));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
  db.close();
}

export async function loadProject(): Promise<Project | null> {
  try {
    const db = await open();
    const p = await new Promise<Project | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('current');
      req.onsuccess = () => resolve((req.result as Project) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return p;
  } catch {
    return null;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
