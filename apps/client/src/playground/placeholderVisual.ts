/**
 * Placeholder Tumbler visual for the playground: capsule body, googly eyes,
 * mitten hands that reach when grabbing, and a spring-driven squash & stretch.
 *
 * It sits behind {@link CharacterVisual}, a structural subset of the art team's
 * `TumblerVisual` (`@tumble/render/character`), so the real Tumbler can replace
 * it without touching the playground loop.
 */
import { CapsuleGeometry, Group, Mesh, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import { createOutlineMaterial, createToonMaterial } from '@tumble/render';
import { CharacterState } from '@tumble/sim/character';

/** Per-frame animation input. Field-compatible with `TumblerAnimInput`. */
export interface CharacterAnim {
  state: number;
  stateTime: number;
  /** Planar speed (m/s). */
  speed: number;
  verticalSpeed: number;
  facing: number;
  grounded: boolean;
  emote: string | null;
  /** One-shot squash (negative) / stretch (positive) kick, consumed by the visual. */
  impulse?: number;
  /** Full body orientation while tumbling (stunned); ignored otherwise. */
  tumble?: { x: number; y: number; z: number; w: number };
}

/** What the playground needs from a Tumbler visual. */
export interface CharacterVisual {
  readonly object: Object3D;
  update(dt: number, anim: CharacterAnim): void;
  dispose(): void;
}

const HALF = 0.45;
const RADIUS = 0.45;
const CENTRE = HALF + RADIUS;

/**
 * Capsule Tumbler. `object` is placed at the feet; the body pivots at its centre.
 */
export class PlaceholderTumbler implements CharacterVisual {
  readonly object = new Group();
  private readonly pivot = new Group();
  private readonly squash = new Group();
  private readonly body: Mesh;
  private readonly hands: Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private spring = 0;
  private springVel = 0;
  private blink = 0;
  private time = 0;
  private readonly eyes: Group[] = [];
  private readonly q = new Quaternion();
  private readonly qYaw = new Quaternion();
  private readonly axisY = new Vector3(0, 1, 0);
  private readonly axisX = new Vector3(1, 0, 0);

  /** @param color - Body colour. */
  constructor(color: string) {
    const bodyGeo = new CapsuleGeometry(RADIUS, HALF * 2, 8, 24);
    const bodyMat = createToonMaterial({ color, rimStrength: 0.55 });
    const outlineMat = createOutlineMaterial(0.035);
    this.body = new Mesh(bodyGeo, bodyMat);
    this.body.castShadow = true;
    this.body.add(new Mesh(bodyGeo, outlineMat));
    this.disposables.push(bodyGeo, bodyMat, outlineMat);

    const white = createToonMaterial({ color: '#ffffff', rimStrength: 0 });
    const black = createToonMaterial({ color: '#1d1430', rimStrength: 0 });
    const eyeGeo = new SphereGeometry(0.13, 16, 12);
    const pupilGeo = new SphereGeometry(0.065, 12, 8);
    this.disposables.push(white, black, eyeGeo, pupilGeo);
    for (const side of [-1, 1]) {
      const eye = new Group();
      const ball = new Mesh(eyeGeo, white);
      const pupil = new Mesh(pupilGeo, black);
      pupil.position.set(0, 0, 0.09);
      eye.add(ball, pupil);
      eye.position.set(side * 0.16, 0.38, 0.36);
      this.body.add(eye);
      this.eyes.push(eye);
    }

    const handGeo = new SphereGeometry(0.14, 12, 10);
    const handMat = createToonMaterial({ color, rimStrength: 0.4 });
    this.disposables.push(handGeo, handMat);
    for (const side of [-1, 1]) {
      const h = new Mesh(handGeo, handMat);
      h.castShadow = true;
      h.position.set(side * 0.52, -0.05, 0.05);
      this.body.add(h);
      this.hands.push(h);
    }

    this.squash.add(this.body);
    this.pivot.add(this.squash);
    this.pivot.position.y = CENTRE;
    // Squash from the feet, not the centre: offset the scaled group down by its centre height.
    this.squash.position.y = -CENTRE;
    this.body.position.y = CENTRE;
    this.object.add(this.pivot);
  }

  update(dt: number, anim: CharacterAnim): void {
    this.time += dt;
    const S = CharacterState;

    // Second-order spring for squash/stretch: kicks from jumps/landings ring out quickly.
    if (anim.impulse) this.springVel += anim.impulse * 9;
    const k = 220;
    const c = 16;
    this.springVel += (-k * this.spring - c * this.springVel) * dt;
    this.spring += this.springVel * dt;
    let stretch = this.spring;
    if (!anim.grounded && anim.state !== S.Dive && anim.state !== S.Stunned) {
      stretch += Math.max(-0.1, Math.min(0.14, anim.verticalSpeed * 0.012));
    }
    const sy = Math.max(0.6, 1 + stretch);
    const sxz = 1 / Math.sqrt(sy);
    this.squash.scale.set(sxz, sy, sxz);

    // Orientation
    if (anim.state === S.Stunned && anim.tumble) {
      this.pivot.quaternion.set(anim.tumble.x, anim.tumble.y, anim.tumble.z, anim.tumble.w);
    } else {
      this.qYaw.setFromAxisAngle(this.axisY, anim.facing);
      let tilt = 0;
      if (anim.state === S.Dive) tilt = Math.min(1, anim.stateTime * 8) * 1.25;
      else if (anim.state === S.DiveSlide) tilt = 1.45;
      else if (anim.state === S.GetUp) tilt = 1.45 * Math.max(0, 1 - anim.stateTime / 0.45);
      else if (anim.state === S.Run) tilt = Math.min(0.22, anim.speed * 0.03);
      else if (anim.state === S.LedgeHang) tilt = -0.15;
      this.q.setFromAxisAngle(this.axisX, tilt);
      this.pivot.quaternion.copy(this.qYaw).multiply(this.q);
    }
    // Run bob, emote hop
    let bob = 0;
    if (anim.state === S.Run && anim.grounded) bob = Math.abs(Math.sin(this.time * Math.max(6, anim.speed * 2.2))) * 0.08;
    if (anim.state === S.Emote) bob = Math.abs(Math.sin(anim.stateTime * 9)) * 0.35;
    this.pivot.position.y = CENTRE + bob;
    if (anim.state === S.Emote) this.body.rotation.y = anim.stateTime * 6;
    else this.body.rotation.y = 0;

    // Hands: reach forward while grabbing/hanging, swing while running
    const reach =
      anim.state === S.Grab || anim.state === S.Carry || anim.state === S.LedgeHang || anim.state === S.LedgeClimb;
    const swing = anim.state === S.Run ? Math.sin(this.time * Math.max(6, anim.speed * 2.2)) * 0.25 : 0;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i]!;
      const side = i === 0 ? -1 : 1;
      const tz = reach ? 0.55 : 0.05 + swing * side;
      const ty = anim.state === S.LedgeHang || anim.state === S.LedgeClimb ? 0.75 : reach ? 0.15 : -0.05;
      const tx = reach ? side * 0.3 : side * 0.52;
      h.position.x += (tx - h.position.x) * Math.min(1, dt * 18);
      h.position.y += (ty - h.position.y) * Math.min(1, dt * 18);
      h.position.z += (tz - h.position.z) * Math.min(1, dt * 18);
    }

    // Blink, and dizzy wobbling eyes when stunned
    this.blink -= dt;
    if (this.blink < -0.12) this.blink = 2 + ((this.time * 7.31) % 2.5);
    const closed = this.blink < 0 ? 0.15 : 1;
    for (let i = 0; i < this.eyes.length; i++) {
      const e = this.eyes[i]!;
      e.scale.y = closed;
      const pupil = e.children[1]!;
      if (anim.state === S.Stunned) {
        pupil.position.x = Math.cos(this.time * 14 + i * 3) * 0.05;
        pupil.position.y = Math.sin(this.time * 14 + i * 3) * 0.05;
      } else {
        pupil.position.x = 0;
        pupil.position.y = anim.verticalSpeed < -6 ? 0.05 : 0;
      }
    }
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
