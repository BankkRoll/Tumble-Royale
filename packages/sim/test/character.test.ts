import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier, type Rapier } from '../src/index.ts';
import { Button, CharacterState, DEFAULT_TUNING, resolveTuning } from '../src/character/index.ts';
import { Harness, linearPose, spinPose } from './characterHarness.ts';

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

const feetY = (h: Harness, i = 0): number => {
  const p = { x: 0, y: 0, z: 0 };
  return h.controllers[i]!.getFeet(p).y;
};
const feet = (h: Harness, i = 0): { x: number; y: number; z: number } => h.controllers[i]!.getFeet({ x: 0, y: 0, z: 0 });

describe('tuning', () => {
  it('resolveTuning merges overrides without mutating defaults', () => {
    const t = resolveTuning({ maxSpeed: 12, surfaces: { ice: { decelMul: 0.01 } } } as never);
    expect(t.maxSpeed).toBe(12);
    expect(t.surfaces.ice.decelMul).toBe(0.01);
    expect(t.surfaces.ice.accelMul).toBe(DEFAULT_TUNING.surfaces.ice.accelMul);
    expect(DEFAULT_TUNING.surfaces.ice.decelMul).not.toBe(0.01);
    expect(DEFAULT_TUNING.maxSpeed).not.toBe(12);
  });
});

describe('locomotion', () => {
  it('settles on the ground and runs camera-relative', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0.5, z: 0 });
    h.step(30);
    expect(c.grounded).toBe(true);
    expect(c.state).toBe(CharacterState.Idle);
    expect(Math.abs(feetY(h))).toBeLessThan(0.02);

    // Camera yaw π/2 → forward is +X.
    h.inputs[0]!.moveZ = 1;
    h.inputs[0]!.yaw = Math.PI / 2;
    h.step(60);
    const p = feet(h);
    expect(c.state).toBe(CharacterState.Run);
    expect(p.x).toBeGreaterThan(6);
    expect(Math.abs(p.z)).toBeLessThan(0.05);
    const v = c.getVelocity({ x: 0, y: 0, z: 0 });
    expect(v.x).toBeCloseTo(DEFAULT_TUNING.maxSpeed, 1);
    expect(Math.abs(c.facing - Math.PI / 2)).toBeLessThan(0.01);

    // Snappy stop
    h.inputs[0]!.moveZ = 0;
    h.step(12);
    expect(Math.hypot(c.getVelocity(v).x, v.z)).toBeLessThan(0.01);
    h.dispose();
  });

  it('rides up a 0.3 m step but not a 0.6 m one', () => {
    for (const [height, climbs] of [
      [0.3, true],
      [0.6, false],
    ] as const) {
      const h = new Harness(R);
      h.floor();
      h.box(0, height, 10, 3, height / 2, 8);
      h.tumbler({ x: 0, y: 0, z: 0 });
      h.step(10);
      h.inputs[0]!.moveZ = 1;
      h.step(90);
      if (climbs) expect(feetY(h)).toBeCloseTo(height, 1);
      else expect(feetY(h)).toBeLessThan(0.1);
      h.dispose();
    }
  });

  it('climbs 30° and 45° slopes but not 60°', () => {
    for (const [deg, climbs] of [
      [30, true],
      [45, true],
      [60, false],
    ] as const) {
      const h = new Harness(R);
      h.floor();
      h.ramp(deg, 1.5);
      h.tumbler({ x: 0, y: 0, z: 0 });
      h.step(10);
      h.inputs[0]!.moveZ = 1;
      h.step(120);
      if (climbs) expect(feetY(h), `${deg}°`).toBeGreaterThan(2.5);
      else expect(feetY(h), `${deg}°`).toBeLessThan(1);
      h.dispose();
    }
  });

  it('adds conveyor belt velocity', () => {
    const h = new Harness(R);
    h.floor({ kind: 'conveyor', conveyorVelocity: { x: 3, y: 0, z: 0 } });
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(60);
    expect(c.getVelocity({ x: 0, y: 0, z: 0 }).x).toBeCloseTo(3, 1);
    h.dispose();
  });

  it('ice keeps momentum far longer than normal ground', () => {
    const stopDistance = (kind: 'normal' | 'ice'): number => {
      const h = new Harness(R);
      h.floor({ kind });
      h.tumbler({ x: 0, y: 0, z: 0 });
      h.step(5);
      h.inputs[0]!.moveZ = 1;
      h.step(150);
      const z0 = feet(h).z;
      h.inputs[0]!.moveZ = 0;
      h.step(120);
      const d = feet(h).z - z0;
      h.dispose();
      return d;
    };
    expect(stopDistance('ice')).toBeGreaterThan(stopDistance('normal') * 5);
  });
});

