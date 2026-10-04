/**
 * Show playlist schema. Zod plus shared constants only, so data packages and UI can
 * import it as `@tumble/sim/show/schema` without pulling in the simulation.
 */
import { DEFAULT_SHOW_PLAYERS, MAX_PLAYERS } from '@tumble/shared';
import { z } from 'zod';

/** One round in a playlist's pool. */
export const PlaylistRoundSchema = z.object({
  /** Round id from the content registry. Ids missing from the registry are skipped. */
  roundId: z.string(),
  /** Relative selection weight. */
  weight: z.number().min(0).default(1),
});

const TypeWeightsSchema = z
  .object({
    race: z.number().min(0),
    survival: z.number().min(0),
    team: z.number().min(0),
    hunt: z.number().min(0),
    logic: z.number().min(0),
    final: z.number().min(0),
  })
  .partial();

/** Relative weights for bot skill tiers when a show is filled with bots. */
export const BotSkillMixSchema = z.object({
  clumsy: z.number().min(0).default(1),
  average: z.number().min(0).default(2),
  sharp: z.number().min(0).default(1),
});

/**
 * A show playlist: which rounds can appear, how many, how fast the field
 * shrinks and who fills empty seats. Authored in `@tumble/content/shows`.
 */
export const ShowPlaylistSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  /** 1 = solos, 2 = duos, 4 = squads. Party members share fates and the Crown. */
  partySize: z.number().int().min(1).max(4).default(1),
  /** Lobby size the matchmaker fills to (bots top up). */
  maxPlayers: z.number().int().min(2).max(MAX_PLAYERS).default(DEFAULT_SHOW_PLAYERS),
  /** Fewest players a show may start with. */
  minPlayers: z.number().int().min(1).default(2),
  /** Rounds before the final is allowed (including round 1). */
  minRounds: z.number().int().min(1).default(3),
  /** Hard cap on rounds; the last is always the final. */
  maxRounds: z.number().int().min(1).default(5),
  /** Go to the final once this many or fewer remain (after `minRounds - 1` rounds). */
  finalAtOrBelow: z.number().int().min(2).default(10),
  /** Qualify ratio per round index, overriding each round's own ratio. */
  qualifyCurve: z.array(z.number().min(0.05).max(0.95)).default([]),
  /** Round type of round 1. */
  firstRoundType: z.enum(['race', 'survival', 'team', 'hunt', 'logic']).default('race'),
  pool: z.array(PlaylistRoundSchema).min(1),
  /** Multipliers per round type on top of per-round weights. */
  typeWeights: TypeWeightsSchema.default({}),
  /** Added to the round index when picking obstacle speed scales (negative = gentler). */
  stageOffset: z.number().int().default(0),
  botSkillMix: BotSkillMixSchema.default({ clumsy: 1, average: 2, sharp: 1 }),
  /** Ranked shows hide bots from rating updates and use stricter rules. */
  ranked: z.boolean().default(false),
  /** Allow bots to fill empty seats. */
  botsAllowed: z.boolean().default(true),
  /**
   * Show mutators (`@tumble/sim/mutators` ids) with weights. When non-empty the
   * director picks exactly one per show from the seed and applies it to every
   * round. Unknown ids are skipped.
   */
  mutators: z.array(z.object({ id: z.string(), weight: z.number().min(0).default(1) })).default([]),
  /**
   * Limited-time playlists: ISO instants bounding when it can be queued
   * (start inclusive, end exclusive). Operators can override both at runtime
   * (`PUT /internal/playlists/:id`); absent means always available.
   */
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  /** Spotlighted: announced as "Coming soon" before `startsAt`. */
  featured: z.boolean().default(false),
});

/** Validated playlist. */
export type ShowPlaylist = z.output<typeof ShowPlaylistSchema>;
/** Playlist as authored. */
export type ShowPlaylistInput = z.input<typeof ShowPlaylistSchema>;

/**
 * Identity helper for authoring playlists with type checking.
 *
 * @example
 * export const mainShow = definePlaylist({ id: 'main', name: 'Main Show', pool: [...] });
 */
export function definePlaylist(p: ShowPlaylistInput): ShowPlaylistInput {
  return p;
}
