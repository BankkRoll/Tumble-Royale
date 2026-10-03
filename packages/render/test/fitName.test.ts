import { describe, expect, it } from 'vitest';
import { fitName } from '../src/scenes/nameplates.ts';

// One character = 10px keeps the arithmetic obvious.
const g = { measureText: (t: string) => ({ width: t.length * 10 }) };

describe('fitName', () => {
  it('leaves names that fit alone', () => {
    expect(fitName(g, 'Sprinkles#1234', 200)).toBe('Sprinkles#1234');
  });
  it('shortens the name but keeps the whole tag', () => {
    expect(fitName(g, 'Mega Toffeesocks#9001', 120)).toBe('Mega T…#9001');
  });
  it('shortens names without a tag', () => {
    expect(fitName(g, 'Doodlezilla', 60)).toBe('Doodl…');
  });
});
