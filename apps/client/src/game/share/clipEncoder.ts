/**
 * Clip encoding: picking a format the browser can produce and turning a
 * stream of composited canvas frames into a file.
 *
 * Responsibilities:
 * - format choice, best first: WebCodecs H.264 in MP4 (plays everywhere,
 *   shares to every app), WebCodecs VP9 then VP8 in WebM, and, where
 *   WebCodecs is missing, MediaRecorder on `canvas.captureStream()`;
 * - {@link WebCodecsSink}: frame-accurate timestamps, a keyframe every two
 *   seconds, back-pressure on the encoder queue, every `VideoFrame` closed
 *   at once; muxed by the dependency-free writers in `mp4Muxer.ts` /
 *   `webmMuxer.ts`;
 * - {@link RecorderSink}: the MediaRecorder fallback, paced in real time
 *   and paused between frames so slow rendering does not stretch the clip.
 *
 * Encoding runs on the browser's codec threads; the main thread only
 * submits frames, so menus keep animating while a clip renders.
 */
import type { EncodedSample } from './bytes.ts';
import { muxMp4 } from './mp4Muxer.ts';
import { muxWebm, type WebmCodec } from './webmMuxer.ts';

/** A format the browser can make. */
export interface ClipFormat {
  encoder: 'webcodecs' | 'mediarecorder';
  container: 'mp4' | 'webm';
  /** WebCodecs codec string, or the MediaRecorder MIME type. */
  codec: string;
  /** File MIME type. */
  mime: string;
}

/** The browser surface format detection uses (injected for tests). */
export interface ClipEncoderEnv {
  /** `VideoEncoder.isConfigSupported`, when WebCodecs exists. */
  isConfigSupported?: (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;
  /** `MediaRecorder.isTypeSupported`, when MediaRecorder exists. */
  recorderSupports?: (mime: string) => boolean;
  /** `HTMLCanvasElement.prototype.captureStream` exists. */
  captureStream?: boolean;
}

/** Frames per second of every clip. */
export const CLIP_FPS = 30;
/** Keyframe spacing (frames): two seconds, so players can scrub. */
export const KEYFRAME_INTERVAL = CLIP_FPS * 2;

/**
 * Target bitrate for a clip size: generous, since clips are short and the
 * scenes are busy (confetti, crowds, 40 Tumblers).
 *
 * @param height - Frame height (px).
 */
export function clipBitrate(height: number): number {
  return height >= 1080 ? 9_000_000 : 5_000_000;
}

function avcCodecs(height: number): string[] {
  // High / Main / Baseline at level 4.0 for 1080p, 3.1 for 720p.
  const level = height >= 1080 ? '28' : '1f';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}

function encoderConfig(codec: string, width: number, height: number): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    bitrate: clipBitrate(height),
    framerate: CLIP_FPS,
    latencyMode: 'quality',
    ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
  };
}

const RECORDER_TYPES: readonly [string, ClipFormat['container']][] = [
  ['video/mp4;codecs=avc1', 'mp4'],
  ['video/webm;codecs=vp9', 'webm'],
  ['video/webm;codecs=vp8', 'webm'],
  ['video/webm', 'webm'],
  ['video/mp4', 'mp4'],
];

/**
 * The best clip format this browser can make at a size.
 *
 * @param width - Frame width.
 * @param height - Frame height.
 * @param env - Browser surface (see {@link browserEncoderEnv}).
 * @returns The format, or null when clips are impossible here.
 */
export async function pickClipFormat(
  width: number,
  height: number,
  env: ClipEncoderEnv,
): Promise<ClipFormat | null> {
  if (env.isConfigSupported) {
    const tries: [string, ClipFormat['container'], string][] = [
      ...avcCodecs(height).map((c): [string, ClipFormat['container'], string] => [c, 'mp4', 'video/mp4']),
      [height >= 1080 ? 'vp09.00.40.08' : 'vp09.00.31.08', 'webm', 'video/webm'],
      ['vp8', 'webm', 'video/webm'],
    ];
    for (const [codec, container, mime] of tries) {
      try {
        const r = await env.isConfigSupported(encoderConfig(codec, width, height));
        if (r.supported) return { encoder: 'webcodecs', container, codec, mime };
      } catch {
        // A malformed or unknown codec string throws on some engines; try the next one.
      }
    }
  }
  if (env.recorderSupports && env.captureStream) {
    for (const [mime, container] of RECORDER_TYPES)
      if (env.recorderSupports(mime))
        return { encoder: 'mediarecorder', container, codec: mime, mime: mime.split(';')[0] as string };
  }
  return null;
}

/** The real browser's encoder surface. */
export function browserEncoderEnv(): ClipEncoderEnv {
  const env: ClipEncoderEnv = {};
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined')
    env.isConfigSupported = (c) => VideoEncoder.isConfigSupported(c);
  if (typeof MediaRecorder !== 'undefined') env.recorderSupports = (m) => MediaRecorder.isTypeSupported(m);
  env.captureStream =
    typeof HTMLCanvasElement !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
  return env;
}

/** Receives composited frames and produces the file. */
export interface ClipSink {
  /**
   * Submits the canvas as frame `index` (resolves once there is room for the next one).
   *
   * @param index - 0-based frame number.
   */
  addFrame(index: number): Promise<void>;
  /** Flushes and muxes; the sink is spent afterwards. */
  finish(): Promise<Blob>;
  /** Drops everything (cancel or failure). */
  abort(): void;
}