describe('jump', () => {
  const press = (h: Harness, button: number): void => {
    h.inputs[0]!.buttons |= button;
    h.step();
    h.inputs[0]!.buttons &= ~button;
  };

  it('variable height: holding jump goes higher than tapping', () => {
    const apex = (holdSteps: number): number => {
      const h = new Harness(R);
      h.floor();
      h.tumbler({ x: 0, y: 0, z: 0 });
      h.step(10);
      h.inputs[0]!.buttons = Button.Jump;
      let top = 0;
      for (let i = 0; i < 90; i++) {
        if (i === holdSteps) h.inputs[0]!.buttons = 0;
        h.step();
        top = Math.max(top, feetY(h));
      }
      h.dispose();
      return top;
    };
    const full = apex(60);
    const tap = apex(3);
    expect(full).toBeGreaterThan(1.4);
    expect(full).toBeLessThan(2.2);
    expect(tap).toBeLessThan(full * 0.6);
  });

  /** Ledge at z ∈ [-10, 0] over a deep pit; returns harness after the Tumbler walks off. */
  const walkOff = (): Harness => {
    const h = new Harness(R);
    h.box(0, -20, 0, 60, 0.5, 60);
    h.box(0, 0, -5, 3, 0.5, 5);
    const c = h.tumbler({ x: 0, y: 0, z: -2 });
    h.step(10);
    h.inputs[0]!.moveZ = 1;
    expect(h.until(() => !c.grounded, 120)).toBeGreaterThan(0);
    h.inputs[0]!.moveZ = 0;
    return h;
  };

  it('coyote time: jump accepted shortly after leaving a ledge', () => {
    const h = walkOff();
    const c = h.controllers[0]!;
    h.step(5); // ~83 ms
    press(h, Button.Jump);
    expect(c.state).toBe(CharacterState.Jump);
    expect(c.getVelocity({ x: 0, y: 0, z: 0 }).y).toBeGreaterThan(6);
    h.dispose();
  });

  it('coyote time: jump rejected after the window', () => {
    const h = walkOff();
    const c = h.controllers[0]!;
    h.step(12); // 200 ms
    press(h, Button.Jump);
    expect(c.state).not.toBe(CharacterState.Jump);
    expect(c.getVelocity({ x: 0, y: 0, z: 0 }).y).toBeLessThan(0);
    h.dispose();
  });

  it('jump buffer: a press shortly before landing jumps on touchdown', () => {
    const landTick = (): number => {
      const h = new Harness(R);
      h.floor();
      const c = h.tumbler({ x: 0, y: 3, z: 0 });
      const n = h.until(() => c.grounded, 200);
      h.dispose();
      return n;
    };
    const land = landTick();
    expect(land).toBeGreaterThan(20);

    const run = (pressAt: number): boolean => {
      const h = new Harness(R);
      h.floor();
      const c = h.tumbler({ x: 0, y: 3, z: 0 });
      h.step(pressAt);
      press(h, Button.Jump);
      let jumped = false;
      for (let i = 0; i < 40; i++) {
        h.step();
        if (c.state === CharacterState.Jump) jumped = true;
      }
      h.dispose();
      return jumped;
    };
    expect(run(land - 5)).toBe(true); // ~83 ms early
    expect(run(land - 15)).toBe(false); // 250 ms early
  });
});

describe('dive', () => {
  it('jump → dive chain lands into a belly slide, gets up, and returns to idle', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(10);
    h.inputs[0]!.moveZ = 1;
    h.step(30);
    h.inputs[0]!.buttons = Button.Jump;
    h.step(12);
    h.inputs[0]!.buttons = Button.Jump | Button.Dive;
    h.step();
    expect(c.state).toBe(CharacterState.Dive);
    const v = c.getVelocity({ x: 0, y: 0, z: 0 });
    expect(v.z).toBeGreaterThanOrEqual(DEFAULT_TUNING.diveSpeed - 0.5);
    h.inputs[0]!.buttons = 0;
    expect(h.until(() => c.state === CharacterState.DiveSlide, 120)).toBeGreaterThan(0);
    expect(h.until(() => c.state === CharacterState.GetUp, 120)).toBeGreaterThan(0);
    h.inputs[0]!.moveZ = 0;
    expect(h.until(() => c.state === CharacterState.Idle || c.state === CharacterState.Run, 60)).toBeGreaterThan(0);
    for (const e of ['jump', 'dive', 'land', 'getUp']) expect(h.log).toContain(e);
    h.dispose();
  });

  it('allows only one dive per airtime', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 6, z: 0 });
    h.step(5);
    h.inputs[0]!.buttons = Button.Dive;
    h.step();
    h.inputs[0]!.buttons = 0;
    h.step();
    h.inputs[0]!.buttons = Button.Dive;
    h.step();
    expect(h.log.filter((e) => e === 'dive').length).toBe(1);
    expect(c.state).toBe(CharacterState.Dive);
    h.dispose();
  });
});

