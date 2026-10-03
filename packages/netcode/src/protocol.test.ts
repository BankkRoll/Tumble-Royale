import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from './bits.ts';
import {
  MsgType,
  PROTOCOL_VERSION,
  packLowFreq,
  readHello,
  unpackLowFreq,
  writeHello,
  type LowFreqMessage,
} from './protocol.ts';

describe('protocol v3', () => {
  it('round-trips a Hello with a join ticket', () => {
    const ticket = `${'a'.repeat(40)}.${'b'.repeat(700)}.${'c'.repeat(43)}`;
    const w = new BitWriter(64);
    writeHello(w, { version: PROTOCOL_VERSION, name: 'Sprinkles', resumeToken: '', loadout: 'L1', ticket });
    const r = new BitReader().reset(w.finish());
    expect(r.readBits(8)).toBe(MsgType.Hello);
    const h = readHello(r);
    expect(r.overflow).toBe(false);
    expect(h).toEqual({
      version: PROTOCOL_VERSION,
      name: 'Sprinkles',
      resumeToken: '',
      loadout: 'L1',
      ticket,
    });
  });

  it('carries round facts and rewards on the reliable channel', () => {
    const join: LowFreqMessage = {
      t: 'joinRound',
      roundId: 'crown-climb',
      seed: 7,
      stage: 3,
      players: [],
      obstacleIds: [],
      bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      epoch: 4,
      startTick: 100,
      roundIndex: 3,
      isFinal: true,
      qualifyTarget: 1,
      variationId: 'windy',
    };
    expect(unpackLowFreq(packLowFreq(join))).toEqual(join);
    const rewards: LowFreqMessage = { t: 'showRewards', matchId: 'm_1234567', reward: null };
    expect(unpackLowFreq(packLowFreq(rewards))).toEqual(rewards);
  });

  it('carries load progress and the loading roster (v3)', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    const progress: LowFreqMessage = { t: 'loadProgress', roundId: 'tilt-town', pct: 0.42 };
    expect(unpackLowFreq(packLowFreq(progress))).toEqual(progress);
    const status: LowFreqMessage = {
      t: 'loadingStatus',
      roundId: 'tilt-town',
      loaded: 37,
      total: 40,
      waitingOn: [3, 17, 29],
    };
    expect(unpackLowFreq(packLowFreq(status))).toEqual(status);
    // Low-frequency means small: a full roster stays well under one reliable packet.
    const full: LowFreqMessage = { ...status, waitingOn: [1, 2, 3, 4, 5, 6, 7, 8] };
    expect(packLowFreq(full).byteLength).toBeLessThan(80);
  });
});
