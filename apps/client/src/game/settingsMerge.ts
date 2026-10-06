/**
 * Saved settings over the current defaults, so fields added since they were
 * saved always exist. Bindings need care: an action added in an update brings
 * its default key or button, which the player may already use for something
 * else.
 */
import type { Keybinds, PadBinds, Settings } from '@tumble/ui';

/**
 * Saved bindings over the defaults. Actions the save already has keep the
 * player's choice; an action new since then gets its default inputs, minus
 * any the player has already put on another action (that slot stays empty).
 *
 * @param defaults - Default bindings, every action present.
 * @param saved - Saved bindings, possibly from an older version.
 * @param empty - The empty slot value (`''` for keys, -1 for buttons).
 * @returns Complete bindings.
 * @example
 * mergeBinds(DEFAULT_KEYBINDS, { jump: ['KeyV', ''] }, '').pushToTalk; // ['', ''] instead of a second V
 */
export function mergeBinds<A extends string, V extends string | number>(
  defaults: Record<A, [V, V]>,
  saved: Partial<Record<A, [V, V]>> | undefined,
  empty: V,
): Record<A, [V, V]> {
  const out = { ...defaults, ...saved } as Record<A, [V, V]>;
  if (!saved) return out;
  const taken = new Set<V>();
  for (const pair of Object.values(saved) as [V, V][]) for (const v of pair) if (v !== empty) taken.add(v);
  for (const a of Object.keys(defaults) as A[]) {
    if (a in saved) continue;
    out[a] = defaults[a].map((v) => (taken.has(v) ? empty : v)) as [V, V];
  }
  return out;
}

/**
 * Merges saved settings over defaults so new fields always exist.
 *
 * @param base - Defaults.
 * @param saved - Saved settings, or null on first launch.
 * @returns Complete settings.
 */
export function mergeSettings(base: Settings, saved: Partial<Settings> | null): Settings {
  if (!saved) return base;
  return {
    graphics: { ...base.graphics, ...saved.graphics },
    controls: {
      ...base.controls,
      ...saved.controls,
      keybinds: mergeBinds<keyof Keybinds, string>(base.controls.keybinds, saved.controls?.keybinds, ''),
      padBinds: mergeBinds<keyof PadBinds, number>(base.controls.padBinds, saved.controls?.padBinds, -1),
    },
    audio: { ...base.audio, ...saved.audio },
    accessibility: { ...base.accessibility, ...saved.accessibility },
    gameplay: { ...base.gameplay, ...saved.gameplay },
    voice: { ...base.voice, ...saved.voice },
  };
}
