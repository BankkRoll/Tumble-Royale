import type { TriggerDef } from '@tumble/shared';
import type { SimEvent } from '../events.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import { BaseRules } from './base.ts';
import type { RulesHost, RulesPlayer } from './types.ts';

/**
 * Team rules: teams accumulate points from obstacle `score` events (painted
 * tiles, delivered eggs), props entering `nest`/`goal` triggers (trigger
 * `index` = scoring team) and players standing in their team's `zone`. When
 * time runs out the lowest `teamsEliminated` teams are out.
 *
 * Ties across the elimination line go to overtime (sudden death: the first
 * score that breaks the tie decides). If overtime also ends tied, the team
 * that reached its score first ranks higher, then the lower team index.
 */
export class TeamScoreRules extends BaseRules {
  readonly mode = 'teamScore' as const;
  private teamCount = 2;
  private teamScoreTick: number[] = [];
  /** Per player index: zone team they stand in, or -1. */
  private inZone: number[] = [];
  private zoneAccum: number[] = [];
  private readonly order: number[] = [];
  /** Obstacle-held points per team already folded into `teamScores`. */
  private obstacleApplied: number[] = [];
  private readonly obstacleNow: number[] = [];

  override init(host: RulesHost): void {
    super.init(host);
    this.teamCount = Math.max(2, Math.min(4, host.round.qualification.teams || 2));
    this.teamScores = new Array<number>(this.teamCount).fill(0);
    this.teamScoreTick = new Array<number>(this.teamCount).fill(0);
    this.zoneAccum = new Array<number>(this.teamCount).fill(0);
    this.obstacleApplied = new Array<number>(this.teamCount).fill(0);
    this.inZone = new Array<number>(host.players.length).fill(-1);
    const teams = host.players.map((p) => p.team);
    assignTeams(
      teams,
      host.players.map((p) => p.id),
      this.teamCount,
    );
    host.players.forEach((p, i) => {
      p.team = teams[i] as number;
    });
  }

  /** Adds `delta` to `team` and emits a `score` event. */
  addScore(team: number, player: number, delta: number): void {
    if (team < 0 || team >= this.teamCount || delta === 0 || this.finished) return;
    const total = (this.teamScores[team] as number) + delta;
    this.teamScores[team] = total;
    this.teamScoreTick[team] = this.host.tick;
    const p = player >= 0 ? this.host.playerById(player) : undefined;
    if (p) {
      p.score += delta;
      p.scoreTick = this.host.tick;
    }
    this.host.events.push({ type: 'score', team, player, delta, total });
  }

  override onEvent(e: SimEvent): void {
    if (e.type !== 'score') return;
    let team = e.team;
    if (team < 0 || team >= this.teamCount) team = this.host.playerById(e.player)?.team ?? -1;
    if (team < 0 || team >= this.teamCount || e.delta === 0 || this.finished) return;
    // Obstacles already pushed their own event; only the books need updating.
    this.teamScores[team] = (this.teamScores[team] as number) + e.delta;
    this.teamScoreTick[team] = this.host.tick;
    const p = this.host.playerById(e.player);
    if (p) {
      p.score += e.delta;
      p.scoreTick = this.host.tick;
    }
  }

  override onPropTrigger(trigger: TriggerDef, _propKey: number, entered: boolean): void {
    if (trigger.kind === 'nest') this.addScore(trigger.index, -1, entered ? 1 : -1);
    else if (trigger.kind === 'goal' && entered) this.addScore(trigger.index, -1, 1);
  }

  override onTrigger(p: RulesPlayer, trigger: TriggerDef, entered: boolean): void {
    if (trigger.kind !== 'zone') return;
    const idx = this.host.players.indexOf(p);
    if (idx < 0) return;
    if (entered && trigger.index === p.team) this.inZone[idx] = p.team;
    else if (!entered && this.inZone[idx] === trigger.index) this.inZone[idx] = -1;
  }

  /** Applies the change in obstacle-held points (paint, nest bonuses) since the last step. */
  private syncObstacleScores(): void {
    const now = this.obstacleNow;
    now.length = this.teamCount;
    now.fill(0);
    if (!this.host.obstacleTeamScores?.(now)) return;
    for (let t = 0; t < this.teamCount; t++) {
      const delta = (now[t] as number) - (this.obstacleApplied[t] as number);
      if (delta === 0) continue;
      this.obstacleApplied[t] = now[t] as number;
      this.teamScores[t] = (this.teamScores[t] as number) + delta;
      this.teamScoreTick[t] = this.host.tick;
    }
  }

