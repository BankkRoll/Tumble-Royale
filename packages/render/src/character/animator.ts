/**
 * Procedural animator: turns `TumblerAnimInput` into a blended {@link Pose}.
 *
 * Layers, in order:
 * 1. State poses, crossfaded by per-state weights (fade time per target state).
 * 2. Clip (emote / celebration / victory) over a breathing idle base, faded in/out.
 * 3. Secondary motion: lean into acceleration and turns, squash & stretch from
 *    vertical speed and impulses (second-order dynamics), landing jiggle.
 *
 * Allocation-free per frame.
 */
import type { AnimClipId } from '@tumble/content/cosmetics';
import { CharacterState } from '@tumble/sim';
import { CLIPS, type ClipDef } from './clips.ts';
import { SecondOrder } from './dynamics.ts';
import type { ExpressionId } from './face.ts';
import { CH, Pose } from './pose.ts';
import { Bone } from './rig.ts';
import { STATE_COUNT, STATE_FACE, STATE_FADE, STATE_POSES, type PoseContext } from './states.ts';
import type { TumblerAnimInput } from './types.ts';

const TAU = Math.PI * 2;
const S = CharacterState;

const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** States whose body leans with acceleration and turns. */
const LOCOMOTION = new Set<number>([S.Idle, S.Run, S.Grab, S.Carry, S.Slime, S.Emote, S.Finished]);

/** Blended animation state for one Tumbler. */
export class Animator {
  /** Final pose after all layers. */
  readonly out = new Pose();
  /** Expression the face should blend towards. */
  expression: ExpressionId = 'neutral';
  /** Current state id. */
  state: number = S.Idle;

  private readonly tmp = new Pose();
  private readonly clipPose = new Pose();
  private readonly weights = new Float32Array(STATE_COUNT);
  private readonly ctx: PoseContext;
  private lastStateTime = 0;
  private time = 0;
  private clipId: AnimClipId | null = null;
  private clipTime = 0;
  private clipWeight = 0;
  private readonly squash = new SecondOrder(2.4, 0.28, 0, 0);
  private readonly lean = new SecondOrder(2, 0.55, 0, 0);
  private readonly roll = new SecondOrder(2, 0.55, 0, 0);
  private readonly jiggle = new SecondOrder(4.2, 0.22, 0, 0);
  private prevSpeed = 0;
  private prevFacing = 0;
  private prevGrounded = true;
  private prevVy = 0;
  private accel = 0;

  /** @param seed - Per-instance seed for idle noise. */
  constructor(seed: number) {
    this.weights[S.Idle] = 1;
    this.ctx = { t: 0, time: 0, speed: 0, vy: 0, grounded: true, phase: 0, seed, prevT: 0 };
  }

  /** The active clip definition, if any. */
  get clip(): ClipDef | null {
    return this.clipId ? CLIPS[this.clipId] : null;
  }

  /** Applies a one-shot squash kick (positive = squash first, then rebound). */
  kick(amount: number): void {
    this.squash.yd -= amount * 4.5;
    this.jiggle.yd -= amount * 3;
  }

  /** Snaps all blending (teleports, LOD pops, pooled reuse). */
  snap(state: number): void {
    this.weights.fill(0);
    this.weights[state] = 1;
    this.state = state;
    this.squash.reset(0);
    this.lean.reset(0);
    this.roll.reset(0);
    this.jiggle.reset(0);
  }

