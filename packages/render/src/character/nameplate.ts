/**
 * Player nameplates.
 *
 * Responsibilities:
 * - A {@link NameplateLayer}: every nameplate in the scene drawn by ONE
 *   instanced draw call, from a shared 1024 × 2048 canvas atlas (128 slots: a
 *   plate for every possible player id, so a full 100-player show never runs out).
 * - Styled plates from the nameplate cosmetics (pill, ribbon, bubble, ticket,
 *   neon), an optional team/party colour dot, distance fade, streamer mode.
 *
 * NOTE: troika-three-text is not used here. It imports `ShaderChunk`,
 * `ShaderLib` and `UniformsUtils` from `three`, which the client aliases to
 * `three/webgpu` where they don't exist, so importing it breaks the bundle;
 * its derived GLSL materials also can't run on the WebGPU backend. A canvas
 * atlas renders identically on both backends.
 */
import type { Object3D } from 'three/webgpu';
import type { TeamShape } from '@tumble/shared';
import {
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearMipmapLinearFilter,
  Matrix4,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type Node,
} from 'three/webgpu';
import { instancedBufferAttribute, texture, uv, vec2 } from 'three/tsl';
import { getCosmeticInSlot } from '@tumble/content/cosmetics';

const ATLAS_W = 1024;
const ATLAS_H = 2048;
const COLS = 4;
const ROWS = 32;
const SLOT_W = ATLAS_W / COLS;
const SLOT_H = ATLAS_H / ROWS;
/** Plates one {@link NameplateLayer} can hold at once. */
export const NAMEPLATE_CAPACITY = COLS * ROWS;
const CAPACITY = NAMEPLATE_CAPACITY;

/** Visual style of a plate (from a `nameplate.*` cosmetic). */
export interface NameplateStyle {
  style: 'pill' | 'ribbon' | 'bubble' | 'ticket' | 'neon';
  bg: string;
  bg2: string;
  text: string;
  border: string;
}

const DEFAULT_STYLE: NameplateStyle = {
  style: 'pill',
  bg: '#2a2238',
  bg2: '#3d3157',
  text: '#ffffff',
  border: '#ffffff',
};

/** Options for {@link NameplateLayer.create}. */
export interface NameplateOptions {
  /** Nameplate cosmetic id (`nameplate.*`). */
  style?: string;
  /** Explicit look; wins over `style` (speech bubbles use this). */
  plate?: NameplateStyle;
  /** Team or party colour shown as a dot before the name. */
  teamColor?: string | null;
  /** Shape of that dot, so the team reads without colour (default circle). */
  teamShape?: TeamShape | null;
  /** Height above the target's origin. Default 2.3 m. */
  height?: number;
  /** Small text chip after the name (e.g. `BOT`), or null for none. */
  tag?: string | null;
}

/** A handle to one plate in a {@link NameplateLayer}. */
export class Nameplate {
  /** Object whose world position the plate follows (e.g. `tumbler.object`). */
  target: Object3D | null = null;
  height: number;
  visible = true;
  /** @internal */
  opacity = 0;

  constructor(
    private readonly layer: NameplateLayer,
    /** @internal Atlas slot. */
    readonly slot: number,
    private name: string,
    private style: NameplateStyle,
    private teamColor: string | null,
    height: number,
    private tag: string | null = null,
    private teamShape: TeamShape | null = null,
  ) {
    this.height = height;
  }

  /** Sets (or clears) the text chip after the name. */
  setTag(tag: string | null): void {
    if (tag === this.tag) return;
    this.tag = tag;
    this.redraw();
  }

  /** Renames the plate (redraws its atlas slot). */
  setName(name: string): void {
    if (name === this.name) return;
    this.name = name;
    this.redraw();
  }

  /** Applies a nameplate cosmetic id. */
  setStyle(styleId: string): void {
    this.style = resolveStyle(styleId);
    this.redraw();
  }

  /** Sets (or clears) the team / party colour dot and its shape. */
  setTeamColor(color: string | null, shape: TeamShape | null = this.teamShape): void {
    this.teamColor = color;
    this.teamShape = shape;
    this.redraw();
  }

  /** @internal */
  redraw(): void {
    this.layer.draw(this.slot, this.name, this.style, this.teamColor, this.tag, this.teamShape);
  }

  /** Frees the slot. */
  dispose(): void {
    this.layer.release(this);
  }
}

