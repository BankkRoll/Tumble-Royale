/**
 * Floating text signs for the playground, drawn to a canvas texture. troika
 * text is not a client dependency and signage here is static, so a canvas
 * sprite per label is the lightest option.
 */
import { CanvasTexture, SRGBColorSpace, Sprite, SpriteNodeMaterial } from 'three/webgpu';

/**
 * Creates a camera-facing text sprite.
 *
 * @param text - Label text (single line).
 * @param color - Background pill colour.
 * @param height - World height of the sign (m).
 * @returns The sprite; dispose its material map + material when removing it.
 */
export function createLabel(text: string, color = '#ffffff', height = 0.8): Sprite {
  const font = '700 64px "Trebuchet MS", system-ui, sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + 64;
  const h = 96;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(43,29,58,0.85)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(3, 3, w - 6, h - 6, 40);
  ctx.fill();
  ctx.stroke();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#2b1d3a';
  ctx.fillText(text, w / 2, h / 2 + 4);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const mat = new SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new Sprite(mat);
  sprite.scale.set((height * w) / h, height, 1);
  return sprite;
}
