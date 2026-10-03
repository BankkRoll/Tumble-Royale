/**
 * Mock data generators for the UI preview harness: 40 funny Tumblers, a full
 * show (rounds, results, wall recap), meta (profile, locker, store, pass,
 * challenges, leaderboards, history, news, social) and rewards.
 *
 * Everything is seeded so a deep link always shows the same content.
 */
import { Rng, type RoundType, type ThemeId } from '@tumble/shared';
import {
  randomTumblerName,
  tumblerSwatches,
  type AvatarHat,
  type BetweenRoundsInfo,
  type ChallengesData,
  type CosmeticItem,
  type CosmeticSlot,
  type Friend,
  type InventoryData,
  type LeaderboardRow,
  type MatchHistoryEntry,
  type NewsItem,
  type NotificationItem,
  type PartyState,
  type PassTier,
  type PatternId,
  type Playlist,
  type ProfileData,
  type Rarity,
  type ResultsEntry,
  type RewardsSummary,
  type RoundCatalogEntry,
  type RoundIntroInfo,
  type RoundResults,
  type SeasonPassData,
  type ShowPlayer,
  type ShowSummary,
  type StoreData,
  type StoreOffer,
  type TumblerColors,
} from '@tumble/ui';

const PATTERNS: PatternId[] = [
  'plain',
  'stripes',
  'dots',
  'checker',
  'zigzag',
  'stars',
  'gradient',
  'galaxy',
  'camo',
];
const HATS: AvatarHat[] = ['none', 'none', 'none', 'cone', 'cap', 'bow', 'antenna', 'tophat'];

/** Seeded `() => number` for name generation. */
export function seeded(seed: number): () => number {
  const r = new Rng(seed);
  return () => r.next();
}

/** Random candy colours. */
export function randomColors(rng: Rng): TumblerColors {
  const primary = rng.pick(tumblerSwatches);
  let secondary = rng.pick(tumblerSwatches);
  if (secondary === primary) secondary = '#ffffff';
  return { primary, secondary, pattern: rng.pick(PATTERNS) };
}

/** The local player's look. */
export const LOCAL_COLORS: TumblerColors = { primary: '#ff4f9a', secondary: '#ffffff', pattern: 'dots' };
/** The local player's name. */
export const LOCAL_NAME = 'Sprinkles';

/** 40 participants; index 0 is the local player, 1–2 are party mates. */
export function makePlayers(n = 40, seed = 7): ShowPlayer[] {
  const rng = new Rng(seed);
  const rand = seeded(seed + 1);
  const used = new Set<string>([LOCAL_NAME]);
  const out: ShowPlayer[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out.push({ id: 0, name: LOCAL_NAME, colors: LOCAL_COLORS, isBot: false, isLocal: true, hat: 'none' });
      continue;
    }
    let name = randomTumblerName(rand);
    while (used.has(name)) name = randomTumblerName(rand);
    used.add(name);
    out.push({
      id: i,
      name,
      colors: randomColors(rng),
      hat: rng.pick(HATS),
      isBot: rng.chance(0.6),
      isParty: i <= 2,
    });
  }
  // Lobby join order is random-ish; keep the local player somewhere in the middle.
  const local = out.shift() as ShowPlayer;
  out.splice(Math.floor(n * 0.45), 0, local);
  return out;
}