describe('platforms', () => {
  it('rides a kinematic platform moving at constant velocity for 3 s', () => {
    const h = new Harness(R);
    h.box(0, -30, 0, 80, 0.5, 80);
    const plat = h.mover(2, 0.25, 2, linearPose({ x: 0, y: 0.75, z: 0 }, { x: 2.5, y: 0, z: 1 }));
    const c = h.tumbler({ x: 0.5, y: 1.02, z: -0.3 });
    h.step(10);
    const p0 = feet(h);
    const b0 = plat.body.translation();
    h.step(180);
    const p = feet(h);
    const b = plat.body.translation();
    expect(c.grounded).toBe(true);
    expect(p.x - b.x).toBeCloseTo(p0.x - b0.x, 2);
    expect(p.z - b.z).toBeCloseTo(p0.z - b0.z, 2);
    expect(p.y).toBeCloseTo(1, 1);
    h.dispose();
  });

  it('rides an elevator up and down', () => {
    const h = new Harness(R);
    h.box(0, -30, 0, 80, 0.5, 80);
    const pose = (t: number, pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number; w: number }): void => {
      pos.x = 0;
      pos.y = 0.75 + 3 * Math.sin(t);
      pos.z = 0;
      rot.x = rot.y = rot.z = 0;
      rot.w = 1;
    };
    const plat = h.mover(2, 0.25, 2, pose);
    const c = h.tumbler({ x: 0, y: 1, z: 0 });
    let maxGap = 0;
    for (let i = 0; i < 360; i++) {
      h.step();
      if (i > 30) maxGap = Math.max(maxGap, Math.abs(feetY(h) - (plat.body.translation().y + 0.25)));
    }
    expect(c.grounded).toBe(true);
    expect(maxGap).toBeLessThan(0.08);
    h.dispose();
  });

  it('rides a spinning disc without drifting and turns with it', () => {
    const h = new Harness(R);
    h.box(0, -30, 0, 80, 0.5, 80);
    const omega = 1.5;
    h.cylinderMover(5, 0.25, spinPose({ x: 0, y: 0.75, z: 0 }, omega));
    const c = h.tumbler({ x: 0, y: 1.02, z: 3 }, 0);
    h.step(20);
    const f0 = c.facing;
    const a0 = Math.atan2(feet(h).x, feet(h).z);
    h.step(180);
    const p = feet(h);
    const r = Math.hypot(p.x, p.z);
    expect(c.grounded).toBe(true);
    expect(r).toBeCloseTo(3, 1);
    const a1 = Math.atan2(p.x, p.z);
    const turned = (x: number): number => Math.atan2(Math.sin(x), Math.cos(x));
    expect(Math.abs(turned(a1 - a0 - omega * 3))).toBeLessThan(0.05);
    expect(Math.abs(turned(c.facing - f0 - omega * 3))).toBeLessThan(0.05);
    h.dispose();
  });

  it('keeps platform momentum when jumping off', () => {
    const h = new Harness(R);
    h.box(0, -30, 0, 80, 0.5, 80);
    h.mover(2, 0.25, 2, linearPose({ x: 0, y: 0.75, z: 0 }, { x: 4, y: 0, z: 0 }));
    const c = h.tumbler({ x: 0, y: 1.02, z: 0 });
    h.step(30);
    h.inputs[0]!.buttons = Button.Jump;
    h.step(10);
    expect(c.grounded).toBe(false);
    expect(c.getVelocity({ x: 0, y: 0, z: 0 }).x).toBeGreaterThan(3.5);
    h.dispose();
  });
});

