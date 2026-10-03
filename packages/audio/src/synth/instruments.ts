/**
 * Instrument patches built from the toolkit. Used live by the music sequencer
 * (one call per note, scheduled ahead on the audio clock) and offline by the
 * SFX bank for fanfares, jingles and rarity reveals, so stingers and SFX share
 * one sonic identity.
 *
 * Every patch has the same signature and writes to `s.out`.
 */

import { midiToFreq } from '../music/theory.ts';
import { SILENCE, adsr, filter, fm, gain, noise, noiseBuffer, perc, softClip, sweep, tone, vocal } from './toolkit.ts';
import type { SynthContext } from './toolkit.ts';

/**
 * Plays one note.
 *
 * @param s - Synth context (`s.out` is the destination).
 * @param t - Start time.
 * @param midi - MIDI note (drums ignore it or use it as a tuning offset).
 * @param dur - Held duration in seconds (percussive patches may ring past it).
 * @param vel - Velocity 0..1.
 */
export type InstrumentFn = (s: SynthContext, t: number, midi: number, dur: number, vel: number) => void;

/** Pitched instrument ids. */
export type MelodicInstrumentId =
  | 'pluckBass'
  | 'subBass'
  | 'tuba'
  | 'marimba'
  | 'kalimba'
  | 'glock'
  | 'brass'
  | 'kazoo'
  | 'whistle'
  | 'pad'
  | 'organ'
  | 'steelDrum'
  | 'squareLead'
  | 'pizz'
  | 'uke'
  | 'choir';

/** Unpitched kit pieces. */
export type DrumId =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'hat'
  | 'openHat'
  | 'shaker'
  | 'tomLo'
  | 'tomHi'
  | 'woodblock'
  | 'cowbell'
  | 'tambourine'
  | 'crash'
  | 'triangle'
  | 'bongoHi'
  | 'bongoLo'
  | 'snap';

/** Any instrument id. */
export type InstrumentId = MelodicInstrumentId | DrumId;

/** Saw/square through an enveloped lowpass — the workhorse of bass and brass. */
function filteredOsc(
  s: SynthContext,
  t: number,
  freq: number,
  types: readonly OscillatorType[],
  detunes: readonly number[],
  cutFrom: number,
  cutPeak: number,
  cutEnd: number,
  q: number,
  level: number,
  env: { a: number; d: number; s: number; r: number },
  hold: number,
  scoopCents = 0,
): void {
  const { ctx } = s;
  const lp = filter(ctx, 'lowpass', cutFrom, q);
  lp.frequency.setValueAtTime(cutFrom, t);
  lp.frequency.linearRampToValueAtTime(cutPeak, t + env.a + 0.01);
  lp.frequency.exponentialRampToValueAtTime(Math.max(40, cutEnd), t + env.a + env.d + 0.05);
  const g = gain(ctx, 0);
  const end = adsr(g.gain, t, level, env, hold);
  lp.connect(g).connect(s.out);
  for (let i = 0; i < types.length; i++) {
    const o = ctx.createOscillator();
    o.type = types[i] as OscillatorType;
    o.frequency.value = freq;
    const det = detunes[i] ?? 0;
    if (scoopCents !== 0) {
      o.detune.setValueAtTime(det + scoopCents, t);
      o.detune.linearRampToValueAtTime(det, t + 0.06);
    } else o.detune.value = det;
    o.connect(lp);
    o.start(t);
    o.stop(end + 0.05);
  }
}

// -----------------------------------------------------------------------------
// Melodic
// -----------------------------------------------------------------------------

const pluckBass: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['sawtooth', 'square'], [0, -1200], 300, 400 + 2600 * vel, 160, 7, 0.32 * vel, { a: 0.004, d: 0.16, s: 0.45, r: 0.06 }, Math.min(dur, 0.5));
};

const subBass: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  tone(s, { type: 'sine', freq: f, t, dur: Math.min(dur, 0.6), gain: 0.5 * vel, env: { a: 0.006, d: 0.1, s: 0.8, r: 0.08 } });
  tone(s, { type: 'triangle', freq: f * 2, t, dur: 0.12, gain: 0.08 * vel });
};

const tuba: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['sawtooth', 'sawtooth'], [-6, 6], 200, 500 + 500 * vel, 380, 1.2, 0.3 * vel, { a: 0.03, d: 0.1, s: 0.75, r: 0.09 }, Math.min(dur, 0.7), -60);
};

