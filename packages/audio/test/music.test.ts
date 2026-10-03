import { describe, expect, it } from 'vitest';
import { createStemLevels, prepareTrack, stemLevels } from '../src/music/prepare.ts';
import { noteNameToMidi } from '../src/music/theory.ts';
import { STINGERS, STINGER_ALIASES, TRACKS, TRACK_ALIASES, TRACK_IDS } from '../src/music/tracks.ts';
import { STEM_IDS } from '../src/music/types.ts';
import { INSTRUMENTS } from '../src/synth/instruments.ts';

const THEMES = [
  'candy',
  'factory',
  'frosty',
  'jungle',
  'sunset',
  'space',
  'beach',
  'neon',
  'castle',
  'goo',
] as const;

describe('track library', () => {
  it('has a track for every theme plus the show tracks', () => {
    for (const t of THEMES) expect(TRACKS[t]).toBeDefined();
    for (const t of ['lobby', 'victory', 'showIntro', 'final', 'results', 'logic'] as const)
      expect(TRACKS[t]).toBeDefined();
  });

  it.each(TRACK_IDS)('%s compiles, uses known instruments and has sane metadata', (id) => {
    const def = TRACKS[id];
    expect(def.id).toBe(id);
    expect(def.bpm).toBeGreaterThan(60);
    expect(def.bpm).toBeLessThan(200);
    expect(() => noteNameToMidi(def.key)).not.toThrow();
    for (const p of def.parts) expect(INSTRUMENTS[p.instrument]).toBeTypeOf('function');
    const prepared = prepareTrack(def);
    expect(prepared.stepsPerBar).toBe(def.beatsPerBar * 4);
    for (const part of prepared.parts) {
      for (const bar of part.bars) {
        expect(bar).toHaveLength(prepared.stepsPerBar);
        for (const n of bar) {
          if (!n) continue;
          for (const m of n.midi) {
            expect(Number.isFinite(m)).toBe(true);
            if (part.def.mode !== 'drum') {
              expect(m).toBeGreaterThanOrEqual(24);
              expect(m).toBeLessThanOrEqual(108);
            }
          }
        }
      }
    }
    // Every stem has material so intensity changes are always audible.
    for (const stem of STEM_IDS) expect(def.parts.some((p) => p.stem === stem)).toBe(true);
  });

  it('generated variations keep the part cycle aligned with the progression', () => {
    for (const id of TRACK_IDS) {
      const prepared = prepareTrack(TRACKS[id]);
      const P = TRACKS[id].progression.length;
      for (const part of prepared.parts) {
        if (part.def.mode === 'scale' && part.def.variations) expect(part.bars.length % P).toBe(0);
      }
      expect(prepared.cycleBars % P).toBe(0);
    }
  });

  it('chord parts are expanded against every chord of the progression', () => {
    const prepared = prepareTrack(TRACKS.candy);
    const bass = prepared.parts.find((p) => p.stem === 'bass')!;
    expect(bass.bars.length % TRACKS.candy.progression.length).toBe(0);
    // Bar 2 of candy is vi (A minor): the bass root sits on A two octaves down.
    expect(bass.bars[1]![0]!.midi[0]).toBe(69 - 24);
  });

  it('quotes the leitmotif (5-6-5-3 | 2-3-1) in the lobby', () => {
    const lobby = prepareTrack(TRACKS.lobby);
    const lead = lobby.parts.find((p) => p.stem === 'lead')!;
    const notes = [...lead.bars[0]!, ...lead.bars[1]!]
      .filter(Boolean)
      .map((n) => n!.midi[0]! - lobby.keyMidi - 12);
    expect(notes).toEqual([7, 9, 7, 4, 2, 4, 0]);
  });

  it('aliases resolve to real tracks and stingers', () => {
    for (const t of Object.values(TRACK_ALIASES)) expect(TRACKS[t]).toBeDefined();
    for (const s of Object.values(STINGER_ALIASES)) expect(STINGERS[s]).toBeDefined();
    for (const s of Object.values(STINGERS))
      for (const n of s.notes) expect(INSTRUMENTS[n[4]]).toBeTypeOf('function');
  });
});

describe('stem levels', () => {
  it('keeps the groove at zero intensity and gates the top layers', () => {
    const l = stemLevels(0, false, createStemLevels());
    expect(l.drums).toBeGreaterThan(0.5);
    expect(l.bass).toBe(1);
    expect(l.lead).toBe(0);
    expect(l.intensity).toBe(0);
    expect(l.final).toBe(0);
  });

  it('brings in lead early and the intensity layer late', () => {
    const mid = stemLevels(0.45, false, createStemLevels());
    expect(mid.lead).toBe(1);
    expect(mid.intensity).toBe(0);
    const high = stemLevels(1, false, createStemLevels());
    expect(high.intensity).toBe(1);
  });

  it('final layer follows the flag only', () => {
    expect(stemLevels(0, true, createStemLevels()).final).toBe(1);
    expect(stemLevels(1, false, createStemLevels()).final).toBe(0);
  });

  it('is monotonic in intensity', () => {
    let prev = createStemLevels();
    stemLevels(0, false, prev);
    for (let i = 1; i <= 20; i++) {
      const cur = stemLevels(i / 20, false, createStemLevels());
      for (const s of STEM_IDS) expect(cur[s]).toBeGreaterThanOrEqual(prev[s] - 1e-9);
      prev = cur;
    }
  });
});
