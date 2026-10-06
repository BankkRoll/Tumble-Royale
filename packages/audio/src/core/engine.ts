/**
 * The Web Audio engine: context lifecycle, bus graph, settings, ducking,
 * 3D listener, pooled spatial SFX voices and looping spatial emitters.
 *
 * Graph:
 * ```
 *  music ─ duck ─┐
 *  sfx ──────────┤
 *  voice ────────┼─ master ─ limiter ─ visibility ─ [mono downmix] ─ destination
 *  ui ───────────┘
 * ```
 *
 * Responsibilities:
 * - lazy AudioContext + unlock on first user gesture (autoplay policies)
 * - per-bus volumes, mute, mono, mute-when-hidden (suspends the context)
 * - announcer ducking of the music bus (ref-counted)
 * - 32-voice SFX limit with priority + distance-aware stealing
 * - HRTF panning on desktop, equal-power on mobile
 * - emitter virtualisation: far-away loops release their nodes
 */

import type { Vec3 } from '@tumble/shared';
import { SfxBank } from '../sfx/bank.ts';
import type { SfxDef } from '../sfx/types.ts';
import { VoicePool, VoicePriority, inverseDistanceGain } from './voicePool.ts';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Mixer buses. */
export type BusName = 'master' | 'music' | 'sfx' | 'voice' | 'ui';

/** User-facing audio settings (the Settings → Audio screen). */
export interface AudioSettings {
  /** 0..1 per bus. */
  master: number;
  music: number;
  sfx: number;
  voice: number;
  ui: number;
  /** Global mute. */
  muted: boolean;
  /** Downmix to mono (accessibility: single-sided hearing). */
  monoAudio: boolean;
  /** Fade out and suspend the context while the tab is hidden. */
  muteWhenHidden: boolean;
}

/** Defaults tuned so music sits under SFX and the announcer. */
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = {
  master: 0.9,
  music: 0.55,
  sfx: 0.85,
  voice: 1,
  ui: 0.7,
  muted: false,
  monoAudio: false,
  muteWhenHidden: true,
};

/** Construction options. */
export interface AudioEngineOptions {
  /** Max simultaneous SFX-bus voices. Default 32. */
  maxVoices?: number;
  /** Spatialisation model; `auto` = HRTF on desktop, equal-power on mobile. */
  panningModel?: 'auto' | PanningModelType;
  /** Override context creation (tests, custom sample rates). */
  createContext?: () => AudioContext;
  /** Initial settings. */
  settings?: Partial<AudioSettings>;
}

/** Options for {@link AudioEngine.play}. */
export interface PlayOptions {
  /** World position; omit for a non-spatial (2D) sound. */
  pos?: Vec3 | null;
  /** Volume multiplier on top of the sound's own gain. */
  volume?: number;
  /** Pitch offset in semitones (added to the random variance). */
  pitch?: number;
  /** Priority override (default: the sound's). */
  priority?: number;
  /** Seconds from now. */
  delay?: number;
  /** Disable random pitch/volume variance (lab, deterministic cues). */
  noVariance?: boolean;
  /** Stereo pan -1..1 for non-spatial sounds. */
  pan?: number;
}

/** Control over a playing one-shot. */
export interface VoiceHandle {
  /** Fades out and stops. */
  stop(fade?: number): void;
}

