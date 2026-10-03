/**
 * Procedural pose per `CharacterState`.
 *
 * Each function ADDS its pose into a cleared {@link Pose}; the animator blends
 * the results by crossfade weight. Rotation conventions (radians, parent axes):
 * +X pitches a trunk bone forward and swings a hanging limb backward; positive
 * symmetric Z lifts a limb away from the body.
 */
import { CharacterState } from '@tumble/sim';
import type { ExpressionId } from './face.ts';
import { Pose, noise1 } from './pose.ts';
import { Bone as B } from './rig.ts';

/** Inputs every state pose reads. */
export interface PoseContext {
  /** Seconds in the current state. */
  t: number;
  /** Free-running animation clock. */
  time: number;
  speed: number;
  vy: number;
  grounded: boolean;
  /** Run cycle phase (radians), advanced by the animator. */
  phase: number;
  /** Per-instance noise seed. */
  seed: number;
  /** Seconds in the previous state when the current one began (GetUp blends from it). */
  prevT: number;
}

/** A state pose function. */
export type PoseFn = (p: Pose, c: PoseContext) => void;

const { sin, cos, abs, min, max, PI } = Math;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function idle(p: Pose, c: PoseContext): void {
  const breathe = sin(c.time * 2.1 + c.seed);
  p.rot(B.chest, breathe * 0.025, 0, 0).stretch(breathe * 0.012);
  const sway = noise1(c.time * 0.35, c.seed) * 0.05;
  p.rot(B.hips, 0, 0, sway).move(sway * 0.15, 0, 0);
  p.rot(B.head, noise1(c.time * 0.3, c.seed + 3) * 0.08, noise1(c.time * 0.22, c.seed + 2) * 0.3, -sway * 0.6);
  p.sym(B.upperArmL, B.upperArmR, noise1(c.time * 0.5, c.seed + 4) * 0.1, 0, 0.06 + breathe * 0.03);
  p.sym(B.lowerArmL, B.lowerArmR, -0.15, 0, 0);
  p.sym(B.upperLegL, B.upperLegR, 0, 0, 0.02);
  // Occasional fidget: a big one-armed stretch every few seconds.
  const f = (c.time + c.seed * 3.7) % 7.3;
  if (f < 1.2) {
    const k = sin((f / 1.2) * PI);
    p.rot(B.upperArmL, -0.3 * k, 0, 1.6 * k).rot(B.lowerArmL, 0, 0, 0.6 * k).rot(B.chest, 0, 0, -0.12 * k);
    p.rot(B.head, -0.1 * k, 0, 0.15 * k);
  }
}

function run(p: Pose, c: PoseContext, ampScale = 1): void {
  const amp = clamp01(c.speed / 6) * 0.75 * ampScale + 0.25;
  const ph = c.phase;
  const s = sin(ph);
  // Legs: forward swing is −X; knees bend on the recovery half.
  p.rot(B.upperLegL, -s * 0.85 * amp, 0, 0.04).rot(B.upperLegR, s * 0.85 * amp, 0, -0.04);
  p.rot(B.lowerLegL, (0.5 + 0.5 * cos(ph)) * 1.1 * amp, 0, 0).rot(B.lowerLegR, (0.5 - 0.5 * cos(ph)) * 1.1 * amp, 0, 0);
  p.rot(B.footL, s * 0.3 * amp, 0, 0).rot(B.footR, -s * 0.3 * amp, 0, 0);
  // Arms counter-swing with bent elbows.
  p.rot(B.upperArmL, s * 1.0 * amp, 0, 0.18).rot(B.upperArmR, -s * 1.0 * amp, 0, -0.18);
  p.sym(B.lowerArmL, B.lowerArmR, -0.9 - 0.2 * amp, 0, 0);
  // Trunk: bob on each footfall, twist with the stride, lean into speed.
  p.move(0, abs(s) * 0.075 * amp - 0.03 * amp, 0).stretch(-abs(cos(ph)) * 0.035 * amp);
  p.rot(B.hips, 0, s * 0.16 * amp, 0).rot(B.chest, 0.04, -s * 0.12 * amp, 0);
  p.rot(B.spine, 0.12 * amp, 0, 0).rot(B.head, -0.1 * amp, s * 0.05, 0);
}