/** Round catalog (SPEC §9 launch set, all original). */
export const ROUNDS: {
  id: string;
  name: string;
  type: RoundType;
  theme: ThemeId;
  objective: string;
  rules: { icon: string; text: string }[];
  tips: string[];
}[] = [
  {
    id: 'gumdrop-gauntlet',
    name: 'Gumdrop Gauntlet',
    type: 'race',
    theme: 'candy',
    objective: 'Reach the finish line!',
    rules: [
      { icon: '🚪', text: 'Bust through the real doors' },
      { icon: '🔨', text: 'Dodge the swinging hammers' },
      { icon: '🏁', text: 'First 26 qualify' },
    ],
    tips: [
      'Fake doors don’t budge — follow the crowd… or don’t.',
      'Dive over the last ramp for a speed boost!',
    ],
  },
  {
    id: 'conveyor-chaos',
    name: 'Conveyor Chaos',
    type: 'race',
    theme: 'factory',
    objective: 'Ride the belts to the finish!',
    rules: [
      { icon: '↔️', text: 'Belts reverse — watch the arrows' },
      { icon: '🥊', text: 'Punch walls pack a wallop' },
      { icon: '🏁', text: 'First 14 qualify' },
    ],
    tips: ['Jump right as a belt flips to keep your momentum.'],
  },
  {
    id: 'spin-cycle',
    name: 'Spin Cycle',
    type: 'survival',
    theme: 'neon',
    objective: 'Don’t get swept off!',
    rules: [
      { icon: '🌀', text: 'Two sweepers, getting faster' },
      { icon: '⬆️', text: 'Jump the low one, duck the high one' },
      { icon: '⏳', text: 'Survive 90 seconds' },
    ],
    tips: ['Stay near the centre — the sweepers are slowest there.'],
  },
  {
    id: 'egg-heist',
    name: 'Egg Heist',
    type: 'team',
    theme: 'jungle',
    objective: 'Hoard the most eggs!',
    rules: [
      { icon: '🥚', text: 'Grab eggs and carry them home' },
      { icon: '🦹', text: 'Steal from other nests' },
      { icon: '📉', text: 'Lowest team is out' },
    ],
    tips: ['Golden eggs are worth 3!'],
  },
  {
    id: 'tilt-town',
    name: 'Tilt Town',
    type: 'race',
    theme: 'sunset',
    objective: 'Keep your balance to the end!',
    rules: [
      { icon: '⚖️', text: 'Platforms tilt under weight' },
      { icon: '🕳️', text: 'Don’t fall in the void' },
      { icon: '🏁', text: 'First 7 qualify' },
    ],
    tips: ['Spread out — crowds tip platforms!'],
  },
  {
    id: 'crown-climb',
    name: 'Crown Climb',
    type: 'final',
    theme: 'castle',
    objective: 'Climb the tower and grab the Crown!',
    rules: [
      { icon: '🧗', text: 'Climb, bounce and grab ledges' },
      { icon: '🌬️', text: 'Fans push you around near the top' },
      { icon: '👑', text: 'First to grab the Crown wins' },
    ],
    tips: ['Grab the Crown with Shift / Right-click — don’t just bump it!'],
  },
  {
    id: 'tile-panic',
    name: 'Tile Panic',
    type: 'survival',
    theme: 'frosty',
    objective: 'Last on the tiles wins!',
    rules: [],
    tips: [],
  },
  {
    id: 'tail-chase',
    name: 'Tail Chase',
    type: 'hunt',
    theme: 'beach',
    objective: 'Hold a tail when time runs out!',
    rules: [],
    tips: [],
  },
  {
    id: 'pattern-panic',
    name: 'Pattern Panic',
    type: 'logic',
    theme: 'space',
    objective: 'Stand on the right picture!',
    rules: [],
    tips: [],
  },
  {
    id: 'hammer-highway',
    name: 'Hammer Highway',
    type: 'race',
    theme: 'castle',
    objective: 'Cross the bridges!',
    rules: [],
    tips: [],
  },
  {
    id: 'slip-n-spiral',
    name: 'Slip ’n’ Spiral',
    type: 'race',
    theme: 'frosty',
    objective: 'Slide down the spiral!',
    rules: [],
    tips: [],
  },
  {
    id: 'bounce-ball-blitz',
    name: 'Bounce Ball Blitz',
    type: 'team',
    theme: 'beach',
    objective: 'Score goals with giant balls!',
    rules: [],
    tips: [],
  },
  {
    id: 'last-tumbler-standing',
    name: 'Last Tumbler Standing',
    type: 'final',
    theme: 'goo',
    objective: 'Be the last one on the hexes!',
    rules: [],
    tips: [],
  },
];

/** Catalog entries for the custom lobby picker. */
export const ROUND_CATALOG: RoundCatalogEntry[] = ROUNDS.map((r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
}));

/** The mock show: R1 race, R2 race, R3 survival, Final (40 → 26 → 14 → 7 → 1). */
export const SHOW_ROUNDS = ['gumdrop-gauntlet', 'conveyor-chaos', 'spin-cycle', 'crown-climb'] as const;
/** Players entering each round, then the lone winner. */
export const SHOW_COUNTS = [40, 26, 14, 7, 1] as const;
/** Show name. */
export const SHOW_NAME = 'Main Show';

