import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS, QUALITY_TIERS, TierGovernor } from '../src/quality/index.ts';

/** Feeds `seconds` of frames at `ms` each; returns how many step-downs were asked for. */
function run(g: TierGovernor, ms: number, seconds: number, spent = true): number {
  let drops = 0;
  for (let t = 0; t < seconds * 1000; t += ms) if (g.sample(ms, spent)) drops++;
  return drops;
}

describe('TierGovernor', () => {
  it('steps down after frames stay well over budget (1.8x) with resolution spent', () => {
    const g = new TierGovernor({ targetMs: 1000 / 60, patienceS: 8, settleS: 6 });
    expect(run(g, 30, 10)).toBe(0); // settling, then still waiting out the patience
    expect(run(g, 30, 6)).toBe(1);
  });

  it('steps down sooner when frames take twice the budget', () => {
    const g = new TierGovernor({ targetMs: 1000 / 60, patienceS: 8, settleS: 6 });
    expect(run(g, 40, 6)).toBe(0); // settling
    expect(run(g, 40, 3.5)).toBe(1); // 40 ms is 2.4x a 60 fps budget: 3 s of patience
    const h = new TierGovernor({ targetMs: 1000 / 60, patienceS: 8, settleS: 6 });
    expect(run(h, 25, 6)).toBe(0);
    expect(run(h, 25, 3.5)).toBe(0); // 1.5x: still the full 8 s
    expect(run(h, 25, 5)).toBe(1);
  });

  it('keeps the tier while adaptive resolution still has room', () => {
    const g = new TierGovernor({ targetMs: 1000 / 60 });
    expect(run(g, 40, 60, false)).toBe(0);
  });

  it('keeps the tier when frames are only a little slow', () => {
    const g = new TierGovernor({ targetMs: 1000 / 30 });
    expect(run(g, 40, 60)).toBe(0);
  });

  it('counts very slow frames (throttled phones) but ignores multi-second stalls', () => {
    const g = new TierGovernor({ targetMs: 1000 / 30, settleS: 0, patienceS: 4 });
    expect(run(g, 300, 5)).toBe(1);
    const h = new TierGovernor({ targetMs: 1000 / 30, settleS: 0, patienceS: 4 });
    expect(h.sample(5000, true)).toBe(false);
    expect(h.smoothedMs).toBeCloseTo(1000 / 30);
  });

  it('waits again after a step down and after a reset', () => {
    const g = new TierGovernor({ targetMs: 1000 / 60, patienceS: 2, settleS: 3 });
    expect(run(g, 50, 6)).toBe(1);
    g.reset(1000 / 30);
    expect(run(g, 50, 2.5)).toBe(0);
  });
});

describe('presets', () => {
  it('make crowd costs cheaper (never dearer) on every lower tier', () => {
    for (let i = 1; i < QUALITY_TIERS.length; i++) {
      const lo = QUALITY_PRESETS[QUALITY_TIERS[i - 1]!];
      const hi = QUALITY_PRESETS[QUALITY_TIERS[i]!];
      expect(lo.farAnimStride).toBeGreaterThanOrEqual(hi.farAnimStride);
      expect(lo.maxNameplates).toBeLessThanOrEqual(hi.maxNameplates);
      expect(lo.footstepVoices).toBeLessThanOrEqual(hi.footstepVoices);
      expect(lo.lodDistances[1]).toBeLessThanOrEqual(hi.lodDistances[1]);
    }
    expect(QUALITY_PRESETS.low.post.bloom).toBe(false);
    expect(QUALITY_PRESETS.low.shadows).toBe('off');
  });
});
