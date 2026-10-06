/**
 * Spectator camera maths: poses and blends, the comfort rules that turn a
 * long sweep into a cut, the free camera's motion and bounds (never below
 * the kill plane, never far outside the level), and the overview framing.
 */
import { describe, expect, it } from 'vitest';
import {
  CameraTransition,
  TRANSITION,
  blendPose,
  forwardOf,
  pose,
  poseLookingAt,
  transitionSeconds,
  wrapAngle,
} from '../src/game/spectate/cameraMath.ts';
import { FREE_CAM, FreeCam, freeCamBounds, idleFlyInput } from '../src/game/spectate/freeCam.ts';
import { OVERVIEW, courseBox, overviewPose } from '../src/game/spectate/overview.ts';

const round = {
  bounds: { min: { x: -30, y: -10, z: -20 }, max: { x: 30, y: 40, z: 220 } },
  killY: -12,
};

describe('camera poses', () => {
  it('looks at a target with the rig convention (positive pitch looks down)', () => {
    const p = poseLookingAt({ x: 0, y: 10, z: -10 }, { x: 0, y: 0, z: 0 });
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(Math.PI / 4);
    const f = forwardOf(p, { x: 0, y: 0, z: 0 });
    expect(f.y).toBeLessThan(0);
    expect(f.z).toBeGreaterThan(0);
  });

  it('blends yaw the short way round', () => {
    const a = pose(0, 0, 0, Math.PI - 0.1, 0);
    const b = pose(10, 0, 0, -Math.PI + 0.1, 0);
    const mid = blendPose(a, b, 0.5, pose());
    expect(Math.abs(wrapAngle(mid.yaw - Math.PI))).toBeLessThan(1e-9);
    expect(mid.x).toBeCloseTo(5);
  });

  it('eases from a frozen start to a moving target and then hands over', () => {
    const tr = new CameraTransition();
    const target = pose(20, 0, 0);
    tr.start(pose(0, 0, 0), 1);
    const out = pose();
    tr.apply(target, 0.5, out);
    expect(out.x).toBeCloseTo(10);
    tr.apply(target, 0.25, out);
    expect(out.x).toBeGreaterThan(10);
    tr.apply(target, 1, out);
    expect(tr.active).toBe(false);
    target.x = 30;
    expect(tr.apply(target, 0.1, out).x).toBe(30);
  });
});

describe('transition comfort rules', () => {
  const here = pose(0, 5, 0, 0, 0.3);

  it('cuts instead of blending with Reduce Motion', () => {
    expect(transitionSeconds(here, pose(5, 5, 0, 0, 0.3), true)).toBe(0);
  });

  it('blends short moves at least the minimum time', () => {
    expect(transitionSeconds(here, pose(1, 5, 0, 0, 0.3), false)).toBe(TRANSITION.minSeconds);
  });

  it('slows a longer move to the travel speed limit', () => {
    const s = transitionSeconds(here, pose(0, 5, 70, 0, 0.3), false);
    expect(s).toBeCloseTo(1, 5);
  });

  it('cuts a sweep across the course or a fast whip turn', () => {
    expect(transitionSeconds(here, pose(0, 5, 200, 0, 0.3), false)).toBe(0);
    expect(transitionSeconds(here, pose(0, 5, 0, Math.PI, 0.3), false)).toBe(0);
  });
});