/** Options for {@link AudioEngine.createEmitter}. */
export interface EmitterOptions {
  /** Start position; `null` for a 2D loop (e.g. the local player's slide). */
  pos?: Vec3 | null;
  volume?: number;
  /** Playback rate (pitch + speed), e.g. spinwheel speed. */
  rate?: number;
  /** Beyond this distance the emitter releases its nodes. Default 45 m. */
  maxDistance?: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const ROLLOFF = 1.1;
const MAX_DISTANCE = 90;
/** Below this estimated loudness a sound isn't worth a voice. */
const MIN_AUDIBILITY = 0.015;
/** Pending (still rendering) sounds older than this are dropped rather than played late. */
const MAX_LATE_START = 0.15;
const DUCK_LEVEL = 0.32;
const STEAL_FADE = 0.015;
/** Idle spatial chains kept for reuse (a burst beyond this many is rare and just rebuilt). */
const MAX_IDLE_CHAINS = 48;

/** A reusable gain → panner pair feeding the SFX bus. */
interface SpatialChain {
  context: AudioContext;
  gain: GainNode;
  panner: PannerNode;
}
/** Squared distance (m²) within which two plays of a sound count as the same emitter for the retrigger guard. */
const SAME_EMITTER_DIST2 = 1.5 * 1.5;

/** @returns true on phones/tablets, where HRTF is too expensive for 32 voices. */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // iPadOS reports as Macintosh; touch points give it away.
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function setParam(param: AudioParam, value: number, now: number, tc = 0.015): void {
  param.setTargetAtTime(value, now, tc);
}

function placePanner(p: PannerNode, x: number, y: number, z: number, now: number, smooth: boolean): void {
  if (p.positionX) {
    if (smooth) {
      setParam(p.positionX, x, now, 0.03);
      setParam(p.positionY, y, now, 0.03);
      setParam(p.positionZ, z, now, 0.03);
    } else {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    }
  } else {
    // COMPAT: older Firefox/Safari lack the AudioParam position API.
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

/**
 * Owns the AudioContext and mixer. One per page.
 *
 * @example
 * const engine = new AudioEngine();
 * engine.installUnlockHandlers();
 * engine.sfx.prewarm();
 * engine.play('jump', { pos: player.pos });
 */
export class AudioEngine {
  /** Procedural sound bank (renders before unlock is fine). */
  readonly sfx: SfxBank;
  /** True on phones/tablets. */
  readonly mobile: boolean;

  private context: AudioContext | null = null;
  private readonly opts: AudioEngineOptions;
  private settings: AudioSettings;
  private buses: Record<BusName, GainNode> | null = null;
  private duckNode: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private visibility: GainNode | null = null;
  private monoNode: GainNode | null = null;
  private readonly pool: VoicePool;
  private readonly panningModel: PanningModelType;
  private readonly lastPlayed = new Map<
    string,
    { t: number; x: number; y: number; z: number; spatial: boolean }
  >();
  private readonly emitters = new Set<LoopEmitter>();
  /** Idle gain → panner chains of finished spatial voices, still connected to the SFX bus. */
  private readonly spatialChains: SpatialChain[] = [];
  private readonly unlockListeners = new Set<() => void>();
  private duckCount = 0;
  private unlocked = false;
  private hidden = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => void) | null = null;
  /** Listener position mirror for culling/audibility (AudioParams are write-mostly). */
  readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * @param opts - Engine options.
   */
  constructor(opts: AudioEngineOptions = {}) {
    this.opts = opts;
    this.settings = { ...DEFAULT_AUDIO_SETTINGS, ...opts.settings };
    this.mobile = isMobileDevice();
    const pm = opts.panningModel ?? 'auto';
    this.panningModel = pm === 'auto' ? (this.mobile ? 'equalpower' : 'HRTF') : pm;
    this.pool = new VoicePool(opts.maxVoices ?? 32);
    this.sfx = new SfxBank(() => this.context?.sampleRate ?? 48000);
  }

  // ---------------------------------------------------------------------------
  // Context lifecycle
  // ---------------------------------------------------------------------------

  /** The context if created, else null. Never creates one. */
  get ctx(): AudioContext | null {
    return this.context;
  }

  /** True once a user gesture has resumed the context. */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Current audio-clock time (0 before the context exists). */
  get now(): number {
    return this.context?.currentTime ?? 0;
  }

  /** Number of SFX voices currently playing. */
  get activeVoices(): number {
    return this.pool.active;
  }

  /** Voice limit. */
  get maxVoices(): number {
    return this.pool.capacity;
  }

  /** Number of looping emitters that currently hold real nodes. */
  get audibleEmitters(): number {
    let n = 0;
    for (const e of this.emitters) if (e.isRealised) n++;
    return n;
  }

  /**
   * Creates the context and bus graph if needed. It stays suspended until
   * {@link unlock} runs inside a user gesture.
   *
   * @returns The AudioContext.
   */
  ensureContext(): AudioContext {
    if (this.context) return this.context;
    const ctx = this.opts.createContext
      ? this.opts.createContext()
      : new AudioContext({ latencyHint: 'interactive' });
    this.context = ctx;
    this.buildGraph(ctx);
    this.watchVisibility();
    return ctx;
  }

  /**
   * Resumes the context. Must be called from a user gesture handler on iOS/Chrome.
   *
   * @returns true if audio is running.
   */
  async unlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') {
      // iOS only unlocks if something actually starts inside the gesture.
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.connect(ctx.destination);
      src.start(0);
      try {
        await ctx.resume();
      } catch {
        return false;
      }
    }
    const ok = (ctx.state as AudioContextState) === 'running';
    if (ok && !this.unlocked) {
      this.unlocked = true;
      for (const cb of this.unlockListeners) cb();
    }
    return ok;
  }

