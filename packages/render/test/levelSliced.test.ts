import { getRound } from '@tumble/content/rounds';
import { getTheme } from '@tumble/content/themes';
import { describe, expect, it } from 'vitest';
import { buildLevelVisuals, buildLevelVisualsSliced } from '../src/level/buildLevel.ts';

describe('buildLevelVisualsSliced', () => {
  it('pauses between pieces with rising progress and builds the same level as the one-shot build', () => {
    const round = getRound('conveyor-chaos');
    if (!round) throw new Error('round missing');
    const theme = getTheme(round.theme);
    const steps = buildLevelVisualsSliced(round, theme);
    const progress: number[] = [];
    let r = steps.next();
    while (!r.done) {
      progress.push(r.value);
      r = steps.next();
    }
    const sliced = r.value;
    const whole = buildLevelVisuals(round, theme);
    expect(progress.length).toBeGreaterThan(round.geometry.length - 1);
    expect(progress.every((p, i) => p >= 0 && p < 1 && (i === 0 || p >= (progress[i - 1] ?? 0)))).toBe(true);
    expect(sliced.meshCount).toBe(whole.meshCount);
    expect(sliced.object.children.map((c) => c.name)).toEqual(whole.object.children.map((c) => c.name));
    sliced.dispose();
    whole.dispose();
  });
});
