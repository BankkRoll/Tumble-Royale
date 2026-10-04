/**
 * Renders a clip from a recorded round.
 *
 * Responsibilities:
 * - plays the recording back deterministically: a private replay view
 *   (its own Tumblers, its own replay sim) stepped at exactly 1/30 s per
 *   frame from the window start, whatever the display does;
 * - draws each frame offscreen on the game's renderer (HDR target → tone
 *   mapping and the round's grade in a small output pass → 8-bit target),
 *   reads it back, stamps the round name and the wordmark, and hands the
 *   canvas to the encoder;
 * - one frame per animation frame with the encoder's back-pressure, so the
 *   menu underneath keeps its frame rate; cancellable at any frame;
 * - frees every GPU resource it created, whatever happens.
 */
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  HalfFloatType,
  NeutralToneMapping,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  SRGBColorSpace,
  type Camera,
  type Scene,
  type ToneMapping,
  type WebGPURenderer,
} from 'three/webgpu';
import { dot, float, mix, renderOutput, texture, uniform, vec3, vec4 } from 'three/tsl';
import type { GradeParams, ToneMappingMode } from '@tumble/render/post';
import type { ReplayView } from '../replay/view.ts';
import { CARD_BODY_FONT, fitText } from './cardLayout.ts';
import { drawWordmark } from './cardDraw.ts';
import type { ClipSink } from './clipEncoder.ts';
import { CLIP_FPS } from './clipEncoder.ts';
import type { ClipWindow } from './clipWindow.ts';
import { readTargetInto, type ReadbackScratch } from './readback.ts';

const TONE: Record<ToneMappingMode, ToneMapping> = {
  neutral: NeutralToneMapping,
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
};

/**
 * Scene → display-referred pixels without the live post pipeline (which is
 * bound to the canvas size): the scene renders into a multisampled HDR
 * target, then one full-screen pass applies exposure, tone mapping, sRGB
 * and the grade's saturation/contrast into an 8-bit target for readback.
 */
class ClipOutput {
  readonly hdr: RenderTarget;
  readonly out: RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material: NodeMaterial;
  private readonly u = { exposure: uniform(1), saturation: uniform(1), contrast: uniform(1) };

  constructor(width: number, height: number, tone: ToneMapping) {
    this.hdr = new RenderTarget(width, height, { samples: 4, type: HalfFloatType });
    this.out = new RenderTarget(width, height);
    const src = texture(this.hdr.texture).rgb.mul(this.u.exposure);
    const mapped = renderOutput(vec4(src, 1), tone, SRGBColorSpace).rgb;
    const luma = dot(mapped, vec3(0.2126, 0.7152, 0.0722));
    const sat = mix(vec3(luma, luma, luma), mapped, this.u.saturation);
    const graded = sat.sub(0.5).mul(this.u.contrast).add(0.5).clamp(0, 1);
    this.material = new NodeMaterial();
    this.material.fragmentNode = vec4(graded, float(1));
    this.quad = new QuadMesh(this.material);
  }

  setGrade(g: GradeParams): void {
    this.u.exposure.value = g.exposure;
    this.u.saturation.value = g.saturation;
    this.u.contrast.value = g.contrast;
  }

  render(renderer: WebGPURenderer, scene: Scene, camera: Camera): void {
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.hdr);
      renderer.render(scene, camera);
      renderer.setRenderTarget(this.out);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  dispose(): void {
    this.hdr.dispose();
    this.out.dispose();
    this.material.dispose();
  }
}

/**
 * The clip's stamps: round name top-left, wordmark bottom-right.
 *
 * @param ctx - The composited frame.
 * @param width - Frame width.
 * @param height - Frame height.
 * @param roundName - Shown in the pill.
 */
