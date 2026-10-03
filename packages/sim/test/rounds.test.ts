import { Rng, RoundPhase, type RoundDefinition, type TriggerDef } from '@tumble/shared';
import { describe, expect, it } from 'vitest';
import { EventSink } from '../src/events.ts';
import {
  PlayerRoundStatus,
  createMatchSim,
  createSimpleController,
  createTestArenaRound,
  testObstacleModules,
} from '../src/match/index.ts';
import { loadRapier } from '../src/index.ts';
import {
  computeQualifyTarget,
  createRoundRules,
  type RoundRules,
  type RoundRulesOptions,
  type RulesHost,
  type RulesPlayer,
} from '../src/rounds/index.ts';

/** Minimal in-memory host: the same bookkeeping the match sim does, minus physics. */
class FakeHost implements RulesHost {
  readonly events = new EventSink();
  readonly rng = new Rng(1);
  readonly players: RulesPlayer[];
  tick = 0;
  time = 0;
  inOvertime = false;
  qualifiedCount = 0;
  eliminatedCount = 0;
  readonly rules: RoundRules;

  constructor(
    readonly round: RoundDefinition,
    n: number,
    options: RoundRulesOptions = {},
    teams?: number[],
  ) {
    this.players = Array.from({ length: n }, (_, i) => ({
      id: i,
      team: teams?.[i] ?? -1,
      isBot: true,
      status: PlayerRoundStatus.Playing,
      score: 0,
      progress: i / n,
      place: 0,
      finishTick: -1,
      finishSubTick: 0,
      hasItem: false,
      scoreTick: 0,
      checkpoint: 0,
      pos: { x: 0, y: i, z: 0 },
      forfeited: false,
    }));
    this.rules = createRoundRules(round, n, options);
    this.rules.init(this);
    this.rules.start();
  }

  get entrants(): number {
    return this.players.length;
  }

  get timeLeft(): number {
    const d = this.round.duration;
    const limit = d.seconds + (this.inOvertime ? d.overtimeSeconds : 0);
    return Math.max(0, limit - this.time);
  }

  playerById(id: number): RulesPlayer | undefined {
    return this.players[id];
  }

  qualify(p: RulesPlayer): void {
    if (p.status !== PlayerRoundStatus.Playing) return;
    p.status = PlayerRoundStatus.Qualified;
    p.place = ++this.qualifiedCount;
    this.events.push({ type: 'qualified', player: p.id, place: p.place });
  }

  eliminate(p: RulesPlayer): void {
    if (p.status !== PlayerRoundStatus.Playing) return;
    p.status = PlayerRoundStatus.Eliminated;
    p.place = this.entrants - this.eliminatedCount++;
    this.events.push({ type: 'eliminated', player: p.id, place: p.place });
  }

  setHasItem(p: RulesPlayer, has: boolean): void {
    p.hasItem = has;
  }

  requestOvertime(): boolean {
    if (this.inOvertime || this.round.duration.overtimeSeconds <= 0) return false;
    this.inOvertime = true;
    return true;
  }

  /** Steps the rules for `seconds` of match time. */
  run(seconds: number): void {
    const steps = Math.round(seconds * 60);
    for (let i = 0; i < steps && !this.rules.finished; i++) {
      this.rules.update(1 / 60);
      this.tick++;
      this.time += 1 / 60;
    }
  }

  status(id: number): number {
    return (this.players[id] as RulesPlayer).status;
  }
}

const trigger = (kind: TriggerDef['kind'], index = 0): TriggerDef => ({
  id: `${kind}-${index}`,
  kind,
  index,
  position: { x: 0, y: 0, z: 0 },
  size: { x: 4, y: 4, z: 4 },
  respawn: [],
  respawnYaw: 0,
});

describe('quota', () => {
  it('follows ceil(entrants × ratio) with sane clamps', () => {
    const race = createTestArenaRound();
    expect(computeQualifyTarget(race, 40)).toBe(26);
    expect(computeQualifyTarget(race, 2)).toBe(1);
    expect(computeQualifyTarget(race, 1)).toBe(1);
    expect(computeQualifyTarget(race, 40, 50)).toBe(39);
    const final = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'crownGrab', ratio: 0, teams: 0, teamsEliminated: 1 },
    });
    expect(computeQualifyTarget(final, 7)).toBe(1);
    const team = createTestArenaRound({
      qualification: { mode: 'teamScore', ratio: 0, teams: 4, teamsEliminated: 1 },
    });
    expect(computeQualifyTarget(team, 20)).toBe(15);
  });
});

