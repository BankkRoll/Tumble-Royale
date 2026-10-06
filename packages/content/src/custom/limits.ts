/**
 * Limits and identifiers for player-made (custom) rounds.
 *
 * Every custom round runs on the same game servers as built-in rounds, in
 * shows of up to {@link MAX_PLAYERS} players, so these caps keep one shared
 * round from costing more physics, bandwidth or memory than the heaviest
 * shipped round.
 */
import { MAX_PLAYERS } from '@tumble/shared';

/** Hard caps a custom round must stay within (checked by the editor, the API and game servers). */
export const CUSTOM_ROUND_LIMITS = {
  /** Serialised definition (UTF-8 JSON). Also bounds the `joinRound` message that carries it. */
  maxBytes: 64 * 1024,
  /** Static pieces, decorative included (each is a draw and usually a collider). */
  maxGeometry: 300,
  /** Placed obstacles. */
  maxObstacles: 48,
  /** Trigger volumes (checkpoints, finish, voids). */
  maxTriggers: 32,
  /** Checkpoint triggers. */
  maxCheckpoints: 12,
  /** Bot waypoints, authored or generated. */
  maxWaypoints: 128,
  /**
   * Estimated colliders across every obstacle (tile grids and bridges build one
   * per tile or segment). The shipped rounds peak a little under 400.
   */
  maxObstacleColliders: 500,
  /** Largest piece dimension (m). */
  maxPieceSize: 120,
  /** Largest horizontal extent of `bounds` along X or Z (m). */
  maxExtent: 600,
  /** Largest vertical extent of `bounds` (m). */
  maxHeight: 200,
  /** Round timer range (s). */
  minSeconds: 30,
  maxSeconds: 300,
  /** Overtime cap (s). */
  maxOvertime: 60,
  /** Score target range for hunt rounds. */
  maxScoreGoal: 50,
  /** Text lengths. */
  nameMin: 3,
  nameMax: 32,
  descriptionMax: 200,
  objectiveMax: 80,
  maxTips: 3,
  tipMax: 80,
  designNotesMax: 200,
  /** Shared rounds per account (published or unpublished). */
  maxPerAccount: 50,
} as const;

/** Round types the editor can author. Team rounds and finals need bespoke logic and stay hand-made. */
export const CUSTOM_ROUND_TYPES = ['race', 'survival', 'hunt', 'logic'] as const;

/** A custom round type. */
export type CustomRoundType = (typeof CUSTOM_ROUND_TYPES)[number];

/** Qualification mode each custom round type runs with. */
export const CUSTOM_MODE_BY_TYPE: Readonly<
  Record<CustomRoundType, 'finish' | 'survive' | 'scoreTarget' | 'logicSurvive'>
> = {
  race: 'finish',
  survival: 'survive',
  hunt: 'scoreTarget',
  logic: 'logicSurvive',
};

/** Player counts every custom round admits (shows fill to the cap). */
export const CUSTOM_ROUND_PLAYERS = { min: 1, max: MAX_PLAYERS, ideal: 40 } as const;

// Crockford-style alphabet without 0/O, 1/I/L and U, so a code read aloud or
// copied from a screenshot cannot be mistyped into a different valid code.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Length of a share code. 30^8 ≈ 6.6e11 codes. */
export const SHARE_CODE_LENGTH = 8;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${SHARE_CODE_LENGTH}}$`);

/** Prefix of a custom round's id (`custom:<CODE>`) in show rounds, lobby picks and results. */
export const CUSTOM_ROUND_PREFIX = 'custom:';

/**
 * Normalises what a player typed as a share code: upper-cased, spaces and
 * dashes removed.
 *
 * @param input - Raw text.
 * @returns The code, or null when it cannot be a share code.
 * @example
 * normalizeShareCode(' k7mq-2x9a '); // 'K7MQ2X9A'
 */
export function normalizeShareCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(code) ? code : null;
}

/**
 * Draws a random share code.
 *
 * @param random - Source of uniform integers in `[0, n)`; pass a CSPRNG on servers.
 * @returns An 8-character code.
 */
export function randomShareCode(random: (n: number) => number): string {
  let out = '';
  for (let i = 0; i < SHARE_CODE_LENGTH; i++) out += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return out;
}

/**
 * Round id of a shared round.
 *
 * @param code - Normalised share code.
 * @example
 * customRoundId('K7MQ2X9A'); // 'custom:K7MQ2X9A'
 */
export function customRoundId(code: string): string {
  return `${CUSTOM_ROUND_PREFIX}${code}`;
}

/**
 * Share code inside a custom round id.
 *
 * @param id - Any round id.
 * @returns The code, or null when `id` is not a shared round's id.
 */
export function shareCodeOf(id: string): string | null {
  if (!id.startsWith(CUSTOM_ROUND_PREFIX)) return null;
  const code = id.slice(CUSTOM_ROUND_PREFIX.length);
  return CODE_RE.test(code) ? code : null;
}

/** True when `id` names a shared custom round. */
export function isCustomRoundId(id: string): boolean {
  return shareCodeOf(id) !== null;
}

/** Id of the round the editor's Test play runs (never shared). */
export const PLAYTEST_ROUND_ID = 'custom:playtest';
