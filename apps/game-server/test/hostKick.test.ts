/**
 * Private show kicks that reach the game server: the room despawns the
 * player for everyone, their still-valid ticket is refused, and the signed
 * `/internal/kick` endpoint only obeys the matchmaker.
 */
import { describe, expect, it } from 'vitest';
import { KickReason, type LowFreqMessage } from '@tumble/netcode';
import { signControl, verifyControl } from '../src/control.ts';
import { ServerMetrics } from '../src/metrics.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { startGameServer } from '../src/server.ts';
import { signJoinTicket, type JoinTicketClaims } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient, testDeps, type FakeMatchSim } from './helpers.ts';

const SECRET = TEST_SECRETS.GAME_TICKET_SECRET;
const CONTROL = TEST_SECRETS.GAME_SERVER_SECRET;
const WALL = Date.parse('2026-10-02T12:00:00Z');
const TICK_MS = 1000 / 30;

class RecordingConnection extends FakeConnection {
  closeCode = 0;
  override close(code = 1000, reason = ''): void {
    if (this.open) this.closeCode = code;
    super.close(code, reason);
  }
}

const claims = (sub: string): JoinTicketClaims => ({
  sub,
  name: `${sub}#0001`,
  mid: 'm_private_1',
  sid: 'gs-test',
  pid: 'custom:ABCDEF',
  team: null,
  role: 'player',
  playlistId: 'main-show',
  queue: 'custom',
  region: 'na',
  size: 4,
  humans: 3,
  bots: 1,
  teamSize: 1,
});

function setup() {
  const clock = { now: 1000 };
  const sims: FakeMatchSim[] = [];
  const manager = new RoomManager(testDeps(clock, sims), new ServerMetrics(), null, {
    config: { capacity: 4, fillWaitMs: 60_000, startAtHumans: 4, ticketedFillWaitMs: 60_000 },
    profileLogMs: 0,
    tickets: { secret: SECRET, allowUnticketed: false, now: () => WALL },
  });
  const connect = (sub: string) => {
    const conn = new RecordingConnection();
    manager.accept(conn);
    const c = new TestClient(conn);
    c.hello(sub, '', signJoinTicket(SECRET, claims(sub), WALL));
    c.pump(clock.now);
    return { c, conn };
  };
  const advance = (ticks: number, clients: TestClient[]): void => {
    for (let i = 0; i < ticks; i++) {
      clock.now += TICK_MS;
      manager.tick();
      for (const c of clients) c.pump(clock.now);
    }
  };
  return { manager, connect, advance, sims };
}

const names = (c: TestClient): string[] => {
  const list = c.lowFreq('playerList').at(-1) as Extract<LowFreqMessage, { t: 'playerList' }> | undefined;
  return (list?.players ?? []).map((p) => p.name);
};

describe('host kicks on the game server', () => {
  it('despawns a kicked player from the pre-show lobby and refuses their ticket', () => {
    const { manager, connect, advance } = setup();
    const host = connect('host');
    const ann = connect('ann');
    advance(2, [host.c, ann.c]);
    expect(names(host.c)).toEqual(['host', 'ann']);

    expect(manager.kickUser('m_private_1', 'ann')).toBe(true);
    advance(2, [host.c, ann.c]);
    expect(ann.c.kicked).toBe(true);
    expect(ann.conn.closeCode).toBe(4000 + KickReason.RemovedByHost);
    expect(names(host.c)).toEqual(['host']);

    const back = connect('ann');
    expect(back.c.welcome).toBeNull();
    expect(back.conn.closeCode).toBe(4000 + KickReason.RemovedByHost);
    expect(manager.list()[0]!.humans).toBe(1);
  });

  it('forfeits a kicked player mid-show and keeps the ban for unknown matches', () => {
    const { manager, connect, advance, sims } = setup();
    const host = connect('host');
    const ann = connect('ann');
    const bob = connect('bob');
    // Every ticketed human (3) is in, so the show starts without waiting.
    advance(3, [host.c, ann.c, bob.c]);
    expect(sims).toHaveLength(1);
    manager.kickUser('m_private_1', 'bob');
    advance(2, [host.c, ann.c, bob.c]);
    expect(bob.c.kicked).toBe(true);
    expect(manager.list()[0]!.humans).toBe(2);
    // Mid-show the slot stays in the list as forfeited (like an expired resume), so results still add up.
    const list = host.c.lowFreq('playerList').at(-1) as Extract<LowFreqMessage, { t: 'playerList' }>;
    expect(list.players.find((p) => p.name === 'bob')?.connected).toBe(false);
    expect(manager.kickUser('m_unknown', 'x')).toBe(false);
  });
});

describe('control endpoint', () => {
  it('verifies signatures and timestamps', () => {
    const body = '{"matchId":"m","userId":"u"}';
    const sig = signControl(CONTROL, WALL, body);
    expect(verifyControl(CONTROL, String(WALL), sig, body, WALL + 1000)).toBe(true);
    expect(verifyControl(CONTROL, String(WALL), sig, body, WALL + 60_000)).toBe(false);
    expect(verifyControl('other-secret-0123456789', String(WALL), sig, body, WALL)).toBe(false);
    expect(verifyControl(CONTROL, String(WALL), sig, body.replace('u', 'v'), WALL)).toBe(false);
    expect(verifyControl(CONTROL, undefined, sig, body, WALL)).toBe(false);
  });

  it('serves POST /internal/kick only with a valid signature', async () => {
    const sims: FakeMatchSim[] = [];
    const deps = { ...testDeps({ now: 0 }, sims), now: () => performance.now() };
    const server = await startGameServer({
      port: 0,
      host: '127.0.0.1',
      deps,
      profileLogMs: 0,
      control: { secret: CONTROL },
    });
    const post = (body: string, ts: number, sig: string) =>
      fetch(`http://127.0.0.1:${server.port}/internal/kick`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tumble-ts': String(ts), 'x-tumble-sig': sig },
        body,
      });
    try {
      const body = JSON.stringify({ matchId: 'm_none', userId: 'u1' });
      const now = Date.now();
      expect((await post(body, now, 'bad')).status).toBe(401);
      // Unknown match: authorised, but nothing is hosted here.
      expect((await post(body, now, signControl(CONTROL, now, body))).status).toBe(404);
      const bad = '{"matchId":1}';
      expect((await post(bad, now, signControl(CONTROL, now, bad))).status).toBe(400);
    } finally {
      await server.close();
    }
    const plain = await startGameServer({ port: 0, host: '127.0.0.1', deps, profileLogMs: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${plain.port}/internal/kick`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