describe('stun', () => {
  it('knock with stun tumbles, then recovers upright through GetUp', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(10);
    h.ctx.events.drain();
    c.knock({ x: 9, y: 5, z: 0 }, true);
    h.step();
    expect(c.state).toBe(CharacterState.Stunned);
    expect(h.log).toContain('stun');
    const stunSteps = h.until(() => c.state !== CharacterState.Stunned, 200);
    expect(stunSteps).toBeGreaterThanOrEqual(Math.floor(DEFAULT_TUNING.stunMinTime * 60) - 2);
    expect(stunSteps).toBeLessThanOrEqual(Math.ceil(DEFAULT_TUNING.stunMaxTime * 60) + 2);
    expect(h.until(() => c.state === CharacterState.Idle, 120)).toBeGreaterThanOrEqual(0);
    const q = c.body.rotation();
    expect(Math.abs(q.x)).toBeLessThan(1e-4);
    expect(Math.abs(q.z)).toBeLessThan(1e-4);
    expect(feetY(h)).toBeCloseTo(0, 1);
    expect(h.log).toContain('getUp');
    h.dispose();
  });

  it('a fast kinematic sweeper stuns; walking into a still one does not', () => {
    const run = (speed: number): boolean => {
      const h = new Harness(R);
      h.floor();
      h.mover(0.3, 0.6, 3, linearPose({ x: -4, y: 0.9, z: 0 }, { x: speed, y: 0, z: 0 }));
      const c = h.tumbler({ x: 0, y: 0, z: 0 });
      if (speed === 0) {
        h.inputs[0]!.moveZ = 1;
        h.inputs[0]!.yaw = -Math.PI / 2;
      }
      let stunned = false;
      for (let i = 0; i < 120; i++) {
        h.step();
        if (c.state === CharacterState.Stunned) stunned = true;
      }
      h.dispose();
      return stunned;
    };
    expect(run(12)).toBe(true);
    expect(run(0)).toBe(false);
  });
});

describe('grab', () => {
  it('grabs a player; the victim mashes free', () => {
    const h = new Harness(R);
    h.floor();
    const a = h.tumbler({ x: 0, y: 0, z: 0 }, 0);
    const b = h.tumbler({ x: 0, y: 0, z: 1.3 }, Math.PI);
    h.step(10);
    h.inputs[0]!.buttons = Button.Grab;
    h.step(2);
    expect(a.state).toBe(CharacterState.Grab);
    expect(b.state).toBe(CharacterState.Grabbed);
    expect(a.grabTargetId).toBe(b.id);
    expect(h.log).toContain('grabStart');
    // Victim walks away: dragged, stays near.
    h.inputs[1]!.moveZ = 1;
    h.inputs[1]!.yaw = 0;
    h.step(60);
    expect(b.state).toBe(CharacterState.Grabbed);
    const d = Math.hypot(feet(h, 1).x - feet(h, 0).x, feet(h, 1).z - feet(h, 0).z);
    expect(d).toBeLessThan(2);
    for (let i = 0; i < DEFAULT_TUNING.breakFreeMashes + 1; i++) {
      h.inputs[1]!.buttons = Button.Jump;
      h.step();
      h.inputs[1]!.buttons = 0;
      h.step();
    }
    expect(b.state).not.toBe(CharacterState.Grabbed);
    h.step(2);
    expect(a.grabTargetId).toBe(-1);
    expect(h.log).toContain('grabEnd');
    h.dispose();
  });

  it('grabber stamina runs out', () => {
    const h = new Harness(R);
    h.floor();
    const a = h.tumbler({ x: 0, y: 0, z: 0 }, 0);
    const b = h.tumbler({ x: 0, y: 0, z: 1.3 }, Math.PI);
    h.step(10);
    h.inputs[0]!.buttons = Button.Grab;
    h.step(Math.ceil(DEFAULT_TUNING.grabStaminaTime * 60) + 5);
    expect(b.state).not.toBe(CharacterState.Grabbed);
    expect(a.grabTargetId).toBe(-1);
    h.dispose();
  });
});

describe('ledges', () => {
  it('catches a 2.4 m grabbable ledge mid-jump, then climbs over with jump', () => {
    const h = new Harness(R);
    h.floor();
    h.box(0, 2.4, 3, 3, 1.2, 1, { kind: 'normal', grabbable: true });
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(5);
    h.inputs[0]!.moveZ = 1;
    h.step(8);
    h.inputs[0]!.buttons = Button.Jump;
    expect(h.until(() => c.state === CharacterState.LedgeHang, 90)).toBeGreaterThan(0);
    h.inputs[0]!.buttons = 0;
    h.step(10);
    expect(c.state).toBe(CharacterState.LedgeHang);
    h.inputs[0]!.buttons = Button.Jump;
    h.step();
    expect(c.state).toBe(CharacterState.LedgeClimb);
    h.inputs[0]!.buttons = 0;
    h.inputs[0]!.moveZ = 0;
    h.step(60);
    expect(feetY(h)).toBeCloseTo(2.4, 1);
    expect(c.grounded).toBe(true);
    h.dispose();
  });
});

