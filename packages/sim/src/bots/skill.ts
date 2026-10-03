import type { BotSkill } from './types.ts';

/**
 * Behaviour knobs per skill tier. Bots must be fun to lose to and fun to
 * beat: clumsy bots blunder visibly (late jumps, dives off ledges, wrong
 * branches), sharp bots read obstacles well but still slip now and then.
 */
export interface BotSkillProfile {
  /** Reaction delay range in seconds before acting on a new situation. */
  reactionMin: number;
  reactionMax: number;
  /** Peak yaw wobble in radians while steering. */
  aimNoise: number;
  /** Fraction of a waypoint's radius used to spread bots across the path. */
  lateralSpread: number;
  /** Chance per authored action (jump, dive) to bungle it. */
  mistakeChance: number;
  /** Standard deviation of jump timing error, seconds. */
  jumpTimingError: number;
  /** Extra clearance demanded before crossing a timed obstacle, metres. */
  gapMargin: number;
  /** Chance to ignore obstacle timing and just go. */
  recklessChance: number;
  /** Chance to notice an incoming hazard at all. */
  hazardAwareness: number;
  /** Forward stick magnitude. */
  speed: number;
  /** Chance per second of a spontaneous emote while idle or celebrating. */
  emotePerSecond: number;
  /** Chance per second of a silly unforced jump or dive. */
  sillyPerSecond: number;
  /** Chance of taking the shortest branch at a fork (else random). */
  branchGreed: number;
  /** Seconds without progress before the stuck routine kicks in. */
  stuckSeconds: number;
  /** Logic rounds: chance of remembering the right answer. */
  memory: number;
  /** Chance per run waypoint of cutting the corner straight to the one after (when the ground allows). */
  shortcutChance: number;
  /** Chance of stretching a long, flat jump into a jump-dive. */
  jumpDiveChance: number;
  /** Chance of diving across the finish line. */
  finishDiveChance: number;
  /** Chance of not noticing a wall or lip ahead and bonking into it. */
  bonkChance: number;
  /** Chance of staggering about dizzily after getting up from a stun. */
  dizzyChance: number;
  /** Chance of an emote (and a hop) the moment the bot qualifies. */
  celebrateChance: number;
}

/** Profiles for each tier. */
export const BOT_SKILLS: Readonly<Record<BotSkill, Readonly<BotSkillProfile>>> = {
  clumsy: {
    reactionMin: 0.35,
    reactionMax: 0.7,
    aimNoise: 0.35,
    lateralSpread: 0.8,
    mistakeChance: 0.25,
    jumpTimingError: 0.12,
    gapMargin: 0,
    recklessChance: 0.45,
    hazardAwareness: 0.4,
    speed: 0.82,
    emotePerSecond: 0.06,
    sillyPerSecond: 0.05,
    branchGreed: 0.3,
    stuckSeconds: 3.5,
    memory: 0.45,
    shortcutChance: 0,
    jumpDiveChance: 0,
    finishDiveChance: 0.15,
    bonkChance: 0.35,
    dizzyChance: 0.6,
    celebrateChance: 0.9,
  },
  average: {
    reactionMin: 0.2,
    reactionMax: 0.4,
    aimNoise: 0.18,
    lateralSpread: 0.6,
    mistakeChance: 0.1,
    jumpTimingError: 0.06,
    gapMargin: 0.3,
    recklessChance: 0.15,
    hazardAwareness: 0.75,
    speed: 0.93,
    emotePerSecond: 0.04,
    sillyPerSecond: 0.015,
    branchGreed: 0.6,
    stuckSeconds: 2.5,
    memory: 0.75,
    shortcutChance: 0.25,
    jumpDiveChance: 0.1,
    finishDiveChance: 0.35,
    bonkChance: 0.1,
    dizzyChance: 0.25,
    celebrateChance: 0.7,
  },
  sharp: {
    reactionMin: 0.1,
    reactionMax: 0.22,
    aimNoise: 0.06,
    lateralSpread: 0.45,
    mistakeChance: 0.03,
    jumpTimingError: 0.025,
    gapMargin: 0.6,
    recklessChance: 0.02,
    hazardAwareness: 0.95,
    speed: 1,
    emotePerSecond: 0.03,
    sillyPerSecond: 0.004,
    branchGreed: 0.9,
    stuckSeconds: 1.8,
    memory: 0.95,
    shortcutChance: 0.7,
    jumpDiveChance: 0.5,
    finishDiveChance: 0.6,
    bonkChance: 0,
    dizzyChance: 0.05,
    celebrateChance: 0.5,
  },
};

/**
 * Picks a tier from weights, e.g. a playlist's skill mix.
 *
 * @param r - Uniform random number in [0, 1).
 * @param mix - Relative weights per tier.
 * @returns The chosen tier.
 */
export function pickSkill(r: number, mix: Readonly<Record<BotSkill, number>>): BotSkill {
  const total = mix.clumsy + mix.average + mix.sharp;
  if (total <= 0) return 'average';
  const x = r * total;
  if (x < mix.clumsy) return 'clumsy';
  if (x < mix.clumsy + mix.average) return 'average';
  return 'sharp';
}
