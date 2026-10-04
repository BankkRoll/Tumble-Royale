/**
 * Puzzle Floor visual: the tile board, its decals and the question screen for
 * Colour Cauldron (`mix`) and Trail Tracer (`trail`).
 *
 * - `mix` tiles are painted their colour, with white parent shapes on top
 *   (● red, ▲ yellow, ■ blue; mixes show both), and fade to grey in memory
 *   rounds. The screen shows the sum or difference.
 * - `trail` tiles are ice with an arrow; start tiles fly a flag. In memory
 *   rounds the arrows frost over (flags stay). The teaching round lights the
 *   trails up step by step near the end.
 * - DROP / FALLEN / RISE animate exactly like the pattern board: wrong tiles
 *   flash and shake, fall away, and rise back.
 *
 * Everything is derived from the floor's schedule at match time `t`; the only
 * replicated input is the per-round voided bit read from the runtime. Without
 * a runtime (gallery) the visual rebuilds the schedule from the show seed.
 */
import {
  CanvasTexture,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
} from 'three/webgpu';
import { color, texture, uv } from 'three/tsl';
import { Rng } from '@tumble/shared';
import type { ObstacleRuntime } from '@tumble/sim';
import {
  MIX_COLORS,
  MIX_COLOR_HEX,
  MIX_PARENTS,
  MixOp,
  PuzzleFloorSchema,
  PuzzlePhase,
  buildPuzzleSchedule,
  patternSeams,
  patternTileCenter,
  puzzlePhaseOf,
  puzzleRoundIndexAt,
  type PatternSeam,
  type PuzzleFloorParams,
  type PuzzleFloorView,
  type PuzzleRound,
} from '@tumble/sim/obstacles';
import {
  Disposer,
  applyInstanceTransform,
  glowMaterial,
  parseParams,
  roundedBox,
  toon,
} from './visual-helpers-b.ts';
import { drawText, makeCanvas, type Ctx2D } from './patternSymbols.ts';
import type { ObstacleVisualFactory } from './types.ts';

const CELL = 256;
const INK = '#1a1033';
const ARROW_CELL = 6;
const FLAG_CELL = 7;
const GREY = new Color('#8c8496');
const ICE = new Color('#d8f0ff');
const FROST = new Color('#f4fbff');
const FLAG_TILE = new Color('#ffe08a');
const SAFE = new Color('#2bffb8');
const WARN_A = new Color('#ff3d6e');
const WARN_B = new Color('#ff7a1a');
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

// -----------------------------------------------------------------------------
// Canvas art
// -----------------------------------------------------------------------------

/** Traces primary shape `k` (0 circle, 1 triangle, 2 square). */
function traceShape(g: Ctx2D, k: number, x: number, y: number, r: number): void {
  g.beginPath();
  if (k === 0) g.arc(x, y, r, 0, Math.PI * 2);
  else if (k === 1) {
    g.moveTo(x, y - r * 1.05);
    g.lineTo(x + r * 1.05, y + r * 0.8);
    g.lineTo(x - r * 1.05, y + r * 0.8);
    g.closePath();
  } else g.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
}

/** A chunky outlined primary shape. */
function drawShape(g: Ctx2D, k: number, x: number, y: number, r: number, fill: string): void {
  g.save();
  g.lineJoin = 'round';
  traceShape(g, k, x, y, r);
  g.lineWidth = r * 0.28;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}

/** The shape(s) of colour `c`: one for a primary, both parents side by side for a mix. */
function drawColourShapes(g: Ctx2D, c: number, x: number, y: number, r: number, fill: string): void {
  const [a, b] = MIX_PARENTS[c]!;
  if (a === b) drawShape(g, a, x, y, r, fill);
  else {
    drawShape(g, a, x - r * 0.95, y, r * 0.72, fill);
    drawShape(g, b, x + r * 0.95, y, r * 0.72, fill);
  }
}

/** A colour blob with its shapes, for the screen. */
function drawColourBlob(g: Ctx2D, c: number, x: number, y: number, r: number): void {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.lineWidth = r * 0.12;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = MIX_COLOR_HEX[c]!;
  g.fill();
  g.restore();
  drawColourShapes(g, c, x, y, r * 0.42, '#ffffff');
}

