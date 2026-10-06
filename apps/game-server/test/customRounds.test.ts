/**
 * Shared custom rounds on the game server: fetching and re-validating picked
 * rounds, holding the show until they are in, sending clients the exact
 * definition in `joinRound`, falling back when a code is gone, and playing a
 * custom round in the real match sim to the same result for the same seed.
 */
import { createHmac } from 'node:crypto';
import { customRoundId, playableCustomRound, starterRound } from '@tumble/content/custom';
import type { LowFreqMessage } from '@tumble/netcode';
import { loadRapier, type Rapier } from '@tumble/sim';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CustomRoundCatalog,
  HttpCustomRoundSource,
  customPicks,
  type CustomRoundSource,
} from '../src/customRounds.ts';
import { ServerMetrics } from '../src/metrics.ts';
import { createRealRoomDeps } from '../src/realDeps.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import type { MatchSettings, RoomDeps } from '../src/room/types.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, FakeMatchSim, TEST_SECRETS, TestClient, testDeps } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const TICK_MS = 1000 / 30;
const WALL = Date.parse('2026-10-06T12:00:00Z');
const CODE = 'K7MQ2X9A';
const ID = customRoundId(CODE);

type Msg<T extends LowFreqMessage['t']> = Extract<LowFreqMessage, { t: T }>;

let R: Rapier;
beforeAll(async () => {
  R = await loadRapier();
});

function match(rounds: string[]): MatchSettings {
  return {
    matchId: 'm_custom',
    playlistId: 'main-show',
    queue: 'custom',
    region: 'eu',
    humans: 1,
    bots: 7,
    custom: {
      playlistId: 'main-show',
      rounds,
      maxPlayers: 8,
      bots: true,
      roundTimeScale: 1,
      lobbyCountdownSec: 0,
      spectatorSlots: 0,
    },
  };
}

function claims(over: Partial<JoinTicketClaims> = {}): JoinTicketClaims {
  const m = match([ID]);
  return {
    sub: 'u-host',
    name: 'Host#1234',
    mid: `m_${Math.random().toString(36).slice(2)}`,
    sid: 'gs-test',
    pid: 'solo:u-host',
    team: null,
    role: 'player',
    playlistId: 'main-show',
    queue: 'custom',
    region: 'eu',
    size: 8,
    humans: 1,
    bots: 7,
    teamSize: 1,
    custom: m.custom!,
    ...over,
  };
}

/** A source that answers from a map, optionally only once `release()` is called. */
function fakeSource(defs: Record<string, unknown>, gated = false) {
  let release: () => void = () => {};
  const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve();
  const calls: string[][] = [];
  const source: CustomRoundSource = {
    async fetch(codes) {
      calls.push([...codes]);
      await gate;
      return new Map(codes.filter((c) => c in defs).map((c) => [c, defs[c]]));
    },
  };
  return { source, calls, release: () => release() };
}

