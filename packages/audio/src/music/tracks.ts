/**
 * The original Tumble Royale soundtrack, authored as data: one adaptive track
 * per theme plus lobby, logic, final, results, victory and show intro, and the
 * stinger set. Tempos, keys and modes follow `docs/design/AUDIO.md` §2.
 *
 * The show leitmotif ("Tumble Tune", degrees 5-6-5-3 | 2-3-1) is quoted in the
 * lobby, results, victory, qualify and logo material so it reads as "good
 * things happen"; the final quotes it in minor.
 *
 * Notation is documented in `theory.ts`. Melodies use an 8th-note grid
 * (`res: 2`); drum lanes are 16 (or 12 for 6/8) characters per bar. 6/8 tracks
 * are written as `beatsPerBar: 3` at the quarter-note tempo that gives the same
 * 16th grid, with accents grouped in threes.
 */

import type { InstrumentId } from '../synth/instruments.ts';
import type { MusicTrackId, PartDef, PartMode, StemId, StingerDef, StingerId, TrackDef } from './types.ts';

function drum(stem: StemId, instrument: InstrumentId, lanes: string | readonly string[], gain = 1): PartDef {
  return { stem, instrument, mode: 'drum', bars: typeof lanes === 'string' ? [lanes] : lanes, gain };
}

function part(stem: StemId, instrument: InstrumentId, mode: PartMode, bars: readonly string[], extra: Partial<PartDef> = {}): PartDef {
  return { stem, instrument, mode, bars, res: 2, ...extra };
}

/** Leitmotif bars on an 8th grid: ♪♪♩♩ | ♩.♪𝅗𝅥. */
const MOTIF_A = '5 6 5 _ 3 _ _ _';
const MOTIF_B = '2 _ _ 3 1 _ _ _';

// -----------------------------------------------------------------------------
// Themes
// -----------------------------------------------------------------------------

const CANDY_LEAD = ['5 . 5 6 5 . 3 .', '1 . 3 . 6 _ 5 .', '4 . 4 5 6 . 8 .', '7 _ 6 . 5 _ _ .', '5 . 5 6 5 . 8 .', '8 . 9 8 6 . 5 .', '4 . 6 . 8 _ 7 6', '5 _ _ . 2 . 7 .'];

const candy: TrackDef = {
  id: 'candy',
  title: 'Sugar Rush',
  bpm: 150,
  beatsPerBar: 4,
  key: 'C4',
  scale: 'major',
  progression: ['1', '6', '4', '5', '1', '6', '2', '5^7'],
  reverb: 0.18,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.....x.x.......'),
    drum('drums', 'clap', '....x.......x...', 0.8),
    drum('drums', 'hat', '..x...x...x...x.'),
    part('bass', 'pluckBass', 'chord', ['1 . 3 . 1 4 3 .', '1 . 3 . 1 2 3 4'], { octave: -24 }),
    part('chords', 'marimba', 'stack', ['. x . x . x . x'], { gain: 0.55 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.7 }),
    part('lead', 'marimba', 'scale', CANDY_LEAD, { octave: 12, variations: 8 }),
    part('lead', 'glock', 'scale', CANDY_LEAD, { octave: 24, gain: 0.35 }),
    drum('intensity', 'shaker', 'oxoxoxoxoxoxoxox'),
    part('intensity', 'kazoo', 'scale', ['3 _ _ _ 5 _ _ _', '3 _ _ _ 1 _ _ _', '4 _ _ _ 6 _ _ _', '5 _ _ _ 4 _ _ _'], { gain: 0.55 }),
    drum('final', 'snare', '..o...o...o.o.oo', 0.7),
    drum('final', 'openHat', '..x...x...x...x.', 0.7),
    part('final', 'brass', 'stack', ['. . . x . . x .'], { gain: 0.6, legato: 0.4 }),
  ],
};

const factory: TrackDef = {
  id: 'factory',
  title: 'Clockwork',
  bpm: 128,
  beatsPerBar: 4,
  key: 'D3',
  scale: 'dorian',
  progression: ['1', '4', '1', '4', '3', '4', '5', '5^7'],
  reverb: 0.14,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x...x...x...x...'),
    drum('drums', 'clap', '....x.......x...', 0.8),
    drum('drums', 'woodblock', '..x..x..x..x.x..', 0.7),
    drum('drums', 'hat', '..x...x...x...x.', 0.8),
    part('bass', 'pluckBass', 'chord', ['1 . 4 . 1 . 4 . 1 . 4 . 3 . 2 .'], { res: 1 }),
    part('chords', 'brass', 'stack', ['x . . x . . x .', '. . x . . x . .'], { gain: 0.45, legato: 0.35, octave: 12 }),
    part(
      'lead',
      'squareLead',
      'scale',
      ['1 . 3 5 . 3 1 .', '4 . 6 . 4 _ 3 .', '1 . 3 5 . 8 7 5', '6 _ _ . 4 . 6 .', '5 . 3 . 5 . 6 5', '4 . 6 8 . 6 4 .', '5 . 7 . 9 _ 8 7', '5 _ _ _ . . 2 .'],
      { octave: 12, variations: 8, legato: 0.7 },
    ),
    drum('intensity', 'cowbell', 'x..x..x...x..x..', 0.6),
    drum('intensity', 'tambourine', '..x...x...x...x.'),
    part('intensity', 'glock', 'chord', ['1 2 3 2 1 2 3 4'], { octave: 24, gain: 0.5 }),
    drum('final', 'snare', 'oooooooooooooooX', 0.6),
    drum('final', 'openHat', '..x...x...x...x.', 0.7),
    part('final', 'brass', 'stack', ['. x . x . x . x'], { gain: 0.5, legato: 0.3, octave: 12 }),
  ],
};

