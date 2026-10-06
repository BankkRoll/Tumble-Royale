/**
 * Local round drafts (IndexedDB), shared by the editor and the game on the
 * same origin: the editor saves drafts here, and Test play hands the round to
 * the game tab through the {@link PLAYTEST_DRAFT_ID} slot.
 */
import type { RoundDefinitionInput } from '@tumble/shared';

/** A saved draft. */
export interface RoundDraft {
  id: string;
  /** Round name at save time (lists show it without parsing the round). */
  name: string;
  type: string;
  description: string;
  round: RoundDefinitionInput;
  /** Share code once published from this draft. */
  sharedCode: string | null;
  updatedAt: number;
}

/** Storage for drafts. */
export interface DraftStore {
  list(): Promise<RoundDraft[]>;
  get(id: string): Promise<RoundDraft | null>;
  put(draft: RoundDraft): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Draft id the editor's Test play writes and the game's `?playtest=1` reads. */
export const PLAYTEST_DRAFT_ID = '__playtest__';

const DB_NAME = 'tumble-round-editor';
const STORE = 'drafts';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Drafts in IndexedDB.
 *
 * @param idb - The factory (tests or private modes may lack one).
 * @example
 * const drafts = indexedDbDrafts(indexedDB);
 * await drafts.put(draft);
 */
export function indexedDbDrafts(idb: IDBFactory): DraftStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const r = idb.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => {
        db = null;
        reject(r.error ?? new Error('Could not open local storage'));
      };
    });
    return db;
  };
  const store = async (mode: IDBTransactionMode) =>
    (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    list: async () =>
      ((await request((await store('readonly')).getAll())) as RoundDraft[])
        .filter((d) => d.id !== PLAYTEST_DRAFT_ID)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: async (id) => ((await request((await store('readonly')).get(id))) as RoundDraft | undefined) ?? null,
    put: async (draft) => void (await request((await store('readwrite')).put(draft))),
    delete: async (id) => void (await request((await store('readwrite')).delete(id))),
  };
}

/** Drafts in memory (tests, or when IndexedDB is unavailable). */
export function memoryDrafts(): DraftStore {
  const data = new Map<string, RoundDraft>();
  const copy = (d: RoundDraft): RoundDraft => structuredClone(d);
  return {
    list: async () =>
      [...data.values()]
        .filter((d) => d.id !== PLAYTEST_DRAFT_ID)
        .map(copy)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    get: async (id) => {
      const d = data.get(id);
      return d ? copy(d) : null;
    },
    put: async (d) => void data.set(d.id, copy(d)),
    delete: async (id) => void data.delete(id),
  };
}

/** The best available store: IndexedDB when the browser has it, else memory. */
export function defaultDrafts(): DraftStore {
  return typeof indexedDB !== 'undefined' ? indexedDbDrafts(indexedDB) : memoryDrafts();
}
