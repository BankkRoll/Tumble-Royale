/**
 * Show mutators: one rule twist applied to every round of a show (Chaos Mode).
 *
 * Responsibilities:
 * - The mutator catalogue, as plain data: multipliers on {@link CharacterTuning},
 *   per-surface response, world gravity, obstacle speed, mirrored steering and
 *   periodic wind gusts.
 * - Pure helpers the match sim uses to apply a mutator ({@link applyMutatorTuning},
 *   {@link mutatorWindAt}) and the show director uses to pick one
 *   ({@link pickMutator}).
 *
 * Dependency-free apart from types, so UI code can import names and
 * descriptions without pulling in Rapier. Everything here is deterministic:
 * the same seed and match time give the same mutator and the same gusts on the
 * server, in client prediction and offline.
 */
import { Rng } from '@tumble/shared';
import type { CharacterTuning, SurfaceTuning } from '../character/tuning.ts';
import type { SurfaceKind } from '../physics/surfaces.ts';

/** Numeric {@link CharacterTuning} fields a mutator may scale. */
export type ScalableTuningKey = {
  [K in keyof CharacterTuning]: CharacterTuning[K] extends number ? K : never;
}[keyof CharacterTuning];

/** Periodic wind: a gust every `period` seconds from a seeded direction. */
export interface MutatorWind {
  /** Seconds between gust starts. */
  period: number;
  /** Seconds each gust blows (including its ramp). */
  duration: number;
  /** Seconds of calm after PLAYING starts before the first gust. */
  delay: number;
  /** Horizontal acceleration at full strength (m/s²), applied as `push()`. */
  accel: number;
  /** Seconds to ramp from calm to full strength, so a gust reads before it bites. */
  ramp: number;
}

/** A show mutator: pure data, applied by the match sim. */
export interface MutatorDefinition {
  id: string;
  name: string;
  /** One short line for the round intro card and HUD chip. */
  description: string;
  icon: string;
  /** Multiplier on world gravity (players, props and every dynamic body). */
  gravityScale?: number;
  /** Multipliers on character tuning numbers. */
  tuningScale?: Partial<Record<ScalableTuningKey, number>>;
  /** Multipliers on per-surface response, by surface kind. */
  surfaceScale?: Partial<Record<SurfaceKind, Partial<SurfaceTuning>>>;
  /** Added to the round's obstacle speed scale. */
  speedScaleBonus?: number;
  /** Human steering is mirrored left ↔ right (bots are unaffected). */
  mirrorSteering?: boolean;
  wind?: MutatorWind;
}

const SLIPPERY: Partial<SurfaceTuning> = { accelMul: 0.3, decelMul: 0.12, turnMul: 0.6 };

/**
 * Every mutator, by id. Values are tuned against the default tuning in
 * `@tumble/content/tuning`.
 */
export const MUTATORS: Readonly<Record<string, Readonly<MutatorDefinition>>> = Object.freeze({
  'moon-bounce': {
    id: 'moon-bounce',
    name: 'Moon Bounce',
    description: 'Half gravity: higher, floatier jumps and slow-motion falls.',
    icon: '🌙',
    gravityScale: 0.5,
    // Launch speed drops less than gravity, so jumps end up ~1.45× higher and ~1.7× longer.
    tuningScale: { jumpSpeed: 0.85, maxFallSpeed: 0.55, bounceSpeed: 0.8 },
  },
  'mirror-mirror': {
    id: 'mirror-mirror',
    name: 'Mirror Mirror',
    description: 'Left is right and right is left. Steer carefully!',
    icon: '🪞',
    mirrorSteering: true,
  },
  'speed-demons': {
    id: 'speed-demons',
    name: 'Speed Demons',
    description: 'Everyone runs 20% faster, and so do the obstacles.',
    icon: '⚡',
    tuningScale: { maxSpeed: 1.2, groundAccel: 1.15, airAccel: 1.15, diveSpeed: 1.1, diveMaxSpeed: 1.1 },
    speedScaleBonus: 0.2,
  },
  'slippery-floors': {
    id: 'slippery-floors',
    name: 'Slippery Floors',
    description: 'Every floor is freshly waxed. Mind the slide!',
    icon: '🧊',
    surfaceScale: { normal: SLIPPERY, conveyor: SLIPPERY, bouncy: SLIPPERY },
    tuningScale: { slideFriction: 0.4 },
  },
  gusty: {
    id: 'gusty',
    name: 'Gusty',
    description: 'Strong gusts sweep the course every few seconds.',
    icon: '🌬️',
    // push() decays with pushHalfLife, so 9 m/s² settles near a 3 m/s drift: fightable at 7.8 m/s run speed.
    wind: { period: 9, duration: 3.5, delay: 4, accel: 9, ramp: 0.8 },
  },
  'bouncy-castle': {
    id: 'bouncy-castle',
    name: 'Bouncy Castle',
    description: 'Jumps launch higher and bounce pads hit twice as hard.',
    icon: '🏰',
    tuningScale: { jumpSpeed: 1.18, bounceSpeed: 1.35, diveUpSpeed: 1.2 },
  },
});

