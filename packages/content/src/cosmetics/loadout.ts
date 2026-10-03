/**
 * Loadout helpers: the default look, seeded random looks (bots, lobby filler,
 * lab lineups) and loadout validation.
 */
import { COSMETICS, getCosmetic, getCosmeticInSlot } from './catalog.ts';
import type { CosmeticItem, CosmeticLoadout, CosmeticSlot } from './schema.ts';

/** Minimal random source; `Rng` from `@tumble/shared` satisfies it. */
export interface RandomSource {
  /** @returns A float in [0, 1). */
  next(): number;
}

/** The look every new account starts with. */
export const DEFAULT_LOADOUT: Readonly<CosmeticLoadout> = Object.freeze({
  colors: ['#ff6fb5', '#ffd23f', '#7c5cff'],
  pattern: 'pattern.solid',
  face: 'face.classic',
  upper: null,
  lower: null,
  headwear: null,
  back: null,
  emotes: ['emote.wave', 'emote.dance', 'emote.laugh', 'emote.flex'],
  celebration: 'celebration.cheer',
  victoryPose: 'victory.superstar',
  nameplate: 'nameplate.classic',
  trail: null,
}) as Readonly<CosmeticLoadout>;

/**
 * @returns A fresh mutable copy of {@link DEFAULT_LOADOUT}.
 */
export function defaultLoadout(): CosmeticLoadout {
  return {
    ...DEFAULT_LOADOUT,
    colors: [...DEFAULT_LOADOUT.colors],
    emotes: [...DEFAULT_LOADOUT.emotes],
  };
}

const ids = (slot: CosmeticSlot): string[] => COSMETICS.filter((c) => c.slot === slot).map((c) => c.id);

function pick<T>(rng: RandomSource, items: readonly T[]): T {
  const item = items[Math.floor(rng.next() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

const maybe = (rng: RandomSource, p: number, slot: CosmeticSlot): string | null =>
  rng.next() < p ? pick(rng, ids(slot)) : null;

/**
 * Builds a random but tasteful loadout. Deterministic for a given random source,
 * so every client dresses a bot identically from its seed.
 *
 * @param rng - Seeded random source (e.g. `new Rng(seed)`).
 * @returns A new loadout using only catalog items.
 * @example
 * const look = randomLoadout(new Rng(hashString(botName)));
 */
export function randomLoadout(rng: RandomSource): CosmeticLoadout {
  const colorItem = getCosmeticInSlot(pick(rng, ids('color')), 'color');
  if (!colorItem) throw new Error('catalog has no colours');
  const colors: [string, string, string] = [...colorItem.colors];
  // Swapping secondary/tertiary now and then doubles the colour variety a crowd shows.
  if (rng.next() < 0.3) [colors[1], colors[2]] = [colors[2], colors[1]];

  // Solid bodies read best at distance, so weight them up in crowds.
  const pattern = rng.next() < 0.3 ? 'pattern.solid' : pick(rng, ids('pattern'));

  const emotePool = ids('emote');
  const emotes: string[] = [];
  while (emotes.length < 4) {
    const e = pick(rng, emotePool);
    if (!emotes.includes(e)) emotes.push(e);
  }

  return {
    colors,
    pattern,
    face: pick(rng, ids('face')),
    upper: maybe(rng, 0.3, 'upper'),
    lower: maybe(rng, 0.3, 'lower'),
    headwear: maybe(rng, 0.7, 'headwear'),
    back: maybe(rng, 0.4, 'back'),
    emotes: emotes as [string, string, string, string],
    celebration: pick(rng, ids('celebration')),
    victoryPose: pick(rng, ids('victory')),
    nameplate: pick(rng, ids('nameplate')),
    trail: maybe(rng, 0.5, 'trail'),
  };
}

/** A problem found by {@link validateLoadout}. */
export interface LoadoutIssue {
  field: keyof CosmeticLoadout;
  message: string;
}

const expectSlot = (
  issues: LoadoutIssue[],
  field: keyof CosmeticLoadout,
  id: string | null,
  slot: CosmeticSlot,
): void => {
  if (id === null) return;
  const item: CosmeticItem | undefined = getCosmetic(id);
  if (!item) issues.push({ field, message: `unknown cosmetic "${id}"` });
  else if (item.slot !== slot) issues.push({ field, message: `"${id}" is a ${item.slot}, not a ${slot}` });
};

/**
 * Checks that every id in a loadout exists and sits in the right slot. The API
 * uses this before saving; the renderer tolerates bad ids, the server must not.
 *
 * @param loadout - Loadout to check.
 * @returns Issues found; empty when valid.
 */
export function validateLoadout(loadout: CosmeticLoadout): LoadoutIssue[] {
  const issues: LoadoutIssue[] = [];
  for (const c of loadout.colors) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) issues.push({ field: 'colors', message: `bad colour "${c}"` });
  }
  expectSlot(issues, 'pattern', loadout.pattern, 'pattern');
  expectSlot(issues, 'face', loadout.face, 'face');
  expectSlot(issues, 'upper', loadout.upper, 'upper');
  expectSlot(issues, 'lower', loadout.lower, 'lower');
  expectSlot(issues, 'headwear', loadout.headwear, 'headwear');
  expectSlot(issues, 'back', loadout.back, 'back');
  for (const e of loadout.emotes) expectSlot(issues, 'emotes', e, 'emote');
  if (new Set(loadout.emotes).size !== loadout.emotes.length) {
    issues.push({ field: 'emotes', message: 'duplicate emote' });
  }
  expectSlot(issues, 'celebration', loadout.celebration, 'celebration');
  expectSlot(issues, 'victoryPose', loadout.victoryPose, 'victory');
  expectSlot(issues, 'nameplate', loadout.nameplate, 'nameplate');
  expectSlot(issues, 'trail', loadout.trail, 'trail');
  return issues;
}
