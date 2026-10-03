/**
 * Secondary-motion primitives: second-order dynamics springs and the chain
 * runtime that drives accessory pool bones (verlet strands, spinners,
 * flappers, bobbers). All per-frame work reuses preallocated scratch.
 */
import { Matrix4, Quaternion, Vector3, type Bone as ThreeBone } from 'three/webgpu';
import type { AssembledChain } from './assembly.ts';

/**
 * Second-order dynamics (frequency / damping / response), the classic
 * procedural-animation spring: `f` Hz natural frequency, `z` damping ratio
 * (< 1 wobbles), `r` initial response (< 0 anticipates, > 1 overshoots).
 */
export class SecondOrder {
  private k1 = 0;
  private k2 = 0;
  private k3 = 0;
  private xp: number;
  /** Current output. */
  y: number;
  /** Current output velocity. */
  yd = 0;

  /**
   * @param f - Natural frequency in Hz.
   * @param z - Damping ratio.
   * @param r - Initial response.
   * @param x0 - Initial value.
   */
  constructor(f: number, z: number, r: number, x0 = 0) {
    this.setParams(f, z, r);
    this.xp = x0;
    this.y = x0;
  }

  /** Re-tunes the spring without resetting its state. */
  setParams(f: number, z: number, r: number): void {
    const w = 2 * Math.PI * f;
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (w * w);
    this.k3 = (r * z) / w;
  }

  /** Snaps the spring to a value with zero velocity. */
  reset(x: number): void {
    this.xp = x;
    this.y = x;
    this.yd = 0;
  }