  /**
   * Advances the animator.
   *
   * @param dt - Seconds.
   * @param a - Animation input from sim or a menu scene.
   * @param clip - Clip to play (resolved from emote/celebration/victory ids), or null.
   */
  update(dt: number, a: TumblerAnimInput, clip: AnimClipId | null): void {
    this.time += dt;
    const state = a.state >= 0 && a.state < STATE_COUNT ? a.state : S.Idle;
    if (state !== this.state) {
      this.ctx.prevT = this.lastStateTime;
      this.state = state;
    }
    this.lastStateTime = a.stateTime;

    // 1. State crossfade.
    const rate = dt / STATE_FADE[state]!;
    let sum = 0;
    for (let i = 0; i < STATE_COUNT; i++) {
      const target = i === state ? 1 : 0;
      const w = this.weights[i]!;
      const d = target - w;
      this.weights[i] = w + (d > rate ? rate : d < -rate ? -rate : d);
      sum += this.weights[i]!;
    }

    const speed = Math.max(0, a.speed);
    const freq = 1.3 + Math.min(speed, 10) * 0.26;
    const c = this.ctx;
    c.phase = (c.phase + dt * freq * TAU) % TAU;
    c.t = a.stateTime;
    c.time = this.time;
    c.speed = speed;
    c.vy = a.verticalSpeed;
    c.grounded = a.grounded;

    const out = this.out.clear();
    for (let i = 0; i < STATE_COUNT; i++) {
      const w = this.weights[i]!;
      if (w < 0.001) continue;
      this.tmp.clear();
      STATE_POSES[i]!(this.tmp, c);
      out.addScaled(this.tmp, w / sum);
    }

    // 2. Clip layer.
    if (clip !== this.clipId) {
      if (this.clipId === null || this.clipWeight < 0.05) {
        this.clipId = clip;
        this.clipTime = 0;
      }
    }
    const wantClip = this.clipId !== null && clip === this.clipId;
    const cr = dt / 0.2;
    this.clipWeight = Math.max(0, Math.min(1, this.clipWeight + (wantClip ? cr : -cr)));
    let def: ClipDef | null = null;
    let ct = 0;
    if (this.clipId !== null) {
      def = CLIPS[this.clipId];
      this.clipTime += dt;
      ct = def.loop ? this.clipTime % def.duration : Math.min(this.clipTime, def.duration);
      if (this.clipWeight > 0) {
        const cp = this.clipPose.clear();
        STATE_POSES[S.Idle]!(cp, c);
        def.pose(cp, ct);
        out.lerp(cp, this.clipWeight);
      } else if (!wantClip) {
        this.clipId = null;
      }
    }

    // Expression.
    if (def && this.clipWeight > 0.5) this.expression = def.face(ct);
    else if (state === S.Run && speed > 7) this.expression = 'effort';
    else if (state === S.Jump && a.verticalSpeed < -6) this.expression = 'surprised';
    else this.expression = STATE_FACE[state]!;

    // 3. Secondary motion.
    const invDt = dt > 0 ? 1 / dt : 0;
    this.accel += ((speed - this.prevSpeed) * invDt - this.accel) * Math.min(1, dt * 8);
    const turn = wrapAngle(a.facing - this.prevFacing) * invDt;
    const loco = LOCOMOTION.has(state) && this.clipWeight < 0.5;
    const leanT = loco ? Math.max(-0.2, Math.min(0.3, this.accel * 0.025)) : 0;
    const rollT = loco ? Math.max(-0.32, Math.min(0.32, -turn * Math.min(speed, 9) * 0.022)) : 0;
    out.rot(Bone.spine, this.lean.update(dt, leanT), 0, 0);
    out.rot(Bone.hips, 0, 0, this.roll.update(dt, rollT));

    if (a.impulse) this.kick(a.impulse);
    if (!this.prevGrounded && a.grounded && this.prevVy < -5) this.kick(Math.min(1, -this.prevVy / 22));
    const airT = a.grounded ? 0 : Math.max(-0.1, Math.min(0.16, a.verticalSpeed * 0.01));
    const sq = this.squash.update(dt, airT);
    const stretch = Math.max(-0.45, Math.min(0.45, out.v[CH.stretch]! + sq));
    out.v[CH.stretch] = stretch;
    const jig = this.jiggle.update(dt, stretch) - stretch;
    out.rot(Bone.chest, jig * 1.6, 0, 0).rot(Bone.head, jig * 1.2, 0, 0);

    this.prevSpeed = speed;
    this.prevFacing = a.facing;
    this.prevGrounded = a.grounded;
    this.prevVy = a.verticalSpeed;
  }
}
