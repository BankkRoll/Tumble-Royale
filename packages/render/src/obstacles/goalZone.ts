/**
 * Goal Zone visual.
 *
 * - Goal mode: a rope net in the defending team's colour behind the mouth, a
 *   glowing goal line, and a celebration on every goal (net flash and bulge,
 *   team-colour confetti burst, a "GOAL!" sign).
 * - Nest mode: a woven basket ring of sticks in the owner's colour, egg-count
 *   pips that light as eggs come home, and a deposit pulse ring.
 *
 * Goal counts, timings and nest occupancy come from the replicated runtime.
 */
import {
  CapsuleGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';
import { abs, color, float, fract, max, mix, smoothstep, uniform, uv, vec2 } from 'three/tsl';
import { TEAM_COLORS, hash01 } from '@tumble/shared';
import type { ObstacleRuntime } from '@tumble/sim';
import { GoalZoneSchema, type GoalZoneParams, type GoalZoneView } from '@tumble/sim/obstacles';
import { Disposer, PAL, Sparkles, addEmissive, applyInstanceTransform, glowMaterial, labelTexture, parseParams, toon } from './visual-helpers-b.ts';
import type { ObstacleVisualFactory } from './types.ts';

const CONFETTI = 90;
const PIPS = 12;
const CELEBRATE = 2.2;

class GoalZoneVisual {
  readonly object = new Group();
  private readonly d = new Disposer();
  private readonly p: GoalZoneParams;
  private readonly teamColor: Color;
  private netFlash = uniform(0);
  private net: Group | null = null;
  private sign: Mesh | null = null;
  private confetti: Sparkles | null = null;
  private pips: InstancedMesh | null = null;
  private pipGlow = uniform(0);
  private pulse: Mesh | null = null;
  private pulseGlow: ReturnType<typeof glowMaterial>['intensity'] | null = null;
  private lastInside = 0;
  private pipCount = -1;
  private readonly cream = new Color(PAL.cream);
  private depositAt = -Infinity;
  private readonly seeds: Float32Array;
  private readonly m = new Matrix4();
  private readonly v = new Vector3();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();

  constructor(instance: Parameters<ObstacleVisualFactory>[0]) {
    const p = (this.p = parseParams(GoalZoneSchema, instance));
    applyInstanceTransform(this.object, instance);
    this.object.name = `obstacle:${instance.id}`;
    this.teamColor = new Color(TEAM_COLORS[p.team % TEAM_COLORS.length]!);
    this.seeds = new Float32Array(CONFETTI * 3);
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = hash01(i * 13 + p.team * 101);
    if (p.mode === 'goal') this.buildGoal();
    else this.buildNest();
  }

  /** Rope-grid material: bright knotted lines, see-through cells, flashes on goals. */
  private netMaterial(): MeshBasicNodeMaterial {
    const mat = this.d.track(new MeshBasicNodeMaterial({ transparent: true, side: DoubleSide, depthWrite: false }));
    const cell = fract(uv().mul(vec2(14, 7)));
    const line = max(smoothstep(float(0.4), float(0.5), abs(cell.x.sub(0.5))), smoothstep(float(0.4), float(0.5), abs(cell.y.sub(0.5))));
    const rope = mix(color(new Color('#fff6ea')), color(this.teamColor), float(0.35));
    mat.colorNode = rope.add(color(this.teamColor).mul(this.netFlash.mul(1.5)));
    mat.opacityNode = line.mul(0.85).add(this.netFlash.mul(0.25));
    return mat;
  }

  private buildGoal(): void {
    const d = this.d;
    const p = this.p;
    const front = p.mouthOffset ?? p.sizeZ / 2;
    const back = -p.sizeZ / 2;
    const depth = front - back;
    const w = p.mouthWidth;
    const h = p.mouthHeight;
    const mat = this.netMaterial();
    const net = new Group();
    const backNet = new Mesh(d.track(new PlaneGeometry(w, h, 12, 6)), mat);
    backNet.position.set(0, h / 2, back);
    net.add(backNet);
    const roof = new Mesh(d.track(new PlaneGeometry(w, depth)), mat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set(0, h, back + depth / 2);
    net.add(roof);
    for (const sx of [-1, 1]) {
      const side = new Mesh(d.track(new PlaneGeometry(depth, h)), mat);
      side.rotation.y = Math.PI / 2;
      side.position.set((sx * w) / 2, h / 2, back + depth / 2);
      net.add(side);
    }
    net.renderOrder = 6;
    this.net = net;
    this.object.add(net);

    // Goal line in the defending colour.
    const line = glowMaterial(d, this.teamColor, { additive: true });
    const strip = new Mesh(d.track(new PlaneGeometry(w, 0.35)), line.mat);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, 0.04, front);
    this.object.add(strip);

    const tex = labelTexture(d, 'GOAL!', { fill: '#ffffff', stroke: PAL.ink, background: TEAM_COLORS[p.team % 4]! });
    if (tex) {
      const signMat = d.track(new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false, side: DoubleSide }));
      this.sign = new Mesh(d.track(new PlaneGeometry(8, 2)), signMat);
      this.sign.position.set(0, h + 2.6, front);
      this.sign.visible = false;
      this.object.add(this.sign);
    }
    this.confetti = new Sparkles(d, CONFETTI, this.teamColor, 0.22);
    this.object.add(this.confetti.mesh);
  }

  private buildNest(): void {
    const d = this.d;
    const p = this.p;
    const sticks = 28;
    const stickGeo = d.track(new CapsuleGeometry(0.11, 1.1, 4, 8));
    const stickMat = toon(d, { color: '#ffffff', rimStrength: 0.5 });
    const ring = new InstancedMesh(stickGeo, stickMat, sticks);
    const cream = new Color(PAL.cream);
    for (let i = 0; i < sticks; i++) {
      const a = (i / sticks) * Math.PI * 2;
      const r = p.basketRadius + 0.32;
      // Alternate lean directions so the ring reads as weave.
      this.q.setFromAxisAngle(this.v.set(Math.cos(a + Math.PI / 2), 0, -Math.sin(a + Math.PI / 2)), i % 2 ? 0.35 : -0.35);
      this.m.compose(this.v.set(Math.cos(a) * r, 1.05, -Math.sin(a) * r), this.q, this.s.set(1, 1, 1));
      ring.setMatrixAt(i, this.m);
      ring.setColorAt(i, i % 2 ? this.teamColor : cream);
    }
    ring.castShadow = true;
    this.object.add(ring);

    const pipMat = toon(d, { color: PAL.cream, rimStrength: 0.6 });
    addEmissive(pipMat, color(this.teamColor).mul(this.pipGlow));
    this.pips = new InstancedMesh(d.track(new SphereGeometry(0.22, 12, 8)), pipMat, PIPS);
    for (let i = 0; i < PIPS; i++) {
      const a = Math.PI * (0.25 + (0.5 * i) / (PIPS - 1));
      this.m.makeTranslation(Math.cos(a) * 3.2, 3.6 + Math.sin(a) * 0.9, 4.9);
      this.pips.setMatrixAt(i, this.m);
      this.pips.setColorAt(i, cream);
    }
    this.object.add(this.pips);

    const glow = glowMaterial(d, this.teamColor, { additive: true });
    this.pulseGlow = glow.intensity;
    glow.intensity.value = 0;
    this.pulse = new Mesh(d.track(new TorusGeometry(1, 0.12, 8, 40)), glow.mat);
    this.pulse.rotation.x = Math.PI / 2;
    this.pulse.position.y = 0.75;
    this.object.add(this.pulse);
  }

  update(t: number, _dt: number, runtime?: ObstacleRuntime): void {
    const view = runtime && 'goals' in runtime ? (runtime as unknown as GoalZoneView) : null;
    if (this.p.mode === 'goal') this.updateGoal(t, view);
    else this.updateNest(t, view);
  }

  private updateGoal(t: number, view: GoalZoneView | null): void {
    const since = view ? t - view.lastGoalTime : Infinity;
    const live = since >= 0 && since < CELEBRATE;
    this.netFlash.value = live ? Math.max(0, 1 - since / 1.2) * (0.6 + 0.4 * Math.sin(since * 30)) : 0;
    if (this.net) this.net.scale.z = live ? 1 + Math.sin(Math.min(1, since * 3) * Math.PI) * 0.18 : 1;
    if (this.sign) {
      this.sign.visible = live;
      const pop = Math.min(1, since * 5);
      this.sign.scale.setScalar(live ? 0.6 + 0.4 * pop + Math.sin(since * 12) * 0.03 : 1);
    }
    const c = this.confetti;
    if (!c) return;
    const front = this.p.mouthOffset ?? this.p.sizeZ / 2;
    for (let i = 0; i < CONFETTI; i++) {
      if (!live) {
        c.set(i, 0, -1e4, 0, 0);
        continue;
      }
      const a = this.seeds[i * 3]! * Math.PI * 2;
      const up = 7 + this.seeds[i * 3 + 1]! * 8;
      const out = 2 + this.seeds[i * 3 + 2]! * 6;
      const tt = since;
      c.set(i, Math.cos(a) * out * tt, 2.5 + up * tt - 7 * tt * tt, front + Math.abs(Math.sin(a)) * out * tt, Math.max(0, 1.6 - tt * 0.6));
    }
    c.commit();
  }

  private updateNest(t: number, view: GoalZoneView | null): void {
    const inside = view ? view.inside : 0;
    if (inside > this.lastInside) this.depositAt = t;
    this.lastInside = inside;
    if (this.pips) {
      if (inside !== this.pipCount) {
        this.pipCount = inside;
        for (let i = 0; i < PIPS; i++) this.pips.setColorAt(i, i < inside ? this.teamColor : this.cream);
        if (this.pips.instanceColor) this.pips.instanceColor.needsUpdate = true;
      }
      this.pipGlow.value = inside > 0 ? 0.35 : 0;
    }
    const since = t - this.depositAt;
    if (this.pulse && this.pulseGlow) {
      const k = since >= 0 && since < 0.8 ? since / 0.8 : 1;
      this.pulse.scale.setScalar(0.5 + k * this.p.basketRadius);
      this.pulseGlow.value = k < 1 ? (1 - k) * 0.9 : 0;
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    this.d.dispose();
  }
}

/** Goal Zone visual factory. */
export const goalZoneVisual: ObstacleVisualFactory = (instance) => new GoalZoneVisual(instance);
