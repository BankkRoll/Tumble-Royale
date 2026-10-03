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

  it('carries v3 party, lobby, carry and pre-show timing fields', () => {
    expect(PROTOCOL_VERSION).toBe(3);
    const msgs: LowFreqMessage[] = [
      {
        t: 'playerList',
        players: [{ id: 3, name: 'Duo', isBot: false, loadout: '', connected: true, partyId: 1 }],
      },
      {
        t: 'joinRound',
        roundId: 'pre-show-lobby',
        seed: 1,
        stage: 0,
        players: [{ id: 3, name: 'Duo', isBot: false, team: -1, partyId: 1 }],
        obstacleIds: [],
        bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
        epoch: 1,
        startTick: 0,
        roundIndex: -1,
        isFinal: false,
        qualifyTarget: 0,
        variationId: null,
        lobby: true,
        roundTimeScale: 1.5,
      },
      { t: 'roundResults', roundId: 'r', results: [{ id: 3, status: 1, place: 9, score: 0, carried: true }] },
      { t: 'showPhase', phase: 0, startsInMs: 9000 },
      { t: 'spectate', target: 7 },
    ];
    for (const m of msgs) expect(unpackLowFreq(packLowFreq(m))).toEqual(m);
  });
});
