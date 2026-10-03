/**
 * Small synthesis toolkit shared by the SFX bank (rendered offline into
 * buffers) and the live music instruments. Every helper builds Web Audio nodes
 * on any `BaseAudioContext`, schedules itself at absolute time `t` and cleans
 * up via `stop()` so nothing lingers.
 *
 * Responsibilities:
 * - envelopes and pitch sweeps on AudioParams
 * - oscillator / noise / FM / formant-vocal voices
 * - filters, waveshapers (soft clip, bitcrush), generated-IR reverb
 * - cached noise buffers and impulse responses per context
 */

import { Rng } from '@tumble/shared';

/** Where a synth helper builds its nodes. */
export interface SynthContext {
  ctx: BaseAudioContext;
  /** Default destination for helpers that are not given `dest`. */
  out: AudioNode;
  /** Seeded randomness so rendered sounds are reproducible. */
  rng: Rng;
}

/** Exponential ramps cannot reach 0; this is inaudible (-80 dB). */
export const SILENCE = 0.0001;

// -----------------------------------------------------------------------------
// Envelopes
// -----------------------------------------------------------------------------

/** ADSR envelope. Times in seconds, `s` is the sustain level as a fraction of peak. */
export interface Adsr {
  a: number;
  d: number;
  s: number;
  r: number;
}

/**
 * Applies an ADSR to a param (typically a gain).
 *
 * @param param - Target param.
 * @param t - Note-on time.
 * @param peak - Peak value.
 * @param env - Envelope.
 * @param hold - Seconds the note is held before release begins (measured from `t`).
 * @returns Time the envelope reaches silence.
 */
export function adsr(param: AudioParam, t: number, peak: number, env: Adsr, hold: number): number {
  const sustain = Math.max(SILENCE, peak * env.s);
  param.cancelScheduledValues(t);
  param.setValueAtTime(SILENCE, t);
  param.linearRampToValueAtTime(peak, t + env.a);
  param.exponentialRampToValueAtTime(sustain, t + env.a + env.d);
  const relAt = Math.max(t + env.a + env.d, t + hold);
  param.setValueAtTime(sustain, relAt);
  param.exponentialRampToValueAtTime(SILENCE, relAt + env.r);
  return relAt + env.r;
}

/**
 * Percussive attack/decay envelope.
 *
 * @param param - Target param.
 * @param t - Start time.
 * @param peak - Peak value.
 * @param attack - Attack seconds (≥ 1 ms avoids clicks).
 * @param decay - Seconds from peak to silence.
 * @returns End time.
 */
export function perc(param: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  param.setValueAtTime(SILENCE, t);
  param.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
  param.exponentialRampToValueAtTime(SILENCE, t + Math.max(0.001, attack) + decay);
  return t + attack + decay;
}

/**
 * Pitch/cutoff sweep.
 *
 * @param param - Target param.
 * @param t - Start time.
 * @param from - Start value.
 * @param to - End value.
 * @param dur - Sweep duration.
 * @param curve - `exp` sounds natural for frequencies; `lin` for everything else.
 */
export function sweep(param: AudioParam, t: number, from: number, to: number, dur: number, curve: 'exp' | 'lin' = 'exp'): void {
  param.setValueAtTime(from, t);
  if (curve === 'exp' && from > 0 && to > 0) param.exponentialRampToValueAtTime(to, t + dur);
  else param.linearRampToValueAtTime(to, t + dur);
}

// -----------------------------------------------------------------------------
// Buffers
// -----------------------------------------------------------------------------

/** Noise colours. */
export type NoiseColor = 'white' | 'pink' | 'brown';

const noiseCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/**
 * Returns a cached 2-second mono noise buffer for the context.
 *
 * @param ctx - Context to build the buffer for.
 * @param color - Spectrum.
 * @returns A loopable noise buffer.
 */
export function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  let map = noiseCache.get(ctx);
  if (!map) {
    map = new Map();
    noiseCache.set(ctx, map);
  }
  const cached = map.get(color);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = new Rng(color === 'white' ? 1 : color === 'pink' ? 2 : 3);
  // Paul Kellet's economy pink filter and a leaky integrator for brown.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = rng.next() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  map.set(color, buf);
  return buf;
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/**
 * Generates (and caches) a stereo impulse response: exponentially decaying
 * noise with a darker tail, which reads as a small bright room / plate.
 *
 * @param ctx - Context.
 * @param seconds - IR length.
 * @param decay - Decay exponent (higher = shorter perceived tail).
 * @returns Stereo IR buffer.
 */