/**
 * Adds a team shape cue to the current path, centred on (cx, cy).
 *
 * @param ctx - Any 2D path sink (a canvas context).
 * @param shape - Team shape.
 * @param r - Outer radius in pixels.
 */
export function traceTeamShape(
  ctx: Pick<CanvasRenderingContext2D, 'arc' | 'rect' | 'moveTo' | 'lineTo' | 'closePath'>,
  shape: TeamShape,
  cx: number,
  cy: number,
  r: number,
): void {
  switch (shape) {
    case 'square': {
      const a = r * 0.82;
      ctx.rect(cx - a, cy - a, a * 2, a * 2);
      return;
    }
    case 'triangle':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.95, cy + r * 0.75);
      ctx.lineTo(cx - r * 0.95, cy + r * 0.75);
      ctx.closePath();
      return;
    case 'diamond':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      return;
    default:
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
}

function resolveStyle(id: string | undefined): NameplateStyle {
  if (!id) return DEFAULT_STYLE;
  return getCosmeticInSlot(id, 'nameplate')?.plate ?? DEFAULT_STYLE;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function platePath(
  ctx: CanvasRenderingContext2D,
  s: NameplateStyle['style'],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (s === 'ribbon') {
    const n = h * 0.35;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - n, y + h / 2);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + n, y + h / 2);
    ctx.closePath();
  } else if (s === 'ticket') {
    const r = h * 0.22;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.arc(x + w, y + h / 2, r, -Math.PI / 2, Math.PI / 2, true);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.arc(x, y + h / 2, r, Math.PI / 2, -Math.PI / 2, true);
    ctx.closePath();
  } else if (s === 'bubble') {
    roundRect(ctx, x, y, w, h * 0.86, h * 0.4);
    ctx.moveTo(x + w * 0.46, y + h * 0.84);
    ctx.lineTo(x + w * 0.5, y + h);
    ctx.lineTo(x + w * 0.56, y + h * 0.84);
  } else {
    roundRect(ctx, x, y, w, h, h / 2);
  }
}

/**
 * Renders every nameplate in a scene with a single instanced draw.
 *
 * @example
 * const plates = new NameplateLayer();
 * scene.add(plates.mesh);
 * const p = plates.create('Sprinkles#42', { style: loadout.nameplate });
 * p.target = tumbler.object;
 * // per frame:
 * plates.update(camera);
 */
export class NameplateLayer {
  /** Add to the scene. */
  readonly mesh: InstancedMesh;
  /** Fully visible up to this distance (m). */
  fadeStart = 26;
  /** Invisible beyond this distance (m). */
  fadeEnd = 40;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: CanvasTexture;
  private readonly slotAttr: InstancedBufferAttribute;
  private readonly plates: (Nameplate | null)[] = new Array<Nameplate | null>(CAPACITY).fill(null);
  private streamer = false;
  private readonly m4 = new Matrix4();
  private readonly pos = new Vector3();
  private readonly camPos = new Vector3();
  private readonly camQuat = new Quaternion();
  private readonly scale = new Vector3();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable for nameplates');
    this.ctx = ctx;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.minFilter = LinearMipmapLinearFilter;
    this.tex.anisotropy = 4;

    this.slotAttr = new InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    const slot = instancedBufferAttribute(this.slotAttr, 'vec4') as unknown as Node<'vec4'>;
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
    // Slot-local UV → atlas UV; textures upload with flipY, so row 0 is the top.
    const atlasUV = vec2(slot.x.add(uv().x).div(COLS), slot.y.add(uv().y).div(ROWS));
    const s = texture(this.tex, atlasUV);
    mat.colorNode = s.rgb;
    mat.opacityNode = s.a.mul(slot.z);