describe('modes', () => {
  it('frozen: cannot move, can hop in place and emote', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(5);
    c.setFrozen(true);
    h.inputs[0]!.moveZ = 1;
    h.step(30);
    expect(Math.abs(feet(h).z)).toBeLessThan(0.01);
    h.inputs[0]!.buttons = Button.Jump;
    h.step(5);
    expect(c.state).toBe(CharacterState.Jump);
    h.inputs[0]!.buttons = 0;
    h.until(() => c.grounded && c.state === CharacterState.Idle, 120);
    h.inputs[0]!.moveZ = 0;
    h.inputs[0]!.emote = 2;
    h.step();
    h.inputs[0]!.emote = 0;
    expect(c.state).toBe(CharacterState.Emote);
    expect(c.emote).toBe(2);
    expect(Math.abs(feet(h).z)).toBeLessThan(0.01);
    h.dispose();
  });

  it('emote cancels on movement', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    h.step(5);
    h.inputs[0]!.emote = 1;
    h.step();
    h.inputs[0]!.emote = 0;
    expect(c.state).toBe(CharacterState.Emote);
    h.inputs[0]!.moveZ = 1;
    h.step(3);
    expect(c.state).toBe(CharacterState.Run);
    h.dispose();
  });

  it('ghost timer expires; fates disable the body', () => {
    const h = new Harness(R);
    h.floor();
    const c = h.tumbler({ x: 0, y: 0, z: 0 });
    c.setGhost(true, 0.5);
    h.step(10);
    expect(c.characterFlags & 1).toBe(1);
    h.step(30);
    expect(c.characterFlags & 1).toBe(0);
    c.setFate(CharacterState.Eliminated);
    expect(c.body.isEnabled()).toBe(false);
    h.step(5);
    c.setFate(CharacterState.Idle);
    expect(c.body.isEnabled()).toBe(true);
    h.dispose();
  });
});

describe('reach (gap design)', () => {
  /**
   * Runs at full speed off a ledge at z = 0 toward a landing at z = gap, jumping
   * at the last moment, optionally diving near the apex.
   */
  const crosses = (gap: number, dive: boolean): boolean => {
    const h = new Harness(R);
    h.box(0, -20, 0, 60, 0.5, 60);
    h.box(0, 0, -15, 3, 0.5, 15);
    h.box(0, 0, gap + 5, 3, 0.5, 5);
    const c = h.tumbler({ x: 0, y: 0, z: -14 });
    h.step(5);
    h.inputs[0]!.moveZ = 1;
    h.until(() => feet(h).z > -0.3, 300);
    h.inputs[0]!.buttons = Button.Jump;
    let dived = false;
    for (let i = 0; i < 150; i++) {
      h.step();
      const vy = c.getVelocity({ x: 0, y: 0, z: 0 }).y;
      if (i > 10 && c.grounded) h.inputs[0]!.moveZ = 0;
      if (dive && !dived && c.state === CharacterState.Jump && vy < 1) {
        h.inputs[0]!.buttons = Button.Jump | Button.Dive;
        dived = true;
      }
    }
    const ok = feetY(h) > -0.1 && feet(h).z > gap;
    h.dispose();
    return ok;
  };

  it('plain running jumps clear 2, 3.5 and 4.5 m gaps but not 5.5 m', () => {
    expect(crosses(2, false), '2 m').toBe(true);
    expect(crosses(3.5, false), '3.5 m').toBe(true);
    expect(crosses(4.5, false), '4.5 m').toBe(true);
    expect(crosses(5.5, false), '5.5 m').toBe(false);
  });

  it('a jump → dive chain clears 5.5 m', () => {
    expect(crosses(5.5, true)).toBe(true);
  });
});

describe('crush', () => {
  it('a descending kinematic slab squeezes the Tumbler out instead of through the floor', () => {
    const h = new Harness(R);
    h.floor();
    h.mover(1.5, 0.2, 1.5, (t, p, q) => {
      p.x = 0;
      p.y = Math.max(0.2, 4 - t * 1.5);
      p.z = 0;
      q.x = q.y = q.z = 0;
      q.w = 1;
    });
    const c = h.tumbler({ x: 0.3, y: 0, z: 0.2 });
    let minY = Infinity;
    for (let i = 0; i < 240; i++) {
      h.step();
      minY = Math.min(minY, feetY(h));
    }
    expect(minY).toBeGreaterThan(-0.3);
    const p = feet(h);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(1.5);
    expect(c.state).not.toBe(CharacterState.Stunned);
    h.dispose();
  });
});