/** Idle ↔ run by speed; used as the lower body of grab/carry. */
function locomotion(p: Pose, c: PoseContext): void {
  const w = clamp01((c.speed - 0.4) / 1.6);
  if (w < 1) {
    const tmp = scratchA.clear();
    idle(tmp, c);
    p.addScaled(tmp, 1 - w);
  }
  if (w > 0) {
    const tmp = scratchA.clear();
    run(tmp, c);
    p.addScaled(tmp, w);
  }
}

function jump(p: Pose, c: PoseContext): void {
  const rising = max(-1, min(1, c.vy / 8));
  p.sym(B.upperArmL, B.upperArmR, -0.3, 0, 1.15 + 0.55 * max(rising, 0));
  p.sym(B.lowerArmL, B.lowerArmR, -0.4, 0, 0.3);
  p.rot(B.upperLegL, -0.6, 0, 0.05).rot(B.lowerLegL, 1.0, 0, 0);
  p.rot(B.upperLegR, 0.1, 0, -0.05).rot(B.lowerLegR, 0.45, 0, 0);
  p.rot(B.spine, -0.08 * rising, 0, 0).rot(B.head, -0.1, 0, 0);
}

function fall(p: Pose, c: PoseContext): void {
  // Windmill: hanging arms circling forward, out of phase.
  const w = c.time * 14;
  p.rot(B.upperArmL, -w, 0, 0.45).rot(B.upperArmR, -w + PI, 0, -0.45);
  p.sym(B.lowerArmL, B.lowerArmR, -0.3, 0, 0);
  p.rot(B.upperLegL, sin(c.time * 12) * 0.6 - 0.2, 0, 0.1).rot(B.upperLegR, cos(c.time * 12) * 0.6 - 0.2, 0, -0.1);
  p.rot(B.lowerLegL, 0.6 + sin(c.time * 12) * 0.4, 0, 0).rot(B.lowerLegR, 0.6 + cos(c.time * 12) * 0.4, 0, 0);
  p.rot(B.spine, -0.14, 0, 0).rot(B.head, -0.12, sin(c.time * 9) * 0.15, 0);
}

function dive(p: Pose, c: PoseContext): void {
  // Not fully horizontal: a slight upward tilt keeps the face readable from a chase camera.
  p.rot(B.hips, 1.35, 0, 0).rot(B.spine, 0.04, 0, 0).rot(B.chest, -0.1, 0, 0).rot(B.head, -0.45, 0, 0);
  p.sym(B.upperArmL, B.upperArmR, 0, 0, 2.6);
  p.sym(B.lowerArmL, B.lowerArmR, 0, 0, 0.1);
  p.sym(B.upperLegL, B.upperLegR, 0.25, 0, 0.08);
  p.sym(B.lowerLegL, B.lowerLegR, 0.25, 0, 0);
  p.move(0, 0.05, -0.4).stretch(0.06 + sin(c.time * 30) * 0.01);
}

function diveSlide(p: Pose, c: PoseContext): void {
  dive(p, c);
  const decay = max(0, 1 - c.t * 1.5);
  p.move(0, -0.12, 0).stretch(-0.1);
  p.rot(B.hips, 0, sin(c.t * 15) * 0.14 * (0.3 + decay), 0);
  p.rot(B.upperLegL, sin(c.t * 18) * 0.35, 0, 0).rot(B.upperLegR, -sin(c.t * 18) * 0.35, 0, 0);
}

function getUp(p: Pose, c: PoseContext): void {
  const k = clamp01(c.t / 0.45);
  // Ease-out-back: the pop to standing slightly overshoots, like a push-up spring.
  const e = 1 + 2.4 * (k - 1) ** 3 + 1.4 * (k - 1) ** 2;
  const a = scratchB.clear();
  Object.assign(subCtx, c).t = c.prevT;
  diveSlide(a, subCtx);
  p.addScaled(a, 1 - e);
  const b = scratchB.clear();
  idle(b, c);
  p.addScaled(b, e);
  const push = sin(k * PI);
  p.sym(B.upperArmL, B.upperArmR, -0.9 * push, 0, -0.4 * push);
  p.sym(B.lowerArmL, B.lowerArmR, -0.6 * push, 0, 0);
}

