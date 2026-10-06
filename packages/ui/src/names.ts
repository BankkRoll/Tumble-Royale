/**
 * Original funny Tumbler name generator (guest placeholders, bots, mocks).
 */

const FIRST = [
  'Sir',
  'Lady',
  'Captain',
  'Professor',
  'Little',
  'Big',
  'Sneaky',
  'Wobbly',
  'Sticky',
  'Fluffy',
  'Turbo',
  'Mega',
  'Grumpy',
  'Jolly',
  'Sleepy',
  'Crispy',
  'Bouncy',
  'Squishy',
  'Dizzy',
  'Noodle',
] as const;

const CORE = [
  'Wobble',
  'Gloop',
  'Sprinkle',
  'Jelly',
  'Gumdrop',
  'Marsh',
  'Puddle',
  'Taffy',
  'Bonk',
  'Fizz',
  'Tumble',
  'Doodle',
  'Pudding',
  'Muffin',
  'Waffle',
  'Bubble',
  'Pickle',
  'Noodle',
  'Biscuit',
  'Toffee',
  'Splat',
  'Boing',
  'Nugget',
  'Flop',
] as const;

const TAIL = [
  'ton',
  'bottom',
  'kins',
  'face',
  'paws',
  'buns',
  'socks',
  'pants',
  'flop',
  'muncher',
  'bandit',
  'zilla',
  'wick',
  'ster',
  'o',
  'McFlop',
  'worth',
  'nose',
] as const;

/**
 * Returns a random original Tumbler name like "Sir Wobbleton" or "Gloopy McFlop".
 * @param rand Uniform [0,1) source; pass a seeded one for deterministic mocks.
 */
export function randomTumblerName(rand: () => number = Math.random): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const style = rand();
  const core = pick(CORE);
  if (style < 0.3) return `${pick(FIRST)} ${core}${pick(TAIL)}`;
  if (style < 0.55)
    return `${core}y ${pick(['McFlop', 'Von Bounce', 'the Great', 'Jr.', 'III', 'Supreme'] as const)}`;
  if (style < 0.8) return `${core}${pick(TAIL)}${Math.floor(rand() * 99) + 1}`;
  return `${pick(FIRST)}${core}`;
}

/**
 * Validates a display name: 3–16 letters, digits, spaces, `_` or `-`.
 * @returns An error message, or null when valid.
 */
export function validateDisplayName(name: string): string | null {
  const n = name.trim();
  if (n.length < 3) return 'At least 3 characters, please!';
  if (n.length > 16) return 'Keep it to 16 characters.';
  if (!/^[A-Za-z0-9 _-]+$/.test(n)) return 'Letters, numbers and spaces only — keep it friendly!';
  return null;
}

/** Who a name belongs to, for {@link streamerSafeName}. */
export interface NamedPlayer {
  /** Show player id (the masked name is `Tumbler <id + 1>`). */
  id: number;
  name: string;
  isLocal?: boolean;
  isBot?: boolean;
  isParty?: boolean;
}

/**
 * The name to show on screen. Streamer Mode turns other real players into
 * "Tumbler N"; you, your party and bots (generated names, not personal data)
 * keep theirs. The game uses this for everything it draws itself (3D wall,
 * pre-show plates, podium banner, toasts) so both layers mask identically.
 *
 * @param p - The player.
 * @param streamer - Settings → Streamer mode.
 * @example
 * streamerSafeName({ id: 4, name: 'xXSniperXx' }, true); // 'Tumbler 5'
 */
export function streamerSafeName(p: NamedPlayer, streamer: boolean): string {
  return streamer && !p.isLocal && !p.isBot && !p.isParty ? seatName(p.id) : p.name;
}

/**
 * The generic name of a show seat: what Streamer Mode shows, and the
 * fallback for a seat whose player is unknown. Counts from 1, so seat 0 is
 * "Tumbler 1" everywhere (nameplates, chat, the wall, replays).
 *
 * @param id - Show player id.
 * @example
 * seatName(0); // 'Tumbler 1'
 */
export function seatName(id: number): string {
  return `Tumbler ${id + 1}`;
}

/**
 * A stable "Tumbler N" (100–999) for someone known by an account key rather
 * than a show seat: menu and lobby chat, private-lobby members. The same key
 * always masks to the same number, so a conversation stays readable.
 *
 * @param key - Account id (or any stable per-person key).
 * @example
 * maskedName('u-123'); // e.g. 'Tumbler 417', the same every time
 */
export function maskedName(key: string): string {
  // FNV-1a: tiny, dependency-free and well spread for short ids.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `Tumbler ${100 + ((h >>> 0) % 900)}`;
}

/** Someone known by account key, for {@link streamerSafeKeyedName}. */
export interface KeyedPlayer {
  /** Account id, or `name:<name>` for players without one. */
  key: string;
  name: string;
  isBot?: boolean;
  /** Show seat when the player is in the current show, so the mask matches their nameplate. */
  seat?: number;
  /** You, your party or a friend: names you already know (and show elsewhere). */
  known?: boolean;
}

/**
 * {@link streamerSafeName} for players known by account key (chat lines,
 * lobby members, host tools): Streamer Mode masks strangers, keeping you,
 * your party, friends and bots. In a show the mask is the seat's
 * "Tumbler N"; elsewhere it is {@link maskedName}.
 *
 * @param p - The player.
 * @param streamer - Settings → Streamer mode.
 */
export function streamerSafeKeyedName(p: KeyedPlayer, streamer: boolean): string {
  if (!streamer || p.known || p.isBot) return p.name;
  return p.seat !== undefined ? seatName(p.seat) : maskedName(p.key);
}

/** What Streamer Mode shows in place of a real `#tag`. */
export const MASKED_TAG = '••••';

/** Another account as named in menus, toasts and notifications. */
export interface AccountName {
  userId: string;
  name: string;
  tag?: string;
}

/**
 * Another account's name and tag for the friends sheet, club lists, toasts
 * and notifications. Streamer Mode masks everyone here, friends included:
 * these surfaces list `Name#tag`, which is exactly what a viewer needs to
 * find, add or harass that player.
 *
 * @param p - The account.
 * @param streamer - Settings → Streamer mode.
 * @returns The name and tag to show, and whether they are masked.
 * @example
 * streamerSafeAccount({ userId: 'u-1', name: 'Real', tag: '1234' }, true);
 * // { name: maskedName('u-1'), tag: '••••', masked: true }
 */
export function streamerSafeAccount(
  p: AccountName,
  streamer: boolean,
): { name: string; tag?: string; masked: boolean } {
  if (!streamer) return { name: p.name, ...(p.tag ? { tag: p.tag } : {}), masked: false };
  return { name: maskedName(p.userId), ...(p.tag ? { tag: MASKED_TAG } : {}), masked: true };
}

/**
 * {@link streamerSafeAccount} as one line of text, for toasts and
 * notification titles.
 *
 * @param p - The account.
 * @param streamer - Settings → Streamer mode.
 * @param withTag - Append `#tag` (`#••••` when masked).
 * @returns `Name`, or `Name#tag` with `withTag`.
 * @example
 * streamerSafeAccountLabel({ userId: 'u-1', name: 'Real', tag: '1234' }, false, true); // 'Real#1234'
 */
export function streamerSafeAccountLabel(p: AccountName, streamer: boolean, withTag = false): string {
  const v = streamerSafeAccount(p, streamer);
  return withTag && v.tag ? `${v.name}#${v.tag}` : v.name;
}
