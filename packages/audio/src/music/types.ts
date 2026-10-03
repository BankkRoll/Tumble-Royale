import type { ThemeId } from '@tumble/shared';
import type { InstrumentId } from '../synth/instruments.ts';
import type { ScaleName } from './theory.ts';

/**
 * Stems every track is split into. Layers fade by game intensity:
 * `drums`/`bass`/`chords` always, `lead` above ~0.2, `intensity` above ~0.6,
 * `final` only while the final-30-seconds flag is set.
 */
export type StemId = 'drums' | 'bass' | 'chords' | 'lead' | 'intensity' | 'final';

/** All stems in mix order. */
export const STEM_IDS: readonly StemId[] = ['drums', 'bass', 'chords', 'lead', 'intensity', 'final'];

/** Track ids: one per theme plus show tracks. */
export type MusicTrackId = ThemeId | 'lobby' | 'victory' | 'showIntro' | 'logic' | 'final' | 'results';

/**
 * How a part's pattern degrees are interpreted.
 * - `drum`: unpitched lane (`x`, `X`, `o`), instrument is a drum.
 * - `scale`: degrees of the track scale (melodies, counter-lines).
 * - `chord`: chord-tone indexes of the current bar's chord (basslines, arps).
 * - `stack`: any hit plays the whole current chord (pads, stabs, comping).
 */
export type PartMode = 'drum' | 'scale' | 'chord' | 'stack';

/** One instrument line within a stem. */
export interface PartDef {
  stem: StemId;
  instrument: InstrumentId;
  mode: PartMode;
  /** One pattern per bar; cycles independently of the progression length. */
  bars: readonly string[];
  /** Steps each token covers; 2 writes on an 8th-note grid. Default 1 (16ths). Drum lanes ignore this. */
  res?: number;
  /** Semitone transpose from the track key (e.g. -24 for bass). */
  octave?: number;
  /** Part gain multiplier. Default 1. */
  gain?: number;
  /** Note length multiplier (staccato < 1 < legato). Default 0.9. */
  legato?: number;
  /** Generate this many extra seeded melody bars after the written ones (variation). Scale mode only. */
  variations?: number;
  /** Density for generated variation bars (0..1). */
  density?: number;
}

/** A complete adaptive track. */
export interface TrackDef {
  id: MusicTrackId;
  /** Display name for the lab and credits. */
  title: string;
  bpm: number;
  beatsPerBar: 3 | 4;
  /** Off-beat 16th delay as a fraction of a step (0..0.5). */
  swing?: number;
  /** Root note, e.g. `C4`. Degree 1 of the scale. */
  key: string;
  scale: ScaleName;
  /** One chord token per bar (see `parseChord`); defines the loop length. */
  progression: readonly string[];
  parts: readonly PartDef[];
  /** Music reverb send 0..1. */
  reverb?: number;
  /** Bars at the start where only drums+bass play (count-in feel). */
  introBars?: number;
}

/** Stinger ids. */
export type StingerId =
  | 'roundStart'
  | 'qualified'
  | 'eliminated'
  | 'roundOver'
  | 'victory'
  | 'levelUp'
  | 'finalRound'
  | 'thirtySeconds'
  | 'lastSpots'
  | 'overtime'
  | 'logo'
  | 'matchFound'
  | 'showStart'
  | 'nextRound'
  | 'spectate';

/** A short phrase scheduled on the next beat and transposed to the playing key. */
export interface StingerDef {
  /** `[beatOffset, semitonesFromKeyRoot, beats, vel, instrument]`. */
  notes: ReadonlyArray<readonly [number, number, number, number, InstrumentId]>;
  /** Duck the loop while the stinger plays (0 = none, 1 = silence). */
  duck: number;
  /** Length in beats (for duck release). */
  beats: number;
}