function roundDef(id: string): (typeof ROUNDS)[number] {
  return ROUNDS.find((r) => r.id === id) ?? (ROUNDS[0] as (typeof ROUNDS)[number]);
}

/** Intro info for show round `index`. */
export function roundIntro(index: number, playerCount = SHOW_COUNTS[index] ?? 40): RoundIntroInfo {
  const d = roundDef(SHOW_ROUNDS[index] ?? 'gumdrop-gauntlet');
  const isFinal = d.type === 'final';
  return {
    roundId: d.id,
    name: d.name,
    type: d.type,
    theme: d.theme,
    objective: d.objective,
    rules: d.rules,
    tips: d.tips.length ? d.tips : ['Grab, dive and bonk your way through!'],
    roundIndex: index,
    roundCount: SHOW_ROUNDS.length,
    isFinal,
    playerCount,
    qualifyTarget: isFinal ? 1 : (SHOW_COUNTS[index + 1] ?? 1),
  };
}

/**
 * Builds a full show recap where `localOutRound` is the round the local player
 * is eliminated in (-1 = they win).
 */
export function makeShowSummary(players: ShowPlayer[], localOutRound = -1, seed = 11): ShowSummary {
  const rng = new Rng(seed);
  const local = players.find((p) => p.isLocal);
  const others = rng.shuffle(players.filter((p) => !p.isLocal).map((p) => p.id));
  const winnerId = localOutRound === -1 && local ? local.id : (others.pop() ?? -1);
  const pool = others.filter((id) => id !== winnerId);
  const rounds = SHOW_ROUNDS.map((rid, i) => {
    const d = roundDef(rid);
    const before = SHOW_COUNTS[i] ?? 0;
    const after = SHOW_COUNTS[i + 1] ?? 1;
    let outCount = before - after;
    const out: number[] = [];
    if (local && localOutRound === i) {
      out.push(local.id);
      outCount--;
    }
    if (i === SHOW_ROUNDS.length - 1) {
      out.push(...pool.splice(0));
    } else {
      out.push(...pool.splice(0, Math.max(0, outCount)));
    }
    return { roundId: d.id, name: d.name, type: d.type, eliminatedIds: out };
  });
  return { showName: SHOW_NAME, players, rounds, winnerId, seed };
}

/** Survivors entering round `index` of a summary. */
export function aliveAt(summary: ShowSummary, index: number): ShowPlayer[] {
  const out = new Set(summary.rounds.slice(0, index).flatMap((r) => r.eliminatedIds));
  return summary.players.filter((p) => !out.has(p.id));
}

/** Results for round `index`. */
export function makeResults(summary: ShowSummary, index: number): RoundResults {
  const round = summary.rounds[index];
  const alive = aliveAt(summary, index);
  const out = new Set(round?.eliminatedIds);
  let place = 1;
  const entries: ResultsEntry[] = alive.map((p) => ({
    player: p,
    qualified: !out.has(p.id),
    place: out.has(p.id) ? 0 : place++,
  }));
  return { roundName: round?.name ?? 'Round', roundType: round?.type ?? 'race', roundIndex: index, entries };
}

/** Between-rounds info after round `index`. */
export function makeBetween(index: number): BetweenRoundsInfo {
  const next = roundDef(SHOW_ROUNDS[index + 1] ?? 'crown-climb');
  return {
    remainingBefore: SHOW_COUNTS[index] ?? 40,
    remaining: SHOW_COUNTS[index + 1] ?? 1,
    roundIndex: index,
    roundCount: SHOW_ROUNDS.length,
    next: { name: next.name, type: next.type, isFinal: next.type === 'final' },
  };
}

// -----------------------------------------------------------------------------
// Cosmetics
// -----------------------------------------------------------------------------

