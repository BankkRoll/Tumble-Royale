import { MAX_PLAYERS } from '@tumble/shared';
import type { PlayerWallSummary, TumblerLoadout } from '@tumble/render/scenes';
import { defaultLoadout } from '@tumble/render/scenes';

/**
 * Mock full-show (MAX_PLAYERS) for the lab's Player Wall recap: deterministic names,
 * colours and a 4-round elimination schedule (100 → 60 → 30 → 12 → 1, scaled to `count`).
 */

const FIRST = [
  'Sprinkle',
  'Gummy',
  'Bubble',
  'Wobble',
  'Jelly',
  'Taffy',
  'Fizz',
  'Noodle',
  'Puddin',
  'Biscuit',
  'Mochi',
  'Pickle',
  'Waffle',
  'Doodle',
];
const LAST = ['Bop', 'Pop', 'Zoom', 'Flop', 'Boing', 'Toot', 'Wiggle', 'Plonk', 'Splat', 'Twirl'];
const COLORS = [
  '#ff6fb5',
  '#5ce1e6',
  '#ffd23f',
  '#7c5cff',
  '#6ee7a8',
  '#ff8a3d',
  '#ff4f8b',
  '#3fa9ff',
  '#b98cff',
  '#7cf27c',
];

/** Builds a mock summary with `count` players over 4 rounds. */
export function createMockShow(count = MAX_PLAYERS): PlayerWallSummary {
  const players = Array.from({ length: count }, (_, i) => {
    const loadout: TumblerLoadout = defaultLoadout(
      COLORS[i % COLORS.length],
      COLORS[(i * 3 + 2) % COLORS.length],
    );
    return { id: `p${i}`, name: `${FIRST[i % FIRST.length]}${LAST[(i * 7) % LAST.length]}`, loadout };
  });
  // Deterministic shuffle so the eliminations scatter across the wall.
  const order = players.map((p) => p.id);
  let s = 1337;
  for (let i = order.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const keep = [60, 30, 12, 1].map((k) => Math.max(1, Math.round((k / 100) * count)));
  const names = ['Gumdrop Gauntlet', 'Tile Panic', 'Egg Heist', 'Crown Climb'];
  const rounds = keep.map((k, r) => {
    const before = r === 0 ? count : keep[r - 1]!;
    return { name: names[r]!, eliminatedIds: order.slice(k, before) };
  });
  return { players, rounds, winnerId: order[0]! };
}
