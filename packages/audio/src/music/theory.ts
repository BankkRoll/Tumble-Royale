/**
 * Pure music-theory helpers used by the sequencer and by stinger/announcer
 * synthesis: note names, scales, diatonic chords and the compact pattern
 * notation that tracks are authored in. No Web Audio here so it is unit-testable
 * in Node.
 *
 * Pattern notation
 * ----------------
 * A pattern is one bar. If it contains whitespace it is split on whitespace,
 * otherwise every character is a token; `|` is ignored either way (use it for
 * readability). Tokens:
 *
 * - `.`        rest
 * - `_`        hold the previous note one more step
 * - `x` `X` `o` an unpitched hit (normal / accent / ghost) — used by drums and chord stacks
 * - `5`, `10`, `-2`  a degree (1-based; `0` and negatives go below, `8+` above)
 * - suffix `#` / `b`  raise / lower the degree by a semitone
 * - prefix `>` accent, prefix `~` ghost (soft)
 */

/** Built-in scale names. */
export type ScaleName =
  | 'major'
  | 'minor'
  | 'dorian'
  | 'mixolydian'
  | 'lydian'
  | 'phrygian'
  | 'harmonicMinor'
  | 'majorPentatonic'
  | 'minorPentatonic'
  | 'blues';

/** Semitone offsets from the root for each scale. */
export const SCALES: Readonly<Record<ScaleName, readonly number[]>> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};

const NOTE_INDEX: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parses a scientific note name into a MIDI number.
 *
 * @param name - e.g. `C4`, `F#3`, `Bb2`.
 * @returns MIDI note number (C4 = 60).
 * @example noteNameToMidi('A4') // 69
 */
export function noteNameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`Invalid note name "${name}"`);
  const letter = (m[1] as string).toUpperCase();
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  return (NOTE_INDEX[letter] as number) + acc + (octave + 1) * 12;
}

/**
 * @param midi - MIDI note number (fractional allowed for detune).
 * @returns Frequency in Hz, A4 = 440.
 */
export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Maps a 1-based scale degree to a MIDI note. Degrees wrap into neighbouring
 * octaves, so `8` in a 7-note scale is the octave and `0` is the leading tone below.
 *
 * @param root - MIDI note of degree 1.
 * @param scale - Semitone offsets of the scale.
 * @param degree - 1-based degree; any integer.
 * @returns MIDI note number.
 * @example scaleDegreeToMidi(60, SCALES.major, 5) // 67 (G4)
 */
export function scaleDegreeToMidi(root: number, scale: readonly number[], degree: number): number {
  const n = scale.length;
  const idx = degree - 1;
  const octave = Math.floor(idx / n);
  const within = idx - octave * n;
  return root + octave * 12 + (scale[within] as number);
}

/** Parsed chord-progression entry. */
export interface ChordSymbol {
  /** 1-based scale degree of the chord root. */
  degree: number;
  /** Add the diatonic seventh. */
  seventh: boolean;
  /** Replace the third with the 2nd or 4th. */
  sus: 0 | 2 | 4;
  /** Force a major (`M`) or minor (`m`) triad instead of the diatonic one, e.g. a major V in a minor key. */
  quality: 'M' | 'm' | null;
}

/**
 * Parses a progression token: `"1"`, `"6"`, `"5^7"`, `"4sus2"`, `"5M^7"` (forced major, dominant 7th).
 *
 * @param token - Chord token.
 * @returns The parsed chord.
 */
export function parseChord(token: string): ChordSymbol {
  const m = /^(-?\d+)([Mm])?(\^7)?(sus[24])?$/.exec(token.trim());
  if (!m) throw new Error(`Invalid chord token "${token}"`);
  return {
    degree: Number(m[1]),
    quality: m[2] === 'M' ? 'M' : m[2] === 'm' ? 'm' : null,
    seventh: m[3] !== undefined,
    sus: m[4] === 'sus2' ? 2 : m[4] === 'sus4' ? 4 : 0,
  };
}

/**
 * Builds a diatonic chord (stacked scale thirds) on a degree.
 *
 * @param root - MIDI note of the key's degree 1.
 * @param scale - Scale offsets; must be heptatonic for true thirds, pentatonic scales still work musically.
 * @param chord - Chord symbol or token.
 * @returns MIDI notes from the chord root upwards (3 or 4 notes).
 * @example diatonicChord(60, SCALES.major, '6') // [69, 72, 76] (A minor)
 */
export function diatonicChord(root: number, scale: readonly number[], chord: ChordSymbol | string): number[] {
  const c = typeof chord === 'string' ? parseChord(chord) : chord;
  const d = c.degree;
  if (c.quality) {
    const r = scaleDegreeToMidi(root, scale, d);
    const third = c.sus === 2 ? r + 2 : c.sus === 4 ? r + 5 : r + (c.quality === 'M' ? 4 : 3);
    const notes = [r, third, r + 7];
    if (c.seventh) notes.push(r + 10);
    return notes;
  }
  const third = c.sus === 2 ? d + 1 : c.sus === 4 ? d + 3 : d + 2;
  const notes = [
    scaleDegreeToMidi(root, scale, d),
    scaleDegreeToMidi(root, scale, third),
    scaleDegreeToMidi(root, scale, d + 4),
  ];
  if (c.seventh) notes.push(scaleDegreeToMidi(root, scale, d + 6));
  return notes;
}

/**
 * Maps a 1-based chord-tone index to a MIDI note, extending the chord into
 * neighbouring octaves (index `n+1` is the root an octave up, `0` is the top
 * tone an octave down).
 *
 * @param chord - Chord notes, ascending.
 * @param index - 1-based chord tone.
 * @returns MIDI note.
 */