export function impulseResponse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const key = `${seconds}:${decay}`;
  let map = irCache.get(ctx);
  if (!map) {
    map = new Map();
    irCache.set(ctx, map);
  }
  const cached = map.get(key);
  if (cached) return cached;
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const rng = new Rng(97 + ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const env = Math.pow(1 - x, decay);
      // One-pole lowpass whose coefficient falls over time: high frequencies die first.
      const k = 0.85 - 0.75 * x;
      lp = lp + k * (rng.next() * 2 - 1 - lp);
      d[i] = lp * env;
    }
  }
  map.set(key, buf);
  return buf;
}

// -----------------------------------------------------------------------------
// Processors
// -----------------------------------------------------------------------------

/**
 * @param ctx - Context.
 * @param type - Biquad type.
 * @param freq - Cutoff/centre Hz.
 * @param q - Resonance / bandwidth.
 * @returns A configured BiquadFilterNode.
 */
export function filter(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/**
 * @param ctx - Context.
 * @param value - Initial gain.
 * @returns A GainNode.
 */
export function gain(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/**
 * Tanh soft clipper; adds warmth/punch to drums and brass.
 *
 * @param ctx - Context.
 * @param drive - 1 = gentle, 10 = fuzz.
 * @returns WaveShaper node.
 */
export function softClip(ctx: BaseAudioContext, drive: number): WaveShaperNode {
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  const ws = ctx.createWaveShaper();
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

/**
 * Bit-depth crusher as a stepped transfer curve (sample-rate reduction needs an
 * AudioWorklet, which we avoid so the bank renders anywhere).
 *
 * @param ctx - Context.
 * @param bits - Effective bit depth (3–8 is the lo-fi range).
 * @returns WaveShaper node.
 */
export function bitcrusher(ctx: BaseAudioContext, bits: number): WaveShaperNode {
  const n = 4096;
  const levels = Math.pow(2, bits);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  const ws = ctx.createWaveShaper();
  ws.curve = curve;
  return ws;
}

/** Reverb send created by {@link reverb}. */
export interface ReverbSend {
  /** Connect sources here. */
  input: GainNode;
}

/**
 * Wet/dry convolution reverb into `dest`.
 *
 * @param s - Synth context.
 * @param seconds - IR length.
 * @param wet - Wet level 0..1.
 * @param dest - Destination (defaults to `s.out`).
 * @returns The send input.
 */
export function reverb(s: SynthContext, seconds: number, wet: number, dest: AudioNode = s.out): ReverbSend {
  const input = gain(s.ctx, 1);
  const conv = s.ctx.createConvolver();
  conv.buffer = impulseResponse(s.ctx, seconds, 3);
  const wetG = gain(s.ctx, wet);
  const dryG = gain(s.ctx, 1 - wet * 0.5);
  input.connect(dryG).connect(dest);
  input.connect(conv).connect(wetG).connect(dest);
  return { input };
}

// -----------------------------------------------------------------------------
// Voices
// -----------------------------------------------------------------------------

/** Options for {@link tone}. */
export interface ToneOptions {
  type?: OscillatorType;
  /** Start frequency (Hz). */
  freq: number;
  /** Optional end frequency; sweeps over `sweepTime` (defaults to `dur`). */
  freqEnd?: number;
  sweepTime?: number;
  sweepCurve?: 'exp' | 'lin';
  /** Start time. */
  t: number;
  /** Seconds of attack + decay (percussive) or hold time (with `env`). */
  dur: number;
  gain: number;
  attack?: number;
  /** Full ADSR instead of a percussive decay. */
  env?: Adsr;
  detune?: number;
  /** Pitch vibrato. */
  vibrato?: { rate: number; depth: number; delay?: number };
  /** Amplitude tremolo (0..1 depth). */
  tremolo?: { rate: number; depth: number };
  dest?: AudioNode;
}

/**
 * Plays an oscillator with an envelope.
 *
 * @param s - Synth context.
 * @param o - Tone options.
 * @returns End time.
 */
export function tone(s: SynthContext, o: ToneOptions): number {
  const { ctx } = s;
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  if (o.detune) osc.detune.value = o.detune;
  if (o.freqEnd !== undefined) sweep(osc.frequency, o.t, o.freq, o.freqEnd, o.sweepTime ?? o.dur, o.sweepCurve ?? 'exp');
  else osc.frequency.setValueAtTime(o.freq, o.t);
  const g = gain(ctx, 0);
  const end = o.env ? adsr(g.gain, o.t, o.gain, o.env, o.dur) : perc(g.gain, o.t, o.gain, o.attack ?? 0.003, o.dur);
  let tail: AudioNode = g;
  if (o.tremolo) {
    const trem = gain(ctx, 1 - o.tremolo.depth / 2);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.tremolo.rate;
    const depth = gain(ctx, o.tremolo.depth / 2);
    lfo.connect(depth).connect(trem.gain);
    lfo.start(o.t);
    lfo.stop(end + 0.05);
    g.connect(trem);
    tail = trem;
  }
  if (o.vibrato) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = o.vibrato.rate;
    const depth = gain(ctx, 0);
    depth.gain.setValueAtTime(0, o.t);
    depth.gain.linearRampToValueAtTime(o.vibrato.depth, o.t + (o.vibrato.delay ?? 0) + 0.02);
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(o.t);
    lfo.stop(end + 0.05);
  }
  osc.connect(g);
  tail.connect(o.dest ?? s.out);
  osc.start(o.t);
  osc.stop(end + 0.05);
  return end;
}

/** Filter stage for {@link noise}; `freqEnd` sweeps the cutoff over `sweepTime` (default: the note duration). */
export interface NoiseFilter {
  type: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  sweepTime?: number;
}

/** Options for {@link noise}. */
export interface NoiseOptions {
  color?: NoiseColor;
  t: number;
  dur: number;
  gain: number;
  attack?: number;
  env?: Adsr;
  /** Filter applied to the noise. */
  filter?: NoiseFilter;
  /** Second filter in series (e.g. bandpass after highpass). */
  filter2?: NoiseFilter;
  /** Random start offset into the buffer so repeated bursts differ. */
  offset?: number;
  dest?: AudioNode;
}

/**
 * Plays a filtered, enveloped noise burst.
 *
 * @param s - Synth context.
 * @param o - Noise options.
 * @returns End time.
 */
export function noise(s: SynthContext, o: NoiseOptions): number {
  const { ctx } = s;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, o.color ?? 'white');
  src.loop = true;
  let head: AudioNode = src;
  for (const spec of [o.filter, o.filter2]) {
    if (!spec) continue;
    const f = filter(ctx, spec.type, spec.freq, spec.q ?? 1);
    if (spec.freqEnd !== undefined) sweep(f.frequency, o.t, spec.freq, spec.freqEnd, spec.sweepTime ?? o.dur);
    head.connect(f);
    head = f;
  }
  const g = gain(ctx, 0);
  const end = o.env ? adsr(g.gain, o.t, o.gain, o.env, o.dur) : perc(g.gain, o.t, o.gain, o.attack ?? 0.002, o.dur);
  head.connect(g).connect(o.dest ?? s.out);
  src.start(o.t, o.offset ?? s.rng.range(0, 1.8));
  src.stop(end + 0.05);
  return end;
}

/** Options for {@link fm}. */
export interface FmOptions {
  t: number;
  freq: number;
  freqEnd?: number;
  /** Modulator frequency = carrier × ratio. Non-integer ratios sound metallic/bell-like. */
  ratio: number;
  /** Modulation index (peak deviation / modulator frequency). */
  index: number;
  /** Index at the end of the note; a falling index makes bells "ring out". */
  indexEnd?: number;
  dur: number;
  gain: number;
  attack?: number;
  carrierType?: OscillatorType;
  dest?: AudioNode;
}

/**
 * Two-operator FM voice; bells, metal clanks, steel drums, spring boings.
 *
 * @param s - Synth context.
 * @param o - FM options.
 * @returns End time.
 */
export function fm(s: SynthContext, o: FmOptions): number {
  const { ctx } = s;
  const car = ctx.createOscillator();
  car.type = o.carrierType ?? 'sine';
  const mod = ctx.createOscillator();
  const modGain = gain(ctx, 0);
  const end = o.t + (o.attack ?? 0.002) + o.dur;
  const f1 = o.freqEnd ?? o.freq;
  sweep(car.frequency, o.t, o.freq, f1, o.dur);
  sweep(mod.frequency, o.t, o.freq * o.ratio, f1 * o.ratio, o.dur);
  const dev0 = o.index * o.freq * o.ratio;
  const dev1 = Math.max(SILENCE, (o.indexEnd ?? o.index * 0.1) * f1 * o.ratio);
  modGain.gain.setValueAtTime(dev0, o.t);
  modGain.gain.exponentialRampToValueAtTime(dev1, end);
  mod.connect(modGain).connect(car.frequency);
  const g = gain(ctx, 0);
  perc(g.gain, o.t, o.gain, o.attack ?? 0.002, o.dur);
  car.connect(g).connect(o.dest ?? s.out);
  car.start(o.t);
  mod.start(o.t);
  car.stop(end + 0.05);
  mod.stop(end + 0.05);
  return end;
}

/** Vowels for {@link vocal}. */
export type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'aw' | 'uh';

/** First three formants (Hz) of a cartoonishly bright voice. */
export const FORMANTS: Readonly<Record<Vowel, readonly [number, number, number]>> = {
  a: [800, 1250, 2600],
  e: [500, 1900, 2600],
  i: [320, 2300, 3000],
  o: [500, 900, 2400],
  u: [350, 700, 2400],
  aw: [650, 1000, 2500],
  uh: [600, 1150, 2500],
};

/** Options for {@link vocal}. */
export interface VocalOptions {
  t: number;
  dur: number;
  /** Fundamental (Hz). */
  f0: number;
  f0End?: number;
  vowel: Vowel;
  /** Optional vowel the formants glide to (e.g. `a`→`u` for "wow"). */
  vowelEnd?: Vowel;
  gain: number;
  attack?: number;
  release?: number;
  vibrato?: number;
  /** Multiplies formant frequencies; >1 sounds smaller/cuter. */
  formantShift?: number;
  dest?: AudioNode;
}

/**
 * Formant-filtered sawtooth that reads as a cartoon voice syllable (grunts,
 * crowd voices, the announcer's speech fallback).
 *
 * @param s - Synth context.
 * @param o - Vocal options.
 * @returns End time.
 */
export function vocal(s: SynthContext, o: VocalOptions): number {
  const { ctx } = s;
  const src = ctx.createOscillator();
  src.type = 'sawtooth';
  const end = o.t + o.dur;
  sweep(src.frequency, o.t, o.f0, o.f0End ?? o.f0, o.dur);
  if (o.vibrato) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const d = gain(ctx, o.f0 * o.vibrato);
    lfo.connect(d).connect(src.frequency);
    lfo.start(o.t);
    lfo.stop(end + 0.1);
  }
  const g = gain(ctx, 0);
  const rel = o.release ?? 0.06;
  g.gain.setValueAtTime(SILENCE, o.t);
  g.gain.linearRampToValueAtTime(o.gain, o.t + (o.attack ?? 0.02));
  g.gain.setValueAtTime(o.gain, Math.max(o.t + (o.attack ?? 0.02), end - rel));
  g.gain.exponentialRampToValueAtTime(SILENCE, end);
  const shift = o.formantShift ?? 1;
  const from = FORMANTS[o.vowel];
  const to = FORMANTS[o.vowelEnd ?? o.vowel];
  const amps = [1, 0.6, 0.25];
  for (let i = 0; i < 3; i++) {
    const bp = filter(ctx, 'bandpass', (from[i] as number) * shift, 8 + i * 4);
    if (o.vowelEnd) sweep(bp.frequency, o.t, (from[i] as number) * shift, (to[i] as number) * shift, o.dur);
    const a = gain(ctx, (amps[i] as number) * 3);
    src.connect(bp).connect(a).connect(g);
  }
  g.connect(o.dest ?? s.out);
  src.start(o.t);
  src.stop(end + 0.05);
  return end;
}