describe('free camera', () => {
  const bounds = freeCamBounds(round);

  it('keeps its floor above the kill plane and its walls just outside the level', () => {
    expect(bounds.min.y).toBeGreaterThan(round.killY);
    expect(bounds.min.y).toBe(Math.max(round.killY, round.bounds.min.y) + FREE_CAM.aboveKill);
    expect(bounds.min.x).toBe(round.bounds.min.x - FREE_CAM.marginXZ);
    expect(bounds.max.z).toBe(round.bounds.max.z + FREE_CAM.marginXZ);
  });

  it('flies forward along its heading and strafes to the right like a Tumbler moves', () => {
    const cam = new FreeCam(pose(0, 5, 0, 0, 0));
    for (let i = 0; i < 60; i++) cam.step({ ...idleFlyInput(), z: 1 }, 1 / 60, bounds);
    expect(cam.pose.z).toBeGreaterThan(5);
    expect(Math.abs(cam.pose.x)).toBeLessThan(1e-6);
    const strafe = new FreeCam(pose(0, 5, 0, 0, 0));
    for (let i = 0; i < 60; i++) strafe.step({ ...idleFlyInput(), x: 1 }, 1 / 60, bounds);
    // Facing +z, right is −x (the sim's right = (−cos yaw, 0, sin yaw)).
    expect(strafe.pose.x).toBeLessThan(-5);
  });

  it('goes faster with the speed modifier', () => {
    const slow = new FreeCam(pose(0, 5, 0));
    const fast = new FreeCam(pose(0, 5, 0));
    for (let i = 0; i < 120; i++) {
      slow.step({ ...idleFlyInput(), z: 1 }, 1 / 60, bounds);
      fast.step({ ...idleFlyInput(), z: 1, boost: true }, 1 / 60, bounds);
    }
    expect(fast.pose.z).toBeGreaterThan(slow.pose.z * 2.5);
  });

  it('never sinks below the kill plane floor and stops against it', () => {
    const cam = new FreeCam(pose(0, 0, 0));
    for (let i = 0; i < 600; i++) cam.step({ ...idleFlyInput(), y: -1, boost: true }, 1 / 60, bounds);
    expect(cam.pose.y).toBe(bounds.min.y);
    expect(cam.vel.y).toBe(0);
    for (let i = 0; i < 6000; i++)
      cam.step({ ...idleFlyInput(), x: 1, z: 1, y: 1, boost: true }, 1 / 60, bounds);
    expect(cam.pose.x).toBeGreaterThanOrEqual(bounds.min.x);
    expect(cam.pose.x).toBeLessThanOrEqual(bounds.max.x);
    expect(cam.pose.z).toBeLessThanOrEqual(bounds.max.z);
    expect(cam.pose.y).toBeLessThanOrEqual(bounds.max.y);
  });

  it('turns with the look input and clamps pitch short of straight down', () => {
    const cam = new FreeCam(pose(0, 5, 0, 0, 0));
    cam.step({ ...idleFlyInput(), lookYaw: 0.5, lookPitch: 9 }, 1 / 60, bounds);
    expect(cam.pose.yaw).toBeCloseTo(-0.5);
    expect(cam.pose.pitch).toBeLessThan(Math.PI / 2);
  });

  it('ignores garbage input', () => {
    const cam = new FreeCam(pose(0, 5, 0));
    cam.step({ ...idleFlyInput(), x: Number.NaN, z: Infinity }, 1 / 60, bounds);
    expect(Number.isFinite(cam.pose.x) && Number.isFinite(cam.pose.z)).toBe(true);
  });
});

describe('overview framing', () => {
  const course = {
    geometry: [
      { shape: 'box', position: { x: 0, y: 0, z: 0 }, size: { x: 20, y: 2, z: 20 } },
      { shape: 'box', position: { x: 0, y: 0, z: 200 }, size: { x: 20, y: 2, z: 20 } },
      { shape: 'box', position: { x: 500, y: 0, z: 0 }, size: { x: 4, y: 4, z: 4 }, decorative: true },
    ],
    spawn: { origin: { x: 0, y: 1, z: 0 } },
    bounds: round.bounds,
  };

  it('measures the solid course and ignores decoration', () => {
    const box = courseBox(course);
    expect(box.max.x).toBeLessThan(50);
    expect(box.min.z).toBeLessThan(-9);
    expect(box.max.z).toBeGreaterThan(209);
  });

  it('falls back to the netcode bounds when a round has no geometry', () => {
    expect(courseBox({ ...course, geometry: [] })).toEqual(round.bounds);
  });

  it('looks across a long course from the side, tilted down, with every corner on screen', () => {
    const box = courseBox(course);
    const p = overviewPose(box, 60, 16 / 9);
    expect(p.yaw).toBeCloseTo(Math.PI / 2);
    expect(p.pitch).toBeCloseTo(OVERVIEW.pitch);
    const f = forwardOf(p, { x: 0, y: 0, z: 0 });
    const r = { x: -Math.cos(p.yaw), y: 0, z: Math.sin(p.yaw) };
    const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
    const tanV = Math.tan((60 * Math.PI) / 360);
    const tanH = tanV * (16 / 9);
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z]) {
          const d = { x: x - p.x, y: y - p.y, z: z - p.z };
          const depth = d.x * f.x + d.y * f.y + d.z * f.z;
          expect(depth).toBeGreaterThan(0);
          expect(Math.abs(d.x * r.x + d.y * r.y + d.z * r.z) / depth).toBeLessThanOrEqual(tanH + 1e-9);
          expect(Math.abs(d.x * u.x + d.y * u.y + d.z * u.z) / depth).toBeLessThanOrEqual(tanV + 1e-9);
        }
  });

  it('keeps a tiny arena a wide shot', () => {
    const p = overviewPose({ min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 1, z: 1 } }, 60, 1.5);
    expect(Math.hypot(p.x, p.y - 0.5, p.z)).toBeGreaterThanOrEqual(OVERVIEW.minDistance - 1e-6);
  });
});
