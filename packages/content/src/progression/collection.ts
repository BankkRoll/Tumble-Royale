/**
 * The collection log: every cosmetic in the catalogue, where it comes from,
 * and (given what a player owns) completion by slot and rarity.
 *
 * Responsibilities:
 * - Source metadata per item ({@link cosmeticSources}), derived from the
 *   catalogue's `source` plus the places that actually hand items out: pass
 *   tracks, achievements, seasonal/milestone challenges, the tutorial.
 * - A pure read model over an ownership predicate ({@link collectionLog}),
 *   shared by the account API and the offline client so both count alike.
 *
 * Hidden achievements are named "Hidden achievement" here so the log never
 * spoils one before it is unlocked.
 */
import {
  COSMETICS,
  RARITY_INFO,
  type CosmeticItem,
  type CosmeticSlot,
  type Rarity,
} from '../cosmetics/index.ts';
import { ACHIEVEMENTS } from './achievements.ts';
import { MILESTONE_CHALLENGES, SEASONAL_CHALLENGE_POOL } from './challenges.ts';
import { PASS_TRACKS } from './seasons.ts';
import { TUTORIAL_REWARD } from './tutorial.ts';

/** Where an item can come from. */
export type CollectionSourceKind =
  'default' | 'store' | 'pass' | 'achievement' | 'challenge' | 'event' | 'shards' | 'tutorial';

/** One way to get an item. */
export interface CollectionSource {
  kind: CollectionSourceKind;
  /** Short player-facing line, e.g. `Season Pass tier 12 (Premium)`. */
  label: string;
}

/** One catalogue item in the log. */
export interface CollectionEntry {
  id: string;
  name: string;
  slot: CosmeticSlot;
  rarity: Rarity;
  owned: boolean;
  sources: readonly CollectionSource[];
}

/** Owned / total for one group. */
export interface CollectionTally {
  owned: number;
  total: number;
}

/** Filters for {@link collectionLog}. */
export interface CollectionFilter {
  slot?: CosmeticSlot;
  rarity?: Rarity;
  /** `true` only owned, `false` only missing. */
  owned?: boolean;
}

/** The log for one player. */
export interface CollectionLog {
  /** Matching items, by slot (catalogue order), then rarity, then name. */
  entries: CollectionEntry[];
  /** Completion over the whole catalogue (filters do not change it). */
  owned: number;
  total: number;
  /** `owned / total` as a percentage with one decimal, floored (never shows 100 early). */
  percent: number;
  bySlot: Record<CosmeticSlot, CollectionTally>;
  byRarity: Record<Rarity, CollectionTally>;
}

function buildSources(): Map<string, CollectionSource[]> {
  const out = new Map<string, CollectionSource[]>();
  const add = (id: string, s: CollectionSource): void => {
    const list = out.get(id) ?? [];
    if (!list.some((x) => x.kind === s.kind && x.label === s.label)) list.push(s);
    out.set(id, list);
  };
  for (const track of Object.values(PASS_TRACKS)) {
    for (const t of track.tiers) {
      for (const [lane, rewards] of [
        ['Free', t.free],
        ['Premium', t.premium],
      ] as const) {
        for (const r of rewards)
          if (r.kind === 'cosmetic')
            add(r.itemId, { kind: 'pass', label: `Season Pass tier ${t.tier} (${lane})` });
      }
    }
  }
  for (const a of ACHIEVEMENTS) {
    for (const r of a.rewards) {
      if (r.kind !== 'cosmetic') continue;
      add(r.itemId, {
        kind: 'achievement',
        label: a.hidden ? 'Hidden achievement' : `Achievement: ${a.title}`,
      });
    }
  }
  for (const c of [...SEASONAL_CHALLENGE_POOL, ...MILESTONE_CHALLENGES]) {
    if (!c.rewardCosmetic) continue;
    const what = c.description.replace('{n}', c.target.toLocaleString('en-US'));
    add(c.rewardCosmetic, {
      kind: 'challenge',
      label: `${c.cadence === 'milestone' ? 'Milestone' : 'Seasonal challenge'}: ${what}`,
    });
  }
  add(TUTORIAL_REWARD.cosmeticId, { kind: 'tutorial', label: 'Complete Practice Island' });

  for (const item of COSMETICS) {
    if (out.has(item.id)) {
      if (item.source === 'store') add(item.id, { kind: 'store', label: 'Item Shop' });
      continue;
    }
    switch (item.source) {
      case 'default':
        add(item.id, { kind: 'default', label: 'Starter item' });
        break;
      case 'store':
        add(item.id, { kind: 'store', label: 'Item Shop' });
        break;
      case 'shards':
        add(item.id, { kind: 'shards', label: 'Crown Shard shop' });
        break;
      case 'event':
        add(item.id, { kind: 'event', label: 'Limited-time event' });
        break;
      case 'pass':
        add(item.id, { kind: 'pass', label: 'Season Pass' });
        break;
      case 'challenge':
        add(item.id, { kind: 'challenge', label: 'Challenges' });
        break;
    }
  }
  return out;
}