  protected override tickRules(): void {
    this.syncObstacleScores();
    const rate = this.options.zonePointsPerSecond ?? 1;
    if (rate > 0) {
      for (let i = 0; i < this.inZone.length; i++) {
        const t = this.inZone[i] as number;
        const p = this.host.players[i];
        if (t < 0 || !p || p.status !== PlayerRoundStatus.Playing) continue;
        this.zoneAccum[t] = (this.zoneAccum[t] as number) + rate * this.dt;
      }
      for (let t = 0; t < this.teamCount; t++) {
        const whole = Math.floor(this.zoneAccum[t] as number);
        if (whole >= 1) {
          this.zoneAccum[t] = (this.zoneAccum[t] as number) - whole;
          this.addScore(t, -1, whole);
        }
      }
    }
    if (this.host.inOvertime && !this.boundaryTied()) {
      this.decide();
      this.finishRound();
      return;
    }
    if (this.activeTeams() <= this.survivingTeamCount()) {
      this.decide();
      this.finishRound();
    }
  }

  protected override wantsOvertime(): boolean {
    return this.boundaryTied();
  }

  protected onTimeUp(): void {
    this.decide();
  }

  private survivingTeamCount(): number {
    return Math.max(1, this.teamCount - Math.max(1, this.host.round.qualification.teamsEliminated));
  }

  /** Teams that still have a player in the round. */
  private activeTeams(): number {
    let mask = 0;
    for (const p of this.host.players)
      if (p.status === PlayerRoundStatus.Playing && p.team >= 0) mask |= 1 << p.team;
    let n = 0;
    for (let t = 0; t < this.teamCount; t++) if (mask & (1 << t)) n++;
    return n;
  }

  /** Fills `order` with team indices best-first. */
  private rankTeams(): number[] {
    const order = this.order;
    order.length = 0;
    for (let t = 0; t < this.teamCount; t++) order.push(t);
    const s = this.teamScores;
    const st = this.teamScoreTick;
    order.sort(
      (a, b) => (s[b] as number) - (s[a] as number) || (st[a] as number) - (st[b] as number) || a - b,
    );
    return order;
  }

  private boundaryTied(): boolean {
    const order = this.rankTeams();
    const k = this.survivingTeamCount();
    if (k >= order.length) return false;
    return this.teamScores[order[k - 1] as number] === this.teamScores[order[k] as number];
  }

  private decide(): void {
    const order = this.rankTeams();
    const k = this.survivingTeamCount();
    const players = this.host.players;
    for (let r = 0; r < order.length; r++) {
      if (r >= k) continue;
      const team = order[r] as number;
      for (const p of players)
        if (p.team === team && p.status === PlayerRoundStatus.Playing) this.host.qualify(p);
    }
    for (let r = order.length - 1; r >= k; r--) {
      const team = order[r] as number;
      for (let i = players.length - 1; i >= 0; i--) {
        const p = players[i] as RulesPlayer;
        if (p.team === team && p.status === PlayerRoundStatus.Playing) this.host.eliminate(p);
      }
    }
    this.eliminateRemaining();
  }
}

/**
 * Deals players without a valid team (dev/offline launches) onto the
 * smallest teams, in id order, so team sizes stay balanced and every machine
 * agrees on the result. Players with a valid team keep it (parties).
 *
 * @param teams - Team per player; entries outside [0, teamCount) are replaced in place.
 * @param ids - Player id per entry, for deterministic ordering.
 * @param teamCount - Number of teams (clamped to 2–4).
 */
export function assignTeams(teams: number[], ids: readonly number[], teamCount: number): void {
  const n = Math.max(2, Math.min(4, teamCount || 2));
  const counts = new Array<number>(n).fill(0);
  for (const t of teams) if (t >= 0 && t < n) counts[t]!++;
  const order = teams
    .map((_, i) => i)
    .filter((i) => !((teams[i] as number) >= 0 && (teams[i] as number) < n));
  order.sort((a, b) => (ids[a] as number) - (ids[b] as number));
  for (const i of order) {
    let best = 0;
    for (let t = 1; t < n; t++) if ((counts[t] as number) < (counts[best] as number)) best = t;
    teams[i] = best;
    counts[best]!++;
  }
}