const ITEM_SEEDS: Record<Exclude<CosmeticSlot, 'colors' | 'pattern'>, [string, string][]> = {
  face: [
    ['Goofy Grin', '😁'],
    ['Star Eyes', '🤩'],
    ['Sleepy Bean-less', '😴'],
    ['Disco Visor', '🕶️'],
    ['Cyclops Wink', '😉'],
  ],
  upper: [
    ['Sailor Shirt', '👕'],
    ['Puffy Jacket', '🧥'],
    ['Superhero Cape Top', '🦸'],
    ['Chef Whites', '👨‍🍳'],
    ['Space Suit Top', '👩‍🚀'],
  ],
  lower: [
    ['Shorts of Speed', '🩳'],
    ['Tutu Deluxe', '🩰'],
    ['Cowpoke Chaps', '🤠'],
    ['Robot Legs', '🦿'],
  ],
  headwear: [
    ['Traffic Cone', '🚧'],
    ['Party Hat', '🎉'],
    ['Wizard Hat', '🧙'],
    ['Pineapple Crown', '🍍'],
    ['Viking Lid', '⚔️'],
    ['Halo of Smugness', '😇'],
    ['Banana Beanie', '🍌'],
    ['Cake Hat', '🎂'],
  ],
  back: [
    ['Jet Pack', '🚀'],
    ['Butterfly Wings', '🦋'],
    ['Turtle Shell', '🐢'],
    ['Balloon Bunch', '🎈'],
  ],
  emote: [
    ['Wiggle', '💃'],
    ['Giggle', '😂'],
    ['Flex', '💪'],
    ['Floss-ish', '🕺'],
    ['Air Guitar', '🎸'],
  ],
  celebration: [
    ['Confetti Cannon', '🎊'],
    ['Backflip Fail', '🤸'],
    ['Victory Lap', '🏃'],
  ],
  victory: [
    ['Crown Juggle', '🤹'],
    ['Big Bow', '🙇'],
    ['Rocket Exit', '🚀'],
  ],
  nameplate: [
    ['Candy Stripe', '🍬'],
    ['Gold Trim', '🏅'],
    ['Pixel Party', '👾'],
  ],
  banner: [
    ['Sunburst', '🌞'],
    ['Goo Lagoon', '🟢'],
    ['Night Circus', '🎪'],
  ],
  trail: [
    ['Sparkle Trail', '✨'],
    ['Bubble Trail', '🫧'],
    ['Rainbow Trail', '🌈'],
  ],
  footsteps: [
    ['Squeaky Shoes', '👟'],
    ['Clown Honks', '🤡'],
    ['Jelly Wobbles', '🍮'],
  ],
};

const RARITY_CYCLE: Rarity[] = [
  'common',
  'uncommon',
  'rare',
  'common',
  'epic',
  'uncommon',
  'legendary',
  'rare',
  'mythic',
];

