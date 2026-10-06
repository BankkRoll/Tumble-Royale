import { describe, expect, it } from 'vitest';
import { getTheme } from '@tumble/content/themes';
import { createEnvironment, createEnvironmentSliced } from '../src/environment/index.ts';

describe('createEnvironmentSliced', () => {
  it('pauses between the sky, clouds, islands, traffic and stands, and builds the same dressing', () => {
    const theme = getTheme('candy');
    const opts = { seed: 7, courseBounds: { min: { x: -20, y: 0, z: -10 }, max: { x: 20, y: 8, z: 140 } } };
    const steps = createEnvironmentSliced(theme, opts);
    const progress: number[] = [];
    let r = steps.next();
    while (!r.done) {
      progress.push(r.value);
      r = steps.next();
    }
    expect(progress.length).toBeGreaterThanOrEqual(5);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    const sliced = r.value;
    const whole = createEnvironment(theme, opts);
    expect(JSON.stringify(sliced.dressing)).toBe(JSON.stringify(whole.dressing));
    expect(sliced.object.children.length).toBe(whole.object.children.length);
    sliced.dispose();
    whole.dispose();
  });
});