/**
 * Fast random-pitched sine pings, the "sparkle" layer for pickups, crowns and fanfares.
 *
 * @param s - Synth context.
 * @param t - Start time.
 * @param dur - Spread of pings.
 * @param count - Number of pings.
 * @param lo - Lowest frequency.
 * @param hi - Highest frequency.
 * @param level - Peak gain per ping.
 * @param dest - Destination.
 */
export function sparkle(s: SynthContext, t: number, dur: number, count: number, lo: number, hi: number, level: number, dest?: AudioNode): void {
  for (let i = 0; i < count; i++) {
    const at = t + (i / count) * dur + s.rng.range(0, dur / count);
    const f = s.rng.range(lo, hi);
    tone(s, { type: 'sine', freq: f, freqEnd: f * 1.02, t: at, dur: s.rng.range(0.08, 0.22), gain: level * s.rng.range(0.5, 1), ...(dest ? { dest } : {}) });
  }
}

/**
 * Stereo-pans a node into `dest` (no-op if the context lacks StereoPanner).
 *
 * @param ctx - Context.
 * @param pan - -1 (left) .. 1 (right).
 * @param dest - Destination.
 * @returns The input node to connect sources to.
 */
export function panTo(ctx: BaseAudioContext, pan: number, dest: AudioNode): AudioNode {
  if (typeof ctx.createStereoPanner !== 'function') return dest;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  return p;
}