  /**
   * Unlocks on the first pointer/key/touch gesture anywhere on `target`.
   *
   * @param target - Event target (default `window`).
   * @returns Disposer that removes the listeners.
   */
  installUnlockHandlers(target: EventTarget = window): () => void {
    const events = ['pointerdown', 'keydown', 'touchend', 'mousedown'];
    const handler = (): void => {
      void this.unlock().then((ok) => {
        if (ok) remove();
      });
    };
    const remove = (): void => {
      for (const e of events) target.removeEventListener(e, handler, true);
    };
    for (const e of events) target.addEventListener(e, handler, true);
    return remove;
  }

  /**
   * @param cb - Called once audio is unlocked (immediately if it already is).
   * @returns Unsubscribe function.
   */
  onUnlock(cb: () => void): () => void {
    if (this.unlocked) cb();
    else this.unlockListeners.add(cb);
    return () => this.unlockListeners.delete(cb);
  }

  private buildGraph(ctx: AudioContext): void {
    const mk = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const master = mk(1);
    const music = mk(1);
    const sfx = mk(1);
    const voice = mk(1);
    const ui = mk(1);
    this.duckNode = mk(1);
    music.connect(this.duckNode).connect(master);
    sfx.connect(master);
    voice.connect(master);
    ui.connect(master);
    // A fast, high-ratio compressor acting as a safety limiter: 40 players can stack a lot of transients.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -9;
    lim.knee.value = 6;
    lim.ratio.value = 14;
    lim.attack.value = 0.003;
    lim.release.value = 0.2;
    this.limiter = lim;
    this.visibility = mk(1);
    this.monoNode = ctx.createGain();
    this.monoNode.channelCount = 1;
    this.monoNode.channelCountMode = 'explicit';
    this.monoNode.channelInterpretation = 'speakers';
    master.connect(lim).connect(this.visibility);
    this.monoNode.connect(ctx.destination);
    this.buses = { master, music, sfx, voice, ui };
    this.routeOutput();
    this.applyVolumes(true);
  }

  private routeOutput(): void {
    const ctx = this.context;
    if (!ctx || !this.visibility || !this.monoNode) return;
    this.visibility.disconnect();
    this.visibility.connect(this.settings.monoAudio ? this.monoNode : ctx.destination);
  }

