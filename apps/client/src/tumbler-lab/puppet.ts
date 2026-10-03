/**
 * Puppet: drives a Tumbler visual without the sim, with tiny scripted action
 * sequences (jump arcs, dive → slide → get-up, stun → recover, bounces,
 * emotes) so every animation state can be previewed in context.
 */
import { CharacterState } from '@tumble/sim';
import { CLIPS, type Tumbler, type TumblerAnimInput } from '@tumble/render/character';
import type { AnimClipId } from '@tumble/content/cosmetics';
import { GRAVITY_Y } from '@tumble/shared';

const S = CharacterState;

type Step = { state: number; duration: number; emote?: string | null; onStart?: () => void };

/** A scripted Tumbler. */
export class Puppet {
  readonly anim: TumblerAnimInput = {
    state: S.Idle,
    stateTime: 0,
    speed: 0,
    verticalSpeed: 0,
    facing: 0,
    grounded: true,
    emote: null,
    lookAt: undefined,
    impulse: 0,
    ghost: false,
  };
  /** State shown when no script runs. */
  baseState: number = S.Idle;
  /** Planar speed fed to the animator (and the run cycle). */
  speed = 0;
  /** Feet position. */
  x = 0;
  z = 0;
  y = 0;
  private vy = 0;
  private script: Step[] = [];
  private stepT = 0;

  constructor(readonly visual: Tumbler) {}

  /** True while a scripted sequence is playing. */
  get busy(): boolean {
    return this.script.length > 0;
  }

  private run(steps: Step[]): void {
    this.script = steps;
    this.stepT = 0;
    steps[0]?.onStart?.();
  }

  /** Ballistic jump with a landing squash. */
  jump(v = 9): void {
    this.vy = v;
    this.y = Math.max(this.y, 0.001);
    this.run([{ state: S.Jump, duration: 99 }]);
  }

  /** Bounce pad: big squash, then a high launch. */
  bounce(): void {
    this.anim.impulse = 1;
    this.run([
      { state: S.Bounce, duration: 0.12 },
      { state: S.Bounce, duration: 0.5, onStart: () => ((this.vy = 15), (this.y = 0.001)) },
      { state: S.Jump, duration: 99 },
    ]);
  }

  /** Dive → belly slide → push-up recovery. */
  dive(): void {
    this.vy = 4;
    this.y = Math.max(this.y, 0.001);
    this.run([
      { state: S.Dive, duration: 99 },
      { state: S.DiveSlide, duration: 0.7 },
      { state: S.GetUp, duration: 0.45 },
    ]);
  }

  /** Stun tumble (ragdoll when a manager is installed), then get up. */
  stun(seconds = 1.8): void {
    this.anim.impulse = 0.8;
    this.visual.hitFlash(0.8);
    this.run([
      { state: S.Stunned, duration: seconds },
      { state: S.GetUp, duration: 0.45 },
    ]);
  }

  /** Plays an emote/celebration/victory clip by id. */
  emote(clip: AnimClipId, seconds?: number): void {
    const def = CLIPS[clip];
    this.run([{ state: S.Emote, duration: seconds ?? (def.loop ? def.duration * 2 : def.duration + 0.2), emote: clip }]);
  }

  /** Cancels any script. */
  stop(): void {
    this.script = [];
  }

  /**
   * Advances the puppet and its visual.
   *
   * @param dt - Seconds.
   */
  update(dt: number): void {
    const a = this.anim;
    const step = this.script[0];
    let state = this.baseState;
    a.emote = null;
    if (step) {
      state = step.state;
      a.emote = step.emote ?? null;
      this.stepT += dt;
      const airborneStep = step.duration >= 99;
      if ((airborneStep && this.y <= 0 && this.vy <= 0 && this.stepT > 0.05) || (!airborneStep && this.stepT >= step.duration)) {
        this.script.shift();
        this.stepT = 0;
        this.script[0]?.onStart?.();
      }
    }

    if (this.y > 0 || this.vy > 0) {
      this.vy += GRAVITY_Y * dt;
      this.y += this.vy * dt;
      if (state === S.Jump && this.vy < -2 && !step) state = S.Fall;
      if (this.y <= 0) {
        if (this.vy < -5) a.impulse = Math.min(1, -this.vy / 20);
        this.y = 0;
        this.vy = 0;
      }
    }
    if (state === S.Fall && this.baseState === S.Fall) {
      // Previewing the fall pose: hover so the windmill reads.
      this.y = 0.6 + Math.sin(performance.now() / 300) * 0.05;
    }

    if (state !== a.state) {
      a.state = state;
      a.stateTime = 0;
    } else a.stateTime += dt;
    a.grounded = this.y <= 0.0001;
    a.verticalSpeed = this.vy;
    a.speed = state === S.Run || state === S.Slime || state === S.Grab || state === S.Carry ? this.speed : 0;
    if (state === S.Dive || state === S.DiveSlide) a.speed = 7;

    this.visual.object.position.set(this.x, this.y, this.z);
    this.visual.update(dt, a);
    a.impulse = 0;
  }
}