    this.mesh = new InstancedMesh(new PlaneGeometry(1.6, 0.4), mat, CAPACITY);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'Nameplates';
  }

  /**
   * Allocates a plate.
   *
   * @param name - Display name.
   * @param opts - Style, team colour, height.
   * @returns The plate, or null when all {@link NAMEPLATE_CAPACITY} slots are taken.
   */
  create(name: string, opts: NameplateOptions = {}): Nameplate | null {
    const slot = this.plates.indexOf(null);
    if (slot < 0) return null;
    const p = new Nameplate(
      this,
      slot,
      name,
      opts.plate ?? resolveStyle(opts.style),
      opts.teamColor ?? null,
      opts.height ?? 2.3,
      opts.tag ?? null,
      opts.teamShape ?? null,
    );
    this.plates[slot] = p;
    p.redraw();
    return p;
  }

  /** @internal */
  release(p: Nameplate): void {
    if (this.plates[p.slot] === p) this.plates[p.slot] = null;
  }

  /** Streamer mode hides every name. */
  setStreamerMode(on: boolean): void {
    this.streamer = on;
  }

  /** @internal Paints one atlas slot. */
  draw(
    slot: number,
    name: string,
    style: NameplateStyle,
    team: string | null,
    tag: string | null = null,
    shape: TeamShape | null = null,
  ): void {
    const ctx = this.ctx;
    const x0 = (slot % COLS) * SLOT_W;
    const y0 = Math.floor(slot / COLS) * SLOT_H;
    ctx.clearRect(x0, y0, SLOT_W, SLOT_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, SLOT_W, SLOT_H);
    ctx.clip();

    const pad = 4;
    const x = x0 + pad;
    const y = y0 + pad;
    const w = SLOT_W - pad * 2;
    const h = SLOT_H - pad * 2;
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, style.bg2);
    grad.addColorStop(1, style.bg);
    platePath(ctx, style.style, x, y, w, h);
    ctx.globalAlpha = style.style === 'neon' ? 0.88 : 0.82;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (style.style === 'neon') {
      ctx.shadowColor = style.border;
      ctx.shadowBlur = 8;
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = style.border;
    ctx.stroke();
    ctx.shadowBlur = 0;

    let tx = x0 + SLOT_W / 2;
    let maxW = w - 36;
    if (team) {
      ctx.beginPath();
      traceTeamShape(ctx, shape ?? 'circle', x + 24, y + h / 2, shape && shape !== 'circle' ? 10 : 9);
      ctx.fillStyle = team;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      tx += 12;
      maxW -= 24;
    }
    if (tag) {
      ctx.font = `800 15px 'Trebuchet MS', system-ui, sans-serif`;
      const tw = ctx.measureText(tag).width + 12;
      const th = 20;
      const cx = x + w - 14 - tw;
      const cy = y + (h - th) / 2;
      roundRect(ctx, cx, cy, tw, th, 6);
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.text;
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = style.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tag, cx + tw / 2, cy + th / 2 + 1);
      ctx.globalAlpha = 1;
      tx -= (tw + 8) / 2;
      maxW -= tw + 8;
    }
    let size = 30;
    ctx.font = `800 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    const mw = ctx.measureText(name).width;
    if (mw > maxW) {
      size = Math.max(16, Math.floor((size * maxW) / mw));
      ctx.font = `800 ${size}px 'Trebuchet MS', system-ui, sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(20,10,35,0.75)';
    ctx.strokeText(name, tx, y0 + SLOT_H / 2 + 1);
    ctx.fillStyle = style.text;
    if (style.style === 'neon') {
      ctx.shadowColor = style.text;
      ctx.shadowBlur = 10;
    }
    ctx.fillText(name, tx, y0 + SLOT_H / 2 + 1);
    ctx.restore();
    this.tex.needsUpdate = true;
  }

  /**
   * Billboards, positions and fades every plate. Call once per frame after
   * Tumblers have been placed.
   *
   * @param camera - Active camera.
   */
  update(camera: Camera): void {
    camera.getWorldPosition(this.camPos);
    camera.getWorldQuaternion(this.camQuat);
    let n = 0;
    const slots = this.slotAttr.array as Float32Array;
    for (const p of this.plates) {
      if (!p || !p.target || !p.visible || this.streamer) continue;
      p.target.getWorldPosition(this.pos);
      if (!p.target.visible) continue;
      this.pos.y += p.height;
      const d = this.pos.distanceTo(this.camPos);
      const fade = 1 - Math.min(1, Math.max(0, (d - this.fadeStart) / (this.fadeEnd - this.fadeStart)));
      if (fade <= 0.01) continue;
      // Grow slightly with distance so names stay legible without dominating close-ups.
      const s = Math.min(2.2, Math.max(0.7, d * 0.07));
      this.m4.compose(this.pos, this.camQuat, this.scale.set(s, s, s));
      this.mesh.setMatrixAt(n, this.m4);
      slots[n * 4] = p.slot % COLS;
      slots[n * 4 + 1] = ROWS - 1 - Math.floor(p.slot / COLS);
      slots[n * 4 + 2] = fade;
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.slotAttr.needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}