const SOURCES = buildSources();

/**
 * Every way to get one cosmetic.
 *
 * @param id - Cosmetic id.
 * @returns At least one source for catalogue items; empty for unknown ids.
 * @example
 * cosmeticSources('nameplate.mint'); // [{ kind: 'tutorial', label: 'Complete Practice Island' }]
 */
export function cosmeticSources(id: string): readonly CollectionSource[] {
  return SOURCES.get(id) ?? [];
}

const SLOT_ORDER = new Map<CosmeticSlot, number>();
for (const c of COSMETICS) if (!SLOT_ORDER.has(c.slot)) SLOT_ORDER.set(c.slot, SLOT_ORDER.size);

const ORDERED: readonly CosmeticItem[] = [...COSMETICS].sort(
  (a, b) =>
    (SLOT_ORDER.get(a.slot) ?? 0) - (SLOT_ORDER.get(b.slot) ?? 0) ||
    RARITY_INFO[a.rarity].order - RARITY_INFO[b.rarity].order ||
    a.name.localeCompare(b.name),
);

/**
 * Builds the collection log.
 *
 * @param owns - Whether the player owns an item.
 * @param filter - Narrows `entries` only; totals always cover the catalogue.
 * @example
 * const log = collectionLog((id) => inventory.has(id), { slot: 'headwear' });
 * log.percent; // e.g. 12.5
 */
export function collectionLog(owns: (id: string) => boolean, filter: CollectionFilter = {}): CollectionLog {
  const bySlot = {} as Record<CosmeticSlot, CollectionTally>;
  const byRarity = Object.fromEntries(
    (Object.keys(RARITY_INFO) as Rarity[]).map((r) => [r, { owned: 0, total: 0 }]),
  ) as Record<Rarity, CollectionTally>;
  const entries: CollectionEntry[] = [];
  let owned = 0;
  for (const item of ORDERED) {
    const has = owns(item.id);
    const slot = (bySlot[item.slot] ??= { owned: 0, total: 0 });
    slot.total++;
    byRarity[item.rarity].total++;
    if (has) {
      owned++;
      slot.owned++;
      byRarity[item.rarity].owned++;
    }
    if (filter.slot && item.slot !== filter.slot) continue;
    if (filter.rarity && item.rarity !== filter.rarity) continue;
    if (filter.owned !== undefined && has !== filter.owned) continue;
    entries.push({
      id: item.id,
      name: item.name,
      slot: item.slot,
      rarity: item.rarity,
      owned: has,
      sources: cosmeticSources(item.id),
    });
  }
  const total = ORDERED.length;
  return {
    entries,
    owned,
    total,
    percent: total === 0 ? 0 : Math.floor((owned * 1000) / total) / 10,
    bySlot,
    byRarity,
  };
}
