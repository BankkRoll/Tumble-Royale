/**
 * Menu/UI sounds and the six escalating rarity reveal fanfares. All on the UI
 * bus, non-spatial, outside the SFX voice limit. Rarity reveals share a motif
 * (rising major third → fifth) that grows in orchestration, length and key so
 * players learn "the bigger the sound, the better the drop".
 */

import { INSTRUMENTS, phrase, riser, snareRoll } from '../../synth/instruments.ts';
import type { InstrumentId } from '../../synth/instruments.ts';
import { fm, gain, noise, panTo, reverb, softClip, sparkle, tone } from '../../synth/toolkit.ts';
import type { SynthContext } from '../../synth/toolkit.ts';
import type { SfxDef, SfxDefs } from '../types.ts';

function into(s: SynthContext, out: AudioNode): SynthContext {
  return { ctx: s.ctx, out, rng: s.rng };
}

function wet(s: SynthContext, seconds: number, amount: number): SynthContext {
  return into(s, reverb(s, seconds, amount).input);
}

function chord(s: SynthContext, inst: InstrumentId, t: number, notes: readonly number[], dur: number, vel: number): void {
  for (const m of notes) INSTRUMENTS[inst](s, t, m, dur, vel);
}

/** Defaults shared by every UI sound. */
function ui(def: SfxDef): SfxDef {
  return { bus: 'ui', pitchVar: 0, volVar: 0.05, eager: true, ...def };
}

/** Rarity tiers in ascending order (matches cosmetics rarity ids). */
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;

/** A cosmetic rarity. */
export type Rarity = (typeof RARITIES)[number];

/** The shared stamp impact: punchy low thunk + paper slap through a soft clipper. */
function stampCore(s: SynthContext): void {
  const bus = gain(s.ctx, 1);
  bus.connect(softClip(s.ctx, 3)).connect(s.out);
  const p = into(s, bus);
  tone(p, { freq: 125, freqEnd: 42, t: 0, dur: 0.25, gain: 0.9 });
  noise(p, { color: 'brown', t: 0, dur: 0.2, gain: 0.8, filter: { type: 'lowpass', freq: 1500, freqEnd: 200 } });
  noise(p, { t: 0, dur: 0.04, gain: 0.5, filter: { type: 'bandpass', freq: 1800, q: 1 } });
}

