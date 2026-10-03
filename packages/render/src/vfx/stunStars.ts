import {
  Euler,
  ExtrudeGeometry,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Shape,
  Vector3,
  type MeshToonNodeMaterial,
} from 'three/webgpu';
import { createToonMaterial } from '../materials/toon.ts';
import { GOLD_COLORS } from './palette.ts';

/**
 * Stun stars: chunky extruded cartoon stars circling a dazed head.
 *
 * Responsibilities:
 * - Up to {@link MAX_STUN_RINGS} rings of {@link STARS_PER_RING} stars in one
 *   instanced, toon-lit draw call.
 * - Rings follow a player anchor (looked up each frame) or stay at a fixed point.
 * - Pop-in with overshoot, orbit + bob + spin, shrink-out at the end.
 *
 * CPU-driven on purpose: at most 80 matrices per frame, and following a moving
 * player cannot be expressed analytically.
 */

/** Simultaneous stun rings. */
export const MAX_STUN_RINGS = 16;
/** Stars per ring. */
export const STARS_PER_RING = 5;

/** Read access to player anchors. */
export interface AnchorLookup {
  /**
   * @param id - Player id.
   * @param out - Receives the anchor.
   * @returns False when the anchor is unknown.
   */
  getAnchor(id: number, out: Vector3): boolean;
}

const HEAD_OFFSET = 0.95;
const TAU = Math.PI * 2;

const tmpPos = new Vector3();
const tmpAnchor = new Vector3();
const tmpScale = new Vector3();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpMatrix = new Matrix4();
const zeroMatrix = new Matrix4().makeScale(0, 0, 0);

function starGeometry(): ExtrudeGeometry {
  const shape = new Shape();
  const outer = 0.12;
  const inner = 0.055;
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelThickness: 0.018,
    bevelSize: 0.016,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geo.center();
  return geo;
}

/**
 * Ring-of-stars pool.
 *
 * @example
 * stars.add(pos.x, pos.y, pos.z, playerId, 1.2, 1, now);
 * stars.update(now, anchors);
 */
export class StunStars {
  /** The single draw call. */
  readonly object: InstancedMesh;
  private readonly material: MeshToonNodeMaterial;
  private readonly player = new Int16Array(MAX_STUN_RINGS).fill(-1);
  private readonly pos = new Float32Array(MAX_STUN_RINGS * 3);
  private readonly start = new Float64Array(MAX_STUN_RINGS);
  private readonly end = new Float64Array(MAX_STUN_RINGS);
  private readonly scale = new Float32Array(MAX_STUN_RINGS);
  private readonly phase = new Float32Array(MAX_STUN_RINGS);
  private readonly active = new Uint8Array(MAX_STUN_RINGS);
  private next = 0;

  constructor() {
    this.material = createToonMaterial({
      color: '#ffffff',
      rimStrength: 0.7,
      emissive: '#ffb627',
      emissiveIntensity: 0.25,
    });
    const capacity = MAX_STUN_RINGS * STARS_PER_RING;
    this.object = new InstancedMesh(starGeometry(), this.material, capacity);
    this.object.name = 'vfx-stun-stars';
    this.object.frustumCulled = false;
    this.object.count = 0;
    this.object.visible = false;
    for (let i = 0; i < capacity; i++) {
      const c = GOLD_COLORS[i % 2 === 0 ? 0 : 3] ?? GOLD_COLORS[0];
      if (c) this.object.setColorAt(i, c);
    }
  }

