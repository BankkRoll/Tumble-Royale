import { Rng } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import {
  VoicePool,
  VoicePriority,
  inverseDistanceGain,
  pickVoiceToSteal,
  voiceKeepScore,
} from '../src/core/voicePool.ts';
import type { VoiceSlot } from '../src/core/voicePool.ts';

function fill(pool: VoicePool, priority: number, audibility: number, now: number): number[] {
  const stopped: number[] = [];
  for (let i = 0; i < pool.capacity; i++) {
    const v = pool.acquire(priority, audibility, now);
    const slot = v.slot;
    pool.slots[slot]!.stop = () => stopped.push(slot);
  }
  return stopped;
}

describe('voice pool', () => {
  it('hands out free slots until full', () => {
    const pool = new VoicePool(4);
    for (let i = 0; i < 4; i++) expect(pool.acquire(VoicePriority.Normal, 1, 0).slot).toBe(i);
    expect(pool.active).toBe(4);
  });

  it('steals the lowest-priority voice for a more important sound', () => {
    const pool = new VoicePool(3);
    pool.acquire(VoicePriority.Normal, 1, 0);
    pool.acquire(VoicePriority.Footstep, 1, 0);
    pool.acquire(VoicePriority.Normal, 1, 0);
    let stopped = -1;
    pool.slots[1]!.stop = () => (stopped = 1);
    const v = pool.acquire(VoicePriority.Important, 1, 0.1);
    expect(v.slot).toBe(1);
    expect(stopped).toBe(1);
    expect(pool.active).toBe(3);
  });

  it('drops an incoming sound that is less important than everything playing', () => {
    const pool = new VoicePool(2);
    pool.acquire(VoicePriority.Critical, 1, 0);
    pool.acquire(VoicePriority.Critical, 1, 0);
    expect(pool.acquire(VoicePriority.Footstep, 1, 0).slot).toBe(-1);
    expect(pool.active).toBe(2);
  });

  it('prefers stealing distant (quiet) voices at equal priority', () => {
    const pool = new VoicePool(3);
    pool.acquire(VoicePriority.Normal, 0.9, 0);
    pool.acquire(VoicePriority.Normal, 0.05, 0);
    pool.acquire(VoicePriority.Normal, 0.8, 0);
    expect(pool.acquire(VoicePriority.Normal, 0.9, 0.01).slot).toBe(1);
  });

  it('prefers stealing older voices at equal priority and loudness', () => {
    const slots: VoiceSlot[] = [
      { id: 1, active: true, priority: 3, audibility: 0.5, startedAt: 1.0, stop: null },
      { id: 2, active: true, priority: 3, audibility: 0.5, startedAt: 0.2, stop: null },
      { id: 3, active: true, priority: 3, audibility: 0.5, startedAt: 1.1, stop: null },
    ];
    expect(pickVoiceToSteal(slots, 3, 0.6, 1.2)).toBe(1);
  });

  it('ignores a late release from a voice that was already stolen', () => {
    const pool = new VoicePool(1);
    const a = { ...pool.acquire(VoicePriority.Footstep, 1, 0) };
    const b = pool.acquire(VoicePriority.Critical, 1, 0);
    expect(b.slot).toBe(a.slot);
    pool.release(a.slot, a.id);
    expect(pool.active).toBe(1);
    pool.release(b.slot, b.id);
    expect(pool.active).toBe(0);
  });

  it('never exceeds capacity under a 40-player event storm and protects critical voices', () => {
    const pool = new VoicePool(32);
    const rng = new Rng(42);
    const live: Array<{ slot: number; id: number; end: number }> = [];
    let criticalDropped = 0;
    for (let frame = 0; frame < 600; frame++) {
      const now = frame / 60;
      for (let i = live.length - 1; i >= 0; i--) {
        const v = live[i]!;
        if (v.end <= now) {
          pool.release(v.slot, v.id);
          live.splice(i, 1);
        }
      }
      const events = rng.int(2, 14);
      for (let k = 0; k < events; k++) {
        const roll = rng.next();
        const priority =
          roll < 0.6 ? VoicePriority.Footstep : roll < 0.95 ? VoicePriority.Normal : VoicePriority.Critical;
        const v = pool.acquire(priority, rng.range(0.02, 1), now);
        if (v.slot < 0) {
          if (priority === VoicePriority.Critical) criticalDropped++;
          continue;
        }
        live.push({ slot: v.slot, id: v.id, end: now + rng.range(0.1, 1.5) });
        expect(pool.active).toBeLessThanOrEqual(32);
      }
    }
    expect(criticalDropped).toBe(0);
  });

  it('stopAll silences everything', () => {
    const pool = new VoicePool(4);
    const stopped = fill(pool, VoicePriority.Normal, 1, 0);
    pool.stopAll();
    expect(stopped).toHaveLength(4);
    expect(pool.active).toBe(0);
  });

  it('keep score rewards priority and loudness, penalises age', () => {
    expect(voiceKeepScore(5, 0, 0)).toBeGreaterThan(voiceKeepScore(3, 1, 0));
    expect(voiceKeepScore(3, 1, 0)).toBeGreaterThan(voiceKeepScore(3, 0.2, 0));
    expect(voiceKeepScore(3, 1, 0)).toBeGreaterThan(voiceKeepScore(3, 1, 2));
  });
});

describe('distance attenuation', () => {
  it('matches the inverse model', () => {
    expect(inverseDistanceGain(0, 4, 1)).toBe(1);
    expect(inverseDistanceGain(4, 4, 1)).toBe(1);
    expect(inverseDistanceGain(8, 4, 1)).toBeCloseTo(0.5);
    expect(inverseDistanceGain(100, 4, 1.1)).toBeLessThan(0.05);
  });
});
