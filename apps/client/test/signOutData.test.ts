/** Signing out forgets the player's notification inbox and their account's flag rollout. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetPlayerData, loadJson, saveJson } from '../src/game/storage.ts';

afterEach(() => vi.unstubAllGlobals());

describe('forgetPlayerData', () => {
  it('drops the inbox and flags, and keeps device settings', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    saveJson('notifications', { items: [{ id: 'local:1' }] });
    saveJson('flags', { newStore: true });
    saveJson('settings', { audio: { master: 0.5 } });
    forgetPlayerData();
    expect(loadJson('notifications')).toBeNull();
    expect(loadJson('flags')).toBeNull();
    expect(loadJson('settings')).not.toBeNull();
  });
});
