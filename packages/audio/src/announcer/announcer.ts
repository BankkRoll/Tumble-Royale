/**
 * The show announcer. By default it only emits captions: spoken lines are an
 * opt-in accessibility setting (`setEnabled(true)`), never on automatically.
 * When enabled it speaks through the Web Speech API with a cheerful
 * voice, ducks the music while talking, and always emits captions. When speech
 * synthesis is unavailable (or disabled, or silently broken — common on
 * Linux/Android), it falls back to a synthesized vocal "blip" babble on the
 * voice bus so lines still have presence and timing.
 */

import { Rng } from '@tumble/shared';
import type { AudioEngine } from '../core/engine.ts';
import { vocal } from '../synth/toolkit.ts';
import type { SynthContext, Vowel } from '../synth/toolkit.ts';
import { ANNOUNCER_LINES, countSyllables, estimateSpeechMs, fillLine } from './lines.ts';
import type { AnnouncerLineId, LineVars } from './lines.ts';

/** Caption callback: text to show and how long to show it. */
export type CaptionListener = (text: string, durationMs: number) => void;

/** Options for {@link Announcer}. */
export interface AnnouncerOptions {
  /** Speak lines aloud. Default false: captions only, voice is an accessibility opt-in. */
  voice?: boolean;
  /** Use Web Speech when available. Default true. */
  speech?: boolean;
  /** Speech rate (Web Speech scale). Default 1.08. */
  rate?: number;
  /** Speech pitch (0..2). Default 1.25 — bright, game-show energy. */
  pitch?: number;
  /** Seconds to wait for speech to start before falling back to blips. */
  speechTimeout?: number;
}

/** Options for a single line. */
export interface SayOptions {
  /** Higher interrupts lower. Default 1. Countdown uses 3. */
  priority?: number;
  /** Cut the current line regardless of priority. */
  interrupt?: boolean;
  /** Caption only, no audio. */
  silent?: boolean;
}

interface QueuedLine {
  text: string;
  priority: number;
}

/** Voice names (substring match) that sound upbeat, in preference order. */
const PREFERRED_VOICES = ['Google US English', 'Samantha', 'Microsoft Aria', 'Microsoft Jenny', 'Karen', 'Google UK English Female', 'Microsoft Zira', 'Tessa', 'Moira'];

const BLIP_VOWELS: readonly Vowel[] = ['a', 'e', 'o', 'i', 'aw', 'uh'];

/**
 * @returns The browser's speech synthesis, if present.
 */
function getSpeech(): SpeechSynthesis | null {
  return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined' ? globalThis.speechSynthesis : null;
}

/**
 * Announcer with captions, ducking, priority queue and a speech fallback.
 *
 * @example
 * const ann = new Announcer(engine);
 * ann.onCaption((text, ms) => hud.showCaption(text, ms));
 * ann.say('roundNumber', { n: 2 });
 */
export class Announcer {
  private readonly listeners = new Set<CaptionListener>();
  private readonly queue: QueuedLine[] = [];
  private speaking: QueuedLine | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private speechOk: boolean;
  private enabled: boolean;
  private readonly opts: Required<AnnouncerOptions>;
  private readonly rng = new Rng(0xa110);
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private ducked = false;
  private finishCurrent: (() => void) | null = null;

