/**
 * Local persistence: a namespaced, versioned `localStorage` wrapper that never
 * throws. Private browsing, disabled storage and quota errors all degrade to
 * "nothing saved" so the game keeps running.
 */

const PREFIX = 'tumble.v1.';

/** Keys the client persists. */
export type StorageKey = 'profile' | 'settings' | 'quality' | 'auth' | 'newsRead';

/**
 * Reads and JSON-parses a stored value.
 *
 * @param key - Storage key.
 * @returns The value, or null if missing, unreadable or corrupt.
 * @example
 * const saved = loadJson<{ tier: string }>('quality');
 */
export function loadJson<T>(key: StorageKey): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Stores a JSON-serialisable value.
 *
 * @param key - Storage key.
 * @param value - Value to store.
 * @returns True when the write succeeded.
 */
export function saveJson(key: StorageKey, value: unknown): boolean {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a stored value (best effort).
 *
 * @param key - Storage key.
 */
export function removeKey(key: StorageKey): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}