function drawArrow(g: Ctx2D, cx: number, cy: number, s: number): void {
  // Points up the canvas (toward the tile's local +Z once mapped).
  g.save();
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(cx, cy - s * 0.9);
  g.lineTo(cx + s * 0.75, cy - s * 0.05);
  g.lineTo(cx + s * 0.3, cy - s * 0.05);
  g.lineTo(cx + s * 0.3, cy + s * 0.85);
  g.lineTo(cx - s * 0.3, cy + s * 0.85);
  g.lineTo(cx - s * 0.3, cy - s * 0.05);
  g.lineTo(cx - s * 0.75, cy - s * 0.05);
  g.closePath();
  g.lineWidth = s * 0.16;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.fillStyle = '#1f3d7a';
  g.fill();
  g.restore();
}

function drawFlag(g: Ctx2D, cx: number, cy: number, s: number, fill = '#ff3d6e'): void {
  g.save();
  g.lineJoin = 'round';
  g.fillStyle = INK;
  g.fillRect(cx - s * 0.62, cy - s * 0.9, s * 0.14, s * 1.8);
  g.beginPath();
  g.moveTo(cx - s * 0.5, cy - s * 0.9);
  g.lineTo(cx + s * 0.75, cy - s * 0.55);
  g.lineTo(cx - s * 0.5, cy - s * 0.15);
  g.closePath();
  g.lineWidth = s * 0.12;
  g.strokeStyle = INK;
  g.stroke();
  g.fillStyle = fill;
  g.fill();
  g.restore();
}

/** 4 × 2 atlas: six colour glyphs, the arrow and the flag. */
function buildAtlas(d: Disposer): CanvasTexture | null {
  const canvas = makeCanvas(CELL * 4, CELL * 2);
  const g = canvas?.getContext('2d') as Ctx2D | null;
  if (!canvas || !g) return null;
  for (let id = 0; id < 8; id++) {
    const cx = (id % 4) * CELL + CELL / 2;
    const cy = Math.floor(id / 4) * CELL + CELL / 2;
    if (id < MIX_COLORS.length) drawColourShapes(g, id, cx, cy, CELL * 0.3, '#ffffff');
    else if (id === ARROW_CELL) drawArrow(g, cx, cy, CELL * 0.42);
    else drawFlag(g, cx, cy, CELL * 0.36);
  }
  const tex = d.track(new CanvasTexture(canvas as HTMLCanvasElement));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Flat plane whose UVs pick cell `id` of the atlas, with the art's top toward
 * local +Z (away from players facing the screen, so glyphs read upright).
 */
function cellPlane(d: Disposer, id: number, size: number): BufferGeometry {
  const g = d.track(new PlaneGeometry(size, size));
  const uvs = g.getAttribute('uv');
  const u0 = (id % 4) / 4;
  const v0 = 1 - (Math.floor(id / 4) + 1) / 2;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, u0 + uvs.getX(i) / 4, v0 + uvs.getY(i) / 2);
  uvs.needsUpdate = true;
  g.rotateX(-Math.PI / 2);
  g.rotateY(Math.PI);
  return g;
}

/** Question screen: a canvas redrawn only when what it shows changes. */
class Screen {
  readonly mesh: Mesh;
  private readonly g: Ctx2D | null;
  private readonly tex: CanvasTexture | null;
  private key = '';

  constructor(d: Disposer, width: number, height: number) {
    const canvas = makeCanvas(1024, 512);
    this.g = (canvas?.getContext('2d') as Ctx2D | null) ?? null;
    this.tex = canvas ? d.track(new CanvasTexture(canvas as HTMLCanvasElement)) : null;
    if (this.tex) this.tex.colorSpace = SRGBColorSpace;
    const mat = d.track(new MeshBasicNodeMaterial());
    mat.colorNode = this.tex ? texture(this.tex, uv()).rgb.mul(1.1) : color(new Color('#1d1630'));
    this.mesh = new Mesh(d.track(new PlaneGeometry(width, height)), mat);
    // The screen faces the floor (−Z).
    this.mesh.rotation.y = Math.PI;
  }

  show(key: string, paint: (g: Ctx2D, w: number, h: number) => void): void {
    if (key === this.key || !this.g || !this.tex) return;
    this.key = key;
    const g = this.g;
    const w = 1024;
    const h = 512;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2a1d4a');
    bg.addColorStop(1, '#140e26');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    paint(g, w, h);
    g.lineWidth = 14;
    g.strokeStyle = '#ffd23f';
    g.strokeRect(7, 7, w - 14, h - 14);
    this.tex.needsUpdate = true;
  }
}