/** Every mock cosmetic. */
export function makeItems(seed = 3): CosmeticItem[] {
  const rng = new Rng(seed);
  const items: CosmeticItem[] = [];
  let k = 0;
  for (const [slot, list] of Object.entries(ITEM_SEEDS) as [
    Exclude<CosmeticSlot, 'colors' | 'pattern'>,
    [string, string][],
  ][]) {
    for (const [name, icon] of list) {
      const rarity = RARITY_CYCLE[k++ % RARITY_CYCLE.length] as Rarity;
      items.push({
        id: `${slot}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        name,
        slot,
        rarity,
        icon,
        art: [rng.pick(tumblerSwatches), rng.pick(tumblerSwatches)],
        owned: rng.chance(0.55),
        description: `A ${rarity} ${slot} for the discerning Tumbler.`,
        set: rng.chance(0.3) ? 'Sugar Rush' : undefined,
      });
    }
  }
  return items;
}

/** Inventory with 6 loadouts. */
export function makeInventory(items: CosmeticItem[]): InventoryData {
  const owned = (slot: CosmeticSlot): string | undefined => items.find((i) => i.slot === slot && i.owned)?.id;
  const base = {
    colors: LOCAL_COLORS,
    items: { headwear: owned('headwear'), face: owned('face'), upper: owned('upper'), trail: owned('trail') },
    emotes: items
      .filter((i) => i.slot === 'emote' && i.owned)
      .slice(0, 4)
      .map((i) => i.id),
  };
  return {
    items,
    loadouts: Array.from({ length: 6 }, (_, i) => ({ ...base, name: `Loadout ${i + 1}` })),
    activeLoadout: 0,
  };
}

/** Store rotation. */
export function makeStore(items: CosmeticItem[]): StoreData {
  const pick = (r: Rarity[]): CosmeticItem[] => items.filter((i) => r.includes(i.rarity));
  const offer = (item: CosmeticItem, i: number, featured = false): StoreOffer => {
    const gems = item.rarity === 'legendary' || item.rarity === 'mythic' || item.rarity === 'epic';
    const price = { common: 300, uncommon: 600, rare: 1200, epic: 600, legendary: 1200, mythic: 2000 }[
      item.rarity
    ];
    return {
      id: `offer-${item.id}`,
      item,
      currency: gems ? 'gems' : 'gumballs',
      price,
      originalPrice: i % 4 === 0 ? Math.round(price * 1.3) : undefined,
      featured,
      tag: featured ? (i === 0 ? 'NEW!' : i === 1 ? 'HOT' : undefined) : undefined,
    };
  };
  return {
    featured: pick(['legendary', 'mythic', 'epic'])
      .slice(0, 4)
      .map((it, i) => offer(it, i, true)),
    daily: pick(['common', 'uncommon', 'rare'])
      .slice(0, 8)
      .map((it, i) => offer(it, i)),
    rotationEndsAt: Date.now() + 5 * 3600_000 + 12 * 60_000,
  };
}

/** 100-tier pass. */
export function makePass(items: CosmeticItem[]): SeasonPassData {
  const tiers: PassTier[] = [];
  for (let t = 1; t <= 100; t++) {
    const item = items[(t * 7) % items.length];
    tiers.push({
      tier: t,
      free:
        t % 3 === 0 && item
          ? { item: { ...item, owned: t <= 23 }, claimed: t < 20 }
          : t % 3 === 1
            ? { currency: { kind: 'gumballs', amount: 100 + (t % 5) * 50 }, claimed: t < 20 }
            : undefined,
      premium: item
        ? { item: { ...items[(t * 11) % items.length]!, owned: false }, claimed: false }
        : undefined,
    });
  }
  return {
    seasonName: 'Sugar Rush',
    seasonNumber: 1,
    endsAt: Date.now() + 41 * 86400_000,
    currentTier: 23,
    tierProgress: 0.62,
    premium: false,
    premiumPrice: 950,
    tiers,
  };
}

/** Daily + weekly challenges. */
export function makeChallenges(): ChallengesData {
  const c = (
    id: string,
    cadence: 'daily' | 'weekly',
    title: string,
    icon: string,
    progress: number,
    goal: number,
    reward: ChallengesData['list'][number]['reward'],
    claimed = false,
  ) => ({
    id,
    cadence,
    title,
    icon,
    progress,
    goal,
    reward,
    claimed,
    canReroll: cadence === 'daily' && !claimed,
  });
  return {
    list: [
      c('d1', 'daily', 'Qualify from 3 races', '🏁', 2, 3, { kind: 'xp', amount: 500 }),
      c('d2', 'daily', 'Grab 10 Tumblers', '✊', 10, 10, { kind: 'gumballs', amount: 150 }),
      c('d3', 'daily', 'Dive 50 times', '🤿', 12, 50, { kind: 'stars', amount: 2 }),
      c('w1', 'weekly', 'Reach 5 finals', '👑', 3, 5, { kind: 'xp', amount: 2500 }),
      c('w2', 'weekly', 'Win a team round', '🤝', 1, 1, { kind: 'stars', amount: 5 }, true),
      c('w3', 'weekly', 'Survive Spin Cycle 3 times', '🌀', 1, 3, { kind: 'gumballs', amount: 400 }),
      c('w4', 'weekly', 'Bounce on 100 pads', '🦘', 64, 100, { kind: 'xp', amount: 1500 }),
      c('w5', 'weekly', 'Play 10 shows with a party', '👥', 4, 10, { kind: 'stars', amount: 4 }),
      c('w6', 'weekly', 'Win the Crown', '🏆', 0, 1, { kind: 'gems', amount: 50 }),
    ],
    dailyResetsAt: Date.now() + 7 * 3600_000,
    weeklyResetsAt: Date.now() + 3 * 86400_000,
  };
}

/** Local profile. */
export function makeProfile(items: CosmeticItem[]): ProfileData {
  return {
    id: 'me',
    name: LOCAL_NAME,
    tag: '0420',
    level: 12,
    xp: 1840,
    xpToNext: 2500,
    gumballs: 4820,
    gems: 1250,
    crowns: 4,
    colors: LOCAL_COLORS,
    hat: 'none',
    isGuest: true,
    rank: { tier: 'gold', division: 2, rp: 64, rpToNext: 100 },
    stats: { shows: 87, finals: 19, roundsQualified: 241, bestStreak: 3, favouriteRound: 'Gumdrop Gauntlet' },
    showcase: items.filter((i) => i.rarity === 'legendary' || i.rarity === 'epic').slice(0, 3),
    linkedProviders: [],
  };
}

/** Leaderboard rows with the local player somewhere below the top 50. */
export function makeLeaderboard(seed: number, unitScale = 1): LeaderboardRow[] {
  const rng = new Rng(seed);
  const rand = seeded(seed);
  const rows: LeaderboardRow[] = [];
  let v = Math.round(900 * unitScale);
  for (let i = 1; i <= 60; i++) {
    v -= rng.int(1, Math.max(2, Math.round(15 * unitScale)));
    rows.push({
      rank: i,
      playerId: `p${i}`,
      name: randomTumblerName(rand),
      value: Math.max(1, v),
      colors: randomColors(rng),
    });
  }
  rows.push({ rank: 1337, playerId: 'me', name: LOCAL_NAME, value: 4, colors: LOCAL_COLORS, isSelf: true });
  return rows;
}

/** Last 20 shows. */
export function makeHistory(): MatchHistoryEntry[] {
  const rng = new Rng(99);
  return Array.from({ length: 20 }, (_, i) => {
    const reached = rng.int(1, 5);
    const crown = reached === 5 && rng.chance(0.4);
    return {
      id: `m${i}`,
      time: Date.now() - i * 5400_000,
      playlist: rng.pick(['Main Show', 'Duos', 'Chaos Mode']),
      rounds: SHOW_ROUNDS.slice(0, reached).map((rid, j) => {
        const d = roundDef(rid);
        return { name: d.name, type: d.type, qualified: j < reached - 1 || crown };
      }),
      result: crown ? 'crown' : reached === 5 ? 'final' : 'eliminated',
      xp: 300 + reached * 180 + (crown ? 1000 : 0),
    };
  });
}

/** News cards. */
export const NEWS: NewsItem[] = [
  {
    id: 'n1',
    title: 'Season 1: Sugar Rush is live!',
    body: '100 tiers of sweet loot, five brand-new rounds and a tower made of cake. Probably.',
    tag: 'SEASON',
    art: ['#ff9ad5', '#ffd23f'],
    icon: '🍭',
  },
  {
    id: 'n2',
    title: 'Goo Weekend — double XP',
    body: 'All weekend long, every round awards double XP. Go fall in some goo!',
    tag: 'EVENT',
    art: ['#9be34f', '#3ee6b4'],
    icon: '🟢',
  },
  {
    id: 'n3',
    title: 'Patch 1.0.3',
    body: 'Spinwheels spin 4% less rudely. Fixed Tumblers occasionally achieving orbit.',
    tag: 'PATCH',
    art: ['#8cc6ff', '#c7b8ff'],
    icon: '🛠️',
  },
];

/** Playlists. */
export const PLAYLISTS: Playlist[] = [
  {
    id: 'main',
    name: 'Main Show',
    description: 'The classic: races, survivals, team games and a final. 40 Tumblers, one Crown.',
    players: 40,
    teamSize: 1,
    art: ['#ff6fae', '#ffd23f'],
    icon: '🎪',
  },
  {
    id: 'duos',
    name: 'Duos',
    description: 'Pair up — if your buddy qualifies, so do you.',
    players: 40,
    teamSize: 2,
    art: ['#5aa9ff', '#3ee6b4'],
    icon: '👯',
  },
  {
    id: 'squads',
    name: 'Squads',
    description: 'Four-Tumbler teams. Pure, beautiful chaos.',
    players: 40,
    teamSize: 4,
    art: ['#8a5cff', '#ff9ad5'],
    icon: '🐙',
  },
  {
    id: 'chaos',
    name: 'Chaos Mode',
    description: 'Every obstacle at double speed. Good luck!',
    players: 40,
    teamSize: 1,
    art: ['#ff8a3d', '#ff4f9a'],
    icon: '🌪️',
    endsAt: Date.now() + 2 * 86400_000 + 5 * 3600_000,
  },
  {
    id: 'ranked',
    name: 'Ranked Show',
    description: 'Climb from Bronze to the Crown League.',
    players: 40,
    teamSize: 1,
    art: ['#ffd23f', '#ffb021'],
    icon: '🏅',
    ranked: true,
  },
];

/** Friends list. */
export function makeFriends(): Friend[] {
  const rng = new Rng(5);
  const rand = seeded(5);
  const presences: Friend['presence'][] = [
    'online',
    'inShow',
    'inMenu',
    'offline',
    'offline',
    'online',
    'inShow',
    'offline',
  ];
  return presences
    .map((presence, i) => ({
      id: `f${i}`,
      name: randomTumblerName(rand).replace(/\s+/g, ''),
      tag: String(rng.int(1000, 9999)),
      presence,
      colors: randomColors(rng),
    }))
    .concat([
      {
        id: 'r1',
        name: 'GloopyMcFlop',
        tag: '7781',
        presence: 'online',
        colors: randomColors(rng),
        recent: true,
      } as Friend,
    ]);
}

/** Party with two mates. */
export function makeParty(players: ShowPlayer[]): PartyState {
  const mates = players.filter((p) => p.isParty).slice(0, 2);
  return {
    code: 'WOBL42',
    maxSize: 4,
    members: [
      { id: 'me', name: LOCAL_NAME, colors: LOCAL_COLORS, ready: true, isLeader: true, isSelf: true },
      ...mates.map((m, i) => ({
        id: `p${m.id}`,
        name: m.name,
        colors: m.colors,
        ready: i === 0,
        isLeader: false,
        isSelf: false,
      })),
    ],
  };
}

/** Notifications. */
export const NOTIFICATIONS: NotificationItem[] = [
  { id: 'x1', kind: 'invite', title: 'Sir Wobbleton invited you to a party', time: Date.now() - 60_000 },
  {
    id: 'x2',
    kind: 'reward',
    title: '3 pass tiers ready to claim!',
    body: 'Tiers 21–23',
    time: Date.now() - 3600_000,
  },
  { id: 'x3', kind: 'news', title: 'Goo Weekend starts Friday', time: Date.now() - 86400_000, read: true },
];

/** End-of-show rewards (`won` adds the Crown line). */
export function makeRewards(items: CosmeticItem[], won: boolean, roundsSurvived = 4): RewardsSummary {
  const lines = [
    { label: `Rounds survived ×${roundsSurvived}`, xp: roundsSurvived * 150 },
    { label: 'Qualified in Gumdrop Gauntlet', xp: 100 },
    { label: 'First show of the day', xp: 200 },
  ];
  if (won) lines.push({ label: 'Won the Crown!', xp: 1000 });
  const legendary = items.find((i) => i.rarity === 'legendary');
  const rare = items.find((i) => i.rarity === 'rare');
  return {
    xpLines: lines,
    levelFrom: { level: 12, xp: 1840, xpToNext: 2500 },
    levelTo: won ? { level: 13, xp: 650, xpToNext: 2600 } : { level: 12, xp: 2440, xpToNext: 2500 },
    gumballs: won ? 450 : 120,
    crowns: won ? 1 : 0,
    pass: { tierFrom: 23, tierTo: won ? 25 : 23, progressFrom: 0.62, progressTo: won ? 0.3 : 0.94 },
    unlocks: won
      ? [rare, legendary].filter((x): x is CosmeticItem => Boolean(x)).map((i) => ({ ...i, owned: true }))
      : [],
    ranked: {
      from: { tier: 'gold', division: 2, rp: 64, rpToNext: 100 },
      to: won
        ? { tier: 'gold', division: 1, rp: 12, rpToNext: 100 }
        : { tier: 'gold', division: 2, rp: 88, rpToNext: 100 },
      delta: won ? 48 : 24,
    },
    challenges: [
      { title: 'Qualify from 3 races', from: 2, to: 3, goal: 3 },
      { title: 'Reach 5 finals', from: 3, to: won ? 4 : 3, goal: 5 },
    ],
  };
}