export function drawClipOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  roundName: string,
): void {
  const u = height / 720;
  const pad = Math.round(22 * u);
  const fit = fitText(
    roundName,
    width * 0.45,
    { family: CARD_BODY_FONT, weight: '700', maxSize: Math.round(26 * u), minSize: Math.round(16 * u) },
    (t, f) => {
      ctx.font = f;
      return ctx.measureText(t).width;
    },
  );
  ctx.save();
  ctx.font = fit.font;
  const w = ctx.measureText(fit.text).width + fit.size * 1.2;
  const h = fit.size * 1.7;
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = '#2b1a5e';
  ctx.beginPath();
  ctx.roundRect(pad, pad, w, h, h / 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff7ea';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fit.text, pad + fit.size * 0.6, pad + h / 2);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.9;
  drawWordmark(ctx, width - pad, height - pad - 30 * u, Math.round(22 * u), 'right');
  ctx.restore();
}

/** What {@link renderClip} needs. */
export interface ClipRenderOptions {
  renderer: WebGPURenderer;
  /** Builds the private replay view (own Tumbler pool and sim; no audio, no screen effects). */
  createView: () => ReplayView;
  window: ClipWindow;
  width: number;
  height: number;
  toneMapping: ToneMappingMode;
  roundName: string;
  /** Opens the encoder on the compositing canvas. */
  openSink: (canvas: HTMLCanvasElement) => ClipSink;
  signal: AbortSignal;
  /** 0..1 after each frame. */
  onProgress: (fraction: number) => void;
  /** Waits for the next chance to render (default: the next animation frame). */
  nextFrame?: () => Promise<void>;
}

/** Thrown when a render is cancelled. */
export function abortError(): DOMException {
  return new DOMException('The clip was cancelled', 'AbortError');
}

function animationFrame(): Promise<void> {
  return new Promise((resolve) => {
    // A hidden tab never fires rAF; the timer keeps the render moving (slowly) instead of hanging.
    const t = setTimeout(done, 250);
    const id = requestAnimationFrame(done);
    function done(): void {
      clearTimeout(t);
      cancelAnimationFrame(id);
      resolve();
    }
  });
}

/**
 * Renders and encodes a clip.
 *
 * @param o - Options.
 * @returns The encoded file.
 * @throws An `AbortError` DOMException when cancelled; the encoder's error when encoding fails.
 */
export async function renderClip(o: ClipRenderOptions): Promise<Blob> {
  const { renderer, width, height } = o;
  const next = o.nextFrame ?? animationFrame;
  if (o.signal.aborted) throw abortError();
  const view = o.createView();
  const output = new ClipOutput(width, height, TONE[o.toneMapping]);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  let sink: ClipSink | null = null;
  const scratch: ReadbackScratch = { image: null };
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    view.resize(width, height);
    output.setGrade(view.grade);
    view.command({ type: 'seek', t: o.window.start });
    if (!view.clock.playing) view.command({ type: 'toggle' });
    // A zero step applies the seek and cuts the camera to its subject before the first frame.
    view.update(0, 0);
    await renderer.compileAsync(view.scene, view.camera);
    if (o.signal.aborted) throw abortError();
    sink = o.openSink(canvas);
    const frames = Math.max(1, Math.round(o.window.length * CLIP_FPS));
    const dt = 1 / CLIP_FPS;
    for (let i = 0; i < frames; i++) {
      if (o.signal.aborted) throw abortError();
      if (i > 0) view.update(dt, dt);
      output.render(renderer, view.scene, view.camera);
      await readTargetInto(renderer, output.out, ctx, scratch);
      drawClipOverlay(ctx, width, height, o.roundName);
      await sink.addFrame(i);
      o.onProgress((i + 1) / frames);
      await next();
    }
    if (o.signal.aborted) throw abortError();
    const blob = await sink.finish();
    sink = null;
    return blob;
  } finally {
    sink?.abort();
    view.dispose();
    output.dispose();
    scratch.image = null;
    canvas.width = 0;
    canvas.height = 0;
  }
}