  /**
   * Advances the spring towards `x`.
   *
   * @param dt - Seconds.
   * @param x - Target.
   * @returns The new output.
   */
  update(dt: number, x: number): number {
    if (dt <= 0) return this.y;
    const xd = (x - this.xp) / dt;
    this.xp = x;
    // Clamping k2 keeps the integration stable at low frame rates.
    const k2 = Math.max(this.k2, (dt * dt) / 2 + (dt * this.k1) / 2, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}

const STEP = 1 / 60;
const GRAVITY = -14;

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpDir = new Vector3();
const tmpRest = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpQAttach = new Quaternion();
const tmpScale = new Vector3();
const tmpPos = new Vector3();
const tmpM = new Matrix4();
const tmpM2 = new Matrix4();

/**
 * Runtime state for one accessory chain.
 * Verlet chains simulate in world space so running, turning and falling
 * naturally swing them; the result is written back into pool bones.
 */
export class ChainRuntime {
  readonly def: AssembledChain;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly prev: Float32Array;
  /** Rest points in the attach bone's local space. */
  private readonly local: Float32Array;
  private readonly restLen: Float32Array;
  /** Rest segment directions (mesh space == attach local space; core bones rest unrotated). */
  private readonly restDir: Float32Array;
  private readonly attachRest: Vector3;
  private acc = 0;
  private angle = 0;
  private initialised = false;

  /**
   * @param def - Assembled chain.
   * @param attachRest - Rest position of the attach bone in mesh space.
   */
  constructor(def: AssembledChain, attachRest: Vector3) {
    this.def = def;
    this.attachRest = attachRest.clone();
    this.n = def.points.length;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.local = new Float32Array(this.n * 3);
    this.restLen = new Float32Array(Math.max(1, this.n - 1));
    this.restDir = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      const p = def.points[i]!;
      this.local.set([p.x - attachRest.x, p.y - attachRest.y, p.z - attachRest.z], i * 3);
      const q = def.points[Math.min(i + 1, this.n - 1)]!;
      const o = i + 1 < this.n ? p : def.points[Math.max(0, i - 1)]!;
      tmpDir.set(q.x - o.x, q.y - o.y, q.z - o.z);
      if (tmpDir.lengthSq() < 1e-8) tmpDir.set(0, 1, 0);
      tmpDir.normalize();
      this.restDir.set([tmpDir.x, tmpDir.y, tmpDir.z], i * 3);
      if (i < this.n - 1) this.restLen[i] = p.distanceTo(def.points[i + 1]!);
    }
  }

  private target(i: number, attachWorld: Matrix4, out: Vector3): Vector3 {
    return out
      .set(this.local[i * 3]!, this.local[i * 3 + 1]!, this.local[i * 3 + 2]!)
      .applyMatrix4(attachWorld);
  }

  /** Places every point at its rest target (spawn, teleport, LOD change). */
  reset(attachWorld: Matrix4): void {
    for (let i = 0; i < this.n; i++) {
      this.target(i, attachWorld, tmpV);
      const o = i * 3;
      this.pos[o] = this.prev[o] = tmpV.x;
      this.pos[o + 1] = this.prev[o + 1] = tmpV.y;
      this.pos[o + 2] = this.prev[o + 2] = tmpV.z;
    }
    this.initialised = true;
  }

  /**
   * Advances the chain.
   *
   * @param dt - Frame delta in seconds.
   * @param attachWorld - Attach bone world matrix.
   * @param spheres - Body collision spheres, xyzr world space.
   * @param sphereCount - Number of spheres used.
   * @param time - Animation clock (s).
   * @param speed - Planar run speed (m/s), drives spinners and tail wag.
   * @param simulate - false = kinematic (LOD1): points follow their rest targets.
   */
  update(
    dt: number,
    attachWorld: Matrix4,
    spheres: Float32Array,
    sphereCount: number,
    time: number,
    speed: number,
    simulate: boolean,
  ): void {
    const d = this.def;
    if (d.type === 'spin') {
      this.angle += dt * ((d.speed ?? 4) + (d.speedGain ?? 0) * speed);
      return;
    }
    if (d.type === 'flap') {
      this.angle = (d.amp ?? 0.3) * Math.sin(time * Math.PI * 2 * (d.freq ?? 1));
      return;
    }
    if (d.type === 'bob') {
      this.angle = (d.amp ?? 0.03) * Math.sin(time * Math.PI * 2 * (d.freq ?? 1));
      return;
    }

    this.target(0, attachWorld, tmpV);
    const jump = tmpV2.set(this.pos[0]!, this.pos[1]!, this.pos[2]!).distanceToSquared(tmpV);
    if (!this.initialised || !simulate || jump > 4) {
      this.reset(attachWorld);
      return;
    }

    this.acc = Math.min(this.acc + dt, STEP * 3);
    const stiff = d.stiffness ?? 0.1;
    const damp = 1 - (d.damping ?? 0.05);
    const g = GRAVITY * (d.gravity ?? 1) * STEP * STEP;
    const pr = d.radius ?? 0.04;
    const wag = (d.wag ?? 0) * Math.sin(time * (7 + speed)) * STEP * STEP * 30;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      const p = this.pos;
      const q = this.prev;
      this.target(0, attachWorld, tmpV);
      p[0] = q[0] = tmpV.x;
      p[1] = q[1] = tmpV.y;
      p[2] = q[2] = tmpV.z;
      for (let i = 1; i < this.n; i++) {
        const o = i * 3;
        const vx = (p[o]! - q[o]!) * damp;
        const vy = (p[o + 1]! - q[o + 1]!) * damp;
        const vz = (p[o + 2]! - q[o + 2]!) * damp;
        q[o] = p[o]!;
        q[o + 1] = p[o + 1]!;
        q[o + 2] = p[o + 2]!;
        tmpV2.set(attachWorld.elements[0]!, attachWorld.elements[1]!, attachWorld.elements[2]!).normalize();
        p[o] = p[o]! + vx + tmpV2.x * wag;
        p[o + 1] = p[o + 1]! + vy + g;
        p[o + 2] = p[o + 2]! + vz + tmpV2.z * wag;
      }
      for (let it = 0; it < 3; it++) {
        for (let i = 0; i < this.n - 1; i++) {
          const a = i * 3;
          const b = a + 3;
          tmpDir.set(p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!);
          const len = tmpDir.length() || 1e-6;
          const diff = (len - this.restLen[i]!) / len;
          // The root is pinned, so the first segment corrects only the free end.
          const wa = i === 0 ? 0 : 0.5;
          const wb = i === 0 ? 1 : 0.5;
          p[a] = p[a]! + tmpDir.x * diff * wa;
          p[a + 1] = p[a + 1]! + tmpDir.y * diff * wa;
          p[a + 2] = p[a + 2]! + tmpDir.z * diff * wa;
          p[b] = p[b]! - tmpDir.x * diff * wb;
          p[b + 1] = p[b + 1]! - tmpDir.y * diff * wb;
          p[b + 2] = p[b + 2]! - tmpDir.z * diff * wb;
        }
      }
      for (let i = 1; i < this.n; i++) {
        const o = i * 3;
        this.target(i, attachWorld, tmpRest);
        p[o] = p[o]! + (tmpRest.x - p[o]!) * stiff;
        p[o + 1] = p[o + 1]! + (tmpRest.y - p[o + 1]!) * stiff;
        p[o + 2] = p[o + 2]! + (tmpRest.z - p[o + 2]!) * stiff;
        for (let s = 0; s < sphereCount; s++) {
          const so = s * 4;
          tmpDir.set(p[o]! - spheres[so]!, p[o + 1]! - spheres[so + 1]!, p[o + 2]! - spheres[so + 2]!);
          const min = spheres[so + 3]! + pr;
          const l2 = tmpDir.lengthSq();
          if (l2 < min * min && l2 > 1e-10) {
            tmpDir.multiplyScalar(min / Math.sqrt(l2));
            p[o] = spheres[so]! + tmpDir.x;
            p[o + 1] = spheres[so + 1]! + tmpDir.y;
            p[o + 2] = spheres[so + 2]! + tmpDir.z;
          }
        }
      }
    }
  }