const frosty: TrackDef = {
  id: 'frosty',
  title: 'Snowglobe',
  bpm: 138,
  beatsPerBar: 4,
  key: 'E4',
  scale: 'minor',
  progression: ['1', '6', '3', '7'],
  reverb: 0.35,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.......x.......'),
    drum('drums', 'snare', '....x.......x...', 0.7),
    drum('drums', 'tambourine', 'xoxoxoxoxoxoxoxo', 0.6),
    part('bass', 'subBass', 'chord', ['1 . . 3 1 . 3 .'], { octave: -24 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.8 }),
    part('chords', 'kalimba', 'chord', ['. 1 . 2 . 3 . 2'], { gain: 0.4 }),
    part('lead', 'glock', 'scale', ['5 . 5 . 8 . 7 5', '6 _ 5 . 3 _ . .', '3 . 5 . 8 . 10 .', '9 _ 8 . 7 _ 5 .', '8 . 10 . 12 _ 10 .', '10 . 9 . 8 _ . .', '8 . 7 . 5 . 3 .', '2 _ _ _ 5 _ _ .'], {
      octave: 12,
      variations: 8,
    }),
    part('intensity', 'kalimba', 'chord', ['1 . 2 . 3 . 2 . 1 . 2 . 3 . 4 .'], { res: 1, octave: 12, gain: 0.5 }),
    drum('intensity', 'triangle', 'x.......x.......', 0.6),
    drum('final', 'snare', '..o...o...o.oooo', 0.6),
    part('final', 'whistle', 'scale', ['8 _ _ _ 9 _ _ _', '10 _ _ _ 9 _ _ _'], { octave: 12, gain: 0.5 }),
  ],
};

const jungle: TrackDef = {
  id: 'jungle',
  title: 'Bongo Bounce',
  bpm: 124,
  beatsPerBar: 4,
  key: 'D4',
  scale: 'mixolydian',
  progression: ['1', '7', '4', '1', '1', '7', '4', '5'],
  reverb: 0.15,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.....x...x.....'),
    // Groups of three 16ths against the 4/4 kick: the 3-against-4 bongo polyrhythm.
    drum('drums', 'bongoHi', 'x..x..x..x..x..x', 0.8),
    drum('drums', 'bongoLo', '..x...x.x....x..', 0.8),
    drum('drums', 'shaker', 'oooooooooooooooo', 0.7),
    part('bass', 'marimba', 'chord', ['1 . 3 . 1 . 3 4'], { octave: -24, gain: 1.2 }),
    part('chords', 'kalimba', 'stack', ['. x . x . x . x'], { gain: 0.4 }),
    part('lead', 'marimba', 'scale', ['5 . 8 . 7 5 3 .', '4 . 5 . 7 _ . .', '4 . 6 . 8 7 6 4', '3 _ 5 _ 1 _ . .', '5 . 8 . 10 . 8 7', '7 . 5 . 4 _ . .', '4 . 6 . 8 . 6 .', '5 _ _ . 2 . 7 .'], {
      octave: 0,
      variations: 8,
    }),
    part('intensity', 'whistle', 'scale', ['8 _ _ _ 7 _ _ _', '7 _ _ _ 5 _ _ _', '6 _ _ _ 8 _ _ _', '7 _ _ _ _ _ _ _'], { octave: 12, gain: 0.5 }),
    drum('intensity', 'tomLo', '......x.......x.', 0.6),
    drum('final', 'tomHi', 'x.x.x.x.xxxxxxxx', 0.5),
    drum('final', 'shaker', 'xXxXxXxXxXxXxXxX', 0.6),
  ],
};

const sunset: TrackDef = {
  id: 'sunset',
  title: 'Boardwalk',
  bpm: 104,
  beatsPerBar: 4,
  swing: 0.24,
  key: 'Bb3',
  scale: 'major',
  progression: ['1^7', '6', '2^7', '5^7'],
  reverb: 0.28,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.....x...x.....'),
    drum('drums', 'snap', '....x.......x...', 0.9),
    drum('drums', 'hat', 'xoxoxoxoxoxoxoxo', 0.7),
    part('bass', 'subBass', 'chord', ['1 . . 3 . 4 3 .'], { octave: -12 }),
    part('chords', 'uke', 'stack', ['. x . x . x . x'], { gain: 0.5, legato: 0.4 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.6 }),
    part('lead', 'kalimba', 'scale', ['3 . 5 . 7 _ 6 .', '5 . 3 . 1 _ . .', '2 . 4 . 6 . 5 4', '3 _ 2 . 1 . 0 .', '8 . 7 . 5 _ 3 .', '5 . 6 5 3 _ 1 .', '2 . 4 . 6 _ 9 .', '8 _ _ _ . . . .'], {
      octave: 12,
      variations: 8,
    }),
    part('intensity', 'whistle', 'scale', ['10 _ _ _ 8 _ _ _', '8 _ _ _ 6 _ _ _', '9 _ _ _ 11 _ _ _', '10 _ _ _ 9 _ _ _'], { octave: 12, gain: 0.45 }),
    drum('intensity', 'shaker', '..x...x...x...x.', 0.7),
    drum('final', 'tambourine', 'xxxxxxxxxxxxxxxx', 0.5),
    part('final', 'brass', 'stack', ['. . x . . . x .'], { gain: 0.45, legato: 0.4 }),
  ],
};

