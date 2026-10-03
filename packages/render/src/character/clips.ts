/**
 * Emote, celebration and victory clips.
 *
 * A tiny clip system: each clip is a duration, a loop flag, a pose function of
 * clip time (keyframes via {@link kf} or closed-form motion) and a face track.
 * Clips add on top of a breathing idle base, so untouched bones stay alive.
 */
import type { AnimClipId } from '@tumble/content/cosmetics';
import type { ExpressionId } from './face.ts';
import type { Pose } from './pose.ts';
import { Bone as B } from './rig.ts';

/** A procedural clip. */
export interface ClipDef {
  duration: number;
  loop: boolean;
  /** Adds the clip pose at clip time `t`. */
  pose(p: Pose, t: number): void;
  /** Facial expression at clip time `t`. */
  face(t: number): ExpressionId;
  /** Shows the trail of a celebration, used by VFX hooks. */
  celebratory?: boolean;
}

const { sin, cos, abs, max, PI } = Math;
const TAU = PI * 2;

/**
 * Samples a flat keyframe list `[t0, v0, t1, v1, …]` with smoothstep easing
 * between keys. Allocation-free.
 *
 * @param t - Time.
 * @param keys - Keyframes sorted by time.
 * @returns Interpolated value (clamped to the end keys).
 */
export function kf(t: number, keys: readonly number[]): number {
  const n = keys.length;
  if (n < 2) return 0;
  if (t <= keys[0]!) return keys[1]!;
  for (let i = 2; i < n; i += 2) {
    const t1 = keys[i]!;
    if (t <= t1) {
      const t0 = keys[i - 2]!;
      const u = (t - t0) / (t1 - t0 || 1);
      const e = u * u * (3 - 2 * u);
      return keys[i - 1]! + (keys[i + 1]! - keys[i - 1]!) * e;
    }
  }
  return keys[n - 1]!;
}