const marimba: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  tone(s, { type: 'sine', freq: f, t, dur: 0.45, gain: 0.42 * vel, attack: 0.002 });
  tone(s, { type: 'sine', freq: f * 4, t, dur: 0.06, gain: 0.12 * vel, attack: 0.001 });
  tone(s, { type: 'sine', freq: f * 9.9, t, dur: 0.02, gain: 0.05 * vel, attack: 0.001 });
};

const kalimba: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  tone(s, { type: 'sine', freq: f, t, dur: 0.8, gain: 0.35 * vel, attack: 0.002 });
  fm(s, { t, freq: f, ratio: 5.9, index: 0.9, indexEnd: 0.01, dur: 0.12, gain: 0.1 * vel });
};

const glock: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  tone(s, { type: 'sine', freq: f, t, dur: 1.1, gain: 0.22 * vel, attack: 0.001 });
  tone(s, { type: 'sine', freq: f * 2.76, t, dur: 0.35, gain: 0.08 * vel, attack: 0.001 });
  tone(s, { type: 'sine', freq: f * 5.4, t, dur: 0.12, gain: 0.05 * vel, attack: 0.001 });
};

const brass: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['sawtooth', 'sawtooth', 'square'], [-7, 7, 0], 500, 900 + 3600 * vel, 1500, 1.4, 0.16 * vel, { a: 0.025, d: 0.12, s: 0.7, r: 0.1 }, dur, -40);
};

const kazoo: InstrumentFn = (s, t, midi, dur, vel) => {
  const { ctx } = s;
  const f = midiToFreq(midi);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.value = f;
  o.detune.setValueAtTime(-35, t);
  o.detune.linearRampToValueAtTime(0, t + 0.05);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 6.2;
  const vib = gain(ctx, 0);
  vib.gain.setValueAtTime(0, t);
  vib.gain.linearRampToValueAtTime(f * 0.018, t + Math.min(0.25, dur));
  lfo.connect(vib).connect(o.frequency);
  // The nasal "buzz" is a narrow resonance near 1.1 kHz plus a fixed second formant.
  const bp1 = filter(ctx, 'bandpass', 1100, 2.5);
  const bp2 = filter(ctx, 'bandpass', 2600, 4);
  const shaper = softClip(ctx, 2.5);
  const g = gain(ctx, 0);
  const end = adsr(g.gain, t, 0.22 * vel, { a: 0.03, d: 0.08, s: 0.85, r: 0.07 }, dur);
  o.connect(shaper);
  shaper.connect(bp1).connect(g);
  shaper.connect(bp2).connect(g);
  g.connect(s.out);
  o.start(t);
  lfo.start(t);
  o.stop(end + 0.05);
  lfo.stop(end + 0.05);
};

const whistle: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  tone(s, { type: 'sine', freq: f, t, dur, gain: 0.2 * vel, env: { a: 0.04, d: 0.1, s: 0.85, r: 0.08 }, vibrato: { rate: 6, depth: f * 0.01, delay: 0.1 } });
  noise(s, { t, dur, gain: 0.03 * vel, env: { a: 0.03, d: 0.1, s: 0.6, r: 0.08 }, filter: { type: 'bandpass', freq: f, q: 15 } });
};

const pad: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['sawtooth', 'triangle', 'sawtooth'], [-9, 0, 9], 600, 1500, 1100, 0.8, 0.07 * vel, { a: 0.3, d: 0.4, s: 0.8, r: 0.5 }, dur);
};

const organ: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  const env = { a: 0.008, d: 0.05, s: 0.9, r: 0.08 };
  tone(s, { type: 'sine', freq: f, t, dur, gain: 0.14 * vel, env, tremolo: { rate: 6.5, depth: 0.25 } });
  tone(s, { type: 'sine', freq: f * 2, t, dur, gain: 0.08 * vel, env });
  tone(s, { type: 'sine', freq: f * 3, t, dur, gain: 0.05 * vel, env });
  tone(s, { type: 'sine', freq: f * 4, t, dur, gain: 0.03 * vel, env });
};

const steelDrum: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  fm(s, { t, freq: f, ratio: 2, index: 1.6, indexEnd: 0.05, dur: 0.55, gain: 0.26 * vel });
  tone(s, { type: 'sine', freq: f * 2.02, t, dur: 0.18, gain: 0.07 * vel });
};

const squareLead: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['square', 'square'], [-8, 8], 1200, 3800, 2400, 1, 0.08 * vel, { a: 0.008, d: 0.12, s: 0.7, r: 0.08 }, dur);
};

const pizz: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['triangle', 'sawtooth'], [0, 4], 2400, 2600, 500, 2, 0.24 * vel, { a: 0.003, d: 0.2, s: 0.05, r: 0.06 }, 0.05);
};

