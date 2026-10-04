/**
 * GPU → 2D canvas readback shared by the share card and clip renderers.
 */
import type { RenderTarget, WebGPURenderer } from 'three/webgpu';

/** Reusable pixel buffer for repeated readbacks of one size (clips). */
export interface ReadbackScratch {
  image: ImageData | null;
}

/**
 * Copies a render target's colour into a 2D context at (0, 0).
 *
 * @param renderer - The renderer that drew the target.
 * @param target - Render target (RGBA8).
 * @param ctx - Destination, at least the target's size.
 * @param scratch - Reused `ImageData` holder (per-frame callers pass one to avoid a 4 MB allocation per frame).
 */
export async function readTargetInto(
  renderer: WebGPURenderer,
  target: RenderTarget,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scratch: ReadbackScratch = { image: null },
): Promise<void> {
  const w = target.width;
  const h = target.height;
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, w, h)) as Uint8Array;
  let img = scratch.image;
  if (!img || img.width !== w || img.height !== h) {
    img = ctx.createImageData(w, h);
    scratch.image = img;
  }
  // COMPAT: WebGL reads rows bottom-up; WebGPU top-down.
  const flip = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true;
  const row = w * 4;
  // WebGPU pads every row but the last to 256 bytes; the buffer length tells the stride.
  const stride = h > 1 ? Math.max(row, Math.floor((pixels.length - row) / (h - 1))) : row;
  for (let y = 0; y < h; y++) {
    const src = (flip ? h - 1 - y : y) * stride;
    img.data.set(pixels.subarray(src, src + row), y * row);
  }
  ctx.putImageData(img, 0, 0);
}