// -----------------------------------------------------------------------------
// Sustained layers (loop beds)
// -----------------------------------------------------------------------------

/** Amplitude modulation for a sustained layer. Pick rates with a whole number of cycles per loop. */
export interface AmSpec {
  rate: number;
  /** 0..1. */
  depth: number;
  type?: OscillatorType;
}

function applyAm(s: SynthContext, input: AudioNode, len: number, level: number, am: AmSpec | undefined, dest: AudioNode): void {
  const g = gain(s.ctx, am ? level * (1 - am.depth / 2) : level);
  input.connect(g).connect(dest);
  if (!am) return;
  const lfo = s.ctx.createOscillator();
  lfo.type = am.type ?? 'sine';
  lfo.frequency.value = am.rate;
  const d = gain(s.ctx, (level * am.depth) / 2);
  lfo.connect(d).connect(g.gain);
  lfo.start(0);
  lfo.stop(len);
}

/**
 * Constant filtered noise for `len` seconds (loop beds: wind, hum, slosh).
 *
 * @param s - Synth context.
 * @param len - Seconds.
 * @param level - Gain.
 * @param color - Noise colour.
 * @param filters - Filters in series.
 * @param am - Optional amplitude modulation.
 */
export function bedNoise(s: SynthContext, len: number, level: number, color: NoiseColor, filters: readonly NoiseFilter[], am?: AmSpec): void {
  const src = s.ctx.createBufferSource();
  src.buffer = noiseBuffer(s.ctx, color);
  src.loop = true;
  let head: AudioNode = src;
  for (const spec of filters) {
    const f = filter(s.ctx, spec.type, spec.freq, spec.q ?? 1);
    head.connect(f);
    head = f;
  }
  applyAm(s, head, len, level, am, s.out);
  src.start(0, s.rng.range(0, 1.5));
  src.stop(len);
}

