/**
 * Voice chat mixing: other players' WebRTC audio and the local microphone's
 * level, through the engine's graph so master volume, the limiter, mono
 * output and "mute when unfocused" all apply to voice like any other sound.
 *
 * Graph: peer stream → peer gain (per-player volume/mute) → analyser →
 * voice chat gain (voice volume, Streamer Mode silence) → master bus.
 * The microphone only feeds an analyser; it is never played back locally.
 *
 * Responsibilities:
 * - one node chain per peer with its own gain and level reading;
 * - a level meter for the local microphone (open-mic gate, settings meter);
 * - ducking the music while anyone talks, released once nobody does.
 */
import type { AudioEngine } from './engine.ts';

/** One remote player's audio. */
export interface VoiceChatPeer {
  /** Per-player volume 0..1 (0 = muted). */
  setGain(gain: number): void;
  /** Current level 0..1 (before the per-player gain, so a muted player still shows as speaking). */
  level(): number;
  dispose(): void;
}

/** A level reading of a stream that is not played. */
export interface VoiceLevelMeter {
  level(): number;
  dispose(): void;
}

/** Lowest level (dBFS) the 0..1 scale shows; quieter reads as 0. */
const FLOOR_DB = -60;

/**
 * Maps a block of samples to a 0..1 loudness: RMS in dBFS, scaled linearly
 * from {@link FLOOR_DB} (0) to 0 dBFS (1), which tracks how loud speech
 * sounds better than raw RMS does.
 *
 * @param samples - Time-domain samples in -1..1.
 * @returns Loudness 0..1.
 * @example
 * rmsLevel(new Float32Array(256).fill(0)); // 0
 */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB));
}

function analyserLevel(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): () => number {
  return () => {
    analyser.getFloatTimeDomainData(buf);
    return rmsLevel(buf);
  };
}

/**
 * Mixes voice chat into an {@link AudioEngine}.
 *
 * @example
 * const mixer = new VoiceChatMixer(engine);
 * const peer = mixer.addPeer(remoteStream);
 * peer.setGain(0.8);
 */
export class VoiceChatMixer {
  private out: GainNode | null = null;
  private volume = 1;
  private ducked = false;

  constructor(private readonly engine: AudioEngine) {}

  private output(): GainNode {
    if (!this.out) {
      const ctx = this.engine.ensureContext();
      this.out = ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(this.engine.bus('master'));
    }
    return this.out;
  }

  /**
   * Voice chat volume under master (0 silences every peer, e.g. Streamer
   * Mode's "don't play voice").
   *
   * @param volume - 0..1.
   */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.out) this.out.gain.value = this.volume;
  }

  /**
   * Starts playing a remote player.
   *
   * @param stream - The peer's remote audio stream.
   * @returns Controls for that peer.
   */
  addPeer(stream: MediaStream): VoiceChatPeer {
    const ctx = this.engine.ensureContext();
    // COMPAT: Chrome only feeds a remote WebRTC stream into Web Audio while a
    // media element is also consuming it. The element stays muted; the sound
    // comes from the graph below.
    let sink: HTMLAudioElement | null = null;
    if (typeof Audio !== 'undefined') {
      sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      void sink.play().catch(() => undefined);
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    source.connect(analyser);
    source.connect(gain).connect(this.output());
    const level = analyserLevel(analyser, new Float32Array(analyser.fftSize));
    return {
      setGain: (g) => {
        gain.gain.value = Math.min(1, Math.max(0, g));
      },
      level,
      dispose: () => {
        source.disconnect();
        gain.disconnect();
        analyser.disconnect();
        if (sink) {
          sink.pause();
          sink.srcObject = null;
        }
      },
    };
  }

  /**
   * Measures a stream without playing it (the local microphone).
   *
   * @param stream - Stream to measure.
   */
  meter(stream: MediaStream): VoiceLevelMeter {
    const ctx = this.engine.ensureContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    return {
      level: analyserLevel(analyser, new Float32Array(analyser.fftSize)),
      dispose: () => {
        source.disconnect();
        analyser.disconnect();
      },
    };
  }

  /**
   * Ducks the music while someone talks. Idempotent: holds at most one of
   * the engine's ref-counted ducks.
   *
   * @param talking - Anyone in the room is speaking.
   */
  setTalking(talking: boolean): void {
    if (talking === this.ducked) return;
    this.ducked = talking;
    this.engine.duckMusic(talking);
  }

  /** Releases the duck and the output node. */
  dispose(): void {
    this.setTalking(false);
    this.out?.disconnect();
    this.out = null;
  }
}
