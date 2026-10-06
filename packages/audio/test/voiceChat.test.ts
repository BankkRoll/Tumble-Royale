import { describe, expect, it } from 'vitest';
import type { AudioEngine } from '../src/core/engine.ts';
import { rmsLevel, VoiceChatMixer } from '../src/core/voiceChat.ts';

describe('rmsLevel', () => {
  it('maps silence to 0, full scale to 1 and speech levels in between', () => {
    expect(rmsLevel(new Float32Array(256))).toBe(0);
    expect(rmsLevel(new Float32Array(256).fill(1))).toBe(1);
    // -20 dBFS (amplitude 0.1) sits two thirds of the way up the 60 dB scale.
    expect(rmsLevel(new Float32Array(256).fill(0.1))).toBeCloseTo(2 / 3, 5);
    expect(rmsLevel(new Float32Array(256).fill(0.0001))).toBe(0);
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });
});

describe('VoiceChatMixer ducking', () => {
  it('holds at most one music duck however often talking is reported', () => {
    const ducks: boolean[] = [];
    const engine = { duckMusic: (on: boolean) => ducks.push(on) } as unknown as AudioEngine;
    const mixer = new VoiceChatMixer(engine);
    mixer.setTalking(true);
    mixer.setTalking(true);
    mixer.setTalking(false);
    mixer.setTalking(false);
    mixer.setTalking(true);
    mixer.dispose();
    expect(ducks).toEqual([true, false, true, false]);
  });
});
