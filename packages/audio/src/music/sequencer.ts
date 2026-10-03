/**
 * Adaptive music system: a lookahead step sequencer on the audio clock that
 * plays prepared tracks as stems, fades layers by game intensity, crossfades
 * between tracks on bar lines and drops stingers on the next beat.
 *
 * Scheduling follows the "tale of two clocks" pattern: a coarse JS timer wakes
 * every 25 ms and schedules every step that falls inside the next 120 ms on
 * the sample-accurate audio clock, so timer jitter never reaches the music.
 */

import { Rng } from '@tumble/shared';
import type { AudioEngine } from '../core/engine.ts';
import { INSTRUMENTS } from '../synth/instruments.ts';
import type { InstrumentFn } from '../synth/instruments.ts';
import { impulseResponse } from '../synth/toolkit.ts';
import type { SynthContext } from '../synth/toolkit.ts';
import { createStemLevels, isDrum, prepareTrack, stemLevels } from './prepare.ts';
import type { PreparedPart, PreparedTrack, StemLevels } from './prepare.ts';
import { nextBarTime, nextBeatTime, secondsPerBeat, secondsPerStep, stepTime } from './timing.ts';
import { STINGERS, TRACKS } from './tracks.ts';
import { STEM_IDS } from './types.ts';
import type { MusicTrackId, StemId, StingerId } from './types.ts';

/** Seconds of audio scheduled ahead of the clock. */
export const LOOKAHEAD = 0.12;
/** Scheduler wake interval (ms). */
export const TICK_MS = 25;
/** Layer fade time constant once a bar-quantised change lands. */
const LAYER_TC = 0.45;

/** Options for {@link MusicSystem.play}. */
export interface PlayTrackOptions {
  /** Crossfade seconds. Default 1.5. */
  fade?: number;
  /** Where the new track starts: next bar of the old one (default), next beat, or ASAP. */
  quantize?: 'bar' | 'beat' | 'now';
}

/** Playback position for UIs. */
export interface MusicPosition {
  track: MusicTrackId | null;
  bar: number;
  beat: number;
  bpm: number;
}

const prepared = new Map<MusicTrackId, PreparedTrack>();

/**
 * @param id - Track id.
 * @returns The compiled track (cached).
 */
export function getPreparedTrack(id: MusicTrackId): PreparedTrack {
  let p = prepared.get(id);
  if (!p) {
    p = prepareTrack(TRACKS[id]);
    prepared.set(id, p);
  }
  return p;
}

/** One playing track instance. */
class TrackPlayer {
  readonly out: GainNode;
  readonly stepDur: number;
  readonly bpm: number;
  private readonly stems: Record<StemId, GainNode>;
  private readonly synths: Record<StemId, SynthContext>;
  private readonly fns: InstrumentFn[];
  private readonly drumFlags: boolean[];
  private nextStep = 0;
  private nextTime: number;
  private stopAt = Infinity;
  private readonly swing: number;
  private readonly intro: number;
  /** Stems whose target level is audible (scheduling continues while they fade in). */
  private readonly rising: Record<StemId, boolean> = { drums: true, bass: true, chords: true, lead: false, intensity: false, final: false };

  constructor(
    readonly track: PreparedTrack,
    private readonly ctx: AudioContext,
    dest: AudioNode,
    reverbIn: AudioNode,
    readonly origin: number,
    rng: Rng,
  ) {
    const def = track.def;
    this.bpm = def.bpm;
    this.stepDur = secondsPerStep(def.bpm);
    this.swing = def.swing ?? 0;
    this.intro = def.introBars ?? 0;
    this.nextTime = origin;
    this.out = ctx.createGain();
    this.out.connect(dest);
    const send = ctx.createGain();
    send.gain.value = def.reverb ?? 0.2;
    this.out.connect(send).connect(reverbIn);
    const stems = {} as Record<StemId, GainNode>;
    const synths = {} as Record<StemId, SynthContext>;
    for (const id of STEM_IDS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      stems[id] = g;
      synths[id] = { ctx, out: g, rng };
    }
    this.stems = stems;
    this.synths = synths;
    this.fns = track.parts.map((p) => INSTRUMENTS[p.def.instrument]);
    this.drumFlags = track.parts.map((p) => isDrum(p.def.instrument));
  }

  get barDur(): number {
    return this.stepDur * this.track.stepsPerBar;
  }

  nextBar(now: number): number {
    return nextBarTime(this.origin, now, this.bpm, this.track.def.beatsPerBar);
  }

  nextBeat(now: number): number {
    return nextBeatTime(this.origin, now, this.bpm);
  }

  setLevels(levels: StemLevels, at: number, immediate: boolean): void {
    for (const id of STEM_IDS) {
      const g = this.stems[id].gain;
      if (immediate) {
        g.cancelScheduledValues(at);
        g.setValueAtTime(levels[id], at);
      } else g.setTargetAtTime(levels[id], at, LAYER_TC);
    }
  }