describe('race rules (finish)', () => {
  it('qualifies in finish order (tick, then sub-tick) and eliminates the rest when the quota fills', () => {
    const host = new FakeHost(createTestArenaRound(), 10);
    expect(host.rules.qualifyTarget).toBe(7);
    const order = [4, 2, 9, 0, 1, 3, 5];
    // Players 2 and 4 finish on the same tick; 4 crossed earlier in the step.
    host.rules.onFinishLine(host.players[4]!, 100, 0.2);
    host.rules.onFinishLine(host.players[2]!, 100, 0.7);
    for (let i = 2; i < order.length; i++) host.rules.onFinishLine(host.players[order[i]!]!, 120 + i, 0);
    expect(host.rules.finished).toBe(true);
    order.forEach((id, i) => {
      expect(host.status(id)).toBe(PlayerRoundStatus.Qualified);
      expect(host.players[id]!.place).toBe(i + 1);
    });
    // The unfinished are ranked by progress: player 8 (furthest) gets the best eliminated place.
    expect(host.players[8]!.place).toBe(8);
    expect(host.players[7]!.place).toBe(9);
    expect(host.players[6]!.place).toBe(10);
    const elim = host.events.events.filter((e) => e.type === 'eliminated');
    expect(elim).toHaveLength(3);
  });

  it('eliminates the unfinished at the time limit', () => {
    const host = new FakeHost(createTestArenaRound({ duration: { seconds: 5, overtimeSeconds: 0 } }), 6);
    host.rules.onFinishLine(host.players[3]!, 10, 0);
    host.run(6);
    expect(host.rules.finished).toBe(true);
    expect(host.status(3)).toBe(PlayerRoundStatus.Qualified);
    for (const id of [0, 1, 2, 4, 5]) expect(host.status(id)).toBe(PlayerRoundStatus.Eliminated);
  });

  it('respects fallBehavior', () => {
    const respawn = new FakeHost(createTestArenaRound(), 4);
    expect(respawn.rules.onFellOut(respawn.players[0]!)).toBe('respawn');
    const elim = new FakeHost(createTestArenaRound({ fallBehavior: 'eliminate' }), 4);
    expect(elim.rules.onFellOut(elim.players[0]!)).toBe('eliminate');
  });
});

describe('survival rules', () => {
  const survival = (seconds = 10) =>
    createTestArenaRound({
      type: 'survival',
      qualification: { mode: 'survive', ratio: 0.5, teams: 0, teamsEliminated: 1 },
      duration: { seconds, overtimeSeconds: 0 },
    });

  it('eliminates fallers and qualifies survivors at the buzzer', () => {
    const host = new FakeHost(survival(), 10);
    expect(host.rules.onFellOut(host.players[1]!)).toBe('eliminate');
    host.eliminate(host.players[1]!);
    host.eliminate(host.players[2]!);
    host.run(11);
    expect(host.rules.finished).toBe(true);
    expect(host.qualifiedCount).toBe(8);
    expect(host.status(1)).toBe(PlayerRoundStatus.Eliminated);
    expect(host.players[1]!.place).toBe(10);
  });

  it('ends early once survivors drop to the quota', () => {
    const host = new FakeHost(survival(60), 10);
    for (let i = 0; i < 5; i++) host.eliminate(host.players[i]!);
    host.run(0.1);
    expect(host.rules.finished).toBe(true);
    expect(host.qualifiedCount).toBe(5);
    expect(host.time).toBeLessThan(1);
  });

  it('can run to the timer when early end is disabled', () => {
    const host = new FakeHost(survival(2), 10, { endEarlyAtQuota: false });
    for (let i = 0; i < 7; i++) host.eliminate(host.players[i]!);
    host.run(1);
    expect(host.rules.finished).toBe(false);
    host.run(2);
    expect(host.qualifiedCount).toBe(3);
  });
});

