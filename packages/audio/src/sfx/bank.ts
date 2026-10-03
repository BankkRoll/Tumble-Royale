/**
 * Renders procedural sound definitions into AudioBuffers once (via
 * OfflineAudioContext), caches them, and prewarms in idle time.
 *
 * Responsibilities:
 * - lazy, de-duplicated rendering per sound
 * - peak normalisation so `SfxDef.gain` is the single mixing knob
 * - seamless loop baking (equal-power crossfade of the tail into the head)
 * - idle-time prewarm queue (eager sounds first)
 *
 * Rendering does not need the live AudioContext, so the bank can warm up
 * before the first user gesture unlocks audio.
 */

import { Rng, hashString } from '@tumble/shared';
import type { SynthContext } from '../synth/toolkit.ts';
import { SFX_DEFS } from './library/index.ts';
import type { SfxDef, SfxDefs } from './types.ts';

/** Seconds rendered past a loop's period and folded back for a click-free seam. */
export const LOOP_CROSSFADE = 0.25;
/** Peak level every rendered sound is normalised to. */
const NORMALISE_PEAK = 0.8;
/**
 * RMS ceiling after peak normalisation. Dense sounds (square blips, whistles)
 * would otherwise sound far louder than transient ones at the same peak.
 */
const MAX_RMS = 0.2;

type IdleFn = (cb: () => void) => void;

const scheduleIdle: IdleFn = (cb) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(cb, { timeout: 250 });
  else setTimeout(cb, 16);
};

/**
 * Folds `xfade` samples past `period` back over the head with an equal-power
 * crossfade, then truncates to `period`. Pure; exported for tests.
 *
 * @param data - Channel samples of length ≥ period + xfade.
 * @param period - Loop period in samples.
 * @param xfade - Crossfade length in samples.
 * @returns A new array of length `period` that loops seamlessly.
 */
export function bakeLoop(data: Float32Array, period: number, xfade: number): Float32Array {
  const out = data.slice(0, period);
  const n = Math.min(xfade, data.length - period, period);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const fadeIn = Math.sin(k * Math.PI * 0.5);
    const fadeOut = Math.cos(k * Math.PI * 0.5);
    out[i] = (data[i] as number) * fadeIn + (data[period + i] as number) * fadeOut;
  }
  return out;
}

/**
 * Lazily rendered, cached procedural sound bank.
 *
 * @example
 * const bank = new SfxBank(() => 48000);
 * bank.prewarm();
 * const buf = bank.get('jump') ?? (await bank.load('jump'));
 */
export class SfxBank {
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<AudioBuffer>>();
  private prewarming = false;

  /**
   * @param sampleRate - Returns the sample rate to render at (match the live context to avoid resampling).
   * @param defs - Sound definitions; defaults to the full bank.
   */
  constructor(
    private readonly sampleRate: () => number,
    readonly defs: SfxDefs = SFX_DEFS,
  ) {}

  /** @returns true if the bank defines `name`. */
  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.defs, name);
  }

  /** @returns The definition for `name`, if any. */
  def(name: string): SfxDef | undefined {
    return this.has(name) ? this.defs[name] : undefined;
  }

  /** @returns Every sound name. */
  names(): string[] {
    return Object.keys(this.defs);
  }

  /** Number of sounds rendered so far. */
  get renderedCount(): number {
    return this.buffers.size;
  }

  /** @returns The rendered buffer, or null if not rendered yet. */
  get(name: string): AudioBuffer | null {
    return this.buffers.get(name) ?? null;
  }

  /**
   * Renders `name` if needed.
   *
   * @param name - Sound name.
   * @returns The cached buffer.
   */
  load(name: string): Promise<AudioBuffer> {
    const ready = this.buffers.get(name);
    if (ready) return Promise.resolve(ready);
    const inflight = this.pending.get(name);
    if (inflight) return inflight;
    const def = this.def(name);
    if (!def) return Promise.reject(new Error(`Unknown sound "${name}"`));
    const p = this.render(name, def).then((buf) => {
      this.buffers.set(name, buf);
      this.pending.delete(name);
      return buf;
    });
    this.pending.set(name, p);
    return p;
  }

  /**
   * Renders sounds one at a time in idle callbacks. Eager sounds (UI,
   * countdown, footsteps) go first.
   *
   * @param names - Sounds to warm; defaults to the whole bank.
   * @param onProgress - Called after each render with (done, total).
   * @returns Resolves when all are rendered.
   */
  prewarm(names?: readonly string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const list = (names ?? this.names()).filter((n) => this.has(n));
    list.sort((a, b) => Number(this.def(b)?.eager ?? false) - Number(this.def(a)?.eager ?? false));
    const total = list.length;
    let done = 0;
    this.prewarming = true;
    return new Promise((resolve) => {
      const step = (): void => {
        const name = list[done];
        if (name === undefined) {
          this.prewarming = false;
          resolve();
          return;
        }
        this.load(name)
          .catch((err: unknown) => console.warn(`[audio] failed to render "${name}"`, err))
          .finally(() => {
            done++;
            onProgress?.(done, total);
            scheduleIdle(step);
          });
      };
      scheduleIdle(step);
    });
  }

  /** True while a prewarm pass is running. */
  get isPrewarming(): boolean {
    return this.prewarming;
  }

  private async render(name: string, def: SfxDef): Promise<AudioBuffer> {
    const sampleRate = this.sampleRate();
    const channels = def.stereo ? 2 : 1;
    const len = def.duration + (def.loop ? LOOP_CROSSFADE : 0);
    const frames = Math.max(1, Math.ceil(len * sampleRate));
    const ctx = new OfflineAudioContext({ numberOfChannels: channels, length: frames, sampleRate });
    const out = ctx.createGain();
    out.connect(ctx.destination);
    const s: SynthContext = { ctx, out, rng: new Rng(hashString(name)) };
    def.render(s, len);
    const rendered = await ctx.startRendering();
    return this.finish(rendered, def, sampleRate);
  }

  private finish(rendered: AudioBuffer, def: SfxDef, sampleRate: number): AudioBuffer {
    const channels = rendered.numberOfChannels;
    const period = def.loop ? Math.max(1, Math.round(def.duration * sampleRate)) : rendered.length;
    const data: Float32Array[] = [];
    let peak = 0;
    let energy = 0;
    for (let ch = 0; ch < channels; ch++) {
      const src = rendered.getChannelData(ch);
      const d = def.loop ? bakeLoop(src, period, Math.round(LOOP_CROSSFADE * sampleRate)) : src;
      for (let i = 0; i < d.length; i++) {
        const v = d[i] as number;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        energy += v * v;
      }
      data.push(d);
    }
    let scale = peak > 1e-5 ? NORMALISE_PEAK / peak : 1;
    const rms = Math.sqrt(energy / Math.max(1, period * channels)) * scale;
    if (rms > MAX_RMS) scale *= MAX_RMS / rms;
    const out = new AudioBuffer({ numberOfChannels: channels, length: period, sampleRate });
    for (let ch = 0; ch < channels; ch++) {
      const d = data[ch] as Float32Array;
      for (let i = 0; i < d.length; i++) d[i] = (d[i] as number) * scale;
      out.copyToChannel(d as Float32Array<ArrayBuffer>, ch);
    }
    return out;
  }
}
