import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, SFX_DEFS, SFX_NAMES } from '../src/index.ts';

/** Just enough of the Web Audio API for the engine's graph and one-shots. */
function fakeContext() {
  const param = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  });
  const node = (extra: Record<string, unknown> = {}) => ({
    connect: vi.fn(function (this: unknown, next: unknown) {
      return next;
    }),
    disconnect: vi.fn(),
    ...extra,
  });
  const sources: { onended: (() => void) | null }[] = [];
  const counts = { panners: 0, gains: 0 };
  const ctx = {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: node(),
    listener: {
      positionX: param(),
      positionY: param(),
      positionZ: param(),
      forwardX: param(),
      forwardY: param(),
      forwardZ: param(),
      upX: param(),
      upY: param(),
      upZ: param(),
    },
    resume: () => Promise.resolve(),
    suspend: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => {
      counts.gains++;
      return node({ gain: param() });
    },
    createPanner: () => {
      counts.panners++;
      return node({ positionX: param(), positionY: param(), positionZ: param() });
    },
    createStereoPanner: () => node({ pan: param() }),
    createDynamicsCompressor: () =>
      node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
    createBuffer: () => ({}),
    createBufferSource: () => {
      const s = node({ buffer: null, playbackRate: param(), start: vi.fn(), stop: vi.fn(), onended: null });
      sources.push(s as unknown as { onended: (() => void) | null });
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources, counts };
}

async function engineWith(fake: ReturnType<typeof fakeContext>): Promise<AudioEngine> {
  const engine = new AudioEngine({ createContext: () => fake.ctx, panningModel: 'equalpower' });
  await engine.unlock();
  vi.spyOn(engine.sfx, 'get').mockReturnValue({} as AudioBuffer);
  return engine;
}

/** A spatial SFX-bus sound without a retrigger cooldown. */
const SOUND = SFX_NAMES.find((n) => {
  const d = SFX_DEFS[n];
  return d && (d.bus ?? 'sfx') === 'sfx' && !d.cooldownMs;
}) as string;

describe('AudioEngine spatial one-shots', () => {
  it('reuses the gain and panner of finished voices', async () => {
    const fake = fakeContext();
    const engine = await engineWith(fake);
    const base = fake.counts.panners;
    for (let i = 0; i < 5; i++) {
      expect(engine.play(SOUND, { pos: { x: i, y: 0, z: 1 }, noVariance: true })).not.toBeNull();
      fake.sources.at(-1)!.onended!();
    }
    expect(fake.counts.panners - base).toBe(1);
  });

  it('gives overlapping voices their own panner', async () => {
    const fake = fakeContext();
    const engine = await engineWith(fake);
    const base = fake.counts.panners;
    engine.play(SOUND, { pos: { x: 0, y: 0, z: 1 }, noVariance: true });
    engine.play(SOUND, { pos: { x: 2, y: 0, z: 1 }, noVariance: true });
    expect(fake.counts.panners - base).toBe(2);
    for (const s of fake.sources.slice(-2)) s.onended!();
    engine.play(SOUND, { pos: { x: 3, y: 0, z: 1 }, noVariance: true });
    expect(fake.counts.panners - base).toBe(2);
  });

  it('keeps non-spatial sounds off the panner pool', async () => {
    const fake = fakeContext();
    const engine = await engineWith(fake);
    const base = fake.counts.panners;
    engine.play(SOUND, { noVariance: true });
    fake.sources.at(-1)!.onended!();
    expect(fake.counts.panners - base).toBe(0);
  });
});