/** Stamp + a flavour layer per meaning (SCREENS.md `ui.stamp.<kind>`). */
const STAMP_VARIANTS: SfxDefs = {
  'ui.stamp.qualified': ui({
    desc: 'QUALIFIED! stamp: thunk + bright major chord + sparkle',
    duration: 1.3,
    stereo: true,
    render: (s) => {
      stampCore(s);
      const w = wet(s, 1.2, 0.3);
      chord(w, 'glock', 0.02, [84, 88, 91, 96], 0.5, 0.8);
      chord(w, 'brass', 0.02, [60, 64, 67, 72], 0.4, 0.7);
      sparkle(w, 0.05, 0.6, 10, 3000, 7500, 0.04);
    },
  }),
  'ui.stamp.eliminated': ui({
    desc: 'ELIMINATED stamp: thunk + sad low honk',
    duration: 1.1,
    render: (s) => {
      stampCore(s);
      INSTRUMENTS.tuba(s, 0.05, 43, 0.5, 0.9);
      INSTRUMENTS.tuba(s, 0.05, 46, 0.5, 0.7);
      INSTRUMENTS.kazoo(s, 0.05, 58, 0.6, 0.6);
    },
  }),
  'ui.stamp.roundOver': ui({
    desc: 'ROUND OVER stamp: thunk + whistle tail',
    duration: 1,
    render: (s) => {
      stampCore(s);
      tone(s, { freq: 2600, t: 0.1, dur: 0.45, gain: 0.12, env: { a: 0.01, d: 0.05, s: 0.85, r: 0.05 }, tremolo: { rate: 30, depth: 0.6 } });
    },
  }),
  'ui.stamp.go': ui({
    desc: 'GO! stamp: thunk + brass stab',
    duration: 0.9,
    stereo: true,
    render: (s) => {
      stampCore(s);
      chord(wet(s, 1, 0.25), 'brass', 0, [60, 64, 67, 72], 0.3, 1);
    },
  }),
  'ui.stamp.timeUp': ui({
    desc: "TIME'S UP stamp: thunk + game-show buzzer",
    duration: 0.9,
    render: (s) => {
      stampCore(s);
      tone(s, { type: 'sawtooth', freq: 110, t: 0.02, dur: 0.6, gain: 0.12, env: { a: 0.01, d: 0.05, s: 0.9, r: 0.08 } });
      tone(s, { type: 'square', freq: 116, t: 0.02, dur: 0.6, gain: 0.08, env: { a: 0.01, d: 0.05, s: 0.9, r: 0.08 } });
    },
  }),
  'ui.stamp.final': ui({
    desc: 'FINAL ROUND stamp: thunk + timpani + minor brass',
    duration: 1.6,
    stereo: true,
    render: (s) => {
      stampCore(s);
      const w = wet(s, 1.5, 0.3);
      INSTRUMENTS.tomLo(s, 0, 0, 0, 1);
      chord(w, 'brass', 0.02, [48, 55, 60, 63, 67], 0.9, 1);
      INSTRUMENTS.crash(w, 0.02, 0, 0, 0.6);
    },
  }),
  'ui.stamp.victory': ui({
    desc: 'VICTORY stamp: thunk + crash + major fanfare chord',
    duration: 1.8,
    stereo: true,
    render: (s) => {
      stampCore(s);
      const w = wet(s, 1.6, 0.35);
      chord(w, 'brass', 0.02, [48, 60, 64, 67, 72], 1.1, 1);
      chord(w, 'choir', 0.02, [64, 67, 72], 1.1, 0.8);
      INSTRUMENTS.crash(w, 0.02, 0, 0, 0.9);
      sparkle(w, 0.1, 1, 16, 2500, 8000, 0.045);
    },
  }),
};