export function chordToneToMidi(chord: readonly number[], index: number): number {
  const n = chord.length;
  const idx = index - 1;
  const octave = Math.floor(idx / n);
  return (chord[idx - octave * n] as number) + octave * 12;
}

/** One note or hit parsed from a pattern bar. */
export interface PatternEvent {
  /** Step within the bar (0-based). */
  step: number;
  /** Length in steps, including holds. */
  len: number;
  /** Velocity 0..1. */
  vel: number;
  /** Degree (scale or chord-tone, depending on part mode); `null` for unpitched hits. */
  degree: number | null;
  /** Extra semitones from `#` / `b` suffixes. */
  semis: number;
}

const DEFAULT_VEL = 0.8;
const ACCENT_VEL = 1;
const GHOST_VEL = 0.4;

/**
 * Splits a pattern bar into tokens (see module docs).
 *
 * @param bar - Pattern string.
 * @returns Tokens in step order.
 */
export function tokenizePattern(bar: string): string[] {
  const cleaned = bar.replace(/\|/g, ' ').trim();
  if (cleaned === '') return [];
  return /\s/.test(cleaned) ? cleaned.split(/\s+/) : [...cleaned];
}

/**
 * Parses one pattern bar into events.
 *
 * @param bar - Pattern string.
 * @param stepsPerToken - Steps each token occupies (2 for an 8th-note grid on 16th steps).
 * @returns Events sorted by step.
 * @example parsePattern('1 . 3 _') // [{step:0,len:1,...degree:1}, {step:2,len:2,...degree:3}]
 */
export function parsePattern(bar: string, stepsPerToken = 1): PatternEvent[] {
  const tokens = tokenizePattern(bar);
  const out: PatternEvent[] = [];
  let last: PatternEvent | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    const step = i * stepsPerToken;
    if (tok === '.') {
      last = null;
      continue;
    }
    if (tok === '_') {
      if (last) last.len += stepsPerToken;
      continue;
    }
    let vel = DEFAULT_VEL;
    let body = tok;
    if (body === 'x' || body === 'X' || body === 'o') {
      vel = body === 'X' ? ACCENT_VEL : body === 'o' ? GHOST_VEL : DEFAULT_VEL;
      last = { step, len: stepsPerToken, vel, degree: null, semis: 0 };
      out.push(last);
      continue;
    }
    if (body.startsWith('>')) {
      vel = ACCENT_VEL;
      body = body.slice(1);
    } else if (body.startsWith('~')) {
      vel = GHOST_VEL;
      body = body.slice(1);
    }
    const m = /^(-?\d+)([#b]?)$/.exec(body);
    if (!m) throw new Error(`Invalid pattern token "${tok}" in "${bar}"`);
    last = {
      step,
      len: stepsPerToken,
      vel,
      degree: Number(m[1]),
      semis: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0,
    };
    out.push(last);
  }
  return out;
}

/**
 * Parses a 16-ish character drum lane into per-step velocities.
 *
 * @param lane - e.g. `"x...x...x...x..."` (`X` accent, `o` ghost, `.` rest).
 * @param steps - Steps per bar; shorter lanes repeat to fill, longer ones are truncated.
 * @returns Velocity per step (0 = silent).
 */
export function parseDrumLane(lane: string, steps: number): Float32Array {
  const chars = lane.replace(/[\s|]/g, '');
  const out = new Float32Array(steps);
  if (chars.length === 0) return out;
  for (let i = 0; i < steps; i++) {
    const c = chars[i % chars.length];
    out[i] = c === 'X' ? ACCENT_VEL : c === 'x' ? DEFAULT_VEL : c === 'o' ? GHOST_VEL : 0;
  }
  return out;
}

/**
 * Seeded generator of a singable melody bar over a chord, used for B-sections
 * and variation so long rounds don't loop the same 4 bars forever.
 *
 * Strong beats land on chord tones; weak steps walk by scale step toward the
 * next target, which is what makes generated lines sound composed rather than random.
 *
 * @param next - Uniform random source in [0, 1).
 * @param scaleLen - Number of notes in the scale.
 * @param chordDegree - Degree of the bar's chord root.
 * @param stepsPerBar - Steps in the bar (16 for 4/4 on 16ths).
 * @param density - 0..1 probability of a note on each 8th.
 * @returns A pattern string in the module's notation (space separated).
 */
export function generateMelodyBar(
  next: () => number,
  scaleLen: number,
  chordDegree: number,
  stepsPerBar: number,
  density = 0.6,
): string {
  const chordTones = [chordDegree, chordDegree + 2, chordDegree + 4, chordDegree + scaleLen];
  const tokens: string[] = [];
  let current = chordTones[Math.floor(next() * 3)] as number;
  for (let s = 0; s < stepsPerBar; s++) {
    const beat = s % 4 === 0;
    const eighth = s % 2 === 0;
    if (!eighth) {
      tokens.push(tokens.length > 0 && tokens[tokens.length - 1] !== '.' && next() < 0.5 ? '_' : '.');
      continue;
    }
    if (s !== 0 && next() > (beat ? Math.min(1, density + 0.25) : density)) {
      tokens.push('.');
      continue;
    }
    if (beat) {
      let best = chordTones[0] as number;
      for (const t of chordTones) if (Math.abs(t - current) < Math.abs(best - current)) best = t;
      current = best;
    } else {
      current += next() < 0.5 ? -1 : 1;
    }
    while (current > chordDegree + scaleLen + 4) current -= scaleLen;
    while (current < chordDegree - 2) current += scaleLen;
    tokens.push(String(current));
  }
  return tokens.join(' ');
}
