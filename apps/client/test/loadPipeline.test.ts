/**
 * The chunked round-load pipeline on a fake clock: time slicing, yields
 * between steps, monotonic weighted progress, cancellation, timings and the
 * progress throttle the loading screen uses.
 */
import { describe, expect, it } from 'vitest';
import {
  runLoadPipeline,
  runLoadStepsSync,
  throttleProgress,
  type LoadStep,
  type LoadTimings,
} from '../src/game/round/loadPipeline.ts';

/** A fake clock plus a yield that records each pause (a "frame" the browser gets). */
function harness() {
  const clock = { t: 0 };
  const pauses: number[] = [];
  return {
    clock,
    pauses,
    now: () => clock.t,
    yieldToMain: async () => {
      pauses.push(clock.t);
    },
  };
}

/** A generator step whose units each cost `costMs` on the fake clock. */
function units(name: string, n: number, costMs: number, clock: { t: number }, weight = 1): LoadStep {
  return {
    name,
    weight,
    *run() {
      for (let i = 0; i < n; i++) {
        clock.t += costMs;
        yield (i + 1) / n;
      }
    },
  };
}

describe('runLoadPipeline', () => {
  it('slices generator steps to the budget and yields between them', async () => {
    const h = harness();
    const log: LoadTimings[] = [];
    // 40 Tumblers at 3 ms each must not run as one 120 ms block.
    const t = await runLoadPipeline([units('tumblers', 40, 3, h.clock)], {
      sliceMs: 8,
      now: h.now,
      yieldToMain: h.yieldToMain,
      log,
    });
    const step = t.steps[0]!;
    expect(step.busyMs).toBe(120);
    expect(step.longestSliceMs).toBeLessThanOrEqual(9);
    expect(step.slices).toBeGreaterThanOrEqual(13);
    // One pause per slice boundary plus one after the step.
    expect(h.pauses.length).toBe(step.slices);
    expect(log).toEqual([t]);
    expect(t.cancelled).toBe(false);
  });

  it('isolates synchronous steps and awaits async ones', async () => {
    const h = harness();
    const order: string[] = [];
    const steps: LoadStep[] = [
      {
        name: 'level',
        weight: 1,
        run: () => {
          h.clock.t += 30;
          order.push('level');
        },
      },
      {
        name: 'compile',
        weight: 1,
        run: async (ctx) => {
          order.push('compile:start');
          for (let i = 1; i <= 4; i++) {
            await h.yieldToMain();
            h.clock.t += 2;
            ctx.report(i / 4);
          }
          order.push('compile:end');
        },
      },
      { name: 'camera', weight: 1, run: () => void order.push('camera') },
    ];
    const t = await runLoadPipeline(steps, { now: h.now, yieldToMain: h.yieldToMain, log: null });
    expect(order).toEqual(['level', 'compile:start', 'compile:end', 'camera']);
    expect(t.steps.map((s) => s.name)).toEqual(['level', 'compile', 'camera']);
    expect(t.steps[0]!.longestSliceMs).toBe(30);
    expect(t.longestSliceMs).toBe(30);
    // The async step's own pauses happen inside it; its synchronous prologue is ~free.
    expect(t.steps[1]!.busyMs).toBe(0);
    expect(t.steps[1]!.ms).toBe(8);
  });

  it('reports weighted, monotonic progress that ends at exactly 1', async () => {
    const h = harness();
    const seen: number[] = [];
    await runLoadPipeline(
      [
        units('a', 10, 5, h.clock, 1),
        { name: 'b', weight: 2, run: (ctx) => (ctx.report(0.5), ctx.report(0.25), undefined) },
        units('c', 4, 5, h.clock, 1),
      ],
      { sliceMs: 8, now: h.now, yieldToMain: h.yieldToMain, onProgress: (p) => seen.push(p), log: null },
    );
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    expect(seen.at(-1)).toBe(1);
    // Step a is a quarter of the weight; b's half-way report lands at 0.25 + 0.5 × 0.5.
    expect(seen).toContain(0.25);
    expect(seen).toContain(0.5);
    // b re-reporting a smaller fraction never moves the bar back.
    expect(seen.filter((p) => p > 0.25 && p < 0.5)).toEqual([]);
  });

  it('stops between slices when cancelled and closes the generator', async () => {
    const h = harness();
    let closed = false;
    let ran = 0;
    let cancel = false;
    const step: LoadStep = {
      name: 'obstacles',
      weight: 1,
      *run() {
        try {
          for (let i = 0; i < 100; i++) {
            h.clock.t += 4;
            ran++;
            if (ran === 6) cancel = true;
            yield;
          }
        } finally {
          closed = true;
        }
      },
    };
    const after = { name: 'never', weight: 1, run: () => expect.unreachable() } satisfies LoadStep;
    const t = await runLoadPipeline([step, after], {
      sliceMs: 8,
      now: h.now,
      yieldToMain: h.yieldToMain,
      isCancelled: () => cancel,
      log: null,
    });
    expect(t.cancelled).toBe(true);
    expect(closed).toBe(true);
    expect(ran).toBeLessThan(10);
    expect(t.steps.map((s) => s.name)).toEqual(['obstacles']);
  });

  it('keeps a bounded log of recent builds', async () => {
    const h = harness();
    const log: LoadTimings[] = [];
    for (let i = 0; i < 20; i++)
      await runLoadPipeline([units('x', 1, 1, h.clock)], {
        label: `round-${i}`,
        now: h.now,
        yieldToMain: h.yieldToMain,
        log,
      });
    expect(log.length).toBe(12);
    expect(log.at(-1)?.label).toBe('round-19');
  });
});

describe('runLoadStepsSync', () => {
  it('drains generator steps in one call and refuses async ones', () => {
    const clock = { t: 0 };
    let level = false;
    runLoadStepsSync([{ name: 'level', weight: 1, run: () => void (level = true) }, units('t', 5, 1, clock)]);
    expect(level).toBe(true);
    expect(clock.t).toBe(5);
    expect(() => runLoadStepsSync([{ name: 'compile', weight: 1, run: async () => {} }])).toThrow(/async/);
  });
});

describe('throttleProgress', () => {
  it('forwards at most once per interval but always the first and the final update', () => {
    const clock = { t: 0 };
    const out: number[] = [];
    const report = throttleProgress(
      250,
      (p) => out.push(p),
      () => clock.t,
    );
    for (let i = 1; i <= 100; i++) {
      clock.t += 16;
      report(i / 100 - 0.001);
    }
    report(1);
    // 1.6 s of 60 Hz updates → ~4 Hz plus completion.
    expect(out.length).toBeLessThanOrEqual(9);
    expect(out[0]).toBeCloseTo(0.009);
    expect(out.at(-1)).toBe(1);
  });
});