/** UI and rarity sound definitions. */
export const UI_SFX: SfxDefs = {
  'ui.click': ui({
    desc: 'Crisp button click',
    duration: 0.06,
    gain: 0.55,
    pitchVar: 0.6,
    render: (s) => {
      tone(s, { freq: 1500, freqEnd: 1100, t: 0, dur: 0.03, gain: 0.3, attack: 0.001 });
      noise(s, { t: 0, dur: 0.008, gain: 0.25, filter: { type: 'highpass', freq: 4000 } });
      tone(s, { type: 'triangle', freq: 600, t: 0, dur: 0.02, gain: 0.1, attack: 0.001 });
    },
  }),
  'ui.hover': ui({
    desc: 'Soft hover tick',
    duration: 0.04,
    pitchVar: 0.8,
    gain: 0.22,
    cooldownMs: 35,
    render: (s) => {
      tone(s, { freq: 2200, t: 0, dur: 0.025, gain: 0.1, attack: 0.002 });
    },
  }),
  'ui.confirm': ui({
    desc: 'Two-note up marimba blip',
    duration: 0.5,
    gain: 0.6,
    render: (s) => {
      INSTRUMENTS.marimba(s, 0, 76, 0.1, 0.9);
      INSTRUMENTS.marimba(s, 0.07, 83, 0.2, 1);
    },
  }),
  'ui.back': ui({
    desc: 'Two-note down marimba blip',
    duration: 0.5,
    gain: 0.5,
    render: (s) => {
      INSTRUMENTS.marimba(s, 0, 83, 0.1, 0.8);
      INSTRUMENTS.marimba(s, 0.07, 76, 0.2, 0.8);
    },
  }),
  'ui.whoosh': ui({
    desc: 'Screen transition swish',
    duration: 0.35,
    gain: 0.5,
    stereo: true,
    render: (s) => {
      noise(into(s, panTo(s.ctx, -0.4, s.out)), { color: 'pink', t: 0, dur: 0.26, gain: 0.35, attack: 0.1, filter: { type: 'bandpass', freq: 400, freqEnd: 3200, q: 1.5 } });
      noise(into(s, panTo(s.ctx, 0.4, s.out)), { color: 'pink', t: 0.03, dur: 0.26, gain: 0.3, attack: 0.1, filter: { type: 'bandpass', freq: 500, freqEnd: 3600, q: 1.5 } });
    },
  }),
  'ui.stamp': ui({
    desc: 'Big rubber-stamp THUNK (any stamp slam)',
    duration: 0.5,
    render: stampCore,
  }),
  'ui.error': ui({
    desc: 'Buzzy "nuh-uh"',
    duration: 0.3,
    gain: 0.5,
    render: (s) => {
      tone(s, { type: 'square', freq: 220, t: 0, dur: 0.09, gain: 0.1, env: { a: 0.005, d: 0.02, s: 0.9, r: 0.02 } });
      tone(s, { type: 'square', freq: 185, t: 0.11, dur: 0.12, gain: 0.1, env: { a: 0.005, d: 0.02, s: 0.9, r: 0.04 } });
    },
  }),
  'ui.toggle': ui({
    desc: 'Switch toggle',
    duration: 0.08,
    gain: 0.4,
    render: (s) => {
      noise(s, { t: 0, dur: 0.01, gain: 0.3, filter: { type: 'bandpass', freq: 3000, q: 2 } });
      tone(s, { freq: 900, t: 0.015, dur: 0.03, gain: 0.15, attack: 0.001 });
    },
  }),
  'ui.coin': ui({
    desc: 'Gumball/Gem ka-ching',
    duration: 0.6,
    gain: 0.6,
    render: (s) => {
      fm(s, { t: 0, freq: 1976, ratio: 3.5, index: 1, indexEnd: 0.05, dur: 0.12, gain: 0.15 });
      fm(s, { t: 0.08, freq: 2637, ratio: 3.5, index: 1, indexEnd: 0.05, dur: 0.45, gain: 0.15 });
    },
  }),
  'ui.notify': ui({
    desc: 'Friendly notification kalimba',
    duration: 0.9,
    gain: 0.6,
    render: (s) => {
      INSTRUMENTS.kalimba(s, 0, 79, 0.2, 0.9);
      INSTRUMENTS.kalimba(s, 0.1, 84, 0.3, 0.9);
    },
  }),
  'ui.reward': ui({
    desc: 'Reward chime (glock arpeggio)',
    duration: 1.3,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.3, 0.35);
      phrase(w, 'glock', 0, [
        [0, 84, 0.2, 0.8],
        [0.07, 88, 0.2, 0.8],
        [0.14, 91, 0.2, 0.85],
        [0.21, 96, 0.4, 0.9],
      ]);
      sparkle(w, 0.2, 0.4, 6, 3500, 7000, 0.03);
    },
  }),
  'ui.levelUp': ui({
    desc: 'Level-up fanfare',
    duration: 2,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.8, 0.3);
      phrase(w, 'brass', 0, [
        [0, 60, 0.09, 0.8],
        [0.1, 64, 0.09, 0.85],
        [0.2, 67, 0.09, 0.9],
        [0.3, 72, 0.7, 1],
      ]);
      chord(w, 'brass', 0.3, [55, 64, 67], 0.7, 0.7);
      chord(w, 'glock', 0.3, [84, 88, 91, 96], 0.3, 0.5);
      INSTRUMENTS.crash(w, 0.3, 0, 0, 0.6);
      INSTRUMENTS.kick(s, 0.3, 0, 0, 0.9);
      sparkle(w, 0.35, 0.9, 12, 3000, 7500, 0.04);
    },
  }),
  'ui.rarity.common': ui({
    desc: 'Rarity reveal 1/6: a friendly pluck',
    duration: 0.9,
    gain: 0.7,
    render: (s) => {
      const w = wet(s, 0.8, 0.2);
      INSTRUMENTS.marimba(w, 0, 72, 0.2, 0.8);
      INSTRUMENTS.marimba(w, 0.09, 76, 0.3, 0.8);
    },
  }),
  'ui.rarity.uncommon': ui({
    desc: 'Rarity reveal 2/6: glock rise + shimmer',
    duration: 1.2,
    gain: 0.8,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.2, 0.3);
      phrase(w, 'glock', 0, [
        [0, 79, 0.2, 0.7],
        [0.08, 83, 0.2, 0.75],
        [0.16, 86, 0.4, 0.85],
      ]);
      INSTRUMENTS.marimba(w, 0.16, 67, 0.3, 0.7);
      sparkle(w, 0.18, 0.4, 5, 3500, 6500, 0.03);
    },
  }),
  'ui.rarity.rare': ui({
    desc: 'Rarity reveal 3/6: brass stab + arpeggio',
    duration: 1.6,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.5, 0.3);
      phrase(w, 'marimba', 0, [
        [0, 74, 0.1, 0.8],
        [0.07, 78, 0.1, 0.8],
        [0.14, 81, 0.1, 0.85],
        [0.21, 86, 0.2, 0.9],
      ]);
      chord(w, 'brass', 0.28, [62, 66, 69, 74], 0.5, 0.85);
      INSTRUMENTS.kick(s, 0.28, 0, 0, 0.8);
      sparkle(w, 0.3, 0.6, 8, 3000, 7000, 0.04);
    },
  }),
  'ui.rarity.epic': ui({
    desc: 'Rarity reveal 4/6: whoosh, two brass hits, cymbal',
    duration: 2.2,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.8, 0.35);
      riser(s, 0, 0.4, 0.2);
      chord(w, 'brass', 0.4, [56, 63, 68, 72], 0.16, 0.85);
      chord(w, 'brass', 0.6, [58, 65, 70, 74], 0.16, 0.9);
      chord(w, 'brass', 0.8, [60, 67, 72, 76, 79], 0.9, 1);
      INSTRUMENTS.kick(s, 0.8, 0, 0, 1);
      INSTRUMENTS.crash(w, 0.8, 0, 0, 0.8);
      phrase(w, 'glock', 0.8, [
        [0, 84, 0.2, 0.6],
        [0.06, 88, 0.2, 0.6],
        [0.12, 91, 0.2, 0.6],
        [0.18, 96, 0.4, 0.7],
      ]);
      sparkle(w, 0.85, 0.9, 12, 3000, 8000, 0.04);
    },
  }),
  'ui.rarity.legendary': ui({
    desc: 'Rarity reveal 5/6: drum roll, full fanfare, choir',
    duration: 3,
    stereo: true,
    render: (s) => {
      const w = wet(s, 2.2, 0.35);
      snareRoll(s, 0, 0.8, 0.2, 0.9);
      riser(s, 0.2, 0.6, 0.15);
      phrase(w, 'brass', 0.8, [
        [0, 65, 0.12, 0.9],
        [0.13, 69, 0.12, 0.9],
        [0.26, 72, 0.12, 0.95],
        [0.39, 77, 1.1, 1],
      ]);
      chord(w, 'brass', 1.19, [53, 60, 65, 69, 72], 1.1, 0.8);
      chord(w, 'choir', 1.19, [65, 69, 72, 77], 1.2, 1);
      INSTRUMENTS.kick(s, 1.19, 0, 0, 1);
      INSTRUMENTS.crash(w, 1.19, 0, 0, 1);
      INSTRUMENTS.tomLo(s, 0.8, 0, 0, 0.8);
      INSTRUMENTS.tomHi(s, 0.93, 0, 0, 0.8);
      INSTRUMENTS.tomHi(s, 1.06, 0, 0, 0.9);
      sparkle(w, 1.2, 1.4, 20, 2500, 8000, 0.045);
    },
  }),
  'ui.rarity.mythic': ui({
    desc: 'Rarity reveal 6/6: riser, key-change fanfare, choir, bells — the works',
    duration: 4.2,
    stereo: true,
    render: (s) => {
      const w = wet(s, 3, 0.45);
      snareRoll(s, 0, 1.2, 0.1, 1);
      riser(s, 0, 1.2, 0.3);
      phrase(w, 'brass', 1.2, [
        [0, 63, 0.12, 0.9],
        [0.13, 67, 0.12, 0.9],
        [0.26, 70, 0.12, 0.95],
      ]);
      chord(w, 'brass', 1.59, [63, 67, 70, 75], 0.3, 0.9);
      phrase(w, 'brass', 1.95, [
        [0, 66, 0.12, 0.95],
        [0.13, 70, 0.12, 0.95],
        [0.26, 73, 0.12, 1],
      ]);
      chord(w, 'brass', 2.34, [54, 61, 66, 70, 73, 78], 1.4, 1);
      chord(w, 'choir', 2.34, [66, 70, 73, 78], 1.6, 1);
      chord(w, 'glock', 2.34, [90, 94, 97, 102], 0.5, 0.6);
      INSTRUMENTS.kick(s, 2.34, 0, 0, 1);
      INSTRUMENTS.crash(w, 2.34, 0, 0, 1);
      INSTRUMENTS.crash(w, 1.59, 0, 0, 0.5);
      INSTRUMENTS.triangle(w, 2.34, 0, 0, 1);
      sparkle(w, 2.35, 1.6, 30, 2500, 9000, 0.05);
    },
  }),
  ...STAMP_VARIANTS,
  'ui.tab': ui({
    desc: 'Menu tab change: soft slide + tick',
    duration: 0.2,
    gain: 0.6,
    render: (s) => {
      noise(s, { color: 'pink', t: 0, dur: 0.12, gain: 0.2, attack: 0.04, filter: { type: 'bandpass', freq: 1500, freqEnd: 3000, q: 2 } });
      INSTRUMENTS.marimba(s, 0.05, 81, 0.1, 0.7);
    },
  }),
  'ui.slider': ui({
    desc: 'Slider detent tick',
    duration: 0.04,
    gain: 0.35,
    pitchVar: 0.5,
    cooldownMs: 50,
    render: (s) => {
      tone(s, { type: 'triangle', freq: 1800, t: 0, dur: 0.02, gain: 0.2, attack: 0.001 });
    },
  }),
  'ui.toast': ui({
    desc: 'Toast pops in',
    duration: 0.4,
    gain: 0.6,
    render: (s) => {
      tone(s, { freq: 500, freqEnd: 900, sweepTime: 0.04, t: 0, dur: 0.06, gain: 0.3 });
      INSTRUMENTS.kalimba(s, 0.04, 84, 0.2, 0.7);
    },
  }),
  'ui.matchFound': ui({
    desc: 'Match found burst (leitmotif run + cymbal)',
    duration: 1.6,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.4, 0.3);
      phrase(w, 'glock', 0, [
        [0, 84, 0.06, 0.9],
        [0.06, 86, 0.06, 0.9],
        [0.12, 84, 0.12, 0.9],
        [0.24, 81, 0.12, 0.9],
        [0.36, 79, 0.18, 0.9],
        [0.54, 81, 0.06, 0.9],
        [0.6, 89, 0.6, 1],
      ]);
      chord(w, 'brass', 0.6, [53, 57, 60, 65], 0.5, 0.8);
      INSTRUMENTS.crash(w, 0.6, 0, 0, 0.7);
      riser(s, 0, 0.6, 0.12);
    },
  }),
  'ui.purchase': ui({
    desc: 'Purchase success: coins pour in',
    duration: 1.2,
    stereo: true,
    render: (s) => {
      for (let i = 0; i < 9; i++) {
        const t = i * 0.07 + s.rng.range(0, 0.02);
        fm(into(s, panTo(s.ctx, s.rng.range(-0.5, 0.5), s.out)), { t, freq: s.rng.pick([1976, 2349, 2637, 3136]), ratio: 3.5, index: 1, indexEnd: 0.05, dur: 0.2, gain: 0.1 });
      }
      INSTRUMENTS.marimba(s, 0.65, 77, 0.2, 0.9);
      INSTRUMENTS.marimba(s, 0.72, 84, 0.3, 1);
    },
  }),
  'ui.claim': ui({
    desc: 'Claim a pass tier / challenge',
    duration: 1,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1, 0.3);
      INSTRUMENTS.kick(s, 0, 0, 0, 0.6);
      chord(w, 'glock', 0, [77, 81, 84, 89], 0.3, 0.7);
      sparkle(w, 0.05, 0.5, 8, 3000, 7000, 0.04);
    },
  }),
  'ui.wall.flash': ui({
    desc: 'Player Wall: eliminated cells flash (alarm-ish blips)',
    duration: 0.6,
    render: (s) => {
      for (let i = 0; i < 3; i++) tone(s, { type: 'square', freq: 740, t: i * 0.16, dur: 0.07, gain: 0.08, env: { a: 0.003, d: 0.02, s: 0.8, r: 0.02 } });
    },
  }),
  'ui.wall.trapdoor': ui({
    desc: 'Player Wall: trapdoors swing open (clunk + creak)',
    duration: 0.5,
    render: (s) => {
      tone(s, { freq: 160, freqEnd: 70, t: 0, dur: 0.12, gain: 0.5 });
      noise(s, { t: 0, dur: 0.04, gain: 0.3, filter: { type: 'bandpass', freq: 900, q: 2 } });
      tone(s, { type: 'sawtooth', freq: 220, freqEnd: 140, t: 0.05, dur: 0.3, gain: 0.04, vibrato: { rate: 30, depth: 8 } });
    },
  }),
  'ui.wall.fall': ui({
    desc: 'Player Wall: a batch of Tumblers falling (whistles)',
    duration: 1.1,
    stereo: true,
    render: (s) => {
      for (let i = 0; i < 4; i++) {
        const f = s.rng.range(1400, 1900);
        tone(into(s, panTo(s.ctx, s.rng.range(-0.7, 0.7), s.out)), { freq: f, freqEnd: f * 0.25, t: i * 0.08, dur: 0.8, gain: 0.08, env: { a: 0.02, d: 0.1, s: 0.8, r: 0.1 } });
      }
    },
  }),
  'ui.wall.counter': ui({
    desc: 'Player Wall: remaining counter ticks',
    duration: 0.1,
    pitchVar: 0.5,
    cooldownMs: 30,
    gain: 0.5,
    render: (s) => {
      tone(s, { type: 'square', freq: 1320, t: 0, dur: 0.025, gain: 0.08, attack: 0.001 });
      tone(s, { freq: 2640, t: 0, dur: 0.02, gain: 0.05, attack: 0.001 });
    },
  }),
  'ui.wall.shake': ui({
    desc: 'Player Wall: rumble before the winner reveal',
    duration: 0.9,
    render: (s) => {
      noise(s, { color: 'brown', t: 0, dur: 0.7, gain: 0.8, env: { a: 0.1, d: 0.2, s: 0.8, r: 0.2 }, filter: { type: 'lowpass', freq: 160 } });
      snareRoll(s, 0, 0.7, 0.1, 0.5);
    },
  }),
  'ui.wall.crown': ui({
    desc: 'Player Wall: the Crown lands on the winner',
    duration: 1.6,
    stereo: true,
    render: (s) => {
      const w = wet(s, 1.6, 0.4);
      tone(s, { freq: 1800, freqEnd: 500, t: 0, dur: 0.35, gain: 0.1 });
      INSTRUMENTS.kick(s, 0.35, 0, 0, 1);
      chord(w, 'glock', 0.35, [84, 88, 91, 96], 0.6, 0.8);
      chord(w, 'brass', 0.35, [60, 64, 67, 72], 0.8, 0.8);
      sparkle(w, 0.4, 1, 16, 2500, 8000, 0.045);
    },
  }),
  'ui.fireworks': ui({
    desc: 'Firework launch + burst + crackle',
    duration: 1.6,
    stereo: true,
    render: (s) => {
      noise(s, { t: 0, dur: 0.45, gain: 0.15, attack: 0.3, filter: { type: 'bandpass', freq: 1500, freqEnd: 5000, q: 4 } });
      tone(s, { freq: 900, freqEnd: 2400, t: 0, dur: 0.45, gain: 0.04, attack: 0.3 });
      noise(s, { color: 'brown', t: 0.48, dur: 0.5, gain: 0.8, filter: { type: 'lowpass', freq: 1200, freqEnd: 150 } });
      tone(s, { freq: 90, freqEnd: 40, t: 0.48, dur: 0.3, gain: 0.6 });
      for (let i = 0; i < 18; i++) noise(into(s, panTo(s.ctx, s.rng.range(-0.9, 0.9), s.out)), { t: s.rng.range(0.6, 1.4), dur: 0.006, gain: s.rng.range(0.05, 0.15), filter: { type: 'highpass', freq: 3500 } });
    },
  }),
  'ui.joinTick': ui({
    desc: 'Pre-show: a player joined',
    duration: 0.12,
    pitchVar: 3,
    cooldownMs: 150,
    gain: 0.45,
    render: (s) => {
      tone(s, { freq: 700, freqEnd: 1100, t: 0, dur: 0.06, gain: 0.2 });
    },
  }),
  'ui.typeOn': ui({
    desc: 'Title card letter pop',
    duration: 0.06,
    pitchVar: 2,
    cooldownMs: 40,
    gain: 0.35,
    render: (s) => {
      tone(s, { freq: 900, freqEnd: 1500, t: 0, dur: 0.03, gain: 0.2 });
      noise(s, { t: 0, dur: 0.006, gain: 0.15, filter: { type: 'highpass', freq: 4000 } });
    },
  }),
  'alarm.blip': {
    desc: 'Hazard telegraph: two bright warning blips (attention band)',
    duration: 0.3,
    priority: 5,
    pitchVar: 0.3,
    cooldownMs: 120,
    refDistance: 6,
    render: (s) => {
      for (let i = 0; i < 2; i++) {
        tone(s, { type: 'square', freq: 1000, t: i * 0.12, dur: 0.07, gain: 0.08, env: { a: 0.003, d: 0.02, s: 0.85, r: 0.02 } });
        tone(s, { type: 'square', freq: 1414, t: i * 0.12, dur: 0.07, gain: 0.05, env: { a: 0.003, d: 0.02, s: 0.85, r: 0.02 } });
      }
    },
  },
  'whoosh.up': {
    desc: 'Rising whoosh (things switching on / spawning)',
    duration: 0.45,
    pitchVar: 1.5,
    cooldownMs: 60,
    render: (s) => {
      noise(s, { color: 'pink', t: 0, dur: 0.35, gain: 0.45, attack: 0.25, filter: { type: 'bandpass', freq: 300, freqEnd: 2500, q: 2 } });
      tone(s, { freq: 200, freqEnd: 600, t: 0, dur: 0.35, gain: 0.06, attack: 0.2 });
    },
  },
  'whoosh.down': {
    desc: 'Falling whoosh (things switching off)',
    duration: 0.45,
    pitchVar: 1.5,
    cooldownMs: 60,
    render: (s) => {
      noise(s, { color: 'pink', t: 0, dur: 0.38, gain: 0.45, attack: 0.03, filter: { type: 'bandpass', freq: 2500, freqEnd: 300, q: 2 } });
      tone(s, { freq: 600, freqEnd: 180, t: 0, dur: 0.35, gain: 0.06 });
    },
  },
  'laser.charge': {
    desc: 'Laser charging whine (telegraph)',
    duration: 0.7,
    priority: 5,
    cooldownMs: 100,
    render: (s) => {
      tone(s, { type: 'sawtooth', freq: 300, freqEnd: 1800, t: 0, dur: 0.6, gain: 0.05, env: { a: 0.4, d: 0.1, s: 0.9, r: 0.08 }, tremolo: { rate: 24, depth: 0.5 } });
      tone(s, { freq: 600, freqEnd: 3600, t: 0, dur: 0.6, gain: 0.05, env: { a: 0.4, d: 0.1, s: 0.9, r: 0.08 } });
    },
  },
};