const uke: InstrumentFn = (s, t, midi, _dur, vel) => {
  const f = midiToFreq(midi);
  filteredOsc(s, t, f, ['sawtooth', 'triangle'], [3, 0], 3200, 3400, 700, 1.5, 0.15 * vel, { a: 0.002, d: 0.35, s: 0.08, r: 0.1 }, 0.1);
};

const choir: InstrumentFn = (s, t, midi, dur, vel) => {
  const f = midiToFreq(midi);
  const level = 0.06 * vel;
  vocal(s, { t, dur: dur + 0.3, f0: f, vowel: 'a', gain: level, attack: 0.25, release: 0.3, vibrato: 0.008 });
  vocal(s, { t, dur: dur + 0.3, f0: f * 1.004, vowel: 'o', gain: level * 0.8, attack: 0.3, release: 0.3, vibrato: 0.01 });
};

// -----------------------------------------------------------------------------
// Drums
// -----------------------------------------------------------------------------

const kick: InstrumentFn = (s, t, _m, _d, vel) => {
  tone(s, { type: 'sine', freq: 165, freqEnd: 46, sweepTime: 0.09, t, dur: 0.3, gain: 0.95 * vel });
  tone(s, { type: 'triangle', freq: 1400, freqEnd: 250, sweepTime: 0.012, t, dur: 0.014, gain: 0.25 * vel });
};

const snare: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.15, gain: 0.45 * vel, filter: { type: 'highpass', freq: 1400 }, filter2: { type: 'lowpass', freq: 8000 } });
  tone(s, { type: 'triangle', freq: 230, freqEnd: 170, t, dur: 0.08, gain: 0.35 * vel });
};

const clap: InstrumentFn = (s, t, _m, _d, vel) => {
  for (let i = 0; i < 3; i++) noise(s, { t: t + i * 0.011, dur: 0.018, gain: 0.5 * vel, filter: { type: 'bandpass', freq: 1250, q: 1.3 } });
  noise(s, { t: t + 0.033, dur: 0.13, gain: 0.4 * vel, filter: { type: 'bandpass', freq: 1150, q: 1.1 } });
};

const hat: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.035, gain: 0.22 * vel, filter: { type: 'highpass', freq: 7500 } });
};

const openHat: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.24, gain: 0.18 * vel, filter: { type: 'highpass', freq: 6500 } });
};

const shaker: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.05, gain: 0.2 * vel, attack: 0.018, filter: { type: 'bandpass', freq: 5500, q: 1.2 } });
};

const tomLo: InstrumentFn = (s, t, _m, _d, vel) => {
  tone(s, { type: 'sine', freq: 150, freqEnd: 92, t, dur: 0.22, gain: 0.6 * vel });
  tone(s, { type: 'triangle', freq: 300, freqEnd: 180, t, dur: 0.05, gain: 0.12 * vel });
};

const tomHi: InstrumentFn = (s, t, _m, _d, vel) => {
  tone(s, { type: 'sine', freq: 230, freqEnd: 150, t, dur: 0.18, gain: 0.55 * vel });
  tone(s, { type: 'triangle', freq: 460, freqEnd: 300, t, dur: 0.04, gain: 0.12 * vel });
};

const woodblock: InstrumentFn = (s, t, midi, _d, vel) => {
  const f = midi > 0 ? midiToFreq(midi) : 950;
  tone(s, { type: 'sine', freq: f, freqEnd: f * 0.96, t, dur: 0.06, gain: 0.4 * vel, attack: 0.001 });
  noise(s, { t, dur: 0.008, gain: 0.15 * vel, filter: { type: 'bandpass', freq: f * 2.5, q: 4 } });
};

const cowbell: InstrumentFn = (s, t, _m, _d, vel) => {
  const { ctx } = s;
  const bp = filter(ctx, 'bandpass', 830, 2.5);
  const g = gain(ctx, 0);
  const end = perc(g.gain, t, 0.22 * vel, 0.001, 0.28);
  bp.connect(g).connect(s.out);
  for (const f of [545, 815]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    o.connect(bp);
    o.start(t);
    o.stop(end + 0.05);
  }
};

const tambourine: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.13, gain: 0.18 * vel, attack: 0.004, filter: { type: 'highpass', freq: 5200 } });
  fm(s, { t, freq: 4100, ratio: 1.41, index: 1, dur: 0.1, gain: 0.025 * vel });
};