function copyBytes(src: AllowSharedBufferSource): Uint8Array {
  const view = ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src as ArrayBuffer);
  return view.slice();
}

/** Encoder queue depth before {@link WebCodecsSink.addFrame} waits. */
const MAX_QUEUE = 6;

/**
 * WebCodecs encoder + muxer.
 *
 * @example
 * const sink = new WebCodecsSink(format, canvas);
 * for (let i = 0; i < frames; i++) { draw(); await sink.addFrame(i); }
 * const blob = await sink.finish();
 */
export class WebCodecsSink implements ClipSink {
  private readonly encoder: VideoEncoder;
  private samples: EncodedSample[] = [];
  private description: Uint8Array | null = null;
  private failure: Error | null = null;
  private readonly frameUs = Math.round(1_000_000 / CLIP_FPS);

  /**
   * @param format - A WebCodecs format from {@link pickClipFormat}.
   * @param canvas - The canvas frames are composited on.
   */
  constructor(
    private readonly format: ClipFormat,
    private readonly canvas: HTMLCanvasElement | OffscreenCanvas,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push({
          data,
          timestampUs: chunk.timestamp,
          durationUs: chunk.duration ?? this.frameUs,
          key: chunk.type === 'key',
        });
        const desc = meta?.decoderConfig?.description;
        if (desc && !this.description) this.description = copyBytes(desc);
      },
      error: (e) => {
        this.failure = e instanceof Error ? e : new Error(String(e));
      },
    });
    this.encoder.configure(encoderConfig(format.codec, canvas.width, canvas.height));
  }

  async addFrame(index: number): Promise<void> {
    if (this.failure) throw this.failure;
    const frame = new VideoFrame(this.canvas, { timestamp: index * this.frameUs, duration: this.frameUs });
    try {
      this.encoder.encode(frame, { keyFrame: index % KEYFRAME_INTERVAL === 0 });
    } finally {
      frame.close();
    }
    while (this.encoder.encodeQueueSize > MAX_QUEUE && !this.failure) await waitDequeue(this.encoder);
    if (this.failure) throw this.failure;
  }

  async finish(): Promise<Blob> {
    await this.encoder.flush();
    if (this.failure) throw this.failure;
    this.encoder.close();
    const samples = this.samples.sort((a, b) => a.timestampUs - b.timestampUs);
    this.samples = [];
    const track = { width: this.canvas.width, height: this.canvas.height, description: this.description };
    const parts =
      this.format.container === 'mp4'
        ? muxMp4(track, samples)
        : muxWebm(
            track,
            samples,
            (this.format.codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8') as WebmCodec,
            this.frameUs,
          );
    return new Blob(parts as BlobPart[], { type: this.format.mime });
  }

  abort(): void {
    this.samples = [];
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

function waitDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    // COMPAT: the `dequeue` event is newer than VideoEncoder itself; a short poll covers older engines.
    const t = setTimeout(done, 8);
    function done(): void {
      clearTimeout(t);
      encoder.removeEventListener('dequeue', done);
      resolve();
    }
    encoder.addEventListener('dequeue', done);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * COMPAT: MediaRecorder fallback for browsers without WebCodecs. The recorder
 * timestamps by wall clock, so it is resumed for one frame interval per
 * submitted frame and paused while the next one renders.
 */
export class RecorderSink implements ClipSink {
  private readonly recorder: MediaRecorder;
  private readonly track: CanvasCaptureMediaStreamTrack;
  private readonly chunks: Blob[] = [];
  private readonly stopped: Promise<void>;
  private failure: Error | null = null;

  /**
   * @param format - A MediaRecorder format from {@link pickClipFormat}.
   * @param canvas - The canvas frames are composited on.
   */
  constructor(
    private readonly format: ClipFormat,
    canvas: HTMLCanvasElement,
  ) {
    const stream = canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    this.recorder = new MediaRecorder(stream, {
      mimeType: format.codec,
      videoBitsPerSecond: clipBitrate(canvas.height),
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onerror = () => {
      this.failure = new Error('The browser stopped recording');
    };
    this.stopped = new Promise((r) => {
      this.recorder.onstop = () => r();
    });
    this.recorder.start();
    this.recorder.pause();
  }

  async addFrame(): Promise<void> {
    if (this.failure) throw this.failure;
    this.recorder.resume();
    this.track.requestFrame();
    await sleep(1000 / CLIP_FPS);
    this.recorder.pause();
  }

  async finish(): Promise<Blob> {
    if (this.failure) throw this.failure;
    this.recorder.resume();
    this.recorder.stop();
    await this.stopped;
    this.track.stop();
    const blob = new Blob(this.chunks, { type: this.recorder.mimeType || this.format.mime });
    this.chunks.length = 0;
    return blob;
  }

  abort(): void {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.track.stop();
    this.chunks.length = 0;
  }
}

/**
 * Opens the right sink for a format.
 *
 * @param format - From {@link pickClipFormat}.
 * @param canvas - The compositing canvas (a DOM canvas: MediaRecorder needs `captureStream`).
 */
export function openClipSink(format: ClipFormat, canvas: HTMLCanvasElement): ClipSink {
  return format.encoder === 'webcodecs'
    ? new WebCodecsSink(format, canvas)
    : new RecorderSink(format, canvas);
}
