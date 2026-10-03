/**
 * Compiles a {@link TrackDef} into lookup tables the scheduler can walk with
 * zero allocations: per part, per bar, an array indexed by step holding the
 * note (or undefined), plus per-bar chord voicings. Pure (no Web Audio).
 */

import { Rng, hashString } from '@tumble/shared';
import { DRUM_IDS } from '../synth/instruments.ts';
import type { DrumId } from '../synth/instruments.ts';
import {
  SCALES,
  chordToneToMidi,
  diatonicChord,
  generateMelodyBar,
  noteNameToMidi,
  parseChord,
  parsePattern,
  parseDrumLane,
  scaleDegreeToMidi,
} from './theory.ts';
import type { PatternEvent } from './theory.ts';
import type { PartDef, StemId, TrackDef } from './types.ts';

/** A note resolved to MIDI, ready to schedule. */
export interface PreparedNote {
  /** MIDI note(s); stacks hold the whole chord. Drums: `[0]`. */
  midi: readonly number[];
  /** Length in steps. */
  len: number;
  vel: number;
}

/** A compiled part. */
export interface PreparedPart {
  def: PartDef;
  stem: StemId;
  /** `bars[barIndex][step]` → note or undefined. Bar index cycles modulo length. */
  bars: ReadonlyArray<ReadonlyArray<PreparedNote | undefined>>;
}

/** A compiled track. */
export interface PreparedTrack {
  def: TrackDef;
  keyMidi: number;
  stepsPerBar: number;
  parts: readonly PreparedPart[];
  /** Number of bars until every part and the progression line up again. */
  cycleBars: number;
}

const DRUMS = new Set<string>(DRUM_IDS);

/** @returns true if `id` is a drum (unpitched) instrument. */
export function isDrum(id: string): id is DrumId {
  return DRUMS.has(id);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Keeps a stack voicing inside one octave above `floor` so chord changes
 * move by small steps instead of jumping around (cheap voice leading).
 */
function voiceStack(notes: readonly number[], floor: number): number[] {
  const out = notes.map((n) => {
    let m = n;
    while (m >= floor + 12) m -= 12;
    while (m < floor) m += 12;
    return m;
  });
  return out.sort((a, b) => a - b);
}

/**
 * Compiles a track definition.
 *
 * @param def - Track definition.
 * @returns Prepared lookup tables.
 * @example prepareTrack(TRACKS.candy).stepsPerBar // 16
 */
export function prepareTrack(def: TrackDef): PreparedTrack {
  const keyMidi = noteNameToMidi(def.key);
  const scale = SCALES[def.scale];
  const stepsPerBar = def.beatsPerBar * 4;
  const chords = def.progression.map((tok) => diatonicChord(keyMidi, scale, tok));
  const chordDegrees = def.progression.map((tok) => parseChord(tok).degree);
  const P = def.progression.length;
  const rng = new Rng(hashString(def.id));
  const next = (): number => rng.next();

  const parts: PreparedPart[] = def.parts.map((p) => {
    const octave = p.octave ?? 0;
    const res = p.res ?? 1;
    const parsed: PatternEvent[][] = [];
    if (p.mode === 'drum') {
      for (const lane of p.bars) {
        const vels = parseDrumLane(lane, stepsPerBar);
        const evs: PatternEvent[] = [];
        vels.forEach((v, step) => {
          if (v > 0) evs.push({ step, len: 1, vel: v, degree: null, semis: 0 });
        });
        parsed.push(evs);
      }
    } else {
      for (const bar of p.bars) parsed.push(parsePattern(bar, res));
      if (p.mode === 'scale' && p.variations) {
        const W = p.bars.length;
        let V = p.variations;
        // Generated bars are composed against the chord they will actually meet, which only holds if the part cycle is a multiple of the progression.
        while ((W + V) % P !== 0) V++;
        for (let j = 0; j < V; j++) {
          const chordDeg = chordDegrees[(W + j) % P] as number;
          parsed.push(
            parsePattern(generateMelodyBar(next, scale.length, chordDeg, stepsPerBar, p.density ?? 0.6), 1),
          );
        }
      }
    }

    const bars = parsed.map((evs, barIdx) => {
      const row: Array<PreparedNote | undefined> = new Array<PreparedNote | undefined>(stepsPerBar).fill(
        undefined,
      );
      for (const ev of evs) {
        if (ev.step >= stepsPerBar) continue;
        let midi: number[];
        if (p.mode === 'drum') midi = [0];
        else if (p.mode === 'scale')
          midi = [scaleDegreeToMidi(keyMidi, scale, ev.degree ?? 1) + ev.semis + octave];
        else {
          // Chord-relative parts are resolved per progression bar at schedule time; store the raw index here and remap below.
          midi = [ev.degree ?? 1, ev.semis];
        }
        row[ev.step] = { midi, len: ev.len, vel: ev.vel };
      }
      return { row, barIdx };
    });

    if (p.mode === 'chord' || p.mode === 'stack') {
      // Expand chord-relative parts to the LCM of their pattern length and the progression so every (pattern bar, chord) pair is precomputed.
      const L = bars.length;
      const total = (L * P) / gcd(L, P);
      const expanded: Array<Array<PreparedNote | undefined>> = [];
      for (let b = 0; b < total; b++) {
        const src = (bars[b % L] as { row: Array<PreparedNote | undefined> }).row;
        const chord = chords[b % P] as number[];
        const stack = voiceStack(chord, keyMidi - 5 + octave);
        expanded.push(
          src.map((n) => {
            if (!n) return undefined;
            if (p.mode === 'stack') return { midi: stack, len: n.len, vel: n.vel };
            const idx = n.midi[0] as number;
            const semis = n.midi[1] as number;
            return { midi: [chordToneToMidi(chord, idx) + octave + semis], len: n.len, vel: n.vel };
          }),
        );
      }
      return { def: p, stem: p.stem, bars: expanded };
    }
    return { def: p, stem: p.stem, bars: bars.map((b) => b.row) };
  });

  let cycle = P;
  for (const part of parts) cycle = (cycle * part.bars.length) / gcd(cycle, part.bars.length);
  return { def, keyMidi, stepsPerBar, parts, cycleBars: cycle };
}

/** Mutable per-stem levels written by {@link stemLevels}. */
export type StemLevels = Record<StemId, number>;

/** @returns A zeroed levels object to reuse with {@link stemLevels}. */
export function createStemLevels(): StemLevels {
  return { drums: 0, bass: 0, chords: 0, lead: 0, intensity: 0, final: 0 };
}

/**
 * Maps game intensity onto stem gains. Base groove is always present (so the
 * game is never silent); the melody enters early, the intensity layer late,
 * and the final layer is gated by the final-30-seconds flag.
 *
 * @param intensity - 0..1.
 * @param final30 - Final 30 seconds active.
 * @param out - Levels object to write (reused to avoid allocation).
 * @returns `out`.
 */
export function stemLevels(intensity: number, final30: boolean, out: StemLevels): StemLevels {
  const i = Math.min(1, Math.max(0, intensity));
  const ss = (a: number, b: number): number => {
    const t = Math.min(1, Math.max(0, (i - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  out.drums = 0.8 + 0.2 * ss(0, 0.3);
  out.bass = 1;
  out.chords = 0.85;
  out.lead = ss(0.12, 0.35);
  out.intensity = ss(0.5, 0.8);
  out.final = final30 ? 1 : 0;
  return out;
}
