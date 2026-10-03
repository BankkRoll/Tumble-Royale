/**
 * Show playlists. Each lists round pools by id with weights; the show
 * director skips ids that are not (yet) in the round registry, so playlists
 * can reference the full launch set before every level exists.
 */
import { ShowPlaylistSchema, type ShowPlaylist, type ShowPlaylistInput } from '@tumble/sim/show/schema';

/** The 20 launch rounds, by id, grouped by type. */
export const PLANNED_ROUNDS = {
  race: [
    'gumdrop-gauntlet',
    'conveyor-chaos',
    'tilt-town',
    'slip-n-spiral',
    'hammer-highway',
    'wind-tunnel-peaks',
    'cannonball-canyon',
  ],
  survival: ['spin-cycle', 'tile-panic', 'rising-goo-tower', 'jump-rope-royale'],
  team: ['egg-heist', 'bounce-ball-blitz', 'paint-the-plaza'],
  hunt: ['tail-chase'],
  logic: ['pattern-panic'],
  final: ['crown-climb', 'last-tumbler-standing', 'spin-cycle-finale', 'goo-peak-final'],
} as const;

/** Every planned round id. */
export const PLANNED_ROUND_IDS: readonly string[] = Object.values(PLANNED_ROUNDS).flat();

type Pool = ShowPlaylistInput['pool'];

/** Base weights for the standard rotation; tweaked per playlist below. */
const STANDARD_WEIGHTS: Readonly<Record<string, number>> = {
  'gumdrop-gauntlet': 1.3,
  'conveyor-chaos': 1.1,
  'tilt-town': 1,
  'slip-n-spiral': 1,
  'hammer-highway': 1,
  'wind-tunnel-peaks': 0.8,
  'cannonball-canyon': 1,
  'spin-cycle': 1.1,
  'tile-panic': 1,
  'rising-goo-tower': 0.8,
  'jump-rope-royale': 1,
  'egg-heist': 1,
  'bounce-ball-blitz': 1,
  'paint-the-plaza': 0.9,
  'tail-chase': 0.9,
  'pattern-panic': 0.8,
  'crown-climb': 1.3,
  'last-tumbler-standing': 1,
  'spin-cycle-finale': 0.9,
  'goo-peak-final': 0.9,
};

function pool(ids: readonly string[], scale: Readonly<Record<string, number>> = {}): Pool {
  return ids.map((roundId) => ({ roundId, weight: (STANDARD_WEIGHTS[roundId] ?? 1) * (scale[roundId] ?? 1) }));
}

/** The default 40-player solo show. */
export const MAIN_SHOW: ShowPlaylistInput = {
  id: 'main-show',
  name: 'Main Show',
  description: 'The classic: 40 Tumblers, every kind of round, one Crown.',
  maxPlayers: 40,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 10,
  qualifyCurve: [0.65, 0.55, 0.5, 0.5],
  pool: pool(PLANNED_ROUND_IDS),
};

/** Pairs: a duo advances if either member qualifies; both share the Crown. */
export const DUOS: ShowPlaylistInput = {
  id: 'duos',
  name: 'Duos',
  description: 'Team up with a buddy. If one of you makes it, you both do.',
  partySize: 2,
  maxPlayers: 40,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 10,
  qualifyCurve: [0.6, 0.5, 0.45, 0.45],
  typeWeights: { team: 1.5, hunt: 1.2 },
  pool: pool(PLANNED_ROUND_IDS),
};

/** Squads of four, with team rounds front and centre. */
export const SQUADS: ShowPlaylistInput = {
  id: 'squads',
  name: 'Squads',
  description: 'Four-player squads. Carry your crew to the Crown.',
  partySize: 4,
  maxPlayers: 40,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 12,
  qualifyCurve: [0.55, 0.45, 0.4, 0.4],
  typeWeights: { team: 2, hunt: 1.2, logic: 0.6 },
  pool: pool(PLANNED_ROUND_IDS),
};

/** Faster obstacles, harsher cuts, more survival. */
export const CHAOS_MODE: ShowPlaylistInput = {
  id: 'chaos-mode',
  name: 'Chaos Mode',
  description: 'Everything spins faster and the cuts are brutal. Good luck.',
  maxPlayers: 40,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 8,
  qualifyCurve: [0.55, 0.45, 0.45, 0.4],
  stageOffset: 2,
  typeWeights: { survival: 1.6, logic: 0.6 },
  botSkillMix: { clumsy: 0, average: 2, sharp: 3 },
  pool: pool(PLANNED_ROUND_IDS, { 'cannonball-canyon': 1.5, 'hammer-highway': 1.4, 'tile-panic': 1.3, 'spin-cycle': 1.3 }),
};

/** Rated shows: humans only, standard cuts, no hunt randomness. */
export const RANKED: ShowPlaylistInput = {
  id: 'ranked',
  name: 'Ranked',
  description: 'Climb the ladder. Every placement counts.',
  maxPlayers: 40,
  minPlayers: 20,
  minRounds: 4,
  maxRounds: 5,
  finalAtOrBelow: 10,
  qualifyCurve: [0.65, 0.55, 0.5, 0.5],
  ranked: true,
  botsAllowed: false,
  typeWeights: { hunt: 0.5 },
  pool: pool(PLANNED_ROUND_IDS),
};

/** A new player's first shows: friendly rounds, generous cuts, mostly clumsy bots. */
export const FIRST_SHOW: ShowPlaylistInput = {
  id: 'first-show',
  name: 'First Show',
  description: 'Your debut! Easier rounds and a gentler crowd.',
  maxPlayers: 40,
  minRounds: 3,
  maxRounds: 4,
  finalAtOrBelow: 12,
  qualifyCurve: [0.75, 0.65, 0.6],
  stageOffset: -1,
  botSkillMix: { clumsy: 4, average: 1, sharp: 0 },
  pool: pool([
    'gumdrop-gauntlet',
    'conveyor-chaos',
    'tilt-town',
    'slip-n-spiral',
    'spin-cycle',
    'jump-rope-royale',
    'egg-heist',
    'paint-the-plaza',
    'tail-chase',
    'crown-climb',
    'last-tumbler-standing',
  ]),
};

/** Every playlist, validated (defaults applied). */
export const PLAYLISTS: readonly ShowPlaylist[] = [MAIN_SHOW, DUOS, SQUADS, CHAOS_MODE, RANKED, FIRST_SHOW].map((p) =>
  ShowPlaylistSchema.parse(p),
);

/**
 * Looks up a validated playlist.
 *
 * @param id - Playlist id, e.g. `main-show`.
 */
export function getPlaylist(id: string): ShowPlaylist | undefined {
  return PLAYLISTS.find((p) => p.id === id);
}
