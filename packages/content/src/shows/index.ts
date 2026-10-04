/**
 * Show playlists. Each lists round pools by id with weights; the show
 * director skips ids that are not (yet) in the round registry, so playlists
 * can reference the full launch set before every level exists.
 */
import { DEFAULT_SHOW_PLAYERS } from '@tumble/shared';
import { MUTATOR_IDS } from '@tumble/sim/mutators';
import { ShowPlaylistSchema, type ShowPlaylist, type ShowPlaylistInput } from '@tumble/sim/show/schema';

/** Every show round by id, grouped by type: the 20 launch rounds plus the five added after launch. */
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
  hunt: ['tail-chase', 'comet-catch'],
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
  'comet-catch': 0.9,
  'pattern-panic': 0.8,
  'crown-climb': 1.3,
  'last-tumbler-standing': 1,
  'spin-cycle-finale': 0.9,
  'goo-peak-final': 0.9,
};

function pool(ids: readonly string[], scale: Readonly<Record<string, number>> = {}): Pool {
  return ids.map((roundId) => ({
    roundId,
    weight: (STANDARD_WEIGHTS[roundId] ?? 1) * (scale[roundId] ?? 1),
  }));
}

/** The default solo show: a full 100-player lobby (100 → 60 → 30 → 12 → final). */
export const MAIN_SHOW: ShowPlaylistInput = {
  id: 'main-show',
  name: 'Main Show',
  description: 'The classic: 100 Tumblers, every kind of round, one Crown.',
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 12,
  qualifyCurve: [0.6, 0.5, 0.4, 0.5],
  pool: pool(PLANNED_ROUND_IDS),
};

/** Pairs: a duo advances if either member qualifies; both share the Crown. */
export const DUOS: ShowPlaylistInput = {
  id: 'duos',
  name: 'Duos',
  description: 'Team up with a buddy. If one of you makes it, you both do.',
  partySize: 2,
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 12,
  qualifyCurve: [0.55, 0.5, 0.4, 0.45],
  typeWeights: { team: 1.5, hunt: 1.2 },
  pool: pool(PLANNED_ROUND_IDS),
};

/** Squads of four, with team rounds front and centre. */
export const SQUADS: ShowPlaylistInput = {
  id: 'squads',
  name: 'Squads',
  description: 'Four-player squads. Carry your crew to the Crown.',
  partySize: 4,
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 12,
  qualifyCurve: [0.5, 0.45, 0.4, 0.4],
  typeWeights: { team: 2, hunt: 1.2, logic: 0.6 },
  pool: pool(PLANNED_ROUND_IDS),
};

/**
 * Chaos Mode's mutator rotation: one is picked per show from the seed
 * (SHOWS.md §4.4). Every `@tumble/sim/mutators` entry is eligible.
 */
export const CHAOS_MUTATORS: readonly { id: string; weight: number }[] = MUTATOR_IDS.map((id) => ({
  id,
  weight: 1,
}));

/** Faster obstacles, harsher cuts, more survival, and one mutator per show. */
export const CHAOS_MODE: ShowPlaylistInput = {
  id: 'chaos-mode',
  name: 'Chaos Mode',
  description: 'Everything spins faster, the cuts are brutal and every show has a twist. Good luck.',
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  minRounds: 3,
  maxRounds: 5,
  finalAtOrBelow: 10,
  qualifyCurve: [0.5, 0.45, 0.4, 0.4],
  stageOffset: 2,
  typeWeights: { survival: 1.6, logic: 0.6 },
  botSkillMix: { clumsy: 0, average: 2, sharp: 3 },
  pool: pool(PLANNED_ROUND_IDS, {
    'cannonball-canyon': 1.5,
    'hammer-highway': 1.4,
    'tile-panic': 1.3,
    'spin-cycle': 1.3,
  }),
  mutators: [...CHAOS_MUTATORS],
};

/**
 * Rated shows: humans only, individual skill (SHOWS.md §4.5). Team rounds are
 * out because a teammate's play would move your rating; hunts stay but are
 * down-weighted. If the lobby is not full after the queue timeout it starts
 * with at least 24 humans. Full rated lobbies are 100 like every other show,
 * so a placement means the same thing in Ranked and Main Show; the 24-human
 * floor keeps queues short while the population is small.
 */
export const RANKED: ShowPlaylistInput = {
  id: 'ranked',
  name: 'Ranked',
  description: 'Climb the ladder. Every placement counts.',
  maxPlayers: DEFAULT_SHOW_PLAYERS,
  minPlayers: 24,
  minRounds: 4,
  maxRounds: 5,
  finalAtOrBelow: 12,
  qualifyCurve: [0.6, 0.5, 0.4, 0.5],
  ranked: true,
  botsAllowed: false,
  typeWeights: { hunt: 0.5 },
  pool: pool(PLANNED_ROUND_IDS.filter((id) => !(PLANNED_ROUNDS.team as readonly string[]).includes(id))),
};

/**
 * A new player's first shows: friendly rounds, generous cuts, mostly clumsy
 * bots. Deliberately 40 seats, not 100: a debut is easier to read with fewer
 * Tumblers on screen, and newcomers often play on the weakest devices.
 */
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
    'comet-catch',
    'crown-climb',
    'last-tumbler-standing',
  ]),
};

/** Every playlist, validated (defaults applied). */
export const PLAYLISTS: readonly ShowPlaylist[] = [
  MAIN_SHOW,
  DUOS,
  SQUADS,
  CHAOS_MODE,
  RANKED,
  FIRST_SHOW,
].map((p) => ShowPlaylistSchema.parse(p));

/**
 * Looks up a validated playlist.
 *
 * @param id - Playlist id, e.g. `main-show`.
 */
export function getPlaylist(id: string): ShowPlaylist | undefined {
  return PLAYLISTS.find((p) => p.id === id);
}
