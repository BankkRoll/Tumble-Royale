import { describe, expect, it } from 'vitest';
import { ButtonLatch } from './latch.ts';

describe('ButtonLatch', () => {
  it('reports a tap shorter than one step for exactly one step', () => {
    const l = new ButtonLatch();
    l.press();
    l.release();
    expect(l.sample()).toBe(true);
    expect(l.sample()).toBe(false);
  });

  it('reports a hold every step until released', () => {
    const l = new ButtonLatch();
    l.press();
    expect([l.sample(), l.sample(), l.sample()]).toEqual([true, true, true]);
    l.release();
    expect(l.sample()).toBe(false);
  });

  it('splits a release + re-press between two steps into a fresh edge', () => {
    const l = new ButtonLatch();
    l.press();
    expect(l.sample()).toBe(true);
    l.release();
    l.press();
    // A gap step, then held again: the sim sees a new rising edge.
    expect(l.sample()).toBe(false);
    expect(l.sample()).toBe(true);
    expect(l.sample()).toBe(true);
  });

  it('re-tap while held between steps still yields a one-step edge', () => {
    const l = new ButtonLatch();
    l.press();
    expect(l.sample()).toBe(true);
    l.release();
    l.press();
    l.release();
    expect(l.sample()).toBe(false);
    expect(l.sample()).toBe(true);
    expect(l.sample()).toBe(false);
  });

  it('counts multiple sources (two keys bound to one action)', () => {
    const l = new ButtonLatch();
    l.press();
    l.press();
    l.release();
    expect(l.down).toBe(true);
    expect(l.sample()).toBe(true);
    l.release();
    expect(l.sample()).toBe(false);
  });

  it('reset drops held sources', () => {
    const l = new ButtonLatch();
    l.press();
    l.sample();
    l.reset();
    expect(l.down).toBe(false);
    expect(l.sample()).toBe(false);
  });
});
