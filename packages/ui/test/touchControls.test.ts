import { describe, expect, it } from 'vitest';
import { dragStick } from '../src/hud/TouchControls.tsx';

describe('dragStick', () => {
  const base = { ox: 100, oy: 100, dx: 0, dy: 0 };

  it('maps screen up to forward and right to right', () => {
    expect(dragStick(base, 100, 72, 56).move).toEqual({ x: 0, y: 0.5 });
    expect(dragStick(base, 128, 100, 56).move).toEqual({ x: 0.5, y: -0 });
  });

  it('caps the knob at the radius and drags the base along', () => {
    const r = dragStick(base, 100 + 156, 100, 56);
    expect(r.move.x).toBeCloseTo(1);
    expect(r.stick.dx).toBeCloseTo(56);
    expect(r.stick.ox).toBeCloseTo(200);
    // Reversing now responds immediately from the dragged base.
    expect(dragStick(r.stick, 150, 100, 56).move.x).toBeLessThan(0);
  });
});