  /**
   * Starts a ring. When every ring is busy the oldest is replaced. A new ring
   * for a player who already has one refreshes that ring instead.
   *
   * @param x - Fallback anchor x (used when `playerId` is unknown or < 0).
   * @param y - Fallback anchor y.
   * @param z - Fallback anchor z.
   * @param playerId - Player to follow, or -1.
   * @param duration - Seconds.
   * @param scale - Size multiplier.
   * @param now - Current effect time.
   * @param delay - Seconds before it appears.
   */
  add(
    x: number,
    y: number,
    z: number,
    playerId: number,
    duration: number,
    scale: number,
    now: number,
    delay = 0,
  ): void {
    let slot = -1;
    if (playerId >= 0) {
      for (let i = 0; i < MAX_STUN_RINGS; i++) {
        if (this.active[i] && this.player[i] === playerId) {
          slot = i;
          break;
        }
      }
    }
    const refresh = slot >= 0 && (this.start[slot] ?? 0) <= now;
    if (slot < 0) {
      slot = this.next;
      this.next = (this.next + 1) % MAX_STUN_RINGS;
    }
    this.active[slot] = 1;
    this.player[slot] = playerId;
    this.pos[slot * 3] = x;
    this.pos[slot * 3 + 1] = y;
    this.pos[slot * 3 + 2] = z;
    if (!refresh) {
      this.start[slot] = now + delay;
      this.phase[slot] = Math.random() * TAU;
    }
    this.end[slot] = now + delay + Math.max(0.3, duration);
    this.scale[slot] = scale;
  }

  /**
   * Rebuilds instance matrices.
   *
   * @param now - Current effect time.
   * @param anchors - Player anchor lookup for rings that follow a player.
   */
  update(now: number, anchors: AnchorLookup): void {
    let any = false;
    let used = 0;
    const mesh = this.object;
    for (let r = 0; r < MAX_STUN_RINGS; r++) {
      const base = r * STARS_PER_RING;
      if (!this.active[r]) continue;
      const start = this.start[r] ?? 0;
      const end = this.end[r] ?? 0;
      if (now >= end) {
        this.active[r] = 0;
        for (let s = 0; s < STARS_PER_RING; s++) mesh.setMatrixAt(base + s, zeroMatrix);
        continue;
      }
      any = true;
      used = Math.max(used, base + STARS_PER_RING);
      const age = now - start;
      if (age < 0) {
        for (let s = 0; s < STARS_PER_RING; s++) mesh.setMatrixAt(base + s, zeroMatrix);
        continue;
      }
      const id = this.player[r] ?? -1;
      if (id < 0 || !anchors.getAnchor(id, tmpAnchor)) {
        tmpAnchor.set(this.pos[r * 3] ?? 0, this.pos[r * 3 + 1] ?? 0, this.pos[r * 3 + 2] ?? 0);
      }
      const k = this.scale[r] ?? 1;
      const popIn = Math.min(1, age / 0.18);
      const overshoot = 1 + Math.sin(popIn * Math.PI) * 0.35;
      const out = Math.min(1, (end - now) / 0.22);
      const env = popIn * overshoot * out;
      const radius = 0.42 * k * (0.85 + 0.15 * env);
      const spin = (this.phase[r] ?? 0) + age * 3.4;
      for (let s = 0; s < STARS_PER_RING; s++) {
        const a = spin + (s * TAU) / STARS_PER_RING;
        tmpPos.set(
          tmpAnchor.x + Math.cos(a) * radius,
          tmpAnchor.y + HEAD_OFFSET * k + Math.sin(a * 2 + age * 5) * 0.05 * k,
          tmpAnchor.z + Math.sin(a) * radius,
        );
        tmpEuler.set(0.25 * Math.sin(age * 4 + s), -a + Math.PI / 2, age * 6 + s);
        tmpQuat.setFromEuler(tmpEuler);
        const size = k * env * (s % 2 === 0 ? 1 : 0.8);
        tmpScale.set(size, size, size);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
        mesh.setMatrixAt(base + s, tmpMatrix);
      }
    }
    mesh.count = used;
    mesh.visible = any;
    if (any) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Removes every ring. */
  clear(): void {
    this.active.fill(0);
    this.object.count = 0;
    this.object.visible = false;
  }

  /** Frees GPU resources (the shared toon ramp survives). */
  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
    this.object.dispose();
    this.object.removeFromParent();
  }
}
