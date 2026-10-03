/**
 * Maps live round state to the UI HUD at ~12 Hz: timer, qualified counter,
 * alive counter, race progress + leaders, team scores, place/score, ping/FPS,
 * and feeds the same numbers to adaptive music.
 */
import type { GameAudio } from '@tumble/audio';
import { TEAM_COLORS, type RoundDefinition, type RoundType } from '@tumble/shared';
import { ui, type EmoteSlot, type HudState, type ProgressMarker, type TeamScore } from '@tumble/ui';

/** Seconds between HUD pushes (12 Hz, inside the store's 10–15 Hz budget). */
const HUD_INTERVAL = 1 / 12;
const TEAM_NAMES = ['Pink', 'Blue', 'Yellow', 'Green'];

/** Per-player numbers the mapper reads (a subset of the sim's `RoundStatus` entries). */
export interface HudPlayerStatus {
  status: number;
  score: number;
  progress: number;
  place: number;
  team?: number;
  hasItem?: boolean;
}

/** Normalised round status for the HUD (offline sim status or online snapshot). */
export interface HudInput {
  timeLeft: number;
  qualifiedCount: number;
  qualifyTarget: number;
  eliminatedCount: number;
  overtime: boolean;
  teamScores: readonly number[];
  /** Per-player detail when available (offline); online leaves it null. */
  players: ReadonlyMap<number, HudPlayerStatus> | null;
  /** Ids in race/score order (offline), or null. */
  standings: readonly number[] | null;
}

/**
 * Throttled HUD writer for one round.
 *
 * @example
 * const hud = new HudMapper(round, entrants, localId, colorOf, audio);
 * hud.begin(emotes);
 * // per frame
 * hud.update(dt, input, fps, ping);
 */
export class HudMapper {
  private acc = HUD_INTERVAL;
  private readonly leaders: ProgressMarker[] = [];
  private teams: TeamScore[] = [];
  private lastTeamKey = '';
  private objectiveFor: string;

  /**
   * @param round - Round definition.
   * @param entrants - Players entering the round.
   * @param localId - Local player (-1 if spectating the whole round).
   * @param info - Name/colour lookup.
   * @param audio - Adaptive music sink.
   * @param isFinal - Final round (one winner).
   */
  constructor(
    private readonly round: RoundDefinition,
    private readonly entrants: number,
    private readonly localId: number,
    private readonly info: (id: number) => { name: string; color: string } | null,
    private readonly audio: GameAudio | null,
    private readonly isFinal: boolean,
  ) {
    this.objectiveFor = round.objective;
  }

  /**
   * HUD flavour: last-one-standing style rounds (including finals) read as an
   * ALIVE counter; race-style finals keep the qualified counter.
   */
  private get type(): RoundType {
    const mode = this.round.qualification.mode;
    if (mode === 'lastStanding' || mode === 'survive' || mode === 'logicSurvive') return 'survival';
    return this.isFinal ? 'final' : this.round.type;
  }

  /**
   * Resets the HUD for the countdown.
   *
   * @param emotes - Emote wheel slots.
   * @param spectating - The local player is not in this round.
   * @param device - Last input device (controls hint glyphs).
   * @param qualifyTarget - Expected qualifiers.
   */
  begin(emotes: EmoteSlot[], spectating: boolean, device: HudState['device'], qualifyTarget: number): void {
    const d = this.round.duration.seconds;
    ui.getState().resetHud({
      roundType: this.type,
      timeLeft: d > 0 ? d : -1,
      timeTotal: d > 0 ? d : 0,
      overtime: false,
      qualified: 0,
      qualifyTarget,
      eliminated: 0,
      alive: this.entrants,
      objective: this.objectiveFor,
      localStatus: spectating ? 'spectating' : 'playing',
      progress: 0,
      leaders: [],
      teams: [],
      controlsHint: !spectating,
      device,
      emotes,
    });
    this.acc = HUD_INTERVAL;
  }

  /** Forces the next {@link update} to push immediately. */
  flush(): void {
    this.acc = HUD_INTERVAL;
  }

  /**
   * Pushes a HUD patch at most every 1/12 s.
   *
   * @param dt - Real frame delta.
   * @param s - Live status.
   * @param fps - Smoothed FPS.
   * @param ping - RTT ms (0 offline).
   */
  update(dt: number, s: HudInput, fps: number, ping: number): void {
    this.acc += dt;
    if (this.acc < HUD_INTERVAL) return;
    this.acc = 0;
    const patch: Partial<HudState> = {
      timeLeft: s.timeLeft,
      overtime: s.overtime,
      qualified: s.qualifiedCount,
      qualifyTarget: s.qualifyTarget,
      eliminated: s.eliminatedCount,
      alive: Math.max(0, this.entrants - s.eliminatedCount),
      fps: Math.round(fps),
      ping: Math.round(ping),
    };

    const me = s.players && this.localId >= 0 ? s.players.get(this.localId) : undefined;
    if (me) {
      patch.progress = Math.max(0, Math.min(1, me.progress));
      patch.place = me.place;
      patch.score = me.score;
      if (me.hasItem !== undefined) {
        const obj = me.hasItem ? 'You have it — hold on!' : this.round.objective;
        if (obj !== this.objectiveFor) {
          this.objectiveFor = obj;
          patch.objective = obj;
        }
      }
    }

    if (s.standings && s.players) {
      this.leaders.length = 0;
      for (const id of s.standings) {
        if (this.leaders.length >= 3) break;
        const p = s.players.get(id);
        const who = this.info(id);
        if (!p || !who) continue;
        this.leaders.push({ id, name: who.name, color: who.color, progress: Math.max(0, Math.min(1, p.progress)) });
      }
      patch.leaders = this.leaders.slice();
    }

    if (this.round.qualification.mode === 'teamScore' && s.teamScores.length > 0) {
      const myTeam = me?.team ?? -1;
      const key = `${s.teamScores.join(',')}|${myTeam}`;
      if (key !== this.lastTeamKey) {
        this.lastTeamKey = key;
        this.teams = s.teamScores.map((score, i) => ({
          name: TEAM_NAMES[i] ?? `Team ${i + 1}`,
          color: TEAM_COLORS[i % TEAM_COLORS.length] ?? '#ffffff',
          score,
          isMine: i === myTeam,
        }));
        patch.teams = this.teams;
      }
    }
    ui.getState().setHud(patch);

    if (this.audio) {
      const teams = s.teamScores;
      const myTeam = me?.team ?? -1;
      const losing = myTeam >= 0 && teams.length > 1 && (teams[myTeam] ?? 0) <= Math.min(...teams);
      this.audio.updateRoundStatus({
        roundType: this.type,
        qualified: s.qualifiedCount,
        qualifyTarget: s.qualifyTarget,
        ...(s.timeLeft >= 0 ? { timeLeft: s.timeLeft } : {}),
        alive: Math.max(0, this.entrants - s.eliminatedCount),
        startPlayers: this.entrants,
        losing,
      });
    }
  }
}
