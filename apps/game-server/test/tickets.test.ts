import { describe, expect, it } from 'vitest';
import { KickReason, type LowFreqMessage } from '@tumble/netcode';
import { ServerMetrics } from '../src/metrics.ts';
import {
  computePlacements,
  signInternal,
  type IngestResponse,
  type MatchResultPayload,
  type ResultsSink,
} from '../src/results.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { SimpleShowController } from '../src/show/SimpleShowController.ts';
import { signJoinTicket, verifyJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const SECRET = 'test-ticket-secret-0123456789';
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-02T12:00:00Z');

function claims(sub: string, over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  return {
    sub,
    name: `${sub}#1234`,
    mid: 'm_test_match_1',
    sid: 'gs-test',
    pid: 'party-1',
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'casual',
    region: 'eu',
    size: 4,
    humans: 2,
    bots: 2,
    teamSize: 1,
    ...over,
  };
}

describe('join tickets', () => {
  it('verifies a ticket signed the matchmaker way', () => {
    const t = signJoinTicket(SECRET, claims('11111111-1111-4111-8111-111111111111'), WALL);
    const c = verifyJoinTicket(SECRET, t, WALL + 10_000);
    expect(c?.mid).toBe('m_test_match_1');
    expect(c?.humans).toBe(2);
  });

  it('rejects a wrong secret, expiry, tampering and alg confusion', () => {
    const t = signJoinTicket(SECRET, claims('u1'), WALL);
    expect(verifyJoinTicket('another-secret-0123456789', t, WALL)).toBeNull();
    expect(verifyJoinTicket(SECRET, t, WALL + 91_000)).toBeNull();
    const [h, p, s] = t.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), size: 60 }),
    ).toString('base64url');
    expect(verifyJoinTicket(SECRET, `${h}.${forged}.${s}`, WALL)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    expect(verifyJoinTicket(SECRET, `${none}.${p}.`, WALL)).toBeNull();
  });
});

