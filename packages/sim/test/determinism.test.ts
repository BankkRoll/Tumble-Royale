import { describe, expect, it } from 'vitest';
import { loadRapier, maxStateError, runDeterminismScenario } from '../src/index.ts';

describe('determinism scenario', () => {
  it('produces bit-identical results across runs', async () => {
    const R = await loadRapier();
    const a = runDeterminismScenario(R, 600);
    const b = runDeterminismScenario(R, 600);
    expect(a.hash).toBe(b.hash);
    expect(maxStateError(a.state, b.state)).toBe(0);
  });

  it('actually simulates: state is finite and evolves over time', async () => {
    const R = await loadRapier();
    const early = runDeterminismScenario(R, 1);
    const late = runDeterminismScenario(R, 600);
    for (const v of late.state) expect(Number.isFinite(v)).toBe(true);
    // The spinner flings some bodies off the floor; most should still have landed.
    let resting = 0;
    for (let i = 1; i < late.state.length; i += 7) if (Math.abs(late.state[i]!) < 2) resting++;
    expect(resting).toBeGreaterThan(late.state.length / 7 / 2);
    expect(late.hash).not.toBe(early.hash);
  });
});
