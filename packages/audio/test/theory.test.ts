import { Rng } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  SCALES,
  chordToneToMidi,
  diatonicChord,
  generateMelodyBar,
  midiToFreq,
  noteNameToMidi,
  parseChord,
  parseDrumLane,
  parsePattern,
  scaleDegreeToMidi,
  tokenizePattern,
} from '../src/music/theory.ts';

describe('note names', () => {
  it('parses scientific pitch', () => {
    expect(noteNameToMidi('C4')).toBe(60);
    expect(noteNameToMidi('A4')).toBe(69);
    expect(noteNameToMidi('F#3')).toBe(54);
    expect(noteNameToMidi('Bb2')).toBe(46);
    expect(() => noteNameToMidi('H2')).toThrow();
  });

  it('converts MIDI to Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(57)).toBeCloseTo(220);
  });
});

describe('scales', () => {
  it('maps degrees across octaves', () => {
    const major = SCALES.major;
    expect(scaleDegreeToMidi(60, major, 1)).toBe(60);
    expect(scaleDegreeToMidi(60, major, 5)).toBe(67);
    expect(scaleDegreeToMidi(60, major, 8)).toBe(72);
    expect(scaleDegreeToMidi(60, major, 10)).toBe(76);
    expect(scaleDegreeToMidi(60, major, 0)).toBe(59);
    expect(scaleDegreeToMidi(60, major, -1)).toBe(57);
  });

  it('wraps pentatonic scales by their own length', () => {
    expect(scaleDegreeToMidi(60, SCALES.majorPentatonic, 6)).toBe(72);
  });

  it('every scale is ascending within an octave', () => {
    for (const s of Object.values(SCALES)) {
      expect(s[0]).toBe(0);
      for (let i = 1; i < s.length; i++) expect(s[i]!).toBeGreaterThan(s[i - 1]!);
      expect(s[s.length - 1]!).toBeLessThan(12);
    }
  });
});

describe('chords', () => {
  it('builds diatonic triads and sevenths', () => {
    expect(diatonicChord(60, SCALES.major, '1')).toEqual([60, 64, 67]);
    expect(diatonicChord(60, SCALES.major, '6')).toEqual([69, 72, 76]);
    expect(diatonicChord(60, SCALES.major, '5^7')).toEqual([67, 71, 74, 77]);
    expect(diatonicChord(60, SCALES.major, '4sus2')).toEqual([65, 67, 72]);
  });

  it('forces quality for borrowed chords (major V in minor)', () => {
    expect(diatonicChord(57, SCALES.minor, '5')).toEqual([64, 67, 71]);
    expect(diatonicChord(57, SCALES.minor, '5M')).toEqual([64, 68, 71]);
    expect(diatonicChord(57, SCALES.minor, '5M^7')).toEqual([64, 68, 71, 74]);
    expect(parseChord('2m^7sus4')).toEqual({ degree: 2, quality: 'm', seventh: true, sus: 4 });
  });

  it('extends chord tones into neighbouring octaves', () => {
    const c = [60, 64, 67];
    expect(chordToneToMidi(c, 1)).toBe(60);
    expect(chordToneToMidi(c, 3)).toBe(67);
    expect(chordToneToMidi(c, 4)).toBe(72);
    expect(chordToneToMidi(c, 0)).toBe(55);
  });
});

describe('pattern notation', () => {
  it('tokenises compact and spaced forms', () => {
    expect(tokenizePattern('1.3_')).toEqual(['1', '.', '3', '_']);
    expect(tokenizePattern('10 . | -2 _')).toEqual(['10', '.', '-2', '_']);
    expect(tokenizePattern('')).toEqual([]);
  });

  it('parses holds, accents, ghosts and accidentals', () => {
    const evs = parsePattern('>5 _ . ~3b 8#', 2);
    expect(evs).toHaveLength(3);
    expect(evs[0]).toMatchObject({ step: 0, len: 4, vel: 1, degree: 5, semis: 0 });
    expect(evs[1]).toMatchObject({ step: 6, len: 2, vel: 0.4, degree: 3, semis: -1 });
    expect(evs[2]).toMatchObject({ step: 8, degree: 8, semis: 1 });
  });

  it('parses unpitched hits', () => {
    const evs = parsePattern('x . X o');
    expect(evs.map((e) => [e.step, e.vel, e.degree])).toEqual([
      [0, 0.8, null],
      [2, 1, null],
      [3, 0.4, null],
    ]);
  });

  it('rejects junk tokens', () => {
    expect(() => parsePattern('1 q 3')).toThrow();
  });

  it('parses drum lanes and repeats short ones', () => {
    const lane = parseDrumLane('x...X...o...x...', 16);
    const hits = Array.from(lane.filter((v) => v > 0));
    expect(hits).toHaveLength(4);
    [0.8, 1, 0.4, 0.8].forEach((v, i) => expect(hits[i]).toBeCloseTo(v));
    const short = parseDrumLane('x.', 16);
    expect(short.filter((v) => v > 0).length).toBe(8);
    expect(parseDrumLane('', 16).every((v) => v === 0)).toBe(true);
  });
});

describe('melody generation', () => {
  it('is deterministic per seed and fills a whole bar', () => {
    const gen = (seed: number): string => {
      const r = new Rng(seed);
      return generateMelodyBar(() => r.next(), 7, 1, 16);
    };
    expect(gen(3)).toBe(gen(3));
    expect(tokenizePattern(gen(3))).toHaveLength(16);
    expect(parsePattern(gen(5)).length).toBeGreaterThan(0);
  });

  it('starts every bar on a chord tone', () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = new Rng(seed);
      const bar = generateMelodyBar(() => r.next(), 7, 4, 16);
      const first = parsePattern(bar)[0]!;
      expect(first.step).toBe(0);
      expect([4, 6, 8, 11]).toContain(first.degree);
    }
  });
});