const crash: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 1.4, gain: 0.26 * vel, filter: { type: 'highpass', freq: 3200 } });
  noise(s, { t, dur: 0.35, gain: 0.12 * vel, filter: { type: 'bandpass', freq: 6200, q: 1.5 } });
};

const triangleHit: InstrumentFn = (s, t, _m, _d, vel) => {
  fm(s, { t, freq: 2650, ratio: 2.76, index: 0.4, indexEnd: 0.05, dur: 0.9, gain: 0.08 * vel });
};

const bongoHi: InstrumentFn = (s, t, _m, _d, vel) => {
  tone(s, { type: 'sine', freq: 440, freqEnd: 390, t, dur: 0.11, gain: 0.4 * vel });
  noise(s, { t, dur: 0.006, gain: 0.1 * vel, filter: { type: 'highpass', freq: 3000 } });
};

const bongoLo: InstrumentFn = (s, t, _m, _d, vel) => {
  tone(s, { type: 'sine', freq: 310, freqEnd: 270, t, dur: 0.14, gain: 0.45 * vel });
  noise(s, { t, dur: 0.006, gain: 0.1 * vel, filter: { type: 'highpass', freq: 2500 } });
};

const snap: InstrumentFn = (s, t, _m, _d, vel) => {
  noise(s, { t, dur: 0.03, gain: 0.35 * vel, filter: { type: 'bandpass', freq: 2600, q: 3 } });
};

/** Every instrument patch by id. */
export const INSTRUMENTS: Readonly<Record<InstrumentId, InstrumentFn>> = {
  pluckBass,
  subBass,
  tuba,
  marimba,
  kalimba,
  glock,
  brass,
  kazoo,
  whistle,
  pad,
  organ,
  steelDrum,
  squareLead,
  pizz,
  uke,
  choir,
  kick,
  snare,
  clap,
  hat,
  openHat,
  shaker,
  tomLo,
  tomHi,
  woodblock,
  cowbell,
  tambourine,
  crash,
  triangle: triangleHit,
  bongoHi,
  bongoLo,
  snap,
};

/** Drum ids, for UIs and validation. */
export const DRUM_IDS: readonly DrumId[] = [
  'kick',
  'snare',
  'clap',
  'hat',
  'openHat',
  'shaker',
  'tomLo',
  'tomHi',
  'woodblock',
  'cowbell',
  'tambourine',
  'crash',
  'triangle',
  'bongoHi',
  'bongoLo',
  'snap',
];

/**
 * Plays a sequence of notes on one instrument; handy for jingles and stingers.
 *
 * @param s - Synth context.
 * @param inst - Instrument id.
 * @param t0 - Start time.
 * @param notes - `[offsetSeconds, midi, durSeconds, vel]` tuples.
 */
export function phrase(s: SynthContext, inst: InstrumentId, t0: number, notes: ReadonlyArray<readonly [number, number, number, number]>): void {
  const fn = INSTRUMENTS[inst];
  for (const [dt, midi, dur, vel] of notes) fn(s, t0 + dt, midi, dur, vel);
}

/**
 * Snare roll that crescendos into `t + dur`, used under fanfares and reveals.
 *
 * @param s - Synth context.
 * @param t - Start time.
 * @param dur - Roll length.
 * @param from - Start velocity.
 * @param to - End velocity.
 */
export function snareRoll(s: SynthContext, t: number, dur: number, from: number, to: number): void {
  const hits = Math.max(2, Math.floor(dur / 0.045));
  for (let i = 0; i < hits; i++) {
    const k = i / (hits - 1);
    noise(s, { t: t + k * dur, dur: 0.06, gain: (from + (to - from) * k) * 0.3, filter: { type: 'highpass', freq: 1800 }, filter2: { type: 'lowpass', freq: 7000 } });
  }
}

/**
 * Rising filtered-noise "whoosh" riser into `t + dur`.
 *
 * @param s - Synth context.
 * @param t - Start time.
 * @param dur - Riser length.
 * @param level - Peak gain.
 */
export function riser(s: SynthContext, t: number, dur: number, level: number): void {
  const { ctx } = s;
  const src = ctx.createBufferSource();
  const bp = filter(ctx, 'bandpass', 300, 2);
  sweep(bp.frequency, t, 300, 6000, dur);
  const g = gain(ctx, 0);
  g.gain.setValueAtTime(SILENCE, t);
  g.gain.exponentialRampToValueAtTime(level, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
  src.buffer = noiseBuffer(ctx, 'white');
  src.loop = true;
  src.connect(bp).connect(g).connect(s.out);
  src.start(t);
  src.stop(t + dur + 0.1);
}
