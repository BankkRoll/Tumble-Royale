/**
 * Pattern Panic symbol art: the eight board symbols drawn as chunky outlined
 * Canvas2D shapes (each a distinct silhouette AND colour, so they stay
 * readable for colour-blind players and in greyscale).
 */
import { PATTERN_SYMBOL_COLORS } from '@tumble/sim/obstacles';

/** A 2D context from either a DOM canvas or an OffscreenCanvas. */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const INK = '#1a1033';

/** Creates a canvas (DOM or offscreen), or null when neither exists (headless). */
export function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas | null {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

function circle(g: Ctx2D, x: number, y: number, r: number): void {
  g.moveTo(x + r, y);
  g.arc(x, y, r, 0, Math.PI * 2);
}

/** Traces symbol `id` centred at (cx, cy) with radius `r` into the current path. */
function trace(g: Ctx2D, id: number, cx: number, cy: number, r: number): void {
  g.beginPath();
  switch (id) {
    case 0: {
      // Star.
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 === 0 ? r : r * 0.45;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr * 1.0 + r * 0.06;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      break;
    }
    case 1: {
      // Heart.
      const s = r * 0.95;
      g.moveTo(cx, cy + s * 0.85);
      g.bezierCurveTo(cx - s * 1.25, cy + s * 0.05, cx - s * 0.75, cy - s * 0.95, cx, cy - s * 0.35);
      g.bezierCurveTo(cx + s * 0.75, cy - s * 0.95, cx + s * 1.25, cy + s * 0.05, cx, cy + s * 0.85);
      g.closePath();
      break;
    }
    case 2: {
      // Crescent moon: outer arc, then the inner arc back.
      g.arc(cx, cy, r * 0.9, Math.PI * 0.32, Math.PI * 1.68, false);
      g.arc(cx + r * 0.42, cy - r * 0.08, r * 0.72, Math.PI * 1.5, Math.PI * 0.5, true);
      g.closePath();
      break;
    }
    case 3: {
      // Lightning bolt.
      const p = [
        [0.15, -1],
        [-0.55, 0.12],
        [-0.02, 0.12],
        [-0.22, 1],
        [0.58, -0.22],
        [0.04, -0.22],
        [0.34, -1],
      ];
      p.forEach(([x, y], k) =>
        k === 0 ? g.moveTo(cx + x! * r, cy + y! * r) : g.lineTo(cx + x! * r, cy + y! * r),
      );
      g.closePath();
      break;
    }
    case 4: {
      // Flower: five petals around a centre.
      for (let k = 0; k < 5; k++) {
        const a = -Math.PI / 2 + (k * Math.PI * 2) / 5;
        circle(g, cx + Math.cos(a) * r * 0.52, cy + Math.sin(a) * r * 0.52, r * 0.42);
      }
      break;
    }
    case 5: {
      // Water drop.
      g.moveTo(cx, cy - r);
      g.bezierCurveTo(cx + r * 0.25, cy - r * 0.55, cx + r * 0.75, cy - r * 0.1, cx + r * 0.72, cy + r * 0.3);
      g.arc(cx, cy + r * 0.3, r * 0.72, 0, Math.PI, false);
      g.bezierCurveTo(cx - r * 0.75, cy - r * 0.1, cx - r * 0.25, cy - r * 0.55, cx, cy - r);
      g.closePath();
      break;
    }
    case 6: {
      // Crown.
      const p = [
        [-0.9, 0.7],
        [-0.95, -0.55],
        [-0.45, -0.05],
        [0, -0.85],
        [0.45, -0.05],
        [0.95, -0.55],
        [0.9, 0.7],
      ];
      p.forEach(([x, y], k) =>
        k === 0 ? g.moveTo(cx + x! * r, cy + y! * r) : g.lineTo(cx + x! * r, cy + y! * r),
      );
      g.closePath();
      break;
    }
    default: {
      // Cloud.
      circle(g, cx - r * 0.45, cy + r * 0.15, r * 0.45);
      circle(g, cx + r * 0.05, cy - r * 0.2, r * 0.58);
      circle(g, cx + r * 0.55, cy + r * 0.12, r * 0.42);
      g.moveTo(cx - r * 0.85, cy + r * 0.55);
      g.rect(cx - r * 0.85, cy + r * 0.1, r * 1.65, r * 0.5);
    }
  }
}

/**
 * Draws one symbol: thick ink outline, colour fill, a soft highlight.
 *
 * @param g - 2D context.
 * @param id - Symbol id (0–7).
 * @param cx - Centre x (px).
 * @param cy - Centre y (px).
 * @param r - Radius (px).
 * @param tint - Override fill colour (e.g. dimmed), defaults to the symbol colour.
 */
export function drawSymbol(g: Ctx2D, id: number, cx: number, cy: number, r: number, tint?: string): void {
  g.save();
  g.lineJoin = 'round';
  g.lineCap = 'round';
  trace(g, id, cx, cy, r);
  g.lineWidth = r * 0.26;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = tint ?? PATTERN_SYMBOL_COLORS[id % PATTERN_SYMBOL_COLORS.length]!;
  g.fill();
  // Glossy highlight clipped to the shape.
  g.clip();
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.beginPath();
  g.ellipse(cx - r * 0.25, cy - r * 0.45, r * 0.7, r * 0.38, -0.4, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** Draws a big ✕ (NOT rounds) over a symbol. */
export function drawCross(g: Ctx2D, cx: number, cy: number, r: number): void {
  g.save();
  g.lineCap = 'round';
  for (const [w, c] of [
    [r * 0.42, INK],
    [r * 0.26, '#ff3d6e'],
  ] as const) {
    g.lineWidth = w;
    g.strokeStyle = c;
    g.beginPath();
    g.moveTo(cx - r, cy - r);
    g.lineTo(cx + r, cy + r);
    g.moveTo(cx + r, cy - r);
    g.lineTo(cx - r, cy + r);
    g.stroke();
  }
  g.restore();
}

/** Chunky outlined text (screen captions). */
export function drawText(g: Ctx2D, text: string, x: number, y: number, size: number, fill = '#ffffff'): void {
  g.save();
  g.font = `900 ${Math.round(size)}px "Baloo 2", "Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = size * 0.18;
  g.strokeStyle = INK;
  g.strokeText(text, x, y);
  g.fillStyle = fill;
  g.fillText(text, x, y);
  g.restore();
}
