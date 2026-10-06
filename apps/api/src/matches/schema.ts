/**
 * Contract for `POST /internal/match-results` (game server → API).
 *
 * The game server mirrors these types; it signs the exact JSON body with the
 * scheme in `http/auth.ts` (`signInternal`). Placement encodes elimination
 * order: 1 is the Crown winner, larger numbers were eliminated earlier, and
 * players knocked out together (same round, no finish order) share a value.
 */
import { MAX_PLAYERS } from '@tumble/shared';
import { z } from 'zod';

/** Round categories (`RoundType` in `@tumble/shared`). */
export const RoundTypeSchema = z.enum(['race', 'survival', 'team', 'hunt', 'logic', 'final']);

/** One player slot in the show. */
export const MatchParticipantSchema = z.object({
  /** Stable per-match key (e.g. the room's player index as a string). */
  key: z.string().min(1).max(40),
  /** Account id for humans; null for bots. */
  userId: z.string().uuid().nullable(),
  isBot: z.boolean(),
  name: z.string().min(1).max(32),
  /** Team index for duos/squads. */
  team: z.number().int().min(0).max(31).nullable().optional(),
  /** Left before the show ended (forfeits most rewards). */
  quit: z.boolean().optional(),
  /** Queued into this show together with a party (social achievements and challenges). */
  party: z.boolean().optional(),
  /** Per-show action counters for challenges; omitted counters count as zero. */
  stats: z
    .object({
      jumps: z.number().int().min(0).max(100_000),
      dives: z.number().int().min(0).max(100_000),
      grabs: z.number().int().min(0).max(100_000),
      checkpoints: z.number().int().min(0).max(10_000),
      bounces: z.number().int().min(0).max(100_000),
      emotes: z.number().int().min(0).max(10_000),
    })
    .partial()
    .optional(),
});

/** One participant's outcome in one round. */
export const RoundResultSchema = z.object({
  key: z.string().min(1).max(40),
  qualified: z.boolean(),
  /** Finish order for races (1 = first), when meaningful. */
  position: z.number().int().min(1).max(100).nullable().optional(),
  score: z.number().int().nullable().optional(),
  /** Finish time in ms for races. */
  timeMs: z.number().int().min(0).nullable().optional(),
});

/** A round played in the show. */
export const MatchRoundSchema = z.object({
  roundId: z.string().min(1).max(64),
  roundType: RoundTypeSchema,
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(30 * 60_000),
  /** Every participant who started the round. */
  results: z.array(RoundResultSchema).max(MAX_PLAYERS),
});

/** Final standing of a participant. */
export const PlacementSchema = z.object({
  key: z.string().min(1).max(40),
  /** 1 = winner; equal values tie. */
  placement: z.number().int().min(1).max(MAX_PLAYERS),
  /** Won (or shares, in team modes) the Crown. */
  crowned: z.boolean(),
});

/** Full show summary posted once per match. */
export const MatchResultSchema = z.object({
  /** Game-server match id; the idempotency key for every grant. */
  matchId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  /** `SERVER_ID` of the reporting game server, checked against the matchmaker's placement. */
  serverId: z.string().min(1).max(64).optional(),
  queue: z.enum(['casual', 'ranked', 'custom']),
  playlistId: z.string().min(1).max(64),
  /** Defaults to the API's active season. */
  seasonId: z.string().min(1).max(32).optional(),
  region: z.string().min(2).max(8).default('na'),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  participants: z.array(MatchParticipantSchema).min(1).max(MAX_PLAYERS),
  rounds: z.array(MatchRoundSchema).min(1).max(10),
  placements: z.array(PlacementSchema).min(1).max(MAX_PLAYERS),
});

/** Match result payload (input). */
export type MatchResultInput = z.input<typeof MatchResultSchema>;
/** Match result payload (validated). */
export type MatchResult = z.output<typeof MatchResultSchema>;
