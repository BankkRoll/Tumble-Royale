import type { RoundDefinition, RoundPhaseId, RoundType, ShowPhaseId } from '@tumble/shared';
import type { BotSkill } from '../bots/types.ts';
import type { MatchPlayerInfo, RoundStatus } from '../match/types.ts';

/** Someone in the show. */
export interface ShowParticipant {
  id: number;
  name: string;
  isBot: boolean;
  botSkill?: BotSkill;
  /** Duos/squads: members of one party share fates and the Crown. */
  partyId?: number;
}

/** Phase durations in seconds. */
export interface ShowTimings {
  /** Waiting platform countdown before round 1. */
  preShow: number;
  /** Longest wait for human load acks. */
  loadingMax: number;
  /** Used when a round has no flyover duration. */
  introFlyover: number;
  rulesCard: number;
  countdown: number;
  /** Slow-motion "ROUND OVER" beat. */
  roundEnd: number;
  results: number;
  transition: number;
  victory: number;
  /** Extra PLAYING time beyond duration + overtime before the director forces an end. */
  safetyGrace: number;
}

/** Defaults from the spec's round lifecycle. */
export const DEFAULT_SHOW_TIMINGS: Readonly<ShowTimings> = {
  preShow: 10,
  loadingMax: 12,
  introFlyover: 7,
  rulesCard: 4,
  countdown: 3,
  roundEnd: 1.5,
  results: 6,
  transition: 2,
  victory: 8,
  safetyGrace: 10,
};

/** Everything a host needs to start a round. */
export interface RoundStartInfo {
  round: RoundDefinition;
  roundIndex: number;
  /** Stage for `speedScaleByStage` (round index + playlist offset, ≥ 0). */
  stage: number;
  /** Show seed (the match combines it with the round id). */
  seed: number;
  players: MatchPlayerInfo[];
  /** Explicit target from the playlist curve; undefined lets the round decide. */
  qualifyTarget?: number;
  isFinal: boolean;
}

/**
 * A running round as the director sees it. A `MatchSimHandle` satisfies this
 * directly; tests use fakes.
 */
export interface RoundDriver {
  setPhase(phase: RoundPhaseId, time?: number): void;
  getStatus(): Pick<RoundStatus, 'phase' | 'finished' | 'players'>;
  /** A participant left mid-round. */
  forfeit?(playerId: number): void;
  dispose(): void;
}

/** Creates the round simulation for the director (server room, offline runner, tests). */
export interface ShowRoundHost {
  startRound(info: RoundStartInfo): RoundDriver;
}

/** Per-round result in the show summary. */
export interface RoundOutcome {
  roundIndex: number;
  roundId: string;
  name: string;
  type: RoundType;
  isFinal: boolean;
  /** Qualified player ids, best first. */
  qualified: number[];
  /** Eliminated player ids, best first. */
  eliminated: number[];
  /** Party mode: eliminated players carried through by a qualifying teammate. */
  carried: number[];
}

/** One line of the final ranking. */
export interface ShowPlacement {
  playerId: number;
  /** 1 = Crown. Party winners share place 1. */
  place: number;
  /** Round index the player went out in, or -1 for winners. */
  eliminatedInRound: number;
}

/** End-of-show record: drives the player wall, rewards and match history. */
export interface ShowSummary {
  seed: number;
  playlistId: string;
  participants: ShowParticipant[];
  rounds: RoundOutcome[];
  /** The crowned player, or null if nobody survived. */
  winner: number | null;
  /** Everyone who shares the Crown (the winner's party in duos/squads). */
  winners: number[];
  /** Full ranking, best first. */
  placements: ShowPlacement[];
}

/** Snapshot of the director for the server room and UI. */
export interface ShowState {
  showPhase: ShowPhaseId;
  /** Round phase while a round is loaded, else null. */
  roundPhase: RoundPhaseId | null;
  roundIndex: number;
  roundId: string | null;
  roundName: string | null;
  roundType: RoundType | null;
  isFinal: boolean;
  /** Seconds spent in the current phase. */
  phaseElapsed: number;
  /** Planned length of the current phase, or -1 when open-ended (PLAYING). */
  phaseDuration: number;
  /** Players still in the show. */
  alive: readonly number[];
  /** Eliminated and departed players watching. */
  spectators: readonly number[];
  qualifyTarget: number | null;
}

/** Notifications from the director. */
export type ShowEvent =
  | { type: 'showPhase'; phase: ShowPhaseId }
  | { type: 'roundSelected'; roundIndex: number; roundId: string; isFinal: boolean }
  | { type: 'roundPhase'; phase: RoundPhaseId; roundIndex: number; roundId: string }
  | { type: 'roundResult'; outcome: RoundOutcome }
  | { type: 'ended'; summary: ShowSummary };

/** Listener for {@link ShowEvent}s. */
export type ShowListener = (e: ShowEvent) => void;