/** Mutator ids in catalogue order. */
export const MUTATOR_IDS: readonly string[] = Object.keys(MUTATORS);

/**
 * Looks up a mutator.
 *
 * @param id - Mutator id, e.g. `moon-bounce`.
 * @returns The definition, or null for an unknown, empty or missing id.
 */
export function getMutator(id: string | null | undefined): Readonly<MutatorDefinition> | null {
  if (!id) return null;
  return Object.prototype.hasOwnProperty.call(MUTATORS, id) ? (MUTATORS[id] ?? null) : null;
}

const MUTATOR_SALT = 0x3a7c_0de5;

/**
 * Seeded weighted pick of one mutator for a show. Uses its own Rng stream so
 * adding mutators to a playlist never changes which rounds the show selects.
 *
 * @param seed - Show seed.
 * @param pool - Candidate ids with weights; unknown ids and zero weights are skipped.
 * @returns The chosen id, or null when nothing is eligible.
 * @example
 * pickMutator(42, [{ id: 'moon-bounce', weight: 1 }, { id: 'gusty', weight: 2 }]);
 */
export function pickMutator(seed: number, pool: readonly { id: string; weight: number }[]): string | null {
  const eligible = pool.filter((m) => m.weight > 0 && getMutator(m.id) !== null);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, m) => s + m.weight, 0);
  let roll = new Rng((seed ^ MUTATOR_SALT) >>> 0).next() * total;
  for (const m of eligible) {
    roll -= m.weight;
    if (roll < 0) return m.id;
  }
  return (eligible.at(-1) as { id: string }).id;
}

/**
 * Applies a mutator's multipliers to a tuning object in place.
 *
 * @param tuning - Resolved, mutable tuning (e.g. from `resolveTuning`).
 * @param mutator - The mutator, or null for a no-op.
 * @returns `tuning`, for chaining.
 */
export function applyMutatorTuning(
  tuning: CharacterTuning,
  mutator: Readonly<MutatorDefinition> | null,
): CharacterTuning {
  if (!mutator) return tuning;
  const t = tuning as unknown as Record<string, number>;
  for (const [key, mul] of Object.entries(mutator.tuningScale ?? {})) {
    if (typeof t[key] === 'number' && typeof mul === 'number') t[key] *= mul;
  }
  for (const [kind, scale] of Object.entries(mutator.surfaceScale ?? {}) as [
    SurfaceKind,
    Partial<SurfaceTuning>,
  ][]) {
    const surf = tuning.surfaces[kind];
    if (!surf) continue;
    // Copy first: surface entries may be shared with the frozen defaults.
    const next = { ...surf };
    for (const [field, mul] of Object.entries(scale) as [keyof SurfaceTuning, number][]) next[field] *= mul;
    tuning.surfaces[kind] = next;
  }
  return tuning;
}

const GUST_SALT = 0x6057_a11d;

/**
 * Wind acceleration at a match time. Pure: the server, client prediction and
 * renderers (for streak VFX or a HUD arrow) all get the same gusts.
 *
 * @param wind - The mutator's wind block.
 * @param seed - Round seed (show seed mixed with the round id).
 * @param time - Match time in seconds (0 = PLAYING starts).
 * @param out - Receives the horizontal acceleration (m/s²).
 * @returns True while a gust is blowing.
 */
export function mutatorWindAt(
  wind: Readonly<MutatorWind>,
  seed: number,
  time: number,
  out: { x: number; z: number },
): boolean {
  out.x = 0;
  out.z = 0;
  const t = time - wind.delay;
  if (t < 0 || wind.period <= 0) return false;
  const gust = Math.floor(t / wind.period);
  const into = t - gust * wind.period;
  if (into >= wind.duration) return false;
  const angle = new Rng((seed ^ GUST_SALT ^ Math.imul(gust + 1, 0x9e3779b1)) >>> 0).next() * Math.PI * 2;
  const strength = wind.accel * (wind.ramp > 0 ? Math.min(1, into / wind.ramp) : 1);
  out.x = Math.sin(angle) * strength;
  out.z = Math.cos(angle) * strength;
  return true;
}