function grab(p: Pose, c: PoseContext): void {
  locomotion(p, c);
  const reach = 0.85 + 0.15 * sin(c.time * 9);
  p.sym(B.upperArmL, B.upperArmR, -1.45 * reach, -0.18, -0.12);
  p.sym(B.lowerArmL, B.lowerArmR, -0.15, 0, 0);
  p.rot(B.spine, 0.14, 0, 0).rot(B.head, -0.08, 0, 0);
}

function grabbed(p: Pose, c: PoseContext): void {
  idle(p, c);
  const t = c.time;
  p.rot(B.hips, 0, sin(t * 18) * 0.22, sin(t * 13) * 0.08);
  p.rot(B.upperArmL, sin(t * 17) * 0.4, 0, 1.5 + sin(t * 20) * 0.5).rot(B.upperArmR, -sin(t * 17) * 0.4, 0, -1.5 - sin(t * 21) * 0.5);
  p.rot(B.upperLegL, sin(t * 15) * 0.5, 0, 0.1).rot(B.upperLegR, -sin(t * 15) * 0.5, 0, -0.1);
  p.rot(B.head, 0, sin(t * 11) * 0.3, 0);
}

function carry(p: Pose, c: PoseContext): void {
  locomotion(p, c);
  // Stubby arms can't clear the dome, so the load is held up and in front of the face.
  p.sym(B.upperArmL, B.upperArmR, -0.75, 0, 2.15);
  p.sym(B.lowerArmL, B.lowerArmR, 0, 0, -0.35);
  p.rot(B.spine, -0.06, 0, 0).stretch(-0.02);
}

function stunned(p: Pose, c: PoseContext): void {
  const t = c.t;
  p.rot(B.hips, t * 8.5, 0, sin(t * 4.3) * 0.5);
  p.move(0, 0.2 + abs(sin(t * 5)) * 0.28, 0);
  p.rot(B.upperArmL, sin(t * 6) * 0.6, 0, 1.3 + sin(t * 7) * 0.4).rot(B.upperArmR, -sin(t * 6) * 0.6, 0, -1.3 - sin(t * 7.3) * 0.4);
  p.sym(B.upperLegL, B.upperLegR, sin(t * 5) * 0.4, 0, 0.45);
  p.rot(B.head, sin(t * 5) * 0.3, sin(t * 3) * 0.2, 0);
}

function bounce(p: Pose, c: PoseContext): void {
  p.sym(B.upperArmL, B.upperArmR, -0.2, 0, 1.6 + sin(c.t * 10) * 0.15);
  p.sym(B.lowerArmL, B.lowerArmR, 0, 0, 0.4);
  p.sym(B.upperLegL, B.upperLegR, 0.05, 0, 0.12);
  p.rot(B.spine, -0.15, 0, 0).rot(B.head, -0.18, 0, 0);
}

function slime(p: Pose, c: PoseContext): void {
  run(p, c, 0.5);
  p.sym(B.upperLegL, B.upperLegR, -0.25, 0, 0);
  p.sym(B.upperArmL, B.upperArmR, -0.2, 0, 0.9 + sin(c.time * 4) * 0.1);
  p.sym(B.lowerArmL, B.lowerArmR, -0.9, 0, 0);
  p.move(0, -0.14, 0).rot(B.hips, 0, 0, sin(c.time * 3) * 0.08);
}

function ledgeHang(p: Pose, c: PoseContext): void {
  p.sym(B.upperArmL, B.upperArmR, -0.95, 0, 2.2);
  p.sym(B.lowerArmL, B.lowerArmR, -0.2, 0, 0);
  p.rot(B.upperLegL, sin(c.time * 2.2) * 0.25 - 0.1, 0, 0.06).rot(B.upperLegR, sin(c.time * 2.2 + 1.3) * 0.25 - 0.1, 0, -0.06);
  p.sym(B.lowerLegL, B.lowerLegR, 0.3, 0, 0);
  p.rot(B.spine, -0.12, 0, 0).rot(B.head, -0.25, 0, 0).stretch(0.05);
}