  /** True while at least one more step will be scheduled. */
  get alive(): boolean {
    return this.nextTime < this.stopAt;
  }

  /** Time the fade-out completes (Infinity while playing). */
  get endTime(): number {
    return this.stopAt;
  }

  fadeOut(at: number, dur: number): void {
    const g = this.out.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(0, at + dur);
    this.stopAt = at + dur;
  }

  fadeIn(at: number, dur: number): void {
    const g = this.out.gain;
    g.setValueAtTime(0, this.ctx.currentTime);
    g.setValueAtTime(0, at);
    g.linearRampToValueAtTime(1, at + dur);
  }

  /** Schedules every step before `until`. Allocation-free apart from the nodes instruments create. */
  schedule(until: number): void {
    const { track, stepDur } = this;
    const spb = track.stepsPerBar;
    const parts = track.parts;
    while (this.nextTime < until && this.nextTime < this.stopAt) {
      const step = this.nextStep;
      const t = this.nextTime;
      const bar = Math.floor(step / spb);
      const inBar = step - bar * spb;
      const inIntro = bar < this.intro;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i] as PreparedPart;
        if (inIntro && part.stem !== 'drums' && part.stem !== 'bass') continue;
        // Skip layers that are silent and staying silent: saves building nodes nobody hears.
        if (!this.rising[part.stem] && this.stems[part.stem].gain.value < 0.002) continue;
        const row = part.bars[bar % part.bars.length];
        const note = row?.[inBar];
        if (!note) continue;
        const fn = this.fns[i] as InstrumentFn;
        const vel = note.vel * (part.def.gain ?? 1);
        const dur = note.len * stepDur * (part.def.legato ?? 0.9);
        const s = this.synths[part.stem];
        if (this.drumFlags[i]) fn(s, t, 0, dur, vel);
        else for (let n = 0; n < note.midi.length; n++) fn(s, t, note.midi[n] as number, dur, vel);
      }
      this.nextStep = step + 1;
      this.nextTime = stepTime(this.origin, this.nextStep, stepDur, this.swing);
    }
  }

  markRising(levels: StemLevels): void {
    for (const id of STEM_IDS) this.rising[id] = levels[id] > 0.002;
  }

  position(now: number): { bar: number; beat: number } {
    const beatDur = secondsPerBeat(this.bpm);
    const beats = Math.max(0, Math.floor((now - this.origin) / beatDur));
    return { bar: Math.floor(beats / this.track.def.beatsPerBar), beat: beats % this.track.def.beatsPerBar };
  }

  dispose(): void {
    this.out.disconnect();
  }
}

/**
 * Adaptive, stem-based music player.
 *
 * @example
 * const music = new MusicSystem(engine);
 * music.play('candy');
 * music.setIntensity(0.7);
 * music.setFinal30(true);
 * music.stinger('qualified');
 */
export class MusicSystem {
  private current: TrackPlayer | null = null;
  private readonly fading = new Set<TrackPlayer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intensity = 0.5;
  private final30 = false;
  private readonly levels: StemLevels = createStemLevels();
  private reverbIn: GainNode | null = null;
  private loopBus: GainNode | null = null;
  private stingerBus: GainNode | null = null;
  private stingerSynth: SynthContext | null = null;
  private pendingTrack: { id: MusicTrackId; opts: PlayTrackOptions } | null = null;
  private readonly rng = new Rng(0x7ab1e);
  private unsubscribeUnlock: (() => void) | null = null;

  /**
   * @param engine - Audio engine (music plays on its `music` bus).
   */
  constructor(private readonly engine: AudioEngine) {}

  /** Currently playing (or queued until unlock) track. */
  get currentTrack(): MusicTrackId | null {
    return this.current?.track.def.id ?? this.pendingTrack?.id ?? null;
  }

  /** Current intensity 0..1. */
  get currentIntensity(): number {
    return this.intensity;
  }

  /** Final-30 flag. */
  get isFinal30(): boolean {
    return this.final30;
  }

  private ensureGraph(ctx: AudioContext): void {
    if (this.loopBus) return;
    const music = this.engine.bus('music');
    this.loopBus = ctx.createGain();
    this.loopBus.connect(music);
    this.stingerBus = ctx.createGain();
    this.stingerBus.connect(music);
    this.reverbIn = ctx.createGain();
    const conv = ctx.createConvolver();
    conv.buffer = impulseResponse(ctx, 2.2, 3.5);
    const ret = ctx.createGain();
    ret.gain.value = 0.6;
    this.reverbIn.connect(conv).connect(ret).connect(music);
    const stingerVerb = ctx.createGain();
    stingerVerb.gain.value = 0.25;
    this.stingerBus.connect(stingerVerb).connect(this.reverbIn);
    this.stingerSynth = { ctx, out: this.stingerBus, rng: this.rng };
  }

