/**
 * Round registry. Level builders add one import + one array entry per round;
 * everything else (show selection, level page, bots) discovers rounds here.
 */
import { RoundDefinitionSchema, type RoundDefinition, type RoundDefinitionInput } from '@tumble/shared';
import testArena from './_test-arena/index.ts';
import { ROUNDS_GROUP_1 } from './group-1.ts';
import { ROUNDS_GROUP_2 } from './group-2.ts';
import { ROUNDS_GROUP_3 } from './group-3.ts';
import { ROUNDS_GROUP_4 } from './group-4.ts';

/** Every authored round, as written. */
export const ROUNDS: RoundDefinitionInput[] = [
  testArena,
  ...ROUNDS_GROUP_1,
  ...ROUNDS_GROUP_2,
  ...ROUNDS_GROUP_3,
  ...ROUNDS_GROUP_4,
];

/** Engineering fixtures that must not appear in real shows while real rounds exist. */
export const DEV_ROUND_IDS: ReadonlySet<string> = new Set(['test-arena', 'practice-island']);

let parsed: Map<string, RoundDefinition> | null = null;

/**
 * All rounds validated (defaults applied), keyed by id. Parsed once.
 *
 * @throws If two rounds share an id or a round fails validation.
 */
export function roundCatalog(): ReadonlyMap<string, RoundDefinition> {
  if (!parsed) {
    const map = new Map<string, RoundDefinition>();
    for (const r of ROUNDS) {
      const def = RoundDefinitionSchema.parse(r);
      if (map.has(def.id)) throw new Error(`Duplicate round id "${def.id}"`);
      map.set(def.id, def);
    }
    parsed = map;
  }
  return parsed;
}

/**
 * Looks up a validated round.
 *
 * @param id - Round id, e.g. `gumdrop-gauntlet`.
 * @returns The round, or undefined if not registered.
 */
export function getRound(id: string): RoundDefinition | undefined {
  return roundCatalog().get(id);
}

/**
 * Rounds eligible for real shows: everything except dev fixtures, unless
 * nothing else exists yet (so a show is always playable during development).
 */
export function showRoundCatalog(): ReadonlyMap<string, RoundDefinition> {
  const all = roundCatalog();
  const real = new Map([...all].filter(([id]) => !DEV_ROUND_IDS.has(id)));
  return real.size > 0 ? real : all;
}
