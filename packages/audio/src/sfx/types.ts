import type { SynthContext } from '../synth/toolkit.ts';

/** Output bus a sound plays on. */
export type SfxBus = 'sfx' | 'ui' | 'voice';

/**
 * A procedurally designed sound. `render` builds a node graph on an
 * OfflineAudioContext once; the result is cached as an AudioBuffer and every
 * play is a cheap buffer source with random pitch/volume variance.
 */
export interface SfxDef {
  /** Rendered length in seconds (for loops: the loop period). */
  duration: number;
  /**
   * Builds the sound starting at time 0 on `s.ctx`, writing to `s.out`.
   * `len` is the full render length (loops render extra for a seamless crossfade).
   */
  render: (s: SynthContext, len: number) => void;
  /** Default `sfx`. `ui` and `voice` sounds are never spatial and bypass the voice limit. */
  bus?: SfxBus;
  /** Linear gain applied at play time. Default 1. */
  gain?: number;
  /** ± semitones of random pitch per play. Default 1. */
  pitchVar?: number;
  /** ± fraction of random volume per play. Default 0.15. */
  volVar?: number;
  /** Voice-stealing priority (see `VoicePriority`). Default `Normal`. */
  priority?: number;
  /** Seamlessly looping bed (emitters, slides). */
  loop?: boolean;
  /** Render in stereo (fanfares, crowds). Spatial plays downmix through the panner. */
  stereo?: boolean;
  /** Minimum ms between plays of this sound; protects against event spam (40 players landing at once). */
  cooldownMs?: number;
  /** PannerNode reference distance in metres. Default 4. */
  refDistance?: number;
  /** Prewarm early (UI, countdown, footsteps) so the first play is instant. */
  eager?: boolean;
  /** One-line description for the lab and README. */
  desc?: string;
}

/** Named sound definitions. */
export type SfxDefs = Readonly<Record<string, SfxDef>>;