// -----------------------------------------------------------------------------
// Visual
// -----------------------------------------------------------------------------

class PuzzleFloorVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: PuzzleFloorParams;
  private readonly fallback: PuzzleRound[];
  private readonly tiles: InstancedMesh;
  private readonly seams: PatternSeam[];
  private readonly seamBody: InstancedMesh;
  private readonly decals: Mesh[] = [];
  private readonly flags: Mesh[] = [];
  private readonly glows: Mesh[] = [];
  private readonly cells: BufferGeometry[] = [];
  private readonly centres: Vector3[] = [];
  private readonly tileY: Float32Array;
  private readonly screen: Screen;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly c = new Color();

  constructor(instance: Parameters<ObstacleVisualFactory>[0], ctx: Parameters<ObstacleVisualFactory>[1]) {
    const d = this.d;
    const p = (this.p = parseParams(PuzzleFloorSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    this.fallback = buildPuzzleSchedule(p, ctx.speedScale, new Rng(ctx.seed));
    const n = p.cols * p.rows;
    this.tileY = new Float32Array(n);
    this.seams = patternSeams(p);

    const tileGeo = roundedBox(d, p.tileSize / 2, p.thickness / 2, p.tileSize / 2, 0.2, 3);
    tileGeo.translate(0, -p.thickness / 2, 0);
    this.tiles = new InstancedMesh(tileGeo, toon(d, { color: '#ffffff', rimStrength: 0.5 }), n);
    this.tiles.castShadow = true;
    this.tiles.receiveShadow = true;
    this.tiles.frustumCulled = false;
    this.object.add(this.tiles);
    const seamGeo = roundedBox(d, 0.5, 0.2, 0.5, 0.05, 2);
    seamGeo.translate(0, -0.2, 0);
    this.seamBody = new InstancedMesh(
      seamGeo,
      toon(d, { color: p.puzzle === 'mix' ? '#4a3a66' : '#9cc7e6', rimStrength: 0.3 }),
      Math.max(1, this.seams.length),
    );
    this.seamBody.frustumCulled = false;
    this.seamBody.receiveShadow = true;
    this.object.add(this.seamBody);

    const atlas = buildAtlas(d);
    const decalMat = d.track(new MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    if (atlas) {
      const tx = texture(atlas, uv());
      decalMat.colorNode = tx.rgb;
      decalMat.opacityNode = tx.a;
    }
    for (let id = 0; id < 8; id++)
      this.cells.push(cellPlane(d, id, p.tileSize * (id === FLAG_CELL ? 0.5 : 0.72)));
    const glow = glowMaterial(d, '#fff6b0', { opacity: 0.55 });
    const glowGeo = d.track(new PlaneGeometry(p.tileSize * 0.94, p.tileSize * 0.94));
    glowGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const c = patternTileCenter(i, p, { x: 0, y: 0, z: 0 });
      this.centres.push(new Vector3(c.x, 0, c.z));
      const decal = new Mesh(this.cells[0]!, decalMat);
      decal.renderOrder = 4;
      decal.visible = false;
      this.decals.push(decal);
      this.object.add(decal);
      const flag = new Mesh(this.cells[FLAG_CELL]!, decalMat);
      flag.renderOrder = 5;
      flag.visible = false;
      this.flags.push(flag);
      this.object.add(flag);
      const g = new Mesh(glowGeo, glow.mat);
      g.renderOrder = 3;
      g.visible = false;
      this.glows.push(g);
      this.object.add(g);
    }
    this.screen = new Screen(d, p.screen.width, p.screen.height);
    this.screen.mesh.position.set(p.screen.x, p.screen.y, p.screen.z);
    this.object.add(this.screen.mesh);
    this.update(0, 0);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtime && 'schedule' in runtime ? (runtime as unknown as PuzzleFloorView) : null;
    const schedule = view?.schedule ?? this.fallback;
    const k = puzzleRoundIndexAt(schedule, t);
    const r = k >= 0 ? schedule[k]! : null;
    const phase = r ? puzzlePhaseOf(r, t) : PuzzlePhase.Idle;
    const voided = !!r && !!view?.isVoided(r.index);
    this.drawTiles(r, phase, voided, t);
    this.drawScreen(r, phase, voided, t);
  }

  /** Trail tiles lit by the teaching round's walk-through at `t` (bit per tile). */
  private taught(r: PuzzleRound, t: number): Set<number> {
    const lit = new Set<number>();
    if (!r.teach) return lit;
    const from = r.start + (r.dropAt - r.start) * 0.65;
    if (t < from) return lit;
    if (this.p.puzzle === 'mix') {
      for (let i = 0; i < r.safe.length; i++) if (r.safe[i]) lit.add(i);
      return lit;
    }
    const f = Math.min(1, (t - from) / Math.max(0.01, r.dropAt - from) / 0.8);
    for (const path of r.trails) {
      const upto = Math.min(path.length - 1, Math.floor(f * path.length));
      for (let s = 0; s <= upto; s++) lit.add(path[s]!);
    }
    return lit;
  }

  private drawTiles(r: PuzzleRound | null, phase: number, voided: boolean, t: number): void {
    const p = this.p;
    const mix = p.puzzle === 'mix';
    const n = this.decals.length;
    const lit = r && (phase === PuzzlePhase.Read || phase === PuzzlePhase.Recall) ? this.taught(r, t) : null;
    const starts = new Set<number>();
    if (r) for (const path of r.trails) starts.add(path[0]!);
    for (let i = 0; i < n; i++) {
      const centre = this.centres[i]!;
      const safe = !!r && r.safe[i] === 1;
      const dropping = !!r && !safe && !voided;
      const value = r ? r.tiles[i]! : 0;
      let y = 0;
      let rx = 0;
      let rz = 0;
      let showDecal = false;
      let showFlag = false;
      // Base colour: the paint (mix) or ice (trail), grey / frosted while hidden.
      if (!r || phase === PuzzlePhase.Idle) this.c.copy(mix ? GREY : ICE);
      else if (phase === PuzzlePhase.Recall) {
        this.c.copy(mix ? GREY : starts.has(i) ? FLAG_TILE : FROST);
        showFlag = !mix && starts.has(i);
      } else {
        this.c.set(mix ? MIX_COLOR_HEX[value]! : starts.has(i) ? FLAG_TILE : ICE);
        showDecal = true;
        showFlag = !mix && starts.has(i);
      }
      if (r && phase === PuzzlePhase.Drop) {
        const kk = (t - r.dropAt) / Math.max(0.05, r.fallAt - r.dropAt);
        if (dropping) {
          const flash = Math.sin(t * (24 + 30 * kk)) > 0 ? WARN_A : WARN_B;
          this.c.lerp(flash, 0.5 + 0.4 * kk);
          rx = Math.sin(t * 47 + i) * 0.03 * (1 + kk);
          rz = Math.cos(t * 41 + i * 3) * 0.03 * (1 + kk);
        } else this.c.lerp(SAFE, 0.35);
      } else if (r && phase === PuzzlePhase.Fallen) {
        if (dropping) {
          const a = t - r.fallAt;
          y = -0.5 * 22 * a * a;
          if (y < -p.fallDepth) y = -1000;
          rx = a * 0.6;
          this.c.copy(WARN_A);
        } else if (!voided) this.c.lerp(SAFE, 0.35);
      } else if (r && phase === PuzzlePhase.Rise && dropping) {
        const kk = Math.min(1, (t - r.riseAt) / Math.max(0.05, r.end - r.riseAt));
        y = -4 * (1 - kk * kk * (3 - 2 * kk));
      }
      this.q.setFromAxisAngle(AXIS_X, rx).multiply(this.q2.setFromAxisAngle(AXIS_Z, rz));
      this.v.set(centre.x, y, centre.z);
      this.tiles.setMatrixAt(i, this.m.compose(this.v, this.q, this.s));
      this.tiles.setColorAt(i, this.c);
      this.tileY[i] = y;

      const decal = this.decals[i]!;
      decal.visible = showDecal && y > -2;
      if (decal.visible) {
        decal.geometry = this.cells[mix ? value : ARROW_CELL]!;
        decal.position.set(centre.x, y + 0.04, centre.z);
        // Arrow art points to local +Z (direction 0); each further direction is a quarter turn (+Z → +X → −Z → −X).
        decal.quaternion.setFromAxisAngle(AXIS_Y, mix ? 0 : (value * Math.PI) / 2);
      }
      const flag = this.flags[i]!;
      flag.visible = showFlag && y > -2;
      if (flag.visible)
        flag.position.set(centre.x - p.tileSize * 0.28, y + 0.06, centre.z + p.tileSize * 0.28);
      const g = this.glows[i]!;
      g.visible = !!lit && lit.has(i) && Math.sin(t * 9) > -0.6;
      if (g.visible) g.position.set(centre.x, y + 0.02, centre.z);
    }
    this.tiles.instanceMatrix.needsUpdate = true;
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
    for (let k = 0; k < this.seams.length; k++) {
      const s = this.seams[k]!;
      let up = true;
      for (const i of s.tiles) if (this.tileY[i]! < -0.01) up = false;
      this.q.identity();
      this.seamBody.setMatrixAt(
        k,
        this.m.compose(
          this.v.set(s.x, -p.seamDepth, s.z),
          this.q,
          this.s.set(up ? s.sizeX : 0, 1, up ? s.sizeZ : 0),
        ),
      );
    }
    this.s.set(1, 1, 1);
    this.seamBody.instanceMatrix.needsUpdate = true;
  }

  private drawScreen(r: PuzzleRound | null, phase: number, voided: boolean, t: number): void {
    const mix = this.p.puzzle === 'mix';
    if (!r || phase === PuzzlePhase.Idle) {
      this.screen.show('title', (g, w, h) => {
        drawText(g, mix ? 'COLOUR' : 'TRAIL', w / 2, h * 0.36, 150, mix ? '#ff8a1f' : '#9fd8ff');
        drawText(g, mix ? 'CAULDRON' : 'TRACER', w / 2, h * 0.68, 150, mix ? '#a259ff' : '#ffffff');
      });
      return;
    }
    const label = `ROUND ${r.number}`;
    if (phase === PuzzlePhase.Read || phase === PuzzlePhase.Recall) {
      const left = Math.ceil(r.dropAt - t);
      const recall = phase === PuzzlePhase.Recall;
      this.screen.show(`q${r.index}|${left}|${recall ? 1 : 0}`, (g, w, h) => {
        drawText(g, label, w * 0.2, h * 0.13, 48, '#cfd3ff');
        if (recall) drawText(g, 'REMEMBER!', w / 2, h * 0.13, 52, '#ff8fab');
        this.paintQuestion(g, r, w, h);
        drawText(g, String(left), w - 110, h * 0.15, 110, left <= 1 ? '#ff3d6e' : '#ffffff');
      });
      return;
    }
    const caption = voided ? 'NOBODY? AGAIN!' : phase === PuzzlePhase.Drop ? 'REVEAL!' : 'SAFE!';
    this.screen.show(`a${r.index}|${caption}`, (g, w, h) => {
      if (mix) {
        this.paintQuestion(g, r, w, h, true);
      } else {
        drawText(g, `${r.steps} STEPS`, w / 2, h * 0.42, 150, '#9fd8ff');
      }
      drawText(g, caption, w / 2, h * 0.84, 84, voided ? '#ff7a1a' : '#2bffb8');
    });
  }

  private paintQuestion(g: Ctx2D, r: PuzzleRound, w: number, h: number, answered = false): void {
    if (this.p.puzzle === 'trail') {
      drawText(g, `FOLLOW ${r.steps} STEPS`, w / 2, h * 0.47, 112, '#ffffff');
      drawFlag(g, w * 0.17, h * 0.77, 44, '#ff3d6e');
      drawText(g, 'FROM EACH FLAG', w * 0.54, h * 0.77, 58, '#ffe08a');
      return;
    }
    const cy = h * (answered ? 0.42 : 0.52);
    const rad = 82;
    drawColourBlob(g, r.a, w * 0.18, cy, rad);
    drawText(g, r.op === MixOp.Add ? '+' : '−', w * 0.33, cy, 130);
    drawColourBlob(g, r.b, w * 0.48, cy, rad);
    drawText(g, '=', w * 0.63, cy, 130);
    if (answered) drawColourBlob(g, r.answer, w * 0.8, cy, rad);
    else drawText(g, '?', w * 0.8, cy, 200, '#ffd23f');
    if (!answered) {
      const name = (c: number): string => MIX_COLORS[c]!.toUpperCase();
      drawText(
        g,
        `${name(r.a)} ${r.op === MixOp.Add ? '+' : '−'} ${name(r.b)}`,
        w / 2,
        h * 0.85,
        60,
        '#fff4dc',
      );
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}

/** Puzzle Floor visual factory. */
export const puzzleFloorVisual: ObstacleVisualFactory = (instance, ctx) =>
  new PuzzleFloorVisual(instance, ctx);
