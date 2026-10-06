/** Saved settings over new defaults: actions added in an update never steal a key the player already uses. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Keybinds } from '@tumble/ui';
import { mergeBinds, mergeSettings } from '../src/game/settingsMerge.ts';

describe('settings merge', () => {
  it('fills in an action added since the save with its defaults', () => {
    const { pushToTalk: _, ...older } = DEFAULT_SETTINGS.controls.keybinds;
    const merged = mergeBinds(DEFAULT_SETTINGS.controls.keybinds, older as Keybinds, '');
    expect(merged.pushToTalk).toEqual(DEFAULT_SETTINGS.controls.keybinds.pushToTalk);
  });

  it("leaves a new action's default empty when the player already uses that key or button", () => {
    const { pushToTalk: _k, ...keys } = DEFAULT_SETTINGS.controls.keybinds;
    const { pushToTalk: _p, ...pads } = DEFAULT_SETTINGS.controls.padBinds;
    const saved = {
      ...DEFAULT_SETTINGS,
      controls: {
        ...DEFAULT_SETTINGS.controls,
        keybinds: { ...keys, emoteWheel: ['KeyV', ''] },
        padBinds: { ...pads, emoteWheel: [10, -1] },
      },
    } as unknown as Parameters<typeof mergeSettings>[1];
    const merged = mergeSettings(DEFAULT_SETTINGS, saved);
    expect(merged.controls.keybinds.emoteWheel).toEqual(['KeyV', '']);
    expect(merged.controls.keybinds.pushToTalk).toEqual(['', '']);
    expect(merged.controls.padBinds.pushToTalk).toEqual([-1, -1]);
  });

  it("keeps the player's own choices, even ones that match a default elsewhere", () => {
    const saved = mergeBinds(DEFAULT_SETTINGS.controls.keybinds, { pushToTalk: ['KeyQ', ''] }, '');
    expect(saved.pushToTalk).toEqual(['KeyQ', '']);
  });
});