describe('placements', () => {
  it('ranks by elimination round, ties share a value, winner is crowned', () => {
    const p = computePlacements(
      ['a', 'b', 'c', 'd', 'e'],
      [
        { entrants: ['a', 'b', 'c', 'd', 'e'], qualified: ['a', 'b', 'c'] },
        { entrants: ['a', 'b', 'c'], qualified: ['a'] },
      ],
      ['a'],
    );
    const by = new Map(p.map((x) => [x.key, x]));
    expect(by.get('a')).toEqual({ key: 'a', placement: 1, crowned: true });
    expect(by.get('b')?.placement).toBe(2);
    expect(by.get('c')?.placement).toBe(2);
    expect(by.get('d')?.placement).toBe(4);
    expect(by.get('e')?.placement).toBe(4);
    expect(p).toHaveLength(5);
  });

  it('signs internal calls as timestamp.nonce.body', () => {
    const h = signInternal('s3cret-s3cret-s3cret', '{"x":1}', 1234567890123);
    expect(h['x-tumble-timestamp']).toBe('1234567890123');
    expect(h['x-tumble-nonce']).toHaveLength(32);
    expect(h['x-tumble-signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ticketed rooms', () => {
  function setup(allowUnticketed: boolean, sink: ResultsSink | null) {
    const clock = { now: 1000 };
    const sims: FakeMatchSim[] = [];
    const deps = {
      ...testDeps(clock, sims),
      createShowController: () =>
        new SimpleShowController({
          roundId: 'test-round',
          playSeconds: 1,
          countdownSeconds: 0.2,
          roundEndSeconds: 0.2,
          resultsSeconds: 0.2,
          loops: 1,
        }),
      results: sink,
    };
    const manager = new RoomManager(deps, new ServerMetrics(), null, {
      config: { capacity: 40, fillWaitMs: 60_000, startAtHumans: 40, ticketedFillWaitMs: 5000 },
      profileLogMs: 0,
      tickets: { secret: SECRET, allowUnticketed, now: () => WALL },
    });
    const connect = (ticket: string, token = ''): TestClient => {
      const conn = new FakeConnection();
      manager.accept(conn);
      const c = new TestClient(conn);
      c.hello('client-name', token, ticket);
      c.pump(clock.now);
      return c;
    };
    const advance = (ticks: number, clients: TestClient[]): void => {
      for (let i = 0; i < ticks; i++) {
        clock.now += TICK_MS;
        manager.tick();
        for (const c of clients) c.pump(clock.now);
      }
    };
    return { clock, sims, manager, connect, advance };
  }

  it('rejects unticketed joins when tickets are required', () => {
    const { connect } = setup(false, null);
    const c = connect('');
    expect(c.kicked).toBe(true);
    expect(c.welcome).toBeNull();
    const bad = connect('not.a.ticket');
    expect(bad.kicked).toBe(true);
    expect(KickReason.BadTicket).toBe(7);
  });

  it('puts a party into one match room, starts when everyone joined, posts results and forwards rewards', async () => {
    const posted: MatchResultPayload[] = [];
    const sink: ResultsSink = {
      async post(payload): Promise<IngestResponse> {
        posted.push(payload);
        return {
          matchId: payload.matchId,
          alreadyProcessed: false,
          rewards: payload.participants
            .filter((p) => !p.isBot)
            .map((p) => ({
              userId: p.userId!,
              participantKey: p.key,
              placement: 1,
              xp: { total: 300, lines: [{ label: 'Show played', amount: 300 }] },
            })),
        };
      },
    };
    const { sims, manager, connect, advance } = setup(false, sink);
    const u1 = '11111111-1111-4111-8111-111111111111';
    const u2 = '22222222-2222-4222-8222-222222222222';
    const a = connect(signJoinTicket(SECRET, claims(u1), WALL));
    expect(a.welcome?.playerId).toBe(0);
    advance(3, [a]);
    expect(sims).toHaveLength(0);
    const b = connect(signJoinTicket(SECRET, claims(u2), WALL));
    expect(b.welcome?.roomId).toBe(a.welcome?.roomId);
    advance(2, [a, b]);
    expect(sims).toHaveLength(1);
    expect(sims[0]!.opts.players.map((p) => p.isBot)).toEqual([false, false, true, true]);
    expect(manager.list()).toHaveLength(1);

    const info = a.lowFreq('showInfo').at(-1) as Extract<LowFreqMessage, { t: 'showInfo' }> | undefined;
    expect(info?.matchId).toBe('m_test_match_1');
    const join = a.lowFreq('joinRound').at(-1) as Extract<LowFreqMessage, { t: 'joinRound' }> | undefined;
    expect(join?.roundIndex).toBe(0);
    expect(typeof join?.isFinal).toBe('boolean');
    expect(join?.qualifyTarget).toBeGreaterThan(0);

    advance(120, [a, b]);
    await new Promise((r) => setTimeout(r, 0));
    advance(3, [a, b]);
    expect(posted).toHaveLength(1);
    const p = posted[0]!;
    expect(p.matchId).toBe('m_test_match_1');
    expect(
      p.participants
        .filter((x) => !x.isBot)
        .map((x) => x.userId)
        .sort(),
    ).toEqual([u1, u2]);
    expect(p.placements).toHaveLength(4);
    expect(p.rounds[0]!.results).toHaveLength(4);
    const rewards = a.lowFreq('showRewards').at(-1) as
      Extract<LowFreqMessage, { t: 'showRewards' }> | undefined;
    expect(rewards?.reward?.xp.total).toBe(300);

    // A reload (no resume token) with the same account rejoins the same slot.
    const again = connect(signJoinTicket(SECRET, claims(u1), WALL));
    expect(again.welcome?.playerId).toBe(a.welcome?.playerId);
  });
});

describe('chat-ban claim', () => {
  it('carries chatBanned through verification', () => {
    const sub = '22222222-2222-4222-8222-222222222222';
    const banned = verifyJoinTicket(
      SECRET,
      signJoinTicket(SECRET, claims(sub, { chatBanned: true }), WALL),
      WALL,
    );
    expect(banned?.chatBanned).toBe(true);
    const clean = verifyJoinTicket(SECRET, signJoinTicket(SECRET, claims(sub), WALL), WALL);
    expect(clean?.chatBanned).toBeUndefined();
  });
});