function ledgeClimb(p: Pose, c: PoseContext): void {
  const k = clamp01(c.t / 0.5);
  const mid = sin(k * PI);
  p.sym(B.upperArmL, B.upperArmR, -0.95 - 0.4 * k, 0, 2.2 - 1.5 * k);
  p.sym(B.lowerArmL, B.lowerArmR, -0.2 - 0.5 * mid, 0, 0);
  p.rot(B.hips, 0.65 * mid, 0, 0);
  p.sym(B.upperLegL, B.upperLegR, -1.0 * mid, 0, 0.05);
  p.sym(B.lowerLegL, B.lowerLegR, 1.1 * mid, 0, 0);
  p.rot(B.head, -0.25 * (1 - k), 0, 0);
}

function eliminated(p: Pose, c: PoseContext): void {
  const sway = sin(c.time * 0.9) * 0.04;
  p.rot(B.spine, 0.28, 0, sway).rot(B.head, 0.35, sin(c.time * 0.6) * 0.1, 0);
  p.sym(B.upperArmL, B.upperArmR, 0.1, 0, -0.08);
  p.sym(B.lowerArmL, B.lowerArmR, -0.1, 0, 0);
  p.stretch(-0.05 + sin(c.time * 1.4) * 0.008);
}

const scratchA = new Pose();
const scratchB = new Pose();
const subCtx: PoseContext = { t: 0, time: 0, speed: 0, vy: 0, grounded: true, phase: 0, seed: 0, prevT: 0 };

const S = CharacterState;

/** Number of state slots (max `CharacterState` id + 1). */
export const STATE_COUNT = 20;

/** Pose function per state id. */
export const STATE_POSES: readonly PoseFn[] = (() => {
  const fns: PoseFn[] = new Array<PoseFn>(STATE_COUNT).fill(idle);
  fns[S.Idle] = idle;
  fns[S.Run] = (p, c) => run(p, c);
  fns[S.Jump] = jump;
  fns[S.Fall] = fall;
  fns[S.Dive] = dive;
  fns[S.DiveSlide] = diveSlide;
  fns[S.GetUp] = getUp;
  fns[S.Grab] = grab;
  fns[S.Grabbed] = grabbed;
  fns[S.Carry] = carry;
  fns[S.Stunned] = stunned;
  fns[S.Bounce] = bounce;
  fns[S.Slime] = slime;
  fns[S.Emote] = idle;
  fns[S.Finished] = idle;
  fns[S.Spectating] = idle;
  fns[S.LedgeHang] = ledgeHang;
  fns[S.LedgeClimb] = ledgeClimb;
  fns[S.Respawning] = idle;
  fns[S.Eliminated] = eliminated;
  return fns;
})();

/** Facial expression per state. */
export const STATE_FACE: readonly ExpressionId[] = (() => {
  const f: ExpressionId[] = new Array<ExpressionId>(STATE_COUNT).fill('neutral');
  f[S.Run] = 'determined';
  f[S.Jump] = 'happy';
  f[S.Fall] = 'scared';
  f[S.Dive] = 'determined';
  f[S.DiveSlide] = 'tongue';
  f[S.GetUp] = 'wince';
  f[S.Grab] = 'determined';
  f[S.Grabbed] = 'struggle';
  f[S.Carry] = 'effort';
  f[S.Stunned] = 'dizzy';
  f[S.Bounce] = 'grin';
  f[S.Slime] = 'effort';
  f[S.Finished] = 'happy';
  f[S.LedgeHang] = 'effort';
  f[S.LedgeClimb] = 'effort';
  f[S.Respawning] = 'surprised';
  f[S.Eliminated] = 'sad';
  return f;
})();

/** Crossfade duration (s) when entering a state. Snappy actions blend fast. */
export const STATE_FADE: readonly number[] = (() => {
  const f = new Array<number>(STATE_COUNT).fill(0.16);
  f[S.Dive] = 0.08;
  f[S.Bounce] = 0.06;
  f[S.Stunned] = 0.08;
  f[S.GetUp] = 0.05;
  f[S.Jump] = 0.1;
  f[S.Idle] = 0.22;
  return f;
})();