const space: TrackDef = {
  id: 'space',
  title: 'Orbit Party',
  bpm: 120,
  beatsPerBar: 4,
  key: 'A3',
  scale: 'lydian',
  progression: ['1', '2', '1', '2', '6', '5', '2', '2'],
  reverb: 0.4,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x...x...x...x...'),
    drum('drums', 'clap', '....x.......x...', 0.8),
    drum('drums', 'hat', '..x...x...x...x.'),
    part('bass', 'pluckBass', 'chord', ['1 . 4 . 1 . 4 . 1 . 4 . 3 . 4 .'], { res: 1, octave: -12 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.9, octave: 12 }),
    part('lead', 'squareLead', 'scale', ['3 . 5 . 8 _ 7 .', '6 . 4 . 2 _ . .', '3 . 5 . 8 . 10 .', '9 _ 8 . 6 _ . .', '6 . 8 . 10 _ 9 8', '7 . 5 . 3 _ 2 .', '2 . 4 . 6 . 9 .', '8 _ _ _ _ . . .'], {
      octave: 12,
      variations: 8,
      legato: 0.75,
    }),
    part('intensity', 'glock', 'chord', ['1 2 3 4 1 2 3 4 1 2 3 4 1 2 3 4'], { res: 1, octave: 24, gain: 0.4, legato: 0.5 }),
    drum('intensity', 'openHat', '..x...x...x...x.', 0.6),
    drum('final', 'snare', 'o.o.o.o.oooooooo', 0.6),
    part('final', 'choir', 'stack', ['x _ _ _ _ _ _ _'], { octave: 12, gain: 0.8 }),
  ],
};

const beach: TrackDef = {
  id: 'beach',
  title: 'Tiki Tumble',
  bpm: 116,
  beatsPerBar: 4,
  key: 'G3',
  scale: 'major',
  progression: ['1', '4', '1', '5', '1', '4', '5', '1'],
  reverb: 0.12,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x......xx.......'),
    drum('drums', 'snap', '....x.......x...'),
    drum('drums', 'shaker', 'xoxoxoxoxoxoxoxo', 0.7),
    // Calypso 3+3+2 bass.
    part('bass', 'pluckBass', 'chord', ['1 . . 3 . . 4 .'], { octave: -12, gain: 0.9 }),
    part('chords', 'uke', 'stack', ['..x...x...x...x.'], { res: 1, gain: 0.55, legato: 0.5 }),
    part('lead', 'steelDrum', 'scale', ['5 . 3 5 . 8 . 5', '6 . 4 6 . 8 . 6', '5 . 3 . 1 . 3 5', '2 _ _ . 5 . 7 .', '8 . 7 8 . 10 . 8', '6 . 8 . 6 4 . .', '5 . 4 . 2 . 7 .', '8 _ _ _ . . . .'], {
      octave: 12,
      variations: 8,
    }),
    drum('intensity', 'bongoHi', 'x..x..x...x.x...', 0.7),
    drum('intensity', 'bongoLo', '..x...x.x....x..', 0.7),
    part('intensity', 'whistle', 'scale', ['10 _ _ _ 8 _ _ _', '11 _ _ _ 10 _ _ _', '10 _ _ _ 8 _ _ _', '9 _ _ _ _ _ _ _'], { octave: 12, gain: 0.4 }),
    drum('final', 'tambourine', 'xxxxxxxxxxxxxxxx', 0.5),
    part('final', 'brass', 'stack', ['. x . x . x . x'], { gain: 0.4, legato: 0.3 }),
  ],
};

const neon: TrackDef = {
  id: 'neon',
  title: 'Arcade Heart',
  bpm: 140,
  beatsPerBar: 4,
  key: 'F#3',
  scale: 'minor',
  progression: ['1', '6', '7', '5'],
  reverb: 0.25,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x...x...x...x...'),
    drum('drums', 'clap', '....x.......x...'),
    drum('drums', 'openHat', '..x...x...x...x.', 0.8),
    part('bass', 'pluckBass', 'chord', ['1 . 4 . 1 . 4 . 1 . 4 . 1 . 4 .'], { res: 1, octave: -12 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.7, octave: 12 }),
    part('chords', 'organ', 'stack', ['. x . x . x . x'], { gain: 0.35, legato: 0.4 }),
    part('lead', 'squareLead', 'scale', ['8 . 8 . 7 5 . 3', '4 _ 3 . 1 _ . .', '2 . 3 . 5 . 7 .', '5 _ _ . 3 . 2 .', '8 . 10 . 8 7 5 .', '6 . 8 . 6 4 3 .', '2 . 5 . 7 . 9 .', '7 _ _ _ 5 _ _ .'], {
      octave: 12,
      variations: 8,
      legato: 0.7,
    }),
    drum('intensity', 'hat', 'xoxxxoxxxoxxxoxx', 0.7),
    part('intensity', 'glock', 'chord', ['1 2 3 2 1 2 3 4'], { octave: 24, gain: 0.4 }),
    drum('final', 'snare', 'oooooooooooooooX', 0.5),
    part('final', 'brass', 'stack', ['x . . x . . x .'], { gain: 0.5, legato: 0.35, octave: 12 }),
  ],
};