  private watchVisibility(): void {
    if (typeof document === 'undefined' || this.visibilityHandler) return;
    this.visibilityHandler = () => this.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    const ctx = this.context;
    if (!ctx || !this.visibility) return;
    const now = ctx.currentTime;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    if (hidden && this.settings.muteWhenHidden) {
      setParam(this.visibility.gain, 0, now, 0.05);
      // Suspending stops the audio thread entirely, saving battery; the fade above avoids a click.
      this.suspendTimer = setTimeout(() => void ctx.suspend(), 300);
    } else {
      if (this.unlocked && ctx.state === 'suspended') void ctx.resume();
      setParam(this.visibility.gain, 1, now, 0.05);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings & mixing
  // ---------------------------------------------------------------------------

  /** @returns A copy of the current settings. */
  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /**
   * Applies a partial settings update (volumes are clamped to 0..1).
   *
   * @param patch - Fields to change.
   */
  applySettings(patch: Partial<AudioSettings>): void {
    const monoBefore = this.settings.monoAudio;
    this.settings = { ...this.settings, ...patch };
    for (const k of ['master', 'music', 'sfx', 'voice', 'ui'] as const)
      this.settings[k] = clamp01(this.settings[k]);
    if (monoBefore !== this.settings.monoAudio) this.routeOutput();
    this.applyVolumes(false);
    if (patch.muteWhenHidden !== undefined) this.setHidden(this.hidden);
  }

  /**
   * @param bus - Bus to change.
   * @param volume - 0..1.
   */
  setVolume(bus: BusName, volume: number): void {
    this.applySettings({ [bus]: volume });
  }

  /** @param muted - Global mute. */
  setMuted(muted: boolean): void {
    this.applySettings({ muted });
  }

  /** @param mono - Downmix to mono. */
  setMonoAudio(mono: boolean): void {
    this.applySettings({ monoAudio: mono });
  }

  private applyVolumes(immediate: boolean): void {
    const b = this.buses;
    const ctx = this.context;
    if (!b || !ctx) return;
    const st = this.settings;
    // Perceptual (squared) taper so a 50% slider sounds like half as loud.
    const v = (x: number): number => x * x;
    const targets: Record<BusName, number> = {
      master: st.muted ? 0 : v(st.master),
      music: v(st.music),
      sfx: v(st.sfx),
      voice: v(st.voice),
      ui: v(st.ui),
    };
    for (const k of Object.keys(targets) as BusName[]) {
      if (immediate) b[k].gain.value = targets[k];
      else setParam(b[k].gain, targets[k], ctx.currentTime, 0.03);
    }
  }

  /**
   * Bus input node. Creates the context if needed.
   *
   * @param name - Bus.
   * @returns GainNode to connect sources to.
   */
  bus(name: BusName): GainNode {
    this.ensureContext();
    return (this.buses as Record<BusName, GainNode>)[name];
  }

  /**
   * Ducks the music bus (ref-counted, so overlapping announcer lines are safe).
   *
   * @param active - true to push a duck, false to release one.
   */
  duckMusic(active: boolean): void {
    this.duckCount = Math.max(0, this.duckCount + (active ? 1 : -1));
    const ctx = this.context;
    if (!ctx || !this.duckNode) return;
    const ducked = this.duckCount > 0;
    // Fast attack, slow release: classic broadcast sidechain feel.
    setParam(this.duckNode.gain, ducked ? DUCK_LEVEL : 1, ctx.currentTime, ducked ? 0.04 : 0.35);
  }

  /** True while the music is ducked. */
  get isDucked(): boolean {
    return this.duckCount > 0;
  }

  // ---------------------------------------------------------------------------
  // Listener
  // ---------------------------------------------------------------------------

  /**
   * Places the listener (call every frame from the camera).
   *
   * @param pos - Camera/listener position.
   * @param forward - Unit forward vector.
   * @param up - Unit up vector.
   */
  setListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    const ctx = this.context;
    if (!ctx) return;
    const l = ctx.listener;
    const now = ctx.currentTime;
    if (l.positionX) {
      setParam(l.positionX, pos.x, now);
      setParam(l.positionY, pos.y, now);
      setParam(l.positionZ, pos.z, now);
      setParam(l.forwardX, forward.x, now);
      setParam(l.forwardY, forward.y, now);
      setParam(l.forwardZ, forward.z, now);
      setParam(l.upX, up.x, now);
      setParam(l.upY, up.y, now);
      setParam(l.upZ, up.z, now);
    } else {
      // COMPAT: Firefox and older Safari only implement the deprecated setters.
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(pos.x, pos.y, pos.z);
      legacy.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /**
   * Distance from the listener.
   *
   * @param p - World position.
   * @returns Metres.
   */
  distanceTo(p: Vec3): number {
    const dx = p.x - this.listenerPos.x;
    const dy = p.y - this.listenerPos.y;
    const dz = p.z - this.listenerPos.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /** @internal Creates a configured PannerNode. */
  createPanner(refDistance: number, maxDistance = MAX_DISTANCE): PannerNode {
    const ctx = this.ensureContext();
    const p = ctx.createPanner();
    p.panningModel = this.panningModel;
    p.distanceModel = 'inverse';
    p.refDistance = refDistance;
    p.maxDistance = maxDistance;
    p.rolloffFactor = ROLLOFF;
    return p;
  }

  /**
   * An idle gain → panner chain for a spatial one-shot (created on demand).
   *
   * PERF: one-shots built a fresh HRTF PannerNode per sound. With 100
   * Tumblers jumping, landing and bumping that was dozens of node graphs a
   * second, 2.6% of main-thread time in a CPU profile, plus garbage.
   */
  private takeSpatialChain(ctx: AudioContext, refDistance: number): SpatialChain {
    const chain = this.spatialChains.pop();
    if (chain && chain.context === ctx) {
      chain.panner.refDistance = refDistance;
      return chain;
    }
    const gain = ctx.createGain();
    const panner = this.createPanner(refDistance);
    gain.connect(panner);
    panner.connect(this.bus('sfx'));
    return { context: ctx, gain, panner };
  }

  private releaseSpatialChain(ctx: AudioContext, chain: SpatialChain): void {
    if (this.context !== ctx || this.spatialChains.length >= MAX_IDLE_CHAINS) {
      chain.panner.disconnect();
      return;
    }
    chain.gain.gain.cancelScheduledValues(0);
    chain.gain.gain.value = 0;
    this.spatialChains.push(chain);
  }

  // ---------------------------------------------------------------------------
  // One-shots
  // ---------------------------------------------------------------------------

  /**
   * Plays a sound from the bank.
   *
   * @param name - Sound name (see `SFX_NAMES`).
   * @param opts - Position, volume, pitch, priority, delay.
   * @returns A handle, or null if dropped (unknown, cooling down, inaudible, voice-limited, locked).
   */
  play(name: string, opts: PlayOptions = {}): VoiceHandle | null {
    const def = this.sfx.def(name);
    if (!def) return null;
    const ctx = this.context;
    if (!ctx || !this.unlocked) return null;
    const now = ctx.currentTime;
    const last = def.cooldownMs ? this.lastPlayed.get(name) : undefined;
    if (last && now - last.t < (def.cooldownMs as number) / 1000) {
      // The retrigger guard is per emitter: only repeats from (roughly) the same spot are spam.
      const p = opts.pos;
      if (
        !p ||
        !last.spatial ||
        (p.x - last.x) ** 2 + (p.y - last.y) ** 2 + (p.z - last.z) ** 2 < SAME_EMITTER_DIST2
      )
        return null;
    }
    const spatial = (def.bus ?? 'sfx') === 'sfx' && opts.pos != null;
    let volume = (def.gain ?? 1) * (opts.volume ?? 1);
    let audibility = volume;
    if (spatial && opts.pos) {
      audibility *= inverseDistanceGain(this.distanceTo(opts.pos), def.refDistance ?? 4, ROLLOFF);
      if (audibility < MIN_AUDIBILITY) return null;
    }
    const buffer = this.sfx.get(name);
    if (!buffer) {
      const requested = now;
      // Callers may reuse their options object, so snapshot it for the deferred play.
      const deferred: PlayOptions = { ...opts };
      void this.sfx.load(name).then(() => {
        const c = this.context;
        if (c && c.currentTime - requested <= MAX_LATE_START) this.play(name, deferred);
      });
      return null;
    }
    const variance = !opts.noVariance;
    const pitchVar = def.pitchVar ?? 1;
    const volVar = def.volVar ?? 0.15;
    const semis = (opts.pitch ?? 0) + (variance ? (Math.random() * 2 - 1) * pitchVar : 0);
    if (variance) volume *= 1 + (Math.random() * 2 - 1) * volVar;
    if (def.cooldownMs) {
      let rec = this.lastPlayed.get(name);
      if (!rec) {
        rec = { t: 0, x: 0, y: 0, z: 0, spatial: false };
        this.lastPlayed.set(name, rec);
      }
      rec.t = now;
      rec.spatial = opts.pos != null;
      if (opts.pos) {
        rec.x = opts.pos.x;
        rec.y = opts.pos.y;
        rec.z = opts.pos.z;
      }
    }
    return this.startVoice(ctx, def, buffer, volume, semis, audibility, opts);
  }

  private startVoice(
    ctx: AudioContext,
    def: SfxDef,
    buffer: AudioBuffer,
    volume: number,
    semis: number,
    audibility: number,
    opts: PlayOptions,
  ): VoiceHandle | null {
    const busName = def.bus ?? 'sfx';
    const pooled = busName === 'sfx';
    const now = ctx.currentTime;
    let slot = -1;
    let id = 0;
    if (pooled) {
      const acq = this.pool.acquire(
        opts.priority ?? def.priority ?? VoicePriority.Normal,
        Math.min(1, audibility),
        now,
      );
      if (acq.slot < 0) return null;
      slot = acq.slot;
      id = acq.id;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, semis / 12);
    let g: GainNode;
    let tail: AudioNode;
    let chain: SpatialChain | null = null;
    if (busName === 'sfx' && opts.pos) {
      chain = this.takeSpatialChain(ctx, def.refDistance ?? 4);
      g = chain.gain;
      g.gain.cancelScheduledValues(0);
      g.gain.value = volume;
      placePanner(chain.panner, opts.pos.x, opts.pos.y, opts.pos.z, now, false);
      tail = chain.panner;
    } else {
      g = ctx.createGain();
      g.gain.value = volume;
      tail = g;
      if (opts.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
        const sp = ctx.createStereoPanner();
        sp.pan.value = opts.pan;
        g.connect(sp);
        tail = sp;
      }
      tail.connect(this.bus(busName));
    }
    src.connect(g);
    const start = now + (opts.delay ?? 0);
    src.start(start);
    let stopped = false;
    const stop = (fade = STEAL_FADE): void => {
      if (stopped) return;
      stopped = true;
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + fade);
      try {
        src.stop(t + fade + 0.01);
      } catch {
        // Already stopped.
      }
    };
    src.onended = () => {
      stopped = true;
      if (pooled) this.pool.release(slot, id);
      src.disconnect();
      if (chain) this.releaseSpatialChain(ctx, chain);
      else tail.disconnect();
    };
    if (pooled) (this.pool.slots[slot] as { stop: (() => void) | null }).stop = () => stop();
    return { stop };
  }

  /**
   * Plays a sound at the listener (2D), bypassing distance logic.
   *
   * @param name - Sound name.
   * @param volume - Volume multiplier.
   * @returns Handle or null.
   */
  play2D(name: string, volume = 1): VoiceHandle | null {
    return this.play(name, { volume });
  }

  /** Stops every pooled SFX voice (e.g. on round teardown). */
  stopAllVoices(): void {
    this.pool.stopAll();
  }

  // ---------------------------------------------------------------------------
  // Emitters
  // ---------------------------------------------------------------------------

  /**
   * Creates a looping (optionally spatial) emitter for an obstacle or a long
   * player action (belly slide). Starts stopped; call `start()`.
   *
   * @param name - A loop sound (e.g. `spinwheel.loop`).
   * @param opts - Position, volume, rate, cull distance.
   * @returns The emitter.
   */
  createEmitter(name: string, opts: EmitterOptions = {}): LoopEmitter {
    const e = new LoopEmitter(this, name, opts);
    this.emitters.add(e);
    return e;
  }

  /** @internal */
  removeEmitter(e: LoopEmitter): void {
    this.emitters.delete(e);
  }

  /**
   * Per-frame housekeeping: realises/virtualises emitters by distance. Cheap;
   * call from the render loop.
   */
  update(): void {
    if (!this.context || !this.unlocked) return;
    for (const e of this.emitters) e.refresh();
  }

  /** Closes the context and drops every node. */
  dispose(): void {
    for (const e of [...this.emitters]) e.dispose();
    this.pool.stopAll();
    if (this.visibilityHandler && typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    void this.context?.close();
    this.context = null;
    this.buses = null;
    this.spatialChains.length = 0;
    this.unlocked = false;
  }

  /** @internal Engine-level gate for emitters. */
  get canPlay(): boolean {
    return this.context !== null && this.unlocked;
  }
}

// -----------------------------------------------------------------------------
// Emitters
// -----------------------------------------------------------------------------

/**
 * A looping sound that can be started, stopped and moved. Spatial emitters
 * release their nodes beyond `maxDistance` ("virtual" voices) and pick up at a
 * random loop offset when the listener comes back, so a course with 20
 * spinwheels only pays for the few you can hear.
 */
export class LoopEmitter {
  private src: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private panner: PannerNode | null = null;
  private wanted = false;
  private disposed = false;
  private loading = false;
  private readonly pos: Vec3 | null;
  private volume: number;
  private rate: number;
  private readonly maxDistance: number;
  private readonly def: SfxDef | undefined;

  /** @internal Use {@link AudioEngine.createEmitter}. */
  constructor(
    private readonly engine: AudioEngine,
    readonly sound: string,
    opts: EmitterOptions,
  ) {
    this.def = engine.sfx.def(sound);
    this.pos = opts.pos ? { x: opts.pos.x, y: opts.pos.y, z: opts.pos.z } : null;
    this.volume = opts.volume ?? 1;
    this.rate = opts.rate ?? 1;
    this.maxDistance = opts.maxDistance ?? 45;
    if (!this.def) console.warn(`[audio] unknown emitter sound "${sound}"`);
  }

  /** True when started (even if currently virtual). */
  get playing(): boolean {
    return this.wanted;
  }

  /** True when it currently holds real audio nodes. */
  get isRealised(): boolean {
    return this.src !== null;
  }

  /** Starts (or resumes) the loop. */
  start(): void {
    if (this.disposed) return;
    this.wanted = true;
    this.refresh();
  }

  /**
   * Stops the loop.
   *
   * @param fade - Fade-out seconds.
   */
  stop(fade = 0.3): void {
    this.wanted = false;
    this.release(fade);
  }

  /**
   * Moves the emitter (allocation-free).
   *
   * @param x - World x.
   * @param y - World y.
   * @param z - World z.
   */
  setPosition(x: number, y: number, z: number): void {
    if (!this.pos) return;
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    const ctx = this.engine.ctx;
    if (this.panner && ctx) placePanner(this.panner, x, y, z, ctx.currentTime, true);
  }

  /**
   * @param volume - Volume multiplier.
   * @param ramp - Seconds (time constant) to glide.
   */
  setVolume(volume: number, ramp = 0.1): void {
    this.volume = volume;
    const ctx = this.engine.ctx;
    if (this.gainNode && ctx)
      setParam(this.gainNode.gain, volume * (this.def?.gain ?? 1), ctx.currentTime, ramp);
  }

  /**
   * @param rate - Playback rate (1 = original); e.g. map obstacle speed to whirr pitch.
   */
  setRate(rate: number): void {
    this.rate = rate;
    const ctx = this.engine.ctx;
    if (this.src && ctx) setParam(this.src.playbackRate, rate, ctx.currentTime, 0.1);
  }

  /** @internal Called by the engine each frame and on state changes. */
  refresh(): void {
    if (!this.wanted || this.disposed || !this.def || !this.engine.canPlay) return;
    const inRange = !this.pos || this.engine.distanceTo(this.pos) <= this.maxDistance;
    if (inRange && !this.src) this.realise();
    else if (!inRange && this.src) this.release(0.5);
  }

  private realise(): void {
    const ctx = this.engine.ctx;
    const def = this.def;
    if (!ctx || !def) return;
    const buffer = this.engine.sfx.get(this.sound);
    if (!buffer) {
      if (!this.loading) {
        this.loading = true;
        void this.engine.sfx.load(this.sound).then(() => {
          this.loading = false;
          this.refresh();
        });
      }
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = this.rate;
    const g = ctx.createGain();
    g.gain.value = 0;
    setParam(g.gain, this.volume * (def.gain ?? 1), ctx.currentTime, 0.12);
    src.connect(g);
    let tail: AudioNode = g;
    if (this.pos) {
      const p = this.engine.createPanner(def.refDistance ?? 4, this.maxDistance);
      placePanner(p, this.pos.x, this.pos.y, this.pos.z, ctx.currentTime, false);
      g.connect(p);
      tail = p;
      this.panner = p;
    }
    tail.connect(this.engine.bus(def.bus ?? 'sfx'));
    // Random offset so identical obstacles side by side don't phase.
    src.start(ctx.currentTime, Math.random() * buffer.duration);
    this.src = src;
    this.gainNode = g;
  }

  private release(fade: number): void {
    const ctx = this.engine.ctx;
    const src = this.src;
    const g = this.gainNode;
    const p = this.panner;
    this.src = null;
    this.gainNode = null;
    this.panner = null;
    if (!src || !g || !ctx) return;
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.02);
    src.onended = () => {
      g.disconnect();
      p?.disconnect();
    };
  }

  /** Stops and unregisters the emitter. */
  dispose(): void {
    this.stop(0.05);
    this.disposed = true;
    this.engine.removeEmitter(this);
  }
}
