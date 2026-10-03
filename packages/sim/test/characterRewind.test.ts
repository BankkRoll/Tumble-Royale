import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier, type Rapier } from '../src/index.ts';
import {
  Button,
  copyCharacterFullState,
  createCharacterFullState,
  type CharacterFullState,
  type CharacterInput,
} from '../src/character/index.ts';
import { Harness, linearPose, spinPose } from './characterHarness.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

/** Same course every time: floor, moving platform, spinning disc, a wall, two Tumblers. */
function build(): Harness {
  const h = new Harness(R);
  h.floor();
  h.box(6, 1.2, 0, 1, 0.6, 3, { kind: 'normal', grabbable: true });
  h.mover(2, 0.25, 2, (t, p, q) => {
    linearPose({ x: -6, y: 0.6, z: 4 }, { x: 0, y: 0, z: 0 })(t, p, q);
    p.x += Math.sin(t * 1.3) * 3;
  });
  h.cylinderMover(3, 0.25, spinPose({ x: 0, y: 0.25, z: -6 }, 1.2));
  h.tumbler({ x: 0, y: 0, z: 0 }, 0);
  h.tumbler({ x: 1.5, y: 0, z: 1 }, Math.PI);
  return h;
}

/** Deterministic scripted input as a pure function of tick. */
function script(tick: number, i: number, out: CharacterInput): void {
  const phase = Math.floor(tick / 40);
  out.yaw = (tick * 0.013 + i) % (Math.PI * 2);
  out.moveX = Math.sin(tick * 0.05 + i);
  out.moveZ = Math.cos(tick * 0.031 + i * 2);
  let b = 0;
  if (tick % 37 < 6) b |= Button.Jump;
  if (tick % 53 === 20 + i) b |= Button.Dive;
  if (phase % 3 === 1 && i === 0) b |= Button.Grab;
  if (tick % 71 > 60 && i === 1) b |= Button.Jump;
  out.buttons = b;
  out.emote = tick % 97 === 0 ? 1 + (i % 4) : 0;
}

function run(h: Harness, from: number, to: number): void {
  for (let t = from; t < to; t++) {
    for (let i = 0; i < h.controllers.length; i++) script(t, i, h.inputs[i]!);
    // Knocks are part of the scenario too, so stun paths get replayed.
    if (t === 130) h.controllers[1]!.knock({ x: 4, y: 6, z: -8 }, true);
    if (t === 260) h.controllers[0]!.push({ x: 0.5, y: 0, z: 0.2 });
    h.step();
  }
}

function flatten(s: CharacterFullState): number[] {
  const e = s.ext!;
  return [
    s.pos.x, s.pos.y, s.pos.z, s.rot.x, s.rot.y, s.rot.z, s.rot.w,
    s.vel.x, s.vel.y, s.vel.z, s.angVel.x, s.angVel.y, s.angVel.z,
    s.state, s.stateTime, s.facing, s.grounded ? 1 : 0, s.coyoteTimer, s.jumpBufferTimer, s.jumpHeld ? 1 : 0,
    s.prevButtons, s.grabStamina, s.grabTarget, s.stunTimer, s.ghostTimer, s.emote, s.flags,
    e.carryVel.x, e.carryVel.y, e.carryVel.z, e.extVel.x, e.extVel.y, e.extVel.z,
    e.ledgePoint.x, e.ledgePoint.y, e.ledgePoint.z, e.ledgeNormal.x, e.ledgeNormal.y, e.ledgeNormal.z,
    e.latches, e.grabKind, e.partnerCollider, e.grabCooldown, e.breakFree, e.knockTimer, e.bounceCooldown,
  ];
}

describe('character rewind / replay', () => {
  it('getState → setState round-trips every field', () => {
    const h = build();
    run(h, 0, 200);
    const a = createCharacterFullState();
    const b = createCharacterFullState();
    h.controllers[0]!.getState(a);
    h.controllers[0]!.setState(a);
    h.controllers[0]!.getState(b);
    expect(flatten(b)).toEqual(flatten(a));
    const c = copyCharacterFullState(a, createCharacterFullState());
    expect(flatten(c)).toEqual(flatten(a));
    h.dispose();
  });

  it('restoring a snapshot at tick k into a fresh identical world replays bit-identically to N', () => {
    const N = 480;
    const K = 170;
    const original = build();
    run(original, 0, K);
    const snaps = original.controllers.map((c) => c.getState(createCharacterFullState()));
    // A fresh world identical to the original at tick K (Rapier snapshot: bodies, contact cache, broad phase)
    // driven by brand-new controller instances that only know what setState gives them.
    const replay = original.cloneFromSnapshot();
    run(original, K, N);
    const expected = original.controllers.map((c) => flatten(c.getState(createCharacterFullState())));
    for (const e of ['jump', 'dive', 'land', 'stun', 'getUp']) expect(original.log, e).toContain(e);
    original.dispose();

    for (let i = 0; i < replay.controllers.length; i++) replay.controllers[i]!.setState(snaps[i]!);
    run(replay, K, N);
    const actual = replay.controllers.map((c) => flatten(c.getState(createCharacterFullState())));
    replay.dispose();

    for (let i = 0; i < expected.length; i++) {
      const ex = expected[i]!;
      const ac = actual[i]!;
      for (let k = 0; k < ex.length; k++) {
        expect(Object.is(ac[k], ex[k]), `controller ${i} field ${k}: ${ac[k]} vs ${ex[k]}`).toBe(true);
      }
    }
  });

  it('two runs from scratch with the same inputs are bit-identical', () => {
    const N = 300;
    const a = build();
    run(a, 0, N);
    const ea = a.controllers.map((c) => flatten(c.getState(createCharacterFullState())));
    a.dispose();
    const b = build();
    run(b, 0, N);
    const eb = b.controllers.map((c) => flatten(c.getState(createCharacterFullState())));
    b.dispose();
    expect(eb).toEqual(ea);
  });

  it('restoring into a world rebuilt from scratch tracks the original closely', () => {
    // Without Rapier's contact cache the solver warm-starts differently, so this path is only
    // near-identical. It still catches any controller state that getState fails to capture,
    // because missing state shows up as a discrete divergence (wrong state id, timers).
    const K = 170;
    const M = 40;
    const original = build();
    run(original, 0, K);
    const snaps = original.controllers.map((c) => c.getState(createCharacterFullState()));
    run(original, K, K + M);
    const expected = original.controllers.map((c) => c.getState(createCharacterFullState()));
    original.dispose();

    const rebuilt = build();
    rebuilt.tick = K;
    rebuilt.syncMovers();
    // One priming step builds the broad phase so scene queries see the world, then restore again.
    rebuilt.world.step();
    rebuilt.syncMovers();
    for (let i = 0; i < rebuilt.controllers.length; i++) rebuilt.controllers[i]!.setState(snaps[i]!);
    run(rebuilt, K, K + M);
    const actual = rebuilt.controllers.map((c) => c.getState(createCharacterFullState()));
    rebuilt.dispose();

    for (let i = 0; i < expected.length; i++) {
      expect(actual[i]!.state).toBe(expected[i]!.state);
      expect(actual[i]!.stateTime).toBeCloseTo(expected[i]!.stateTime, 6);
      expect(Math.abs(actual[i]!.pos.x - expected[i]!.pos.x)).toBeLessThan(1e-2);
      expect(Math.abs(actual[i]!.pos.y - expected[i]!.pos.y)).toBeLessThan(1e-2);
      expect(Math.abs(actual[i]!.pos.z - expected[i]!.pos.z)).toBeLessThan(1e-2);
    }
  });
});