const castle: TrackDef = {
  id: 'castle',
  title: 'Jester Court',
  // 6/8 at dotted-quarter 100 = 300 eighths/min, i.e. the 16th grid of 3/4 at 150.
  bpm: 150,
  beatsPerBar: 3,
  key: 'G3',
  scale: 'mixolydian',
  progression: ['1', '7', '4', '1', '1', '7', '4', '5'],
  reverb: 0.35,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.....x.....'),
    drum('drums', 'snare', '....o.....o.', 0.8),
    drum('drums', 'tambourine', '..x.x...x.x.', 0.7),
    part('bass', 'tuba', 'chord', ['1 . . 3 . .'], { octave: -12 }),
    part('chords', 'pizz', 'stack', ['. x x . x x'], { gain: 0.45, octave: 12 }),
    part('lead', 'kazoo', 'scale', ['8 _ 5 3 _ 5', '7 _ 4 2 _ 4', '4 _ 6 8 _ 6', '5 _ _ 5 6 7', '8 _ 5 3 _ 5', '7 _ 4 2 _ 7', '6 _ 4 8 _ 6', '5 _ _ _ . .'], { octave: 12, variations: 8 }),
    part('intensity', 'glock', 'chord', ['1 2 3 1 2 3'], { octave: 24, gain: 0.45 }),
    drum('intensity', 'woodblock', 'x.x.x.x.x.x.', 0.5),
    drum('final', 'snare', 'oooooooooooX', 0.5),
    part('final', 'brass', 'stack', ['x _ _ x _ _'], { gain: 0.45, legato: 0.35, octave: 12 }),
  ],
};

const goo: TrackDef = {
  id: 'goo',
  title: 'Gloop Groove',
  bpm: 100,
  beatsPerBar: 4,
  swing: 0.16,
  key: 'E3',
  scale: 'dorian',
  progression: ['1', '4M', '1', '4M', '1', '4M', '5', '7'],
  reverb: 0.22,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x..x......x.....'),
    drum('drums', 'snare', '....x.......x...', 0.8),
    drum('drums', 'hat', 'x.x.x.x.x.x.x.x.', 0.8),
    part('bass', 'pluckBass', 'chord', ['1 . . 1 . . 3 . 4 . 1 . . 2 3 .'], { res: 1, octave: -12 }),
    part('chords', 'organ', 'stack', ['. x . . . x . .'], { gain: 0.4, legato: 0.5, octave: 12 }),
    part('lead', 'kazoo', 'scale', ['1 . 3 . 4 5b 5 .', '6 _ 5 . 3 _ . .', '1 . 3 . 5 . 7 8', '7 _ 6 _ 4 . . .', '8 . 7 . 5 _ 3 4', '5b 5 3 . 1 _ . .', '5 . 7 . 9 _ 8 7', '8 _ _ _ . . . .'], {
      octave: 12,
      variations: 8,
    }),
    part('intensity', 'brass', 'stack', ['. . x . . . x .'], { gain: 0.45, legato: 0.3, octave: 12 }),
    drum('intensity', 'snap', '....x.......x...', 0.6),
    drum('final', 'tambourine', 'xxxxxxxxxxxxxxxx', 0.5),
    part('final', 'whistle', 'scale', ['8 _ _ _ 10 _ _ _', '11 _ _ _ 10 _ _ _'], { octave: 12, gain: 0.45 }),
  ],
};

// -----------------------------------------------------------------------------
// Round-type tracks
// -----------------------------------------------------------------------------

const logic: TrackDef = {
  id: 'logic',
  title: 'Tick Tock',
  bpm: 96,
  beatsPerBar: 4,
  key: 'A3',
  scale: 'minor',
  progression: ['1', '4', '5M', '1', '1', '6', '7', '5M^7'],
  reverb: 0.3,
  introBars: 1,
  parts: [
    drum('drums', 'woodblock', 'x.......x.......'),
    drum('drums', 'bongoHi', '....o.......o...', 0.8),
    drum('drums', 'kick', 'x...............', 0.7),
    part('bass', 'pizz', 'chord', ['1 . 1 . 1 . 1 .'], { octave: -12, gain: 1.2 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.5, octave: 12 }),
    part('lead', 'glock', 'scale', ['1 2 3 5 _ _ . .', '4 3 2 0# _ _ . .', '5 _ 7# _ 9 _ _ _', '8 _ _ _ . . . .', '1 2 3 5 4 3 2 0#', '8 7 6 5 6 5 4 3', '2 3 4 6 _ _ . .', '7# _ 6 _ 5 _ 4 _'], { octave: 12 }),
    drum('intensity', 'hat', '..x...x...x...x.', 0.7),
    drum('intensity', 'snare', '............x...', 0.6),
    part('intensity', 'organ', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.3 }),
    drum('final', 'woodblock', 'xoxoxoxoxoxoxoxo', 0.5),
  ],
};

