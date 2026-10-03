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
