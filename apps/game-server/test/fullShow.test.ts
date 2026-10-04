/**
 * One seeded Main Show with a full 100-seat lobby (one ticketed human who
 * never touches the controls, 99 bots) played from the pre-show lobby to the
 * Crown through the real RoomManager, Room, show director, Rapier match sims
 * and Tumbler controllers, on a fake clock. Asserts the field shrinks round by
 * round along the playlist curve to a final, exactly one player is crowned,
 * and the results the room posts pass the API's ingest schema at 100 players.
 *
 * Every round is simulated in full (minutes of 100-capsule physics), so the
 * suite is opt-in:
 *
 *   TUMBLE_SLOW=1 pnpm --filter @tumble/game-server exec vitest run test/fullShow.test.ts
 */
import type { LowFreqMessage } from '@tumble/netcode';
import { MAX_PLAYERS, SERVER_TICK_HZ } from '@tumble/shared';
import { loadRapier } from '@tumble/sim';
import { PRE_SHOW_LOBBY_ROUND_ID } from '@tumble/sim/show';
import { describe, expect, it } from 'vitest';
import { MatchResultSchema } from '../../api/src/matches/schema.ts';
import { getPlaylist } from '@tumble/content/shows';
import { ServerMetrics } from '../src/metrics.ts';
import { createRealRoomDeps } from '../src/realDeps.ts';
import type { IngestResponse, MatchResultPayload } from '../src/results.ts';
import { RoomManager } from '../src/room/RoomManager.ts';
import { signJoinTicket } from '../src/tickets.ts';
import { FakeConnection, TEST_SECRETS, TestClient } from './helpers.ts';

const SLOW = process.env.TUMBLE_SLOW === '1';
const TICK_MS = 1000 / SERVER_TICK_HZ;
const WALL = Date.parse('2026-10-02T12:00:00Z');
const HUMAN = '11111111-1111-4111-8111-111111111111';

describe(`a full ${MAX_PLAYERS}-player Main Show under physics`, () => {
  it.runIf(SLOW)(
    'shrinks along the playlist curve to one Crown and posts results the API accepts',
    async () => {
      const R = await loadRapier();
      const clock = { now: 1000 };
      const posted: MatchResultPayload[] = [];
      const deps = {
        ...createRealRoomDeps(R, {
          playlistId: 'main-show',
          results: {
            async post(payload: MatchResultPayload): Promise<IngestResponse> {
              posted.push(payload);
              return { matchId: payload.matchId, alreadyProcessed: false, rewards: [] };
            },
          },
        }),
        now: () => clock.now,
        randomSeed: () => 5,
      };
      const manager = new RoomManager(deps, new ServerMetrics(), null, {
        config: { capacity: MAX_PLAYERS, fillWaitMs: 500, startAtHumans: 1, ticketedFillWaitMs: 500 },
        profileLogMs: 0,
        tickets: { secret: TEST_SECRETS.GAME_TICKET_SECRET, allowUnticketed: false, now: () => WALL },
      });
      const conn = new FakeConnection();
      manager.accept(conn);
      const human = new TestClient(conn);
      human.keepSnapshots = false;
      human.hello(
        'Tester',
        '',
        signJoinTicket(
          TEST_SECRETS.GAME_TICKET_SECRET,
          {
            sub: HUMAN,
            name: 'Tester#1234',
            mid: 'm_full_show_100',
            sid: 'gs-test',
            pid: 'solo:tester',
            team: null,
            role: 'player',
            playlistId: 'main-show',
            queue: 'casual',
            region: 'eu',
            size: MAX_PLAYERS,
            humans: 1,
            bots: MAX_PLAYERS - 1,
            teamSize: 1,
          },
          WALL,
        ),
      );
      human.pump(clock.now);
      expect(human.welcome).not.toBeNull();

      const joined: { roundId: string; qualifyTarget: number; isFinal: boolean }[] = [];
      // Half an hour of show time is several times what five rounds need.
      for (let t = 0; t < SERVER_TICK_HZ * 1800 && posted.length === 0; t++) {
        clock.now += TICK_MS;
        manager.tick();
        human.pump(clock.now);
        for (const m of human.messages) {
          if (m.kind !== 'msg' || m.msg.t !== 'joinRound' || m.msg.roundId === PRE_SHOW_LOBBY_ROUND_ID)
            continue;
          const join = m.msg as Extract<LowFreqMessage, { t: 'joinRound' }>;
          joined.push({ roundId: join.roundId, qualifyTarget: join.qualifyTarget, isFinal: join.isFinal });
          human.send({ t: 'loaded', roundId: join.roundId });
        }
        human.messages.length = 0;
        // The results post resolves on a microtask.
        if (t % SERVER_TICK_HZ === 0) await Promise.resolve();
      }
      await new Promise((r) => setTimeout(r, 0));
      manager.stop();

      expect(posted, 'the show never posted results').toHaveLength(1);
      const payload = posted[0]!;
      const parsed = MatchResultSchema.safeParse(payload);
      expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 5))).toBe(true);
      expect(payload.participants).toHaveLength(MAX_PLAYERS);
      expect(payload.participants.filter((p) => !p.isBot).map((p) => p.userId)).toEqual([HUMAN]);
      expect(new Set(payload.placements.map((p) => p.key)).size).toBe(MAX_PLAYERS);

      const playlist = getPlaylist('main-show')!;
      const curve = payload.rounds.map((r) => {
        const entrants = r.results.length;
        const qualified = r.results.filter((x) => x.qualified).length;
        return { id: r.roundId, type: r.roundType, entrants, qualified, seconds: r.durationMs / 1000 };
      });
      process.stderr.write(
        `\n[full show] ${curve.map((r) => `${r.id} (${r.type}) ${r.entrants}→${r.qualified} in ${r.seconds.toFixed(0)} s`).join(' | ')}\n`,
      );
      expect(curve.length).toBeGreaterThanOrEqual(playlist.minRounds);
      expect(curve.length).toBeLessThanOrEqual(playlist.maxRounds);
      expect(joined.map((j) => j.roundId)).toEqual(curve.map((r) => r.id));
      expect(curve[0]!.entrants).toBe(MAX_PLAYERS);
      curve.forEach((r, i) => {
        if (i > 0) expect(r.entrants, `round ${i} entrants`).toBe(curve[i - 1]!.qualified);
        expect(r.qualified, `round ${i} qualified`).toBeLessThan(r.entrants);
        expect(r.qualified).toBeGreaterThan(0);
        const join = joined[i]!;
        const last = i === curve.length - 1;
        expect(join.isFinal).toBe(last);
        if (last) {
          expect(r.type).toBe('final');
          expect(r.qualified).toBe(1);
        } else if (r.type === 'race' || r.type === 'hunt') {
          // Races fill the quota the director announced; hunts qualify exactly the holders.
          expect(r.qualified, `${r.id} qualified vs announced target`).toBe(join.qualifyTarget);
        }
      });
      const crowned = payload.placements.filter((p) => p.crowned);
      expect(crowned).toHaveLength(1);
      expect(crowned[0]!.placement).toBe(1);
      const finalist = payload.rounds.at(-1)!.results.find((x) => x.qualified)!;
      expect(crowned[0]!.key).toBe(finalist.key);
    },
    1_800_000,
  );
});