describe('team rules', () => {
  const teamRound = (overtime = 0) =>
    createTestArenaRound({
      type: 'team',
      qualification: { mode: 'teamScore', ratio: 0, teams: 3, teamsEliminated: 1 },
      duration: { seconds: 10, overtimeSeconds: overtime },
    });

  it('scores obstacle events, nest props and zones; lowest team is eliminated', () => {
    const host = new FakeHost(teamRound(), 9, { zonePointsPerSecond: 1 });
    const teams = host.players.map((p) => p.team);
    expect(new Set(teams).size).toBe(3);
    const t0 = host.players.find((p) => p.team === 0)!;
    host.rules.onEvent({ type: 'score', team: 0, player: t0.id, delta: 5, total: 5 });
    host.rules.onPropTrigger(trigger('nest', 1), 1001, true);
    host.rules.onPropTrigger(trigger('nest', 1), 1002, true);
    host.rules.onPropTrigger(trigger('nest', 1), 1002, false);
    const t2 = host.players.find((p) => p.team === 2)!;
    host.rules.onTrigger(t2, trigger('zone', 2), true);
    host.run(3.05);
    expect(host.rules.teamScores[0]).toBe(5);
    expect(host.rules.teamScores[1]).toBe(1);
    expect(host.rules.teamScores[2]).toBe(3);
    expect(t0.score).toBe(5);
    host.run(8);
    expect(host.rules.finished).toBe(true);
    for (const p of host.players) {
      expect(p.status).toBe(p.team === 1 ? PlayerRoundStatus.Eliminated : PlayerRoundStatus.Qualified);
    }
  });

  it('goes to sudden-death overtime on a tie across the line', () => {
    const host = new FakeHost(teamRound(30), 6, { zonePointsPerSecond: 0 });
    host.rules.onPropTrigger(trigger('goal', 0), 1, true);
    host.rules.onPropTrigger(trigger('goal', 0), 2, true);
    host.rules.onPropTrigger(trigger('goal', 1), 3, true);
    host.rules.onPropTrigger(trigger('goal', 2), 4, true);
    host.run(11);
    expect(host.inOvertime).toBe(true);
    expect(host.rules.finished).toBe(false);
    host.rules.onPropTrigger(trigger('goal', 2), 5, true);
    host.run(0.1);
    expect(host.rules.finished).toBe(true);
    for (const p of host.players)
      expect(p.status).toBe(p.team === 1 ? PlayerRoundStatus.Eliminated : PlayerRoundStatus.Qualified);
  });
});

describe('hunt rules (holdItem)', () => {
  const hunt = () =>
    createTestArenaRound({
      type: 'hunt',
      qualification: { mode: 'holdItem', ratio: 0.5, teams: 0, teamsEliminated: 1 },
      duration: { seconds: 10, overtimeSeconds: 0 },
    });

  it('hands out quota-many items, steals on grab, and qualifies holders at the buzzer', () => {
    const host = new FakeHost(hunt(), 10);
    const holders = host.players.filter((p) => p.hasItem);
    expect(holders).toHaveLength(5);
    const victim = holders[0]!;
    const thief = host.players.find((p) => !p.hasItem)!;
    host.run(2);
    host.rules.onEvent({ type: 'grabStart', player: thief.id, target: victim.id, targetKind: 'player' });
    expect(thief.hasItem).toBe(true);
    expect(victim.hasItem).toBe(false);
    // Immediate steal-back is blocked by the cooldown.
    host.rules.onEvent({ type: 'grabStart', player: victim.id, target: thief.id, targetKind: 'player' });
    expect(thief.hasItem).toBe(true);
    host.run(9);
    expect(host.rules.finished).toBe(true);
    for (const p of host.players)
      expect(p.status).toBe(p.hasItem ? PlayerRoundStatus.Qualified : PlayerRoundStatus.Eliminated);
  });
});

