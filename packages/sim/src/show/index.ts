/**
 * Show flow: playlists, round selection and voting, the ShowDirector state
 * machine used by the server room, and an offline runner for single-player
 * shows vs bots.
 */
export * from './types.ts';
export {
  BotSkillMixSchema,
  PlaylistRoundSchema,
  PlaylistVotingSchema,
  ShowPlaylistSchema,
  definePlaylist,
  type ShowPlaylist,
  type ShowPlaylistInput,
} from './schema/index.ts';
export {
  selectRound,
  selectRoundCandidates,
  playerFit,
  type RoundCandidate,
  type RoundSelectContext,
} from './selector.ts';
export {
  RoundVote,
  VOTE_MIN_OPEN_SECONDS,
  type RoundVoteOptions,
  type VoteCastResult,
  type VoteResolution,
  type VoteResult,
  type VoteSnapshot,
} from './vote.ts';
export { ShowDirector, showSeed, type ShowDirectorOptions } from './director.ts';
export { assignBotSkills, assignShowParties, type RosterSeat } from './roster.ts';
export {
  LOBBY_PLATFORM_RADIUS,
  PRE_SHOW_LOBBY_ROUND,
  PRE_SHOW_LOBBY_ROUND_ID,
  lobbySpawnPoint,
} from './lobby.ts';
export { createOfflineShow, minimumShowSeats, type OfflineShow, type OfflineShowOptions } from './offline.ts';
