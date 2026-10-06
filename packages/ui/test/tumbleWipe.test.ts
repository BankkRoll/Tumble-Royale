/** The Tumble Wipe never strands the player: its safety timeout runs even where frames never do. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWipePhase } from '../src/transitions/TumbleWipe.tsx';

describe('startWipePhase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('finishes in a hidden tab, where animation frames never run', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const start = vi.fn();
    const finish = vi.fn();
    startWipePhase(start, 800, finish);
    vi.advanceTimersByTime(800);
    expect(start).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('starts after two frames, and cancelling stops both', () => {
    const frames: (() => void)[] = [];
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const start = vi.fn();
    const finish = vi.fn();
    const cancel = startWipePhase(start, 800, finish);
    frames.shift()?.();
    expect(start).not.toHaveBeenCalled();
    frames.shift()?.();
    expect(start).toHaveBeenCalledOnce();
    cancel();
    vi.advanceTimersByTime(1000);
    expect(finish).not.toHaveBeenCalled();
  });
});