describe('custom round catalog', () => {
  it('loads valid picks, rejects invalid ones and forgets codes that disappear', async () => {
    const broken = starterRound();
    broken.triggers = [];
    const f = fakeSource({ [CODE]: starterRound(), BBBBBBBB: broken });
    const logs: string[] = [];
    const catalog = new CustomRoundCatalog(f.source, (m) => logs.push(m));
    const m = match([ID, 'custom:BBBBBBBB', 'custom:CCCCCCCC', 'gumdrop-gauntlet', ID]);
    expect(customPicks(m)).toEqual([ID, 'custom:BBBBBBBB', 'custom:CCCCCCCC']);
    expect(await catalog.load(m)).toEqual({ loaded: [ID], failed: ['custom:BBBBBBBB', 'custom:CCCCCCCC'] });
    expect(f.calls).toEqual([[CODE, 'BBBBBBBB', 'CCCCCCCC']]);
    const played = catalog.get(ID)!;
    expect(played).toEqual((playableCustomRound(starterRound(), ID) as { round: unknown }).round);
    expect(logs.some((l) => l.includes('no_finish'))).toBe(true);

    // Taken down: the next show that asks no longer gets it.
    const gone = new CustomRoundCatalog(fakeSource({}).source);
    await gone.load(match([ID]));
    expect(gone.get(ID)).toBeUndefined();
  });

  it('skips custom picks without an API', async () => {
    expect(await new CustomRoundCatalog(null).load(match([ID]))).toEqual({ loaded: [], failed: [ID] });
  });

  it('signs resolve requests like every internal call', async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const source = new HttpCustomRoundSource({
      apiUrl: 'http://api.test/',
      secret: 'hmac-secret',
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string>, body: String(init.body) };
        return new Response(JSON.stringify({ rounds: [{ code: CODE, definition: { a: 1 } }], missing: [] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });
    const out = await source.fetch([CODE]);
    expect(out.get(CODE)).toEqual({ a: 1 });
    expect(seen!.url).toBe('http://api.test/internal/custom-rounds/resolve');
    const h = seen!.headers;
    const expected = createHmac('sha256', 'hmac-secret')
      .update(`${h['x-tumble-timestamp']}.${h['x-tumble-nonce']}.${seen!.body}`)
      .digest('hex');
    expect(h['x-tumble-signature']).toBe(expected);
    const failing = new HttpCustomRoundSource({
      apiUrl: 'http://api.test',
      secret: 's',
      fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    expect((await failing.fetch([CODE])).size).toBe(0);
  });
});

function harness(deps: Partial<RoomDeps>, sims: FakeMatchSim[] | null) {
  const clock = { now: 1000 };
  const fakes: FakeMatchSim[] = [];
  const manager = new RoomManager(
    {
      ...testDeps(clock, fakes),
      createBot: null,
      ...(sims
        ? {
            createMatchSim: (o) => {
              const s = new FakeMatchSim(o);
              sims.push(s);
              return s;
            },
          }
        : {}),
      ...deps,
      randomSeed: () => 4242,
    },
    new ServerMetrics(),
    null,
    {
      config: { capacity: 8, fillWaitMs: 60_000, startAtHumans: 8, ticketedFillWaitMs: 500 },
      profileLogMs: 0,
      tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
    },
  );
  const connect = (ticket: string): TestClient => {
    const c = new TestClient(new FakeConnection());
    manager.accept(c.conn);
    c.hello('client', '', ticket);
    c.pump(clock.now);
    return c;
  };
  let acked = 0;
  const advance = (ticks: number, c: TestClient, until?: () => boolean): void => {
    for (let i = 0; i < ticks && !until?.(); i++) {
      clock.now += TICK_MS;
      manager.tick();
      c.pump(clock.now);
      const joins = c.lowFreq('joinRound') as Msg<'joinRound'>[];
      for (const j of joins.slice(acked)) if (!j.lobby) c.send({ t: 'loaded', roundId: j.roundId });
      acked = joins.length;
    }
  };
  return { clock, manager, connect, advance };
}

describe('custom rounds in a private show', () => {
  it('holds the show until the picks are in, then sends the definition to clients', async () => {
    const f = fakeSource({ [CODE]: starterRound() }, true);
    const real = createRealRoomDeps(R, { customRounds: f.source });
    const sims: FakeMatchSim[] = [];
    const h = harness(
      {
        loadRound: real.loadRound,
        prepareMatch: real.prepareMatch!,
        createShowController: real.createShowController,
      },
      sims,
    );
    const a = h.connect(signJoinTicket(SECRET, claims(), WALL));
    h.advance(30 * 3, a);
    expect(sims.filter((s) => !s.opts.lobby)).toHaveLength(0);
    f.release();
    await new Promise((r) => setTimeout(r, 0));
    h.advance(30 * 20, a, () => sims.some((s) => !s.opts.lobby));
    const round = sims.find((s) => !s.opts.lobby);
    expect(round?.opts.round.id).toBe(ID);
    h.advance(3, a);
    const join = (a.lowFreq('joinRound') as Msg<'joinRound'>[]).find((j) => !j.lobby)!;
    expect(join.roundId).toBe(ID);
    expect(join.round).toEqual(round!.opts.round);
    // The client re-validates what it was sent and builds the same round.
    const rebuilt = playableCustomRound(join.round, ID);
    expect(rebuilt.ok && rebuilt.round).toEqual(round!.opts.round);
  });

  it('falls back to the base playlist when the code no longer resolves', async () => {
    const real = createRealRoomDeps(R, { customRounds: fakeSource({}).source });
    const sims: FakeMatchSim[] = [];
    const h = harness(
      {
        loadRound: real.loadRound,
        prepareMatch: real.prepareMatch!,
        createShowController: real.createShowController,
      },
      sims,
    );
    const a = h.connect(signJoinTicket(SECRET, claims(), WALL));
    await new Promise((r) => setTimeout(r, 0));
    h.advance(30 * 20, a, () => sims.some((s) => !s.opts.lobby));
    const round = sims.find((s) => !s.opts.lobby);
    expect(round).toBeDefined();
    expect(round!.opts.round.id.startsWith('custom:')).toBe(false);
  });

  it('plays a custom round to the same result for the same seed', async () => {
    async function run(): Promise<Msg<'roundResults'>> {
      const real = createRealRoomDeps(R, { customRounds: fakeSource({ [CODE]: starterRound() }).source });
      const h = harness(real, null);
      const a = h.connect(signJoinTicket(SECRET, claims({ mid: 'm_determinism' }), WALL));
      await new Promise((r) => setTimeout(r, 0));
      h.advance(30 * 150, a, () => a.lowFreq('roundResults').length > 0);
      const results = a.lowFreq('roundResults')[0] as Msg<'roundResults'> | undefined;
      for (const room of [
        ...(h.manager as unknown as { rooms: Map<string, { dispose(): void }> }).rooms.values(),
      ])
        room.dispose();
      if (!results) throw new Error('the custom round never finished');
      return results;
    }
    const first = await run();
    const second = await run();
    expect(first.roundId).toBe(ID);
    expect(second).toEqual(first);
    expect(first.results.filter((r) => r.status === 1).length).toBeGreaterThan(0);
  }, 120_000);
});
