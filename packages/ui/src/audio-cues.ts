/**
 * Pluggable UI sound hooks. The UI calls `playCue('ui.click')` etc.; the client
 * wires these to `@tumble/audio` with `setAudioHooks`. No-op by default so the
 * UI works (silently) in tests and the preview harness.
 */

/** Cue names the UI emits. Strings outside this list are allowed (hierarchical). */
export type UICueName =
  | 'ui.click'
  | 'ui.hover'
  | 'ui.confirm'
  | 'ui.back'
  | 'ui.whoosh'
  | 'ui.stamp'
  | `ui.stamp.${string}`
  | 'ui.reward'
  | 'ui.levelUp'
  | `ui.rarity.${string}`
  | 'ui.countdown.tick'
  | 'ui.countdown.go'
  | 'ui.error'
  | 'ui.tab'
  | 'ui.toggle'
  | 'ui.slider'
  | 'ui.toast'
  | 'ui.matchFound'
  | 'ui.purchase'
  | 'ui.claim'
  | 'ui.confetti'
  | `ui.wall.${string}`
  | 'ui.fireworks'
  | 'ui.joinTick'
  | 'ui.typeOn'
  | `music.${string}`;

/** Every concrete cue the UI uses (for the audio team's checklist). */
export const UI_CUES: readonly string[] = [
  'ui.click',
  'ui.hover',
  'ui.confirm',
  'ui.back',
  'ui.whoosh',
  'ui.stamp',
  'ui.stamp.qualified',
  'ui.stamp.eliminated',
  'ui.stamp.roundOver',
  'ui.stamp.timeUp',
  'ui.stamp.go',
  'ui.stamp.overtime',
  'ui.stamp.final',
  'ui.stamp.victory',
  'ui.stamp.teamWin',
  'ui.stamp.teamLose',
  'ui.reward',
  'ui.levelUp',
  'ui.rarity.common',
  'ui.rarity.uncommon',
  'ui.rarity.rare',
  'ui.rarity.epic',
  'ui.rarity.legendary',
  'ui.rarity.mythic',
  'ui.countdown.tick',
  'ui.countdown.go',
  'ui.error',
  'ui.tab',
  'ui.toggle',
  'ui.slider',
  'ui.toast',
  'ui.matchFound',
  'ui.purchase',
  'ui.claim',
  'ui.confetti',
  'ui.wall.flash',
  'ui.wall.trapdoor',
  'ui.wall.fall',
  'ui.wall.aww',
  'ui.wall.counter',
  'ui.wall.shake',
  'ui.wall.crown',
  'ui.fireworks',
  'ui.joinTick',
  'ui.typeOn',
  'music.sting',
];

/** Music tracks the UI requests via `playMusic`. */
export const UI_MUSIC: readonly string[] = [
  'music.menu',
  'music.matchmaking',
  'music.preshow',
  'music.intro',
  'music.results',
  'music.final',
  'music.victory',
  'music.wall',
  'music.rewards',
  'music.none',
];

/** Audio callbacks the client provides. */
export interface AudioHooks {
  /** One-shot UI sound. */
  cue: (name: UICueName) => void;
  /** Cross-fade background music; `music.none` = stop/duck. */
  music: (track: string) => void;
}

let hooks: AudioHooks = { cue: () => {}, music: () => {} };
const lastPlayed = new Map<string, number>();

/** Per-cue minimum spacing so hover/slider/tick spam doesn't machine-gun. */
const THROTTLE_MS: Record<string, number> = {
  'ui.hover': 60,
  'ui.slider': 50,
  'ui.joinTick': 150,
  'ui.typeOn': 45,
  'ui.reward': 70,
  'ui.wall.fall': 180,
  'ui.wall.trapdoor': 200,
};

/**
 * Installs the audio implementation.
 * @example setAudioHooks({ cue: (n) => audio.playUi(n), music: (t) => audio.music(t) });
 */
export function setAudioHooks(next: Partial<AudioHooks>): void {
  hooks = { ...hooks, ...next };
}

/**
 * Plays a UI cue (throttled per cue name).
 * @param name Cue id, e.g. `ui.click`, `ui.rarity.epic`.
 */
export function playCue(name: UICueName): void {
  const throttle = THROTTLE_MS[name];
  if (throttle !== undefined) {
    const now = performance.now();
    const last = lastPlayed.get(name) ?? -Infinity;
    if (now - last < throttle) return;
    lastPlayed.set(name, now);
  }
  try {
    hooks.cue(name);
  } catch (err) {
    console.error('[ui] audio cue failed', name, err);
  }
}

/**
 * Requests a music track.
 * @param track e.g. `music.menu`.
 */
export function playMusic(track: string): void {
  try {
    hooks.music(track);
  } catch (err) {
    console.error('[ui] music hook failed', track, err);
  }
}

/**
 * Fallback chain for hierarchical cue names, most specific first.
 * The audio engine can try each until it finds a sound.
 * @example cueFallbacks('ui.stamp.qualified') // ['ui.stamp.qualified', 'ui.stamp']
 */
export function cueFallbacks(name: string): string[] {
  const parts = name.split('.');
  const out: string[] = [];
  for (let i = parts.length; i >= 2; i--) out.push(parts.slice(0, i).join('.'));
  return out;
}