const final: TrackDef = {
  id: 'final',
  title: 'Crown Fever',
  bpm: 160,
  beatsPerBar: 4,
  key: 'C4',
  scale: 'minor',
  progression: ['1', '6', '7', '1', '4', '1', '6', '5M'],
  reverb: 0.3,
  introBars: 1,
  parts: [
    drum('drums', 'kick', 'x.......x.....x.'),
    drum('drums', 'snare', '....x.......x...'),
    drum('drums', 'hat', 'x.x.x.x.x.x.x.x.', 0.8),
    drum('drums', 'tomLo', ['x...............', '', '', '..............xx'], 0.7),
    part('bass', 'pluckBass', 'chord', ['1 1 1 1 1 1 3 4'], { octave: -24 }),
    part('chords', 'pizz', 'chord', ['1 1 3 1 2 1 3 1'], { gain: 0.6 }),
    part('chords', 'choir', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.6 }),
    // The leitmotif in minor, half notes, on brass — the "Crown Fever" theme.
    part('lead', 'brass', 'scale', ['5 _ _ _ 6 _ _ _', '5 _ _ _ 3 _ _ _', '2 _ _ _ 3 _ _ _', '1 _ _ _ _ _ _ _', '4 _ 6 _ 8 _ 6 _', '5 _ _ _ 3 _ _ _', '3 _ 4 _ 6 _ 8 _', '7# _ _ _ 9 _ _ _'], {
      octave: 0,
    }),
    drum('intensity', 'hat', 'xoxoxoxoxoxoxoxo', 0.6),
    part('intensity', 'glock', 'stack', ['x _ _ _ _ _ _ _'], { octave: 24, gain: 0.5 }),
    drum('final', 'snare', ['oooooooooooooooo', '................'], 0.5),
    part('final', 'brass', 'stack', ['x . . x . . x .'], { gain: 0.5, legato: 0.35, octave: -12 }),
  ],
};

// -----------------------------------------------------------------------------
// Show
// -----------------------------------------------------------------------------

const lobby: TrackDef = {
  id: 'lobby',
  title: 'Tumbletown',
  bpm: 112,
  beatsPerBar: 4,
  swing: 0.12,
  key: 'F3',
  scale: 'major',
  progression: ['1', '6', '4', '5^7', '1', '6', '2^7', '5^7'],
  reverb: 0.22,
  parts: [
    drum('drums', 'kick', ['x.......x.......', 'x.......x.....x.']),
    drum('drums', 'snap', '....x.......x...'),
    drum('drums', 'shaker', 'oxoxoxoxoxoxoxox', 0.6),
    part('bass', 'subBass', 'chord', ['1 . . . 3 . . .', '1 . . . 3 . 2 3'], { octave: -12 }),
    part('chords', 'uke', 'stack', ['. x . x . x . x'], { gain: 0.45, legato: 0.4, octave: 12 }),
    part('chords', 'pad', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.5, octave: 12 }),
    part('lead', 'whistle', 'scale', [MOTIF_A, MOTIF_B, '3 4 5 8 _ _ . .', '7 _ 6 _ 5 _ . .', MOTIF_A, MOTIF_B, '2 3 4 _ 6 _ 5 4', '5 _ 2 _ 3 _ . .'], {
      octave: 12,
      variations: 8,
      density: 0.5,
    }),
    part('lead', 'glock', 'scale', ['. . . . . . 8 _', '. . . . 3 2 1 .', '. . . . . . . .', '. . . . . . 5 _'], { octave: 24, gain: 0.35 }),
    part('intensity', 'kazoo', 'scale', ['3 4 3 _ 1 _ _ _', '0 _ _ 1 -1 _ _ _', '1 2 3 6 _ _ . .', '5 _ 4 _ 3 _ . .'], { octave: 12, gain: 0.4 }),
    drum('intensity', 'tambourine', 'x.x.x.x.x.x.x.x.', 0.6),
    drum('intensity', 'clap', '....x.......x...', 0.6),
    drum('final', 'kick', 'x...x...x...x...'),
    drum('final', 'snare', 'oooooooooooooooo', 0.4),
  ],
};

const results: TrackDef = {
  id: 'results',
  title: 'The Tumble Wall',
  bpm: 92,
  beatsPerBar: 4,
  key: 'Eb3',
  scale: 'major',
  progression: ['1', '4', '2', '5', '6', '3', '4', '5'],
  reverb: 0.3,
  parts: [
    drum('drums', 'kick', 'x.......x.......', 0.8),
    drum('drums', 'snare', '....x.......x.oo', 0.7),
    part('bass', 'tuba', 'chord', ['1 . . . 3 . . .'], { octave: -12 }),
    part('chords', 'uke', 'stack', ['x x x x x x x x'], { gain: 0.35, legato: 0.4, octave: 12 }),
    part('chords', 'brass', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.3 }),
    // Leitmotif at half speed: "remembering the show".
    part('lead', 'whistle', 'scale', ['5 _ 6 _ 5 _ _ _', '3 _ _ _ _ _ _ _', '2 _ _ _ _ _ 3 _', '1 _ _ _ _ _ _ _', '3 _ 5 _ 8 _ 7 _', '7 _ 5 _ 3 _ _ _', '4 _ 6 _ 8 _ 6 _', '5 _ _ _ 2 _ _ _'], {
      octave: 12,
    }),
    part('lead', 'glock', 'scale', ['5 _ 6 _ 5 _ _ _', '3 _ _ _ _ _ _ _', '2 _ _ _ _ _ 3 _', '1 _ _ _ _ _ _ _'], { octave: 24, gain: 0.3 }),
    drum('intensity', 'snare', 'oooooooooooooooo', 0.35),
    part('intensity', 'choir', 'stack', ['x _ _ _ _ _ _ _'], { octave: 12, gain: 0.6 }),
    drum('final', 'crash', 'x...............', 0.5),
  ],
};