  /**
   * Plays a track, crossfading from the current one on its next bar line.
   * Before audio is unlocked the request is remembered and starts on unlock.
   *
   * @param id - Track id.
   * @param opts - Fade length and quantisation.
   */
  play(id: MusicTrackId, opts: PlayTrackOptions = {}): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.engine.isUnlocked) {
      this.pendingTrack = { id, opts };
      this.unsubscribeUnlock ??= this.engine.onUnlock(() => {
        this.unsubscribeUnlock = null;
        const p = this.pendingTrack;
        this.pendingTrack = null;
        if (p) this.play(p.id, p.opts);
      });
      return;
    }
    if (this.current && this.current.track.def.id === id) return;
    this.ensureGraph(ctx);
    const now = ctx.currentTime;
    const fade = opts.fade ?? 1.5;
    const q = opts.quantize ?? 'bar';
    const old = this.current;
    let start = now + 0.06;
    if (old && q === 'bar') start = old.nextBar(now + 0.05);
    else if (old && q === 'beat') start = old.nextBeat(now + 0.05);
    const player = new TrackPlayer(getPreparedTrack(id), ctx, this.loopBus as GainNode, this.reverbIn as GainNode, start, this.rng);
    stemLevels(this.intensity, this.final30, this.levels);
    player.setLevels(this.levels, start, true);
    player.markRising(this.levels);
    if (old) {
      old.fadeOut(start, fade);
      this.fading.add(old);
      player.fadeIn(start, Math.min(fade, 0.6));
    } else player.fadeIn(start, 0.05);
    this.current = player;
    this.startTimer();
  }

  /**
   * Fades the music out.
   *
   * @param fade - Seconds.
   */
  stop(fade = 1.5): void {
    this.pendingTrack = null;
    const ctx = this.engine.ctx;
    if (!ctx || !this.current) return;
    this.current.fadeOut(ctx.currentTime, fade);
    this.fading.add(this.current);
    this.current = null;
  }

  /**
   * Sets game intensity; layers move on the next bar line.
   *
   * @param value - 0 (calm) .. 1 (chaos).
   */
  setIntensity(value: number): void {
    const v = Math.min(1, Math.max(0, value));
    if (Math.abs(v - this.intensity) < 0.01) return;
    this.intensity = v;
    this.applyLevels();
  }

  /**
   * Toggles the final-30-seconds layer (bar-quantised).
   *
   * @param on - Final 30 seconds active.
   */
  setFinal30(on: boolean): void {
    if (on === this.final30) return;
    this.final30 = on;
    this.applyLevels();
  }

  private applyLevels(): void {
    const ctx = this.engine.ctx;
    const p = this.current;
    if (!ctx || !p) return;
    stemLevels(this.intensity, this.final30, this.levels);
    const at = p.nextBar(ctx.currentTime + 0.02);
    p.setLevels(this.levels, at, false);
    p.markRising(this.levels);
  }

  /**
   * Plays a stinger on the next beat of the current track (in its key and
   * tempo), briefly ducking the loop.
   *
   * @param id - Stinger id.
   */
  stinger(id: StingerId): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.engine.isUnlocked) return;
    this.ensureGraph(ctx);
    const def = STINGERS[id];
    const p = this.current;
    const now = ctx.currentTime;
    const bpm = p?.bpm ?? 120;
    const root = p?.track.keyMidi ?? 60;
    const beat = secondsPerBeat(bpm);
    const t = p ? p.nextBeat(now + 0.03) : now + 0.03;
    const s = this.stingerSynth as SynthContext;
    // Keep stingers in a bright register regardless of the track's key octave.
    const base = root < 60 ? root + 12 : root;
    for (const [off, semis, beats, vel, inst] of def.notes) {
      INSTRUMENTS[inst](s, t + off * beat, isDrum(inst) ? 0 : base + semis, beats * beat, vel);
    }
    const loop = this.loopBus as GainNode;
    if (def.duck > 0) {
      loop.gain.setTargetAtTime(1 - def.duck, t - 0.02, 0.03);
      loop.gain.setTargetAtTime(1, t + def.beats * beat, 0.35);
    }
    this.startTimer();
  }

  /** @returns Bar/beat position (allocates; for UIs, not hot paths). */
  position(): MusicPosition {
    const ctx = this.engine.ctx;
    const p = this.current;
    if (!ctx || !p) return { track: this.currentTrack, bar: 0, beat: 0, bpm: 0 };
    const pos = p.position(ctx.currentTime);
    return { track: p.track.def.id, bar: pos.bar, beat: pos.beat, bpm: p.bpm };
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    if (!ctx) return;
    const until = ctx.currentTime + LOOKAHEAD;
    this.current?.schedule(until);
    for (const f of this.fading) {
      f.schedule(until);
      // Leave room for release tails and reverb before disconnecting.
      if (!f.alive && ctx.currentTime > f.endTime + 2) {
        f.dispose();
        this.fading.delete(f);
      }
    }
    if (!this.current && this.fading.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Stops everything and releases nodes. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current?.dispose();
    for (const f of this.fading) f.dispose();
    this.fading.clear();
    this.current = null;
    this.unsubscribeUnlock?.();
  }
}
