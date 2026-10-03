import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from './bits.ts';
import { MsgType, PROTOCOL_VERSION, packLowFreq, readHello, unpackLowFreq, writeHello, type LowFreqMessage } from './protocol.ts';

describe('protocol v2', () => {
  it('round-trips a Hello with a join ticket', () => {
    const ticket = `${'a'.repeat(40)}.${'b'.repeat(700)}.${'c'.repeat(43)}`;
    const w = new BitWriter(64);
    writeHello(w, { version: PROTOCOL_VERSION, name: 'Sprinkles', resumeToken: '', loadout: 'L1', ticket });
    const r = new BitReader().reset(w.finish());
    expect(r.readBits(8)).toBe(MsgType.Hello);
    const h = readHello(r);
    expect(r.overflow).toBe(false);
    expect(h).toEqual({ version: PROTOCOL_VERSION, name: 'Sprinkles', resumeToken: '', loadout: 'L1', ticket });
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
});
