/** Keyboard rebinding: a key taken from another action is swapped, or moved when this slot was empty. */
import { describe, expect, it } from 'vitest';
import { assignKeyBind } from '../src/screens/overlays/SettingsSheet.tsx';
import { DEFAULT_KEYBINDS } from '../src/store/defaults.ts';

describe('assignKeyBind', () => {
  it('binds a free key without touching anything else', () => {
    const r = assignKeyBind(DEFAULT_KEYBINDS, 'jump', 1, 'KeyJ');
    expect(r.tookFrom).toBeNull();
    expect(r.binds.jump[1]).toBe('KeyJ');
    expect(r.binds.dive).toEqual(DEFAULT_KEYBINDS.dive);
  });

  it('swaps with the action that had the key when this slot had one', () => {
    const r = assignKeyBind(DEFAULT_KEYBINDS, 'pushToTalk', 0, 'KeyQ');
    expect(r.tookFrom).toBe('spectatePrev');
    expect(r.swapped).toBe(true);
    expect(r.binds.spectatePrev[0]).toBe('KeyV');
    expect(r.binds.pushToTalk[0]).toBe('KeyQ');
  });

  it('reports a move, not a swap, when this slot was empty', () => {
    const r = assignKeyBind(DEFAULT_KEYBINDS, 'pushToTalk', 1, 'KeyQ');
    expect(r.tookFrom).toBe('spectatePrev');
    expect(r.swapped).toBe(false);
    expect(r.binds.spectatePrev[0]).toBe('');
  });
});