/** Every clip by id. */
export const CLIPS: Readonly<Record<AnimClipId, ClipDef>> = {
  wave: {
    duration: 2.4,
    loop: true,
    pose(p, t) {
      p.rot(B.upperArmR, -0.15, 0, -2.45).rot(B.lowerArmR, 0, 0, -0.45 - sin(t * 12) * 0.45);
      p.rot(B.head, 0, -0.15, 0.12).rot(B.chest, 0, -0.1, -0.06).stretch(sin(t * 6) * 0.02);
    },
    face: () => 'happy',
  },

  dance: {
    duration: 2,
    loop: true,
    pose(p, t) {
      const beat = sin(t * TAU * 2);
      const sway = sin(t * TAU);
      const bounce = abs(beat);
      p.rot(B.hips, 0, sway * 0.2, sway * 0.15).move(sway * 0.05, -bounce * 0.05, 0).stretch(-bounce * 0.03);
      p.rot(B.upperArmL, -0.3, 0, 0.6 + 1.2 * max(0, beat)).rot(B.lowerArmL, 0, 0, 0.7);
      p.rot(B.upperArmR, -0.3, 0, -0.6 - 1.2 * max(0, -beat)).rot(B.lowerArmR, 0, 0, -0.7);
      p.rot(B.head, 0, sway * 0.25, -sway * 0.12);
      p.sym(B.upperLegL, B.upperLegR, -0.25 * bounce, 0, 0.05);
      p.sym(B.lowerLegL, B.lowerLegR, 0.45 * bounce, 0, 0);
    },
    face: (t) => (t % 2 < 1 ? 'grin' : 'laugh'),
  },

  laugh: {
    duration: 1.6,
    loop: true,
    pose(p, t) {
      const shake = sin(t * 26);
      p.rot(B.spine, -0.25 + shake * 0.04, 0, 0).rot(B.head, -0.22 + shake * 0.05, 0, 0).stretch(shake * 0.02);
      p.sym(B.upperArmL, B.upperArmR, -0.7, 0, -0.25);
      p.sym(B.lowerArmL, B.lowerArmR, -1.2, 0, -0.3);
    },
    face: () => 'laugh',
  },

  flex: {
    duration: 2,
    loop: true,
    pose(p, t) {
      const pump = sin(t * TAU) * 0.5 + 0.5;
      p.sym(B.upperArmL, B.upperArmR, 0, 0, 1.45);
      p.sym(B.lowerArmL, B.lowerArmR, 0, 0, 1.25 + pump * 0.4);
      p.rot(B.chest, -0.1, 0, 0).stretch(0.02 + pump * 0.03);
      p.rot(B.head, -0.1, sin(t * PI) * 0.2, 0);
    },
    face: () => 'grin',
  },

  facepalm: {
    duration: 2.6,
    loop: false,
    pose(p, t) {
      const k = kf(t, [0, 0, 0.35, 1, 2.2, 1, 2.6, 0]);
      p.rot(B.upperArmR, -1.25 * k, 0, 0.55 * k).rot(B.lowerArmR, -1.75 * k, 0, 0);
      p.rot(B.head, 0.32 * k, sin(t * 5) * 0.15 * k, 0).rot(B.spine, 0.1 * k, 0, 0);
    },
    face: (t) => (t < 0.3 ? 'surprised' : 'wince'),
  },

  spin: {
    duration: 1.6,
    loop: false,
    pose(p, t) {
      const env = kf(t, [0, 0, 0.2, 1, 1.3, 1, 1.6, 0]);
      p.rot(B.root, 0, kf(t, [0, 0, 1.3, TAU * 2]), 0);
      p.sym(B.upperArmL, B.upperArmR, 0, 0, 1.4 * env);
      p.stretch(0.05 * env).rot(B.head, -0.1 * env, 0, 0);
    },
    face: () => 'laugh',
  },

  'jumping-jacks': {
    duration: 1,
    loop: true,
    pose(p, t) {
      const j = 0.5 - 0.5 * cos(t * TAU);
      p.move(0, abs(sin(t * TAU)) * 0.22, 0).stretch(0.06 * j - 0.04 * (1 - j));
      p.sym(B.upperArmL, B.upperArmR, 0, 0, 0.2 + 2.4 * j);
      p.sym(B.upperLegL, B.upperLegR, 0, 0, 0.05 + 0.35 * j);
    },
    face: () => 'determined',
  },

  bow: {
    duration: 2.4,
    loop: false,
    pose(p, t) {
      const k = kf(t, [0, 0, 0.5, 1, 1.8, 1, 2.4, 0]);
      p.rot(B.spine, 0.7 * k, 0, 0).rot(B.hips, 0.15 * k, 0, 0).rot(B.head, 0.2 * k, 0, 0);
      p.rot(B.upperArmR, -0.9 * k, 0, 0.7 * k).rot(B.lowerArmR, -1.2 * k, 0, 0);
      p.rot(B.upperArmL, 0.7 * k, 0, 0.2 * k);
    },
    face: () => 'content',
  },

  shrug: {
    duration: 1.6,
    loop: false,
    pose(p, t) {
      const k = kf(t, [0, 0, 0.35, 1, 1.1, 1, 1.6, 0]);
      p.sym(B.upperArmL, B.upperArmR, -0.3 * k, 0, 0.55 * k);
      p.sym(B.lowerArmL, B.lowerArmR, -1.3 * k, 0, -0.5 * k);
      p.stretch(0.05 * k).rot(B.head, 0, 0, 0.2 * k);
    },
    face: () => 'meh',
  },

  cheer: {
    duration: 1.2,
    loop: true,
    celebratory: true,
    pose(p, t) {
      const ph = (t / 1.2) * TAU;
      const air = max(0, sin(ph));
      p.move(0, air * 0.45, 0).stretch(air > 0 ? 0.08 * air : sin(ph) * 0.12);
      p.sym(B.upperArmL, B.upperArmR, -0.2, 0, 2.35 + sin(t * 12) * 0.15);
      p.sym(B.lowerArmL, B.lowerArmR, 0, 0, 0.25);
      p.sym(B.upperLegL, B.upperLegR, -0.5 * air, 0, 0.08);
      p.sym(B.lowerLegL, B.lowerLegR, 0.9 * air, 0, 0);
    },
    face: () => 'grin',
  },

  'fist-pump': {
    duration: 1.5,
    loop: true,
    celebratory: true,
    pose(p, t) {
      const k = abs(sin(t * PI * 2));
      p.rot(B.upperArmR, -0.3, 0, -1.1 - 1.4 * k).rot(B.lowerArmR, 0, 0, -1.3 + 1.1 * k);
      p.rot(B.upperArmL, 0.35, 0, 0.55).rot(B.lowerArmL, 0, 0, -1.5);
      p.rot(B.chest, -0.08, 0, 0.1 * k).stretch(0.04 * k).rot(B.head, -0.15 * k, 0, 0);
    },
    face: () => 'grin',
  },

  backflip: {
    duration: 1.8,
    loop: false,
    celebratory: true,
    pose(p, t) {
      const crouch = kf(t, [0, 0, 0.22, 1, 0.3, 0, 1.05, 0, 1.15, 0.8, 1.35, 0]);
      const air = t > 0.25 && t < 1.05 ? sin(((t - 0.25) / 0.8) * PI) : 0;
      const flip = kf(t, [0.25, 0, 1.05, -TAU]);
      p.move(0, air * 1.0, 0).stretch(-0.16 * crouch + 0.08 * air);
      p.rot(B.hips, flip, 0, 0);
      p.sym(B.upperLegL, B.upperLegR, -1.2 * air - 0.4 * crouch, 0, 0.05);
      p.sym(B.lowerLegL, B.lowerLegR, 1.6 * air + 0.8 * crouch, 0, 0);
      const up = kf(t, [1.1, 0, 1.4, 1]);
      p.sym(B.upperArmL, B.upperArmR, -0.8 * air, 0, 0.6 * crouch + 2.3 * up);
    },
    face: (t) => (t < 1.2 ? 'determined' : 'grin'),
  },

  'victory-superstar': {
    duration: 3,
    loop: true,
    celebratory: true,
    pose(p, t) {
      const w = sin((t / 1.5) * TAU);
      p.sym(B.upperArmL, B.upperArmR, -0.15, 0, 2.3 + w * 0.15);
      p.sym(B.lowerArmL, B.lowerArmR, 0, 0, 0.2);
      p.rot(B.hips, 0, 0, w * 0.08).rot(B.head, -0.15, w * 0.2, 0).stretch(0.03 + abs(w) * 0.02);
    },
    face: () => 'grin',
  },

  'victory-hero': {
    duration: 3,
    loop: true,
    celebratory: true,
    pose(p, t) {
      const b = sin(t * 2.1);
      p.sym(B.upperArmL, B.upperArmR, 0.35, 0, 0.6);
      p.sym(B.lowerArmL, B.lowerArmR, 0.3, 0, -1.5);
      p.rot(B.chest, -0.12 + b * 0.02, 0, 0).rot(B.head, -0.15, 0.35, 0).stretch(0.03 + b * 0.01);
      p.sym(B.upperLegL, B.upperLegR, 0, 0, 0.12);
    },
    face: () => 'smug',
  },

  'victory-twirl': {
    duration: 3.2,
    loop: true,
    celebratory: true,
    pose(p, t) {
      const spin = kf(t, [0, 0, 1.0, TAU]);
      const out = kf(t, [0, 0, 0.2, 1, 1.0, 1, 1.2, 0]);
      const curtsey = kf(t, [1.0, 0, 1.4, 1, 1.9, 1, 2.2, 0]);
      const vee = kf(t, [2.0, 0, 2.3, 1, 3.0, 1, 3.2, 0]);
      p.rot(B.root, 0, spin, 0);
      p.sym(B.upperArmL, B.upperArmR, 0.2 * curtsey, 0, 1.3 * out + 0.6 * curtsey + 2.3 * vee);
      p.rot(B.upperLegL, 0.3 * curtsey, 0, -0.1 * curtsey).rot(B.upperLegR, -0.2 * curtsey, 0, 0);
      p.sym(B.lowerLegL, B.lowerLegR, 0.5 * curtsey, 0, 0);
      p.move(0, -0.1 * curtsey, 0).rot(B.spine, 0.25 * curtsey, 0, 0).stretch(0.05 * out);
    },
    face: (t) => (t < 2 ? 'content' : 'grin'),
  },
};

