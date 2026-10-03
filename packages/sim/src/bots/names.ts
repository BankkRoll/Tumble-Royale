/**
 * Original bot name generator: silly two-part names ("WobblyPancake",
 * "SirBounce42"). Word lists are generic everyday words; never real people,
 * brands or other games' characters.
 */
import type { Rng } from '@tumble/shared';

const ADJECTIVES = [
  'Wobbly',
  'Bouncy',
  'Squishy',
  'Sleepy',
  'Giggly',
  'Fuzzy',
  'Sneaky',
  'Clumsy',
  'Zippy',
  'Soggy',
  'Jolly',
  'Wiggly',
  'Grumpy',
  'Sparkly',
  'Dizzy',
  'Tiny',
  'Mighty',
  'Sticky',
  'Crispy',
  'Fluffy',
  'Rowdy',
  'Puffy',
  'Snappy',
  'Breezy',
  'Cheeky',
  'Frosty',
  'Toasty',
  'Lumpy',
  'Peppy',
  'Rubbery',
  'Speedy',
  'Wonky',
  'Jumbo',
  'Plucky',
  'Zany',
  'Bubbly',
  'Chunky',
  'Twirly',
  'Gooey',
  'Salty',
  'Tumbly',
  'Floppy',
  'Nifty',
  'Spicy',
  'Dapper',
  'Jazzy',
  'Loopy',
  'Perky',
  'Rumbly',
  'Swirly',
] as const;

const NOUNS = [
  'Pancake',
  'Noodle',
  'Pickle',
  'Muffin',
  'Waffle',
  'Dumpling',
  'Pudding',
  'Biscuit',
  'Turnip',
  'Meatball',
  'Marshmallow',
  'Jellybean',
  'Gumdrop',
  'Cupcake',
  'Potato',
  'Taco',
  'Pretzel',
  'Sprout',
  'Nugget',
  'Bagel',
  'Penguin',
  'Walrus',
  'Hamster',
  'Platypus',
  'Goose',
  'Llama',
  'Narwhal',
  'Otter',
  'Badger',
  'Wombat',
  'Sock',
  'Teapot',
  'Spoon',
  'Kazoo',
  'Trombone',
  'Pillow',
  'Rocket',
  'Bubble',
  'Button',
  'Doodle',
  'Tumbler',
  'Wobbler',
  'Bumble',
  'Squeaker',
  'Flapjack',
  'Crumpet',
  'Coconut',
  'Mango',
  'Radish',
  'Yeti',
] as const;

const TITLES = [
  'Sir',
  'Lady',
  'Captain',
  'Doctor',
  'Professor',
  'Baron',
  'Duchess',
  'Chef',
  'Agent',
  'Mister',
] as const;

const VERBS = [
  'Bounce',
  'Wobble',
  'Tumble',
  'Flop',
  'Zoom',
  'Splat',
  'Boing',
  'Scoot',
  'Wiggle',
  'Plop',
] as const;

/**
 * Generates one bot display name.
 *
 * Formats, by probability: `AdjectiveNoun` (55%), `AdjectiveNoun` + number
 * (20%), `TitleVerb` + number (15%), `TitleNoun` (10%).
 *
 * @param rng - Seeded generator; the same seed yields the same name everywhere.
 * @returns A name of at most 20 characters.
 * @example
 * generateBotName(new Rng(7)); // e.g. "WobblyPancake"
 */
export function generateBotName(rng: Rng): string {
  const roll = rng.next();
  let name: string;
  if (roll < 0.55) name = rng.pick(ADJECTIVES) + rng.pick(NOUNS);
  else if (roll < 0.75) name = rng.pick(ADJECTIVES) + rng.pick(NOUNS) + rng.int(1, 99);
  else if (roll < 0.9) name = rng.pick(TITLES) + rng.pick(VERBS) + rng.int(1, 99);
  else name = rng.pick(TITLES) + rng.pick(NOUNS);
  return name.length > 20 ? name.slice(0, 20) : name;
}

/**
 * Generates `count` distinct bot names, avoiding any in `taken` (e.g. human names in the lobby).
 *
 * @param count - Names wanted.
 * @param rng - Seeded generator.
 * @param taken - Names already in use (compared case-insensitively).
 * @returns Unique names in generation order.
 */
export function generateBotNames(count: number, rng: Rng, taken: Iterable<string> = []): string[] {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  const out: string[] = [];
  let guard = 0;
  while (out.length < count) {
    let name = generateBotName(rng);
    // The space is ~60k names; after many collisions append digits rather than spin.
    if (++guard > count * 20) name = `${name.slice(0, 16)}${rng.int(100, 9999)}`;
    const key = name.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    out.push(name);
  }
  return out;
}