const victory: TrackDef = {
  id: 'victory',
  title: 'Crowned',
  bpm: 120,
  beatsPerBar: 4,
  key: 'C4',
  scale: 'major',
  progression: ['1', '5^7', '4', '5', '4', '5', '1', '1'],
  reverb: 0.3,
  parts: [
    drum('drums', 'kick', 'x...x...x...x...'),
    drum('drums', 'snare', '....x..o....x.oo', 0.8),
    drum('drums', 'tambourine', '..x...x...x...x.', 0.7),
    part('bass', 'tuba', 'chord', ['1 . 3 . 1 . 3 .'], { octave: -24 }),
    part('chords', 'brass', 'stack', ['. x . x . x . x'], { gain: 0.45, legato: 0.35 }),
    part('lead', 'brass', 'scale', [MOTIF_A, MOTIF_B, '5 . 8 . 10 _ 8 .', '9 _ _ . 7 . 5 .', '6 . 8 . 11 _ 10 .', '9 . 7 . 5 . 9 .', '10 _ 9 . 8 _ 7 .', '8 _ _ _ . . 5 .'], {}),
    part('intensity', 'glock', 'scale', [MOTIF_A, MOTIF_B, '5 . 8 . 10 _ 8 .', '9 _ _ . 7 . 5 .', '6 . 8 . 11 _ 10 .', '9 . 7 . 5 . 9 .', '10 _ 9 . 8 _ 7 .', '8 _ _ _ . . 5 .'], {
      octave: 24,
      gain: 0.4,
    }),
    drum('intensity', 'crash', 'x...............', 0.5),
    part('final', 'choir', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.8 }),
  ],
};

const showIntro: TrackDef = {
  id: 'showIntro',
  title: 'Showtime Spin',
  bpm: 140,
  beatsPerBar: 4,
  key: 'Bb3',
  scale: 'major',
  progression: ['1', '1', '4', '5'],
  reverb: 0.25,
  parts: [
    drum('drums', 'kick', 'x..x..x...x.....'),
    drum('drums', 'snare', '....X.......X.oo', 0.8),
    drum('drums', 'hat', 'xoxoxoxoxoxoxoxo', 0.6),
    part('bass', 'pluckBass', 'chord', ['1 . 4 . 3 . 4 . 1 . 4 . 3 . 2 .'], { res: 1, octave: -12 }),
    part('chords', 'brass', 'stack', ['x..x..x.....x...'], { res: 1, gain: 0.5, legato: 0.3, octave: 12 }),
    part('lead', 'squareLead', 'scale', ['1 . 3 . 5 . 8 .', '7 . 8 . 10 _ 8 .', '4 . 6 . 8 . 11 .', '10 _ 9 _ 7 _ 5 .'], { octave: 12 }),
    part('lead', 'glock', 'scale', ['1 . 3 . 5 . 8 .', '7 . 8 . 10 _ 8 .', '4 . 6 . 8 . 11 .', '10 _ 9 _ 7 _ 5 .'], { octave: 24, gain: 0.35 }),
    drum('intensity', 'snare', 'oooooooooooooooo', 0.4),
    part('intensity', 'organ', 'stack', ['x _ _ _ _ _ _ _'], { gain: 0.35 }),
    drum('final', 'crash', 'x...............', 0.5),
  ],
};

/** Every track by id. */
export const TRACKS: Readonly<Record<MusicTrackId, TrackDef>> = {
  candy,
  factory,
  frosty,
  jungle,
  sunset,
  space,
  beach,
  neon,
  castle,
  goo,
  logic,
  final,
  lobby,
  results,
  victory,
  showIntro,
};

/** Track ids in display order. */
export const TRACK_IDS: readonly MusicTrackId[] = Object.keys(TRACKS) as MusicTrackId[];

/**
 * Other names that resolve to a track: AUDIO.md design ids and the UI's
 * `music.<context>` hooks (SCREENS.md). Menu contexts share the lobby track so
 * moving between menus never restarts the music.
 */
export const TRACK_ALIASES: Readonly<Record<string, MusicTrackId>> = {
  mus_lobby_tumbletown: 'lobby',
  mus_candy_sugarrush: 'candy',
  mus_factory_clockwork: 'factory',
  mus_sunset_boardwalk: 'sunset',
  mus_frosty_snowglobe: 'frosty',
  mus_castle_jestercourt: 'castle',
  mus_space_orbitparty: 'space',
  mus_beach_tikitumble: 'beach',
  mus_goo_gloopgroove: 'goo',
  mus_jungle_bongobounce: 'jungle',
  mus_neon_arcadeheart: 'neon',
  mus_logic_ticktock: 'logic',
  mus_final_crownfever: 'final',
  mus_results_wall: 'results',
  mus_victory_crowned: 'victory',
  menu: 'lobby',
  matchmaking: 'lobby',
  preshow: 'lobby',
  rewards: 'lobby',
  intro: 'showIntro',
  wall: 'results',
};

// -----------------------------------------------------------------------------
// Stingers
// -----------------------------------------------------------------------------