  /**
   * @param engine - Audio engine (voice bus + music ducking).
   * @param opts - Voice options.
   */
  constructor(
    private readonly engine: AudioEngine,
    opts: AnnouncerOptions = {},
  ) {
    this.opts = { voice: false, speech: true, rate: 1.08, pitch: 1.25, speechTimeout: 0.8, ...opts };
    this.enabled = this.opts.voice;
    this.speechOk = this.opts.speech && getSpeech() !== null;
    const sp = getSpeech();
    if (sp) {
      this.pickVoice();
      sp.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  /**
   * Subscribes to captions (fires for every line, even when muted or silent).
   *
   * @param cb - Listener.
   * @returns Unsubscribe.
   */
  onCaption(cb: CaptionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** @param on - Speak lines aloud (accessibility opt-in; captions always fire). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.cancel();
  }

  /** @param on - Prefer Web Speech (true) or always use the blip voice (false). */
  setSpeechEnabled(on: boolean): void {
    this.speechOk = on && getSpeech() !== null;
  }

  /** True when lines will be spoken with Web Speech. */
  get usesSpeech(): boolean {
    return this.speechOk;
  }

  /** Name of the chosen speech voice, if any. */
  get voiceName(): string | null {
    return this.voice?.name ?? null;
  }

  /**
   * Says a scripted line (random variant).
   *
   * @param id - Line id.
   * @param vars - Template values.
   * @param opts - Priority / interrupt / silent.
   * @returns The text spoken.
   */
  say(id: AnnouncerLineId, vars: LineVars = {}, opts: SayOptions = {}): string {
    const variants = ANNOUNCER_LINES[id];
    const text = fillLine(this.rng.pick(variants), vars);
    this.sayText(text, opts);
    return text;
  }

  /**
   * Says arbitrary text (e.g. a round name from content).
   *
   * @param text - Text.
   * @param opts - Priority / interrupt / silent.
   */
  sayText(text: string, opts: SayOptions = {}): void {
    const line: QueuedLine = { text, priority: opts.priority ?? 1 };
    if (opts.silent || !this.enabled) {
      this.emitCaption(text, estimateSpeechMs(text, this.opts.rate));
      return;
    }
    if (this.speaking && (opts.interrupt || line.priority > this.speaking.priority)) {
      this.queue.length = 0;
      this.stopCurrent();
    }
    // A backlog of stale lines is worse than silence: keep only the freshest few.
    if (this.queue.length >= 3) this.queue.shift();
    this.queue.push(line);
    if (!this.speaking) this.next();
  }

  /** Stops speaking and clears the queue. */
  cancel(): void {
    this.queue.length = 0;
    this.stopCurrent();
  }

  private emitCaption(text: string, ms: number): void {
    for (const cb of this.listeners) cb(text, ms);
  }

  private pickVoice(): void {
    const sp = getSpeech();
    if (!sp) return;
    const voices = sp.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
    if (voices.length === 0) return;
    for (const name of PREFERRED_VOICES) {
      const v = voices.find((x) => x.name.includes(name));
      if (v) {
        this.voice = v;
        return;
      }
    }
    this.voice = voices.find((v) => v.default) ?? voices[0] ?? null;
  }

  private next(): void {
    const line = this.queue.shift();
    if (!line) {
      this.speaking = null;
      this.setDuck(false);
      return;
    }
    this.speaking = line;
    const ms = estimateSpeechMs(line.text, this.opts.rate);
    this.emitCaption(line.text, ms);
    this.setDuck(true);
    let finished = false;
    const done = (): void => {
      // Cancelled utterances still fire onend/onerror later; ignore callbacks from lines that were cut.
      if (finished || this.finishCurrent !== done) {
        finished = true;
        return;
      }
      finished = true;
      if (this.doneTimer) clearTimeout(this.doneTimer);
      this.doneTimer = null;
      this.finishCurrent = null;
      this.speaking = null;
      this.next();
    };
    this.finishCurrent = done;
    if (this.speechOk) this.speak(line.text, ms, done);
    else {
      this.blip(line.text);
      this.doneTimer = setTimeout(done, ms);
    }
  }

  private speak(text: string, ms: number, done: () => void): void {
    const sp = getSpeech();
    if (!sp) {
      this.blip(text);
      this.doneTimer = setTimeout(done, ms);
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = this.opts.rate;
    u.pitch = this.opts.pitch;
    u.volume = this.voiceVolume();
    let started = false;
    u.onstart = () => {
      started = true;
    };
    u.onend = done;
    u.onerror = done;
    sp.speak(u);
    // Some platforms expose speechSynthesis but never speak (no voices installed): detect and fall back.
    setTimeout(() => {
      if (!started && this.finishCurrent === done) {
        sp.cancel();
        this.speechOk = false;
        this.blip(text);
        this.doneTimer = setTimeout(done, ms);
      }
    }, this.opts.speechTimeout * 1000);
    // Safety net: a stuck utterance must never block the queue.
    this.doneTimer = setTimeout(done, ms * 2.5 + 1500);
  }

  private voiceVolume(): number {
    const s = this.engine.getSettings();
    return s.muted ? 0 : Math.min(1, s.voice * s.master);
  }

  /** Synthesized babble: one formant syllable per estimated syllable, with a cheerful pitch contour. */
  private blip(text: string): void {
    const ctx = this.engine.ctx;
    if (!ctx || !this.engine.isUnlocked) return;
    const s: SynthContext = { ctx, out: this.engine.bus('voice'), rng: this.rng };
    const words = text.split(/\s+/).filter(Boolean);
    const exclaim = text.includes('!');
    const question = text.includes('?');
    let t = ctx.currentTime + 0.02;
    let total = 0;
    for (const w of words) total += countSyllables(w);
    let i = 0;
    for (const w of words) {
      const n = countSyllables(w);
      for (let k = 0; k < n; k++) {
        const prog = total > 1 ? i / (total - 1) : 0;
        // Excited lines rise to the end, statements fall; a little random wobble keeps it lively.
        const contour = exclaim || question ? 1 + prog * 0.35 : 1.15 - prog * 0.25;
        const f0 = 210 * contour * this.rng.range(0.94, 1.08);
        const dur = this.rng.range(0.085, 0.13);
        vocal(s, { t, dur, f0, f0End: f0 * this.rng.range(0.92, 1.1), vowel: this.rng.pick(BLIP_VOWELS), gain: 0.28, attack: 0.012, release: 0.04, formantShift: 1.15 });
        t += dur + 0.02;
        i++;
      }
      t += 0.06;
    }
  }

  private stopCurrent(): void {
    getSpeech()?.cancel();
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
    this.finishCurrent = null;
    this.speaking = null;
    this.setDuck(false);
  }

  private setDuck(on: boolean): void {
    if (on === this.ducked) return;
    this.ducked = on;
    this.engine.duckMusic(on);
  }

  /** Cancels speech and drops listeners. */
  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }
}
