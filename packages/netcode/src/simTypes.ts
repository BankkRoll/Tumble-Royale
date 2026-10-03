/**
 * Single import point for the match-sim contracts the netcode builds on, so a
 * move of `@tumble/sim/match` touches one line. Types only: the netcode never
 * pulls the simulation runtime into its bundle.
 */
export type {
  MatchPlayerInfo,
  MatchSim,
  MatchSimOptions,
  PlayerRoundStatusId,
  RoundStatus,
} from '@tumble/sim/match';