describe('finals', () => {
  it('crown grab: first to the crown wins, everyone else out', () => {
    const round = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'crownGrab', ratio: 0, teams: 0, teamsEliminated: 1 },
    });
    const host = new FakeHost(round, 7);
    host.rules.onTrigger(host.players[5]!, trigger('crown'), true);
    expect(host.rules.finished).toBe(true);
    expect(host.status(5)).toBe(PlayerRoundStatus.Qualified);
    expect(host.players[5]!.place).toBe(1);
    expect(host.qualifiedCount).toBe(1);
    expect(host.eliminatedCount).toBe(6);
    // A late touch after the win changes nothing.
    host.rules.onTrigger(host.players[6]!, trigger('crown'), true);
    expect(host.status(6)).toBe(PlayerRoundStatus.Eliminated);
  });

  it('crown grab timeout crowns the furthest climber', () => {
    const round = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'crownGrab', ratio: 0, teams: 0, teamsEliminated: 1 },
      duration: { seconds: 3, overtimeSeconds: 0 },
    });
    const host = new FakeHost(round, 5);
    host.run(4);
    expect(host.status(4)).toBe(PlayerRoundStatus.Qualified);
  });

  it('last standing: falls eliminate until one remains; timeout picks the highest', () => {
    const round = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'lastStanding', ratio: 0, teams: 0, teamsEliminated: 1 },
      duration: { seconds: 5, overtimeSeconds: 0 },
    });
    const host = new FakeHost(round, 4);
    // The fall is parked for the step and eliminated when the rules update.
    expect(host.rules.onFellOut(host.players[0]!)).toBe('respawn');
    host.run(1 / 60);
    expect(host.status(0)).toBe(PlayerRoundStatus.Eliminated);
    expect(host.players[0]!.place).toBe(4);
    host.eliminate(host.players[2]!);
    host.eliminate(host.players[3]!);
    host.run(0.05);
    expect(host.status(1)).toBe(PlayerRoundStatus.Qualified);

    const timeout = new FakeHost(round, 4);
    timeout.run(6);
    expect(timeout.status(3)).toBe(PlayerRoundStatus.Qualified);
    expect(timeout.qualifiedCount).toBe(1);
  });

  const lastStanding = (overtimeSeconds = 0) =>
    createTestArenaRound({
      type: 'final',
      qualification: { mode: 'lastStanding', ratio: 0, teams: 0, teamsEliminated: 1 },
      duration: { seconds: 5, overtimeSeconds },
      fallBehavior: 'eliminate',
    });

  /** Every remaining player falls in one step, in slot order, with the given heights. */
  const fallTogether = (host: FakeHost, ids: number[], heights: number[]) => {
    ids.forEach((id, i) => {
      host.players[id]!.pos.y = heights[i]!;
      host.rules.onFellOut(host.players[id]!);
    });
    host.run(1 / 60);
  };

  it('last standing: the last players falling on the same tick still crown exactly one (highest at the fall)', () => {
    const host = new FakeHost(lastStanding(), 5);
    host.eliminate(host.players[4]!);
    host.run(0.5);
    // Slot order would hand it to player 3; player 1 was highest when they dropped.
    fallTogether(host, [0, 1, 2, 3], [-10.4, -10.1, -10.9, -10.3]);
    expect(host.rules.finished).toBe(true);
    expect(host.qualifiedCount).toBe(1);
    expect(host.status(1)).toBe(PlayerRoundStatus.Qualified);
    expect(host.players[1]!.place).toBe(1);
    // Losers are placed by the same tiebreak: 3 (−10.3) second, 0 third, 2 fourth.
    expect([host.players[3]!.place, host.players[0]!.place, host.players[2]!.place]).toEqual([2, 3, 4]);
    expect(host.eliminatedCount).toBe(4);
  });

  it('last standing: same-tick height ties fall back to progress, then lowest id', () => {
    const byProgress = new FakeHost(lastStanding(), 3);
    byProgress.players[0]!.progress = 0.2;
    byProgress.players[1]!.progress = 0.9;
    byProgress.players[2]!.progress = 0.2;
    fallTogether(byProgress, [0, 1, 2], [-10, -10, -10]);
    expect(byProgress.status(1)).toBe(PlayerRoundStatus.Qualified);

    const byId = new FakeHost(lastStanding(), 3);
    for (const p of byId.players) p.progress = 0.5;
    fallTogether(byId, [2, 1, 0], [-10, -10, -10]);
    expect(byId.status(0)).toBe(PlayerRoundStatus.Qualified);
    expect(byId.qualifiedCount).toBe(1);
  });

  it('last standing: a same-tick fall while others still stand eliminates every faller', () => {
    const host = new FakeHost(lastStanding(), 4);
    fallTogether(host, [0, 1], [-10, -9]);
    expect(host.status(0)).toBe(PlayerRoundStatus.Eliminated);
    expect(host.status(1)).toBe(PlayerRoundStatus.Eliminated);
    expect(host.rules.finished).toBe(false);
    fallTogether(host, [2], [-10]);
    expect(host.rules.finished).toBe(true);
    expect(host.status(3)).toBe(PlayerRoundStatus.Qualified);
  });

  it('last standing: the hard cap (after overtime) crowns one survivor by height', () => {
    const host = new FakeHost(lastStanding(3), 4);
    host.players[1]!.pos.y = 50;
    host.run(5.5);
    expect(host.inOvertime).toBe(true);
    expect(host.rules.finished).toBe(false);
    host.run(3);
    expect(host.rules.finished).toBe(true);
    expect(host.qualifiedCount).toBe(1);
    expect(host.status(1)).toBe(PlayerRoundStatus.Qualified);
  });

  it('crown grab with eliminating falls: a simultaneous last fall still crowns one', () => {
    const round = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'crownGrab', ratio: 0, teams: 0, teamsEliminated: 1 },
      fallBehavior: 'eliminate',
    });
    const host = new FakeHost(round, 3);
    fallTogether(host, [0, 1, 2], [-12, -11, -11.5]);
    expect(host.rules.finished).toBe(true);
    expect(host.qualifiedCount).toBe(1);
    expect(host.status(1)).toBe(PlayerRoundStatus.Qualified);

    const respawning = new FakeHost(
      createTestArenaRound({
        type: 'final',
        qualification: { mode: 'crownGrab', ratio: 0, teams: 0, teamsEliminated: 1 },
        fallBehavior: 'respawnCheckpoint',
      }),
      3,
    );
    expect(respawning.rules.onFellOut(respawning.players[0]!)).toBe('respawn');
    respawning.run(1 / 60);
    expect(respawning.status(0)).toBe(PlayerRoundStatus.Playing);
  });
});