/** Stingers, transposed to the playing track's key root at play time. */
export const STINGERS: Readonly<Record<StingerId, StingerDef>> = {
  roundStart: {
    duck: 0.6,
    beats: 2.5,
    notes: [
      [0, 0, 0.2, 0.8, 'squareLead'],
      [0.25, 4, 0.2, 0.8, 'squareLead'],
      [0.5, 7, 0.2, 0.85, 'squareLead'],
      [0.75, 12, 1, 1, 'squareLead'],
      [0.75, 0, 1.5, 0.9, 'brass'],
      [0.75, 4, 1.5, 0.8, 'brass'],
      [0.75, 7, 1.5, 0.8, 'brass'],
      [0.75, 0, 0, 1, 'crash'],
      [0.75, 0, 0, 1, 'kick'],
      [0, 0, 0, 0.6, 'snare'],
      [0.06, 0, 0, 0.9, 'snare'],
    ],
  },
  // The leitmotif, double-time, on glock + marimba over a I chord.
  qualified: {
    duck: 0.5,
    beats: 3.5,
    notes: [
      [0, 19, 0.25, 0.9, 'glock'],
      [0.25, 21, 0.25, 0.9, 'glock'],
      [0.5, 19, 0.5, 0.9, 'glock'],
      [1, 16, 0.5, 0.9, 'glock'],
      [1.5, 14, 0.75, 0.9, 'glock'],
      [2.25, 16, 0.25, 0.9, 'glock'],
      [2.5, 12, 1, 1, 'glock'],
      [0, 7, 0.25, 0.7, 'marimba'],
      [0.25, 9, 0.25, 0.7, 'marimba'],
      [0.5, 7, 0.5, 0.7, 'marimba'],
      [1, 4, 0.5, 0.7, 'marimba'],
      [1.5, 2, 0.75, 0.7, 'marimba'],
      [2.25, 4, 0.25, 0.7, 'marimba'],
      [2.5, 0, 1, 0.8, 'marimba'],
      [2.5, 0, 1.5, 0.6, 'pad'],
      [2.5, 4, 1.5, 0.6, 'pad'],
      [2.5, 7, 1.5, 0.6, 'pad'],
    ],
  },
  eliminated: {
    duck: 0.85,
    beats: 4,
    notes: [
      [0, 7, 0.45, 0.9, 'kazoo'],
      [0.5, 5, 0.45, 0.9, 'kazoo'],
      [1, 4, 0.45, 0.9, 'kazoo'],
      [1.5, 3, 2, 0.95, 'kazoo'],
      [1.5, -9, 2, 0.9, 'tuba'],
      [3.5, 0, 0, 0.6, 'tomLo'],
    ],
  },
  roundOver: {
    duck: 0.7,
    beats: 3,
    notes: [
      [0, 0, 1, 1, 'brass'],
      [0, 4, 1, 0.9, 'brass'],
      [0, 7, 1, 0.9, 'brass'],
      [0, -12, 1, 0.9, 'tuba'],
      [0, 0, 0, 0.9, 'crash'],
      [0, 0, 0, 1, 'kick'],
      [1.25, 24, 0.3, 0.8, 'whistle'],
      [1.6, 31, 0.3, 0.8, 'whistle'],
      [1.95, 19, 0.6, 0.7, 'whistle'],
    ],
  },
  victory: {
    duck: 1,
    beats: 4,
    notes: [
      [0, 0, 0.3, 0.9, 'brass'],
      [0.33, 4, 0.3, 0.9, 'brass'],
      [0.66, 7, 0.3, 0.95, 'brass'],
      [1, 12, 2.5, 1, 'brass'],
      [1, 4, 2.5, 0.8, 'brass'],
      [1, 7, 2.5, 0.8, 'brass'],
      [1, -12, 2.5, 1, 'tuba'],
      [1, 24, 1, 0.7, 'glock'],
      [1, 12, 2.5, 0.8, 'choir'],
      [1, 0, 0, 1, 'crash'],
      [1, 0, 0, 1, 'kick'],
    ],
  },
  levelUp: {
    duck: 0.4,
    beats: 2,
    notes: [
      [0, 19, 0.25, 0.8, 'glock'],
      [0.25, 21, 0.25, 0.8, 'glock'],
      [0.5, 19, 0.25, 0.85, 'glock'],
      [0.75, 24, 1, 0.9, 'glock'],
      [0.75, 12, 1, 0.7, 'kalimba'],
    ],
  },
  finalRound: {
    duck: 0.7,
    beats: 4,
    notes: [
      [0, 0, 0.45, 0.9, 'brass'],
      [0.5, 3, 0.45, 0.9, 'brass'],
      [1, 7, 0.45, 0.95, 'brass'],
      [1.5, 12, 2, 1, 'brass'],
      [1.5, -12, 2, 0.9, 'tuba'],
      [0, 0, 0, 0.8, 'tomLo'],
      [0.25, 0, 0, 0.6, 'tomLo'],
      [0.5, 0, 0, 0.8, 'tomLo'],
      [1, 0, 0, 0.9, 'tomHi'],
      [1.5, 0, 0, 1, 'crash'],
    ],
  },
  thirtySeconds: {
    duck: 0.3,
    beats: 1.5,
    notes: [
      [0, 0, 0, 0.9, 'woodblock'],
      [0.5, 0, 0, 0.7, 'woodblock'],
      [0, 19, 0.4, 0.8, 'whistle'],
      [0.5, 24, 0.8, 0.8, 'whistle'],
    ],
  },
  // Rising chromatic 5-#5-6-b7 in triplets into the downbeat.
  lastSpots: {
    duck: 0.4,
    beats: 1.5,
    notes: [
      [0, 7, 0.3, 0.8, 'brass'],
      [0.33, 8, 0.3, 0.85, 'brass'],
      [0.66, 9, 0.3, 0.9, 'brass'],
      [1, 10, 0.5, 1, 'brass'],
      [0, 0, 0, 0.4, 'snare'],
      [0.33, 0, 0, 0.6, 'snare'],
      [0.66, 0, 0, 0.8, 'snare'],
      [1, 0, 0, 0.7, 'crash'],
    ],
  },
  // Accelerating clock ticks then a tritone stab.
  overtime: {
    duck: 0.6,
    beats: 2.5,
    notes: [
      [0, 0, 0, 0.8, 'woodblock'],
      [0.5, 0, 0, 0.8, 'woodblock'],
      [0.85, 0, 0, 0.85, 'woodblock'],
      [1.1, 0, 0, 0.9, 'woodblock'],
      [1.5, 0, 0.8, 1, 'brass'],
      [1.5, 6, 0.8, 1, 'brass'],
      [1.5, -12, 0.8, 0.9, 'tuba'],
      [1.5, 0, 0, 1, 'kick'],
      [1.5, 0, 0, 0.9, 'crash'],
    ],
  },
  logo: {
    duck: 0,
    beats: 4,
    notes: [
      [0, 19, 0.25, 0.9, 'glock'],
      [0.25, 21, 0.25, 0.9, 'glock'],
      [0.5, 19, 0.5, 0.9, 'glock'],
      [1, 16, 0.5, 0.9, 'glock'],
      [1.5, 14, 0.75, 0.9, 'glock'],
      [2.25, 16, 0.25, 0.9, 'glock'],
      [2.5, 12, 1.5, 1, 'glock'],
      [0, 7, 0.25, 0.6, 'uke'],
      [0.5, 7, 0.25, 0.6, 'uke'],
      [1, 4, 0.25, 0.6, 'uke'],
      [1.5, 2, 0.25, 0.6, 'uke'],
      [2.5, 0, 1.5, 0.9, 'brass'],
      [2.5, 4, 1.5, 0.8, 'brass'],
      [2.5, 7, 1.5, 0.8, 'brass'],
      [2.5, 0, 0, 0.8, 'crash'],
      [2.5, 0, 0, 1, 'kick'],
    ],
  },
  matchFound: {
    duck: 0.5,
    beats: 2,
    notes: [
      [0, 19, 0.12, 0.9, 'glock'],
      [0.125, 21, 0.12, 0.9, 'glock'],
      [0.25, 19, 0.25, 0.9, 'glock'],
      [0.5, 16, 0.25, 0.9, 'glock'],
      [0.75, 14, 0.4, 0.9, 'glock'],
      [1.125, 16, 0.12, 0.9, 'glock'],
      [1.25, 24, 0.75, 1, 'glock'],
      [1.25, 0, 0, 0.7, 'crash'],
    ],
  },
  showStart: {
    duck: 0.8,
    beats: 3,
    notes: [
      [0, 0, 0.5, 1, 'brass'],
      [0, 4, 0.5, 0.9, 'brass'],
      [0, 7, 0.5, 0.9, 'brass'],
      [0.75, 8, 0.4, 0.9, 'brass'],
      [0.75, 12, 0.4, 0.9, 'brass'],
      [1.5, 12, 1.5, 1, 'brass'],
      [1.5, 16, 1.5, 0.9, 'brass'],
      [1.5, 19, 1.5, 0.9, 'brass'],
      [1.5, -12, 1.5, 1, 'tuba'],
      [0, 0, 0, 1, 'kick'],
      [1.5, 0, 0, 1, 'kick'],
      [1.5, 0, 0, 1, 'crash'],
    ],
  },
  nextRound: {
    duck: 0.4,
    beats: 2,
    notes: [
      [0, 12, 0.3, 0.8, 'glock'],
      [0.33, 19, 0.3, 0.85, 'glock'],
      [0.66, 24, 1.2, 0.9, 'glock'],
      [0.66, 0, 0, 0.5, 'crash'],
    ],
  },
  spectate: {
    duck: 0.3,
    beats: 2,
    notes: [
      [0, 0, 2, 0.6, 'pad'],
      [0, 4, 2, 0.6, 'pad'],
      [0, 7, 2, 0.6, 'pad'],
    ],
  },
};

/** Stinger ids. */
export const STINGER_IDS: readonly StingerId[] = Object.keys(STINGERS) as StingerId[];

/** AUDIO.md stinger names → ours. */
export const STINGER_ALIASES: Readonly<Record<string, StingerId>> = {
  go: 'roundStart',
  qualify: 'qualified',
  eliminate: 'eliminated',
  last_player: 'lastSpots',
  round_over: 'roundOver',
  final_reveal: 'finalRound',
  showdown: 'finalRound',
  show_start: 'showStart',
  next_round: 'nextRound',
  match_found: 'matchFound',
  crown_grab: 'victory',
  sting: 'logo',
  mus_stinger_logo: 'logo',
  mus_stinger_show_start: 'showStart',
  mus_stinger_next_round: 'nextRound',
  mus_stinger_final_reveal: 'finalRound',
  mus_stinger_spectate: 'spectate',
};
