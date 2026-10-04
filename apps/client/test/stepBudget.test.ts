import { describe, expect, it } from 'vitest';
import { SIM_DT } from '@tumble/shared';
import { FixedStepper } from '@tumble/sim';
import { StepBudget } from '../src/game/show/stepBudget.ts';

describe('StepBudget', () => {
  it('leaves the stepper uncapped while the sim keeps up', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT });
    expect(b.cap(8)).toBe(8);
    b.record(4, 2); // 2 ms a step: 12 % of real time
    expect(b.cap(8)).toBe(8);
  });

  it('caps steps to the frame budget once one step costs most of its real time', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT, frameBudgetMs: 33 });
    b.record(36, 1); // a 100-Tumbler step on a throttled phone CPU
    expect(b.load).toBeGreaterThan(2);
    expect(b.cap(8)).toBe(1);
    const c = new StepBudget({ stepSeconds: SIM_DT, frameBudgetMs: 33 });
    c.record(25, 2);
    expect(c.cap(8)).toBe(2);
  });

  it('counts the time scale: double speed doubles the load', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT, timeScale: 2 });
    b.record(7, 1);
    expect(b.load).toBeCloseTo(7 / (1000 / 60 / 2));
    expect(b.cap(16)).toBe(4);
  });

  it('notices a slowdown quickly and trusts recovery slowly', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT });
    b.record(2, 1);
    b.record(20, 1);
    expect(b.stepMs).toBeGreaterThan(7);
    const before = b.stepMs;
    b.record(2, 1);
    expect(b.stepMs).toBeGreaterThan(before * 0.85);
  });

  it('ignores frames without steps and forgets on reset', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT });
    b.record(50, 0);
    expect(b.stepMs).toBe(0);
    b.record(30, 1);
    b.reset();
    expect(b.cap(8)).toBe(8);
  });

  it('breaks the catch-up spiral: steps per frame stay bounded and the backlog is dropped', () => {
    const b = new StepBudget({ stepSeconds: SIM_DT, frameBudgetMs: 33 });
    let steps = 0;
    const stepper = new FixedStepper(() => steps++, SIM_DT, 8);
    const stepCost = 30;
    const renderCost = 20;
    let frameMs = 16;
    const perFrame: number[] = [];
    for (let i = 0; i < 40; i++) {
      const before = steps;
      const n = stepper.advance(Math.min(0.1, frameMs / 1000), b.cap(8));
      b.record(n * stepCost, n);
      perFrame.push(steps - before);
      frameMs = renderCost + n * stepCost;
    }
    // Uncapped this settles at 6 steps (200 ms frames); budgeted it holds 1 step (50 ms frames).
    expect(perFrame.slice(5).every((n) => n <= 1)).toBe(true);
  });
});

describe('FixedStepper cap', () => {
  it('never exceeds the constructor cap and always allows one step', () => {
    let n = 0;
    const s = new FixedStepper(() => n++, 0.01, 4);
    expect(s.advance(0.1, 99)).toBe(4);
    expect(s.advance(0.1, 0)).toBe(1);
    expect(s.alpha).toBe(0);
  });
});