  /**
   * Writes this chain's pool bones.
   *
   * @param bones - Skeleton bones (pool bones are children of the mesh-space pivot).
   * @param attachWorld - Attach bone world matrix.
   * @param pivotInv - Inverse world matrix of the pool bones' parent.
   */
  writeBones(bones: ThreeBone[], attachWorld: Matrix4, pivotInv: Matrix4): void {
    const d = this.def;
    attachWorld.decompose(tmpPos, tmpQAttach, tmpScale);
    if (d.type !== 'verlet') {
      const bone = bones[d.firstBone];
      if (!bone) return;
      const pivot = d.points[0]!;
      tmpV.set(pivot.x - this.attachRest.x, pivot.y - this.attachRest.y, pivot.z - this.attachRest.z);
      const axis = d.axis ?? tmpV2.set(0, 1, 0);
      if (d.type === 'bob') {
        tmpV.addScaledVector(axis, this.angle);
        tmpQ.identity();
      } else {
        tmpQ.setFromAxisAngle(tmpDir.copy(axis).normalize(), this.angle);
      }
      tmpM.compose(tmpV, tmpQ, tmpV2.set(1, 1, 1));
      tmpM2.multiplyMatrices(attachWorld, tmpM);
      // Re-anchor at the pivot so the inverse bind (translate(-pivot)) lines up.
      tmpM.multiplyMatrices(pivotInv, tmpM2);
      tmpM.decompose(bone.position, bone.quaternion, bone.scale);
      return;
    }

    tmpQ2.copy(tmpQAttach).invert();
    for (let i = 0; i < this.n; i++) {
      const bone = bones[d.firstBone + i];
      if (!bone) continue;
      const o = i * 3;
      const j = i + 1 < this.n ? i + 1 : i;
      const k = i + 1 < this.n ? i : i - 1;
      tmpDir.set(
        this.pos[j * 3]! - this.pos[k * 3]!,
        this.pos[j * 3 + 1]! - this.pos[k * 3 + 1]!,
        this.pos[j * 3 + 2]! - this.pos[k * 3 + 2]!,
      );
      if (tmpDir.lengthSq() < 1e-10) tmpDir.set(this.restDir[o]!, this.restDir[o + 1]!, this.restDir[o + 2]!);
      tmpDir.normalize().applyQuaternion(tmpQ2);
      tmpRest.set(this.restDir[o]!, this.restDir[o + 1]!, this.restDir[o + 2]!);
      tmpQ.setFromUnitVectors(tmpRest, tmpDir).premultiply(tmpQAttach);
      tmpV.set(this.pos[o]!, this.pos[o + 1]!, this.pos[o + 2]!);
      tmpM.compose(tmpV, tmpQ, tmpV2.set(1, 1, 1));
      tmpM.premultiply(pivotInv);
      tmpM.decompose(bone.position, bone.quaternion, bone.scale);
    }
  }
}
