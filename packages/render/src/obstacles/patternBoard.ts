/**
 * Pattern Board visual: sixteen game-show tiles with glowing symbol decals,
 * the Big Screen (target symbol, NOT/DOUBLE twists, countdown, captions) and
 * the low sweeper bar.
 *
 * Everything is derived from the board's schedule at match time `t`; the only
 * replicated inputs are the per-round voided/judged bits read from the runtime.
 * Without a runtime (gallery) the visual rebuilds the schedule from the show seed.
 */
import {
  CanvasTexture,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
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
import { color, sin, texture, time, uv } from 'three/tsl';
import { Rng } from '@tumble/shared';
import type { ObstacleRuntime, PoseSample } from '@tumble/sim';
import {
  PatternBoardSchema,
  PatternKind,
  PatternPhase,
  buildPatternSchedule,
  patternBoardPose,
  patternPhaseOf,
  patternRoundIndexAt,
  patternSeams,
  patternTileCenter,
  type BoardRound,
  type PatternBoardParams,
  type PatternBoardView,
  type PatternSeam,
} from '@tumble/sim/obstacles';
import { Disposer, PAL, addOutline, applyInstanceTransform, glowMaterial, parseParams, roundedBox, solid, stripedToon, toon } from './visual-helpers-b.ts';
import { drawCross, drawSymbol, drawText, makeCanvas, type Ctx2D } from './patternSymbols.ts';
import type { ObstacleVisualFactory } from './types.ts';

const ATLAS_CELL = 256;
const LIT = new Color('#8f7dff');
const DARK = new Color('#2a2163');
const SAFE = new Color('#2bffb8');
const WARN_A = new Color('#ff3d6e');
const WARN_B = new Color('#ff7a1a');
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/** Plane geometry whose UVs pick cell `id` of the 4 × 2 symbol atlas. */
function symbolPlane(d: Disposer, id: number, size: number): BufferGeometry {
  const g = d.track(new PlaneGeometry(size, size));
  const uvs = g.getAttribute('uv');
  const u0 = (id % 4) / 4;
  const v0 = 1 - (Math.floor(id / 4) + 1) / 2;
  for (let i = 0; i < uvs.count; i++) uvs.setXY(i, u0 + uvs.getX(i) / 4, v0 + uvs.getY(i) / 2);
  uvs.needsUpdate = true;
  g.rotateX(-Math.PI / 2);
  return g;
}

function buildAtlas(d: Disposer): CanvasTexture | null {
  const canvas = makeCanvas(ATLAS_CELL * 4, ATLAS_CELL * 2);
  const g = canvas?.getContext('2d') as Ctx2D | null;
  if (!canvas || !g) return null;
  for (let id = 0; id < 8; id++) {
    const cx = (id % 4) * ATLAS_CELL + ATLAS_CELL / 2;
    const cy = Math.floor(id / 4) * ATLAS_CELL + ATLAS_CELL / 2;
    // Soft glow disc behind the symbol so it reads on dark tiles from afar.
    const grad = g.createRadialGradient(cx, cy, ATLAS_CELL * 0.1, cx, cy, ATLAS_CELL * 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(cx - ATLAS_CELL / 2, cy - ATLAS_CELL / 2, ATLAS_CELL, ATLAS_CELL);
    drawSymbol(g, id, cx, cy, ATLAS_CELL * 0.34);
  }
  const tex = d.track(new CanvasTexture(canvas as HTMLCanvasElement));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function arrowTexture(d: Disposer): CanvasTexture | null {
  const canvas = makeCanvas(256, 256);
  const g = canvas?.getContext('2d') as Ctx2D | null;
  if (!canvas || !g) return null;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(128, 222);
  g.lineTo(30, 110);
  g.lineTo(88, 110);
  g.lineTo(88, 34);
  g.lineTo(168, 34);
  g.lineTo(168, 110);
  g.lineTo(226, 110);
  g.closePath();
  g.lineWidth = 22;
  g.strokeStyle = '#1a1033';
  g.stroke();
  g.fillStyle = '#ff3d6e';
  g.fill();
  const tex = d.track(new CanvasTexture(canvas as HTMLCanvasElement));
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Big Screen: a canvas redrawn only when what it shows changes. */
class BigScreen {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas | null;
  private readonly g: Ctx2D | null;
  private readonly tex: CanvasTexture | null;
  private key = '';

  constructor(d: Disposer, width: number, height: number) {
    this.canvas = makeCanvas(1024, 512);
    this.g = (this.canvas?.getContext('2d') as Ctx2D | null) ?? null;
    this.tex = this.canvas ? d.track(new CanvasTexture(this.canvas as HTMLCanvasElement)) : null;
    if (this.tex) this.tex.colorSpace = SRGBColorSpace;
    const mat = d.track(new MeshBasicNodeMaterial());
    if (this.tex) mat.colorNode = texture(this.tex, uv()).rgb.mul(1.15);
    else mat.colorNode = color(new Color('#120a2e'));
    this.mesh = new Mesh(d.track(new PlaneGeometry(width, height)), mat);
    // The screen faces the board (−Z).
    this.mesh.rotation.y = Math.PI;
  }

  /** Redraws when `key` differs from the last frame's. */
  show(key: string, paint: (g: Ctx2D, w: number, h: number) => void): void {
    if (key === this.key || !this.g || !this.tex) return;
    this.key = key;
    const g = this.g;
    const w = 1024;
    const h = 512;
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#2a1450');
    bg.addColorStop(1, '#120a2e');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(0,229,255,0.18)';
    g.lineWidth = 2;
    for (let x = 0; x <= w; x += 64) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y <= h; y += 64) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    paint(g, w, h);
    g.lineWidth = 14;
    g.strokeStyle = '#ff3df2';
    g.strokeRect(7, 7, w - 14, h - 14);
    this.tex.needsUpdate = true;
  }
}

class PatternBoardVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: PatternBoardParams;
  private readonly fallback: BoardRound[];
  private readonly tiles: InstancedMesh;
  private readonly decals: Mesh[] = [];
  private readonly arrows: Mesh[] = [];
  private readonly symbolGeos: BufferGeometry[] = [];
  private readonly centres: Vector3[] = [];
  private readonly screen: BigScreen;
  private readonly bar = new Group();
  private readonly barGlow;
  private readonly poses: PoseSample[] = [];
  private readonly rim;
  private readonly seams: PatternSeam[];
  private readonly seamBody: InstancedMesh;
  private readonly seamGlow: InstancedMesh;
  /** Per-tile vertical offset this frame (seams vanish when a neighbour drops). */
  private readonly tileY: Float32Array;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly q2 = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3(1, 1, 1);
  private readonly c = new Color();

  constructor(
    instance: Parameters<ObstacleVisualFactory>[0],
    private readonly ctx: Parameters<ObstacleVisualFactory>[1],
  ) {
    const d = this.d;
    const p = (this.p = parseParams(PatternBoardSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    this.fallback = buildPatternSchedule(p, ctx.speedScale, new Rng(ctx.seed));
    const n = p.cols * p.rows;
    this.seams = patternSeams(p);
    this.tileY = new Float32Array(n);

    // Tiles: one instanced rounded slab per tile, coloured per state.
    const tileGeo = roundedBox(d, p.tileSize / 2, p.thickness / 2, p.tileSize / 2, 0.22, 3);
    tileGeo.translate(0, -p.thickness / 2, 0);
    const tileMat = toon(d, { color: '#ffffff', rimStrength: 0.6, rimColor: '#c9b8ff' });
    this.tiles = new InstancedMesh(tileGeo, tileMat, n);
    this.tiles.castShadow = true;
    this.tiles.receiveShadow = true;
    this.tiles.frustumCulled = false;
    this.object.add(this.tiles);
    // Seam strips between tiles (solid in the sim): dark channels with a neon core line.
    const rim = glowMaterial(d, '#d07bff', { additive: true });
    this.rim = rim;
    const seamBoxGeo = roundedBox(d, 0.5, 0.2, 0.5, 0.05, 2);
    seamBoxGeo.translate(0, -0.2, 0);
    const seamGlowGeo = d.track(new PlaneGeometry(1, 1));
    seamGlowGeo.rotateX(-Math.PI / 2);
    const seamCount = Math.max(1, this.seams.length);
    this.seamBody = new InstancedMesh(seamBoxGeo, toon(d, { color: '#3b2b86', rimStrength: 0.4 }), seamCount);
    this.seamGlow = new InstancedMesh(seamGlowGeo, rim.mat, seamCount);
    for (const mesh of [this.seamBody, this.seamGlow]) {
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
    this.seamBody.receiveShadow = true;

    const atlas = buildAtlas(d);
    const arrowTex = arrowTexture(d);
    const symMat = d.track(new MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    if (atlas) {
      const tx = texture(atlas, uv());
      symMat.colorNode = tx.rgb.mul(1.25);
      symMat.opacityNode = tx.a;
    }
    const arrowMat = d.track(new MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
    if (arrowTex) {
      const tx = texture(arrowTex, uv());
      arrowMat.colorNode = tx.rgb.mul(sin(time.mul(18)).mul(0.25).add(1.1));
      arrowMat.opacityNode = tx.a;
    }
    for (let id = 0; id < 8; id++) this.symbolGeos.push(symbolPlane(d, id, p.tileSize * 0.74));
    const arrowGeo = d.track(new PlaneGeometry(p.tileSize * 0.45, p.tileSize * 0.45));
    arrowGeo.rotateX(-Math.PI / 2);
    // Tip toward −Z: "down" for players facing the screen and in top-down views.
    arrowGeo.rotateY(Math.PI);
    for (let i = 0; i < n; i++) {
      const c = patternTileCenter(i, p, { x: 0, y: 0, z: 0 });
      this.centres.push(new Vector3(c.x, 0, c.z));
      const decal = new Mesh(this.symbolGeos[0]!, symMat);
      decal.renderOrder = 4;
      decal.visible = false;
      this.decals.push(decal);
      this.object.add(decal);
      const arrow = new Mesh(arrowGeo, arrowMat);
      arrow.renderOrder = 5;
      arrow.visible = false;
      this.arrows.push(arrow);
      this.object.add(arrow);
    }

    // Big Screen face in front of the static housing.
    this.screen = new BigScreen(d, p.screen.width, p.screen.height);
    this.screen.mesh.position.set(p.screen.x, p.screen.y, p.screen.z);
    this.object.add(this.screen.mesh);

    // Sweeper: hub post (always) and the bar (shown while lowered or lowering).
    const hub = solid(d.track(new CylinderGeometry(p.hubRadius, p.hubRadius * 1.1, p.hubHeight + 4, 24)), stripedToon(d, PAL.yellow, PAL.cream, 2.5, 'y'));
    hub.position.y = (p.hubHeight - 4) / 2;
    this.object.add(hub);
    const reach = p.sweeperLength - p.hubRadius;
    const barMat = stripedToon(d, PAL.magenta, PAL.orange, 1.6, 'y');
    const bar = solid(d.track(new CapsuleGeometry(p.sweeperRadius, Math.max(0.05, reach - 2 * p.sweeperRadius), 6, 14)), barMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.x = p.hubRadius + reach / 2;
    addOutline(d, bar, 0.04);
    this.bar.add(bar);
    const glow = glowMaterial(d, PAL.magenta, { additive: true });
    this.barGlow = glow.intensity;
    const halo = new Mesh(d.track(new CapsuleGeometry(p.sweeperRadius * 1.9, Math.max(0.05, reach - 2 * p.sweeperRadius), 4, 12)), glow.mat);
    halo.rotation.z = Math.PI / 2;
    halo.position.x = bar.position.x;
    this.bar.add(halo);
    this.object.add(this.bar);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtime && 'schedule' in runtime ? (runtime as unknown as PatternBoardView) : null;
    const schedule = view?.schedule ?? this.fallback;
    const k = patternRoundIndexAt(schedule, t);
    const r = k >= 0 ? schedule[k]! : null;
    const phase = r ? patternPhaseOf(r, t) : PatternPhase.Idle;
    const voided = !!r && !!view?.isVoided(r.index);
    this.drawTiles(r, phase, voided, t);
    this.drawScreen(r, phase, voided, t);

    patternBoardPose(t, this.p, this.poses, this.ctx.speedScale);
    const s = this.poses[0]!;
    this.bar.position.set(s.pos.x, s.pos.y, s.pos.z);
    this.bar.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
    this.bar.visible = s.pos.y < this.p.sweeperParkHeight - 0.05;
    this.barGlow.value = this.bar.visible ? 0.35 + 0.25 * Math.sin(t * 9) : 0;
    this.rim.intensity.value = phase === PatternPhase.Decide ? 0.55 + 0.35 * Math.sin(t * 8) : 0.4;
  }

  private drawTiles(r: BoardRound | null, phase: number, voided: boolean, t: number): void {
    const p = this.p;
    const n = this.decals.length;
    for (let i = 0; i < n; i++) {
      const centre = this.centres[i]!;
      const safe = !!r && (r.safeMask & (1 << i)) !== 0;
      const dropping = !!r && !safe && !voided;
      let y = 0;
      let lit = false;
      let symbol = 0;
      let rx = 0;
      let rz = 0;
      this.c.copy(DARK);
      if (r) {
        switch (phase) {
          case PatternPhase.Show:
            lit = true;
            symbol = r.shown[i]!;
            this.c.copy(LIT);
            break;
          case PatternPhase.Hide:
            break;
          case PatternPhase.Decide:
            if (r.litDecide) {
              lit = true;
              symbol = r.symbols[i]!;
              this.c.copy(LIT);
            }
            break;
          case PatternPhase.Drop: {
            lit = true;
            symbol = r.symbols[i]!;
            if (dropping) {
              const k = (t - r.dropAt) / Math.max(0.05, r.fallAt - r.dropAt);
              const flash = Math.sin(t * (24 + 30 * k)) > 0 ? WARN_A : WARN_B;
              this.c.copy(LIT).lerp(flash, 0.55 + 0.4 * k);
              rx = Math.sin(t * 47 + i) * 0.03 * (1 + k);
              rz = Math.cos(t * 41 + i * 3) * 0.03 * (1 + k);
            } else this.c.copy(LIT).lerp(SAFE, 0.45);
            break;
          }
          case PatternPhase.Fallen: {
            lit = !dropping;
            symbol = r.symbols[i]!;
            if (dropping) {
              const a = t - r.fallAt;
              y = -0.5 * 22 * a * a;
              if (y < -p.fallDepth) y = -1000;
              rx = a * 0.6;
              this.c.copy(WARN_A);
            } else this.c.copy(LIT).lerp(SAFE, voided ? 0 : 0.45);
            break;
          }
          case PatternPhase.Rise:
            if (dropping) {
              const k = Math.min(1, (t - r.riseAt) / Math.max(0.05, r.end - r.riseAt));
              y = -4 * (1 - k * k * (3 - 2 * k));
            }
            break;
          default:
            break;
        }
      }
      this.q.setFromAxisAngle(AXIS_X, rx).multiply(this.q2.setFromAxisAngle(AXIS_Z, rz));
      this.v.set(centre.x, y, centre.z);
      this.m.compose(this.v, this.q, this.s);
      this.tiles.setMatrixAt(i, this.m);
      this.tiles.setColorAt(i, this.c);
      this.tileY[i] = y;

      const decal = this.decals[i]!;
      decal.visible = lit && y > -2;
      if (decal.visible) {
        decal.geometry = this.symbolGeos[symbol % 8]!;
        decal.position.set(centre.x, y + 0.04, centre.z);
      }
      const arrow = this.arrows[i]!;
      arrow.visible = !!r && phase === PatternPhase.Drop && dropping;
      if (arrow.visible) arrow.position.set(centre.x + p.tileSize * 0.3, 0.06, centre.z - p.tileSize * 0.3);
    }
    this.tiles.instanceMatrix.needsUpdate = true;
    for (let k = 0; k < this.seams.length; k++) {
      const s = this.seams[k]!;
      let up = true;
      for (const i of s.tiles) if (this.tileY[i]! < -0.01) up = false;
      const sx = up ? s.sizeX : 0;
      const sz = up ? s.sizeZ : 0;
      this.q.identity();
      this.seamBody.setMatrixAt(k, this.m.compose(this.v.set(s.x, -p.seamDepth, s.z), this.q, this.s.set(sx, 1, sz)));
      const thin = Math.min(s.sizeX, s.sizeZ) * 0.3;
      this.seamGlow.setMatrixAt(
        k,
        this.m.compose(this.v.set(s.x, -p.seamDepth + 0.015, s.z), this.q, this.s.set(s.sizeX < s.sizeZ ? thin : sx, 1, s.sizeZ < s.sizeX ? thin : sz)),
      );
      if (!up) this.seamGlow.setMatrixAt(k, this.m.makeScale(0, 0, 0));
    }
    this.s.set(1, 1, 1);
    this.seamBody.instanceMatrix.needsUpdate = true;
    this.seamGlow.instanceMatrix.needsUpdate = true;
    if (this.tiles.instanceColor) this.tiles.instanceColor.needsUpdate = true;
  }

  private drawScreen(r: BoardRound | null, phase: number, voided: boolean, t: number): void {
    if (!r || phase === PatternPhase.Idle) {
      this.screen.show('title', (g, w, h) => {
        drawText(g, 'PATTERN', w / 2, h * 0.36, 150, '#ff3df2');
        drawText(g, 'PANIC!', w / 2, h * 0.68, 150, '#00e5ff');
      });
      return;
    }
    const round = `ROUND ${r.number}`;
    switch (phase) {
      case PatternPhase.Show: {
        const left = Math.ceil(r.hideAt - t);
        this.screen.show(`show${r.index}|${left}`, (g, w, h) => {
          drawText(g, round, w / 2, h * 0.16, 56, '#cfd3ff');
          drawText(g, r.litDecide ? 'FIND THE SYMBOL!' : 'MEMORISE!', w / 2, h * 0.5, 120, '#ffd23f');
          drawText(g, String(left), w / 2, h * 0.82, 90);
        });
        return;
      }
      case PatternPhase.Hide:
        this.screen.show(`hide${r.index}`, (g, w, h) => {
          drawText(g, round, w / 2, h * 0.16, 56, '#cfd3ff');
          drawText(g, '?', w / 2, h * 0.55, 260, '#b45cff');
          if (r.shift !== 0) drawText(g, r.shift > 0 ? 'SHIFT ▶' : '◀ SHIFT', w / 2, h * 0.88, 70, '#ff7a1a');
        });
        return;
      case PatternPhase.Decide: {
        const left = Math.ceil(r.dropAt - t);
        this.screen.show(`decide${r.index}|${left}`, (g, w, h) => {
          this.paintTarget(g, r, w, h);
          drawText(g, String(left), w - 120, h * 0.2, 120, left <= 1 ? '#ff3d6e' : '#ffffff');
        });
        return;
      }
      default: {
        const caption = voided ? 'NOBODY? AGAIN!' : phase === PatternPhase.Drop ? 'REVEAL!' : 'SAFE!';
        this.screen.show(`after${r.index}|${caption}`, (g, w, h) => {
          this.paintTarget(g, r, w, h, 0.62);
          drawText(g, caption, w / 2, h * 0.86, 84, voided ? '#ff7a1a' : '#2bffb8');
        });
      }
    }
  }

  private paintTarget(g: Ctx2D, r: BoardRound, w: number, h: number, scale = 1): void {
    const cy = h * 0.5 * (scale < 1 ? 0.85 : 1);
    const rad = h * 0.3 * scale;
    if (r.kind === PatternKind.Double) {
      drawSymbol(g, r.targets[0], w * 0.3, cy, rad * 0.85);
      drawText(g, '+', w / 2, cy, 120 * scale, '#ffffff');
      drawSymbol(g, r.targets[1], w * 0.7, cy, rad * 0.85);
      return;
    }
    drawSymbol(g, r.targets[0], w / 2, cy, rad);
    if (r.kind === PatternKind.Not) {
      drawCross(g, w / 2, cy, rad * 0.95);
      drawText(g, 'NOT', w * 0.2, cy, 110 * scale, '#ff3d6e');
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}


/** Pattern Board visual factory. */
export const patternBoardVisual: ObstacleVisualFactory = (instance, ctx) => new PatternBoardVisual(instance, ctx);
