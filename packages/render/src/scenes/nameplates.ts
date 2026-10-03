import {
  CanvasTexture,
  InstancedBufferAttribute,
  LinearFilter,
  SRGBColorSpace,
  Sprite,
  SpriteNodeMaterial,
  type Node,
} from 'three/webgpu';
import { float, instancedBufferAttribute, texture, uniform, uv, vec2 } from 'three/tsl';

/**
 * Nameplates for crowds of Tumblers (pre-show, player wall). Every name is
 * drawn once into a shared canvas atlas, and all plates render as ONE instanced
 * sprite draw: per-instance position, atlas cell and visibility attributes.
 *
 * NOTE: troika-three-text derives classic ShaderMaterials, which the WebGPU
 * renderer cannot use, so nameplates rasterise via canvas instead.
 */

const CELL_W = 256;
const CELL_H = 64;

/** Options for {@link NameplateSet}. */
export interface NameplateOptions {
  /** Max plates. */
  capacity: number;
  /** World width of a plate in metres. Default 1.6. */
  width?: number;
  /** Plate fill colour. */
  background?: string;
  /** Text colour. */
  foreground?: string;
}

/**
 * Shortens a name with an ellipsis until it fits `maxW`, keeping a trailing
 * `#tag` whole: the tag is what friends type, the name is just decoration.
 *
 * @param g - Context with the final font already set.
 * @param text - Name, optionally `Name#1234`.
 * @param maxW - Available width in canvas pixels.
 * @returns The text to draw.
 */
export function fitName(
  g: { measureText(t: string): { width: number } },
  text: string,
  maxW: number,
): string {
  if (g.measureText(text).width <= maxW) return text;
  const hash = text.lastIndexOf('#');
  const tag = hash > 0 ? text.slice(hash) : '';
  let base = hash > 0 ? text.slice(0, hash) : text;
  while (base.length > 1 && g.measureText(`${base}…${tag}`).width > maxW) base = base.slice(0, -1);
  return `${base}…${tag}`;
}

/**
 * A batch of camera-facing nameplates.
 *
 * @example
 * const plates = new NameplateSet({ capacity: MAX_PLAYERS });
 * plates.setName(0, 'Sprinkles', '#ff6fb5');
 * plates.setPosition(0, x, y + 1.8, z);
 * scene.add(plates.object);
 */
export class NameplateSet {
  readonly object: Sprite;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: CanvasTexture;
  private readonly cols: number;
  private readonly rows: number;
  private readonly pos: Float32Array;
  private readonly cell: Float32Array;
  private readonly posAttr: InstancedBufferAttribute;
  private readonly cellAttr: InstancedBufferAttribute;
  private readonly material: SpriteNodeMaterial;
  private readonly opts: Required<NameplateOptions>;
  /** Global opacity multiplier. */
  readonly opacity = uniform(1);

  constructor(opts: NameplateOptions) {
    this.opts = { width: 1.6, background: '#ffffff', foreground: '#2b1d3a', ...opts };
    const cap = Math.max(1, opts.capacity);
    this.cols = Math.max(1, Math.min(8, cap));
    this.rows = Math.ceil(cap / this.cols);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.cols * CELL_W;
    this.canvas.height = this.rows * CELL_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.minFilter = LinearFilter;
    this.tex.generateMipmaps = false;

    this.pos = new Float32Array(cap * 3);
    this.cell = new Float32Array(cap * 3);
    this.posAttr = new InstancedBufferAttribute(this.pos, 3);
    this.cellAttr = new InstancedBufferAttribute(this.cell, 3);

    const mat = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const aPos = instancedBufferAttribute(this.posAttr) as unknown as Node<'vec3'>;
    const aCell = instancedBufferAttribute(this.cellAttr) as unknown as Node<'vec3'>;
    mat.positionNode = aPos;
    const w = this.opts.width;
    mat.scaleNode = vec2(w, w * (CELL_H / CELL_W)).mul(aCell.z);
    const st = uv();
    const atlasUV = vec2(
      aCell.x.add(st.x).div(this.cols),
      float(1).sub(aCell.y.add(float(1).sub(st.y)).div(this.rows)),
    );
    const sample = texture(this.tex, atlasUV);
    mat.colorNode = sample.rgb;
    mat.opacityNode = sample.a.mul(this.opacity).mul(aCell.z.min(1));
    this.material = mat;

    const sprite = new Sprite(mat);
    sprite.count = cap;
    sprite.frustumCulled = false;
    sprite.renderOrder = 20;
    sprite.name = 'nameplates';
    this.object = sprite;
  }

  /**
   * Draws a name into plate `i`'s atlas cell.
   *
   * @param i - Plate index.
   * @param name - Display name (truncated to fit).
   * @param accent - Accent stripe colour (player colour).
   * @param tag - Small text chip after the name (e.g. `BOT`).
   */
  setName(i: number, name: string, accent = '#ff6fb5', tag?: string): void {
    const cx = (i % this.cols) * CELL_W;
    const cy = Math.floor(i / this.cols) * CELL_H;
    const g = this.ctx;
    g.clearRect(cx, cy, CELL_W, CELL_H);
    const pad = 4;
    const r = (CELL_H - pad * 2) / 2;
    g.beginPath();
    g.roundRect(cx + pad, cy + pad, CELL_W - pad * 2, CELL_H - pad * 2, r);
    g.fillStyle = this.opts.background;
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = accent;
    g.stroke();
    g.beginPath();
    g.arc(cx + pad + r, cy + CELL_H / 2, r * 0.55, 0, Math.PI * 2);
    g.fillStyle = accent;
    g.fill();
    g.fillStyle = this.opts.foreground;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    let maxW = CELL_W - pad * 2 - r * 2.4;
    let textX = cx + CELL_W / 2 + r * 0.6;
    if (tag) {
      g.font = `800 15px 'Trebuchet MS', system-ui, sans-serif`;
      const tw = g.measureText(tag).width + 12;
      const tx = cx + CELL_W - pad - r * 0.6 - tw;
      const ty = cy + (CELL_H - 20) / 2;
      g.beginPath();
      g.roundRect(tx, ty, tw, 20, 6);
      g.globalAlpha = 0.6;
      g.lineWidth = 2;
      g.strokeStyle = this.opts.foreground;
      g.stroke();
      g.globalAlpha = 0.75;
      g.fillText(tag, tx + tw / 2, ty + 11);
      g.globalAlpha = 1;
      maxW -= tw + 6;
      textX -= (tw + 6) / 2;
    }
    let size = 30;
    g.font = `800 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    while (g.measureText(name).width > maxW && size > 14) {
      size -= 2;
      g.font = `800 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    }
    g.fillText(fitName(g, name, maxW), textX, cy + CELL_H / 2 + 1);
    this.cell[i * 3] = i % this.cols;
    this.cell[i * 3 + 1] = Math.floor(i / this.cols);
    if (this.cell[i * 3 + 2] === 0) this.cell[i * 3 + 2] = 1;
    this.cellAttr.needsUpdate = true;
    this.tex.needsUpdate = true;
  }

  /** Moves plate `i` (world position of its centre). */
  setPosition(i: number, x: number, y: number, z: number): void {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.posAttr.needsUpdate = true;
  }

  /** Plate scale (0 hides it). */
  setScale(i: number, scale: number): void {
    this.cell[i * 3 + 2] = scale;
    this.cellAttr.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