describe('finals in a real match sim', () => {
  it('two finalists falling past killY on the same step: the higher one is crowned', async () => {
    const R = await loadRapier();
    const round = createTestArenaRound({
      type: 'final',
      qualification: { mode: 'lastStanding', ratio: 0, teams: 0, teamsEliminated: 1 },
      fallBehavior: 'eliminate',
    });
    const players = [0, 1, 2].map((id) => ({ id, name: `P${id}`, isBot: false, team: -1 }));
    const sim = createMatchSim(
      { R, round, seed: 4, stage: 0, players, mode: 'authority' },
      { createController: createSimpleController, obstacles: testObstacleModules() },
    );
    sim.setPhase(RoundPhase.Countdown);
    for (let i = 0; i < 180; i++) sim.step();
    sim.setPhase(RoundPhase.Playing, 0);
    sim.controller(2)!.teleport({ x: 0, y: -40, z: 0 });
    sim.step();
    expect(sim.getStatus().players.get(2)?.status).toBe(PlayerRoundStatus.Eliminated);
    // Slot 0 is processed first, but slot 1 is higher when both cross killY (−10).
    sim.controller(0)!.teleport({ x: 0, y: -30, z: 0 });
    sim.controller(1)!.teleport({ x: 2, y: -20, z: 0 });
    sim.step();
    const st = sim.getStatus();
    expect(st.qualifiedCount).toBe(1);
    expect(st.players.get(1)?.status).toBe(PlayerRoundStatus.Qualified);
    expect(st.players.get(1)?.place).toBe(1);
    expect(st.players.get(0)?.status).toBe(PlayerRoundStatus.Eliminated);
    expect(st.players.get(0)?.place).toBe(2);
    expect(sim.rules?.finished).toBe(true);
    sim.dispose();
  });
});