/**
 * Constant oscillator for `len` seconds, optionally filtered, AM'd and vibrato'd.
 *
 * @param s - Synth context.
 * @param len - Seconds.
 * @param level - Gain.
 * @param type - Waveform.
 * @param freq - Frequency.
 * @param opts - Optional detune (cents), lowpass cutoff, AM and vibrato.
 */
export function bedTone(
  s: SynthContext,
  len: number,
  level: number,
  type: OscillatorType,
  freq: number,
  opts: { detune?: number; lowpass?: number; am?: AmSpec; vibrato?: { rate: number; depth: number } } = {},
): void {
  const o = s.ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (opts.detune) o.detune.value = opts.detune;
  if (opts.vibrato) {
    const lfo = s.ctx.createOscillator();
    lfo.frequency.value = opts.vibrato.rate;
    const d = gain(s.ctx, opts.vibrato.depth);
    lfo.connect(d).connect(o.frequency);
    lfo.start(0);
    lfo.stop(len);
  }
  let head: AudioNode = o;
  if (opts.lowpass) {
    const f = filter(s.ctx, 'lowpass', opts.lowpass, 0.9);
    o.connect(f);
    head = f;
  }
  applyAm(s, head, len, level, opts.am, s.out);
  o.start(0);
  o.stop(len);
}
