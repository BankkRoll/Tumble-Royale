import type { DecorSet, ThemeDefinition } from '@tumble/content/themes';
import { DecorRandom } from '../level/toolkit.ts';
import { keepOutHitsBox, type BoxLike, type KeepOut } from './dressing.ts';
import type { PropBuilder } from './propKit.ts';

/**
 * Floating background islands with per-theme set dressing (lollipops, ice
 * crystals, palms, gears, towers, planets…). Pure layout code on top of
 * {@link PropBuilder}; everything ends up in a handful of instanced draws.
 */

/** Exclusion box (world XZ) the islands must stay out of — the course itself. */
export interface IslandExclusion {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Options for {@link layoutIslands}. */
export interface IslandLayoutOptions {
  seed?: number;
  count?: number;
  /** Centre of the ring of islands. */
  center?: { x: number; y: number; z: number };
  /** Minimum distance from centre. */
  innerRadius?: number;
  /** Maximum distance from centre. */
  outerRadius?: number;
  exclude?: IslandExclusion;
  /** Volume no island (props and rock underside included) may touch. */
  keepOut?: KeepOut;
}

/** A placed island and its world bounds (props and rock cone included). */
export interface IslandSpec {
  x: number;
  y: number;
  z: number;
  radius: number;
  bounds: BoxLike;
}

/** Tallest prop above an island top (m): the biggest props are ~5.5 m at up to ~2.1× scale. */
const PROP_HEADROOM = 14;

/**
 * World bounds of an island built by {@link addIsland}.
 *
 * @returns Box around the cake top, its props and the rock cones beneath.
 */
export function islandBounds(x: number, y: number, z: number, radius: number): BoxLike {
  const th = Math.max(1.2, radius * 0.22);
  const r = radius * 1.03 + 1;
  return {
    min: { x: x - r, y: y - th / 2 - radius * 2.5, z: z - r },
    max: { x: x + r, y: y + th / 2 + PROP_HEADROOM, z: z + r },
  };
}

type Palette = readonly string[];

interface IslandStyle {
  ground: string;
  frosting: string;
  rock: string;
}

const STYLES: Record<DecorSet, IslandStyle> = {
  candy: { ground: '#9ff2c8', frosting: '#ffffff', rock: '#ffb3d9' },
  factory: { ground: '#d3dbea', frosting: '#ffb238', rock: '#8a96b8' },
  frosty: { ground: '#ffffff', frosting: '#cfeaff', rock: '#9cc6ee' },
  jungle: { ground: '#6fd67f', frosting: '#9ff09a', rock: '#b0805a' },
  sunset: { ground: '#ffd6a8', frosting: '#ffffff', rock: '#d58fb5' },
  space: { ground: '#8a7bff', frosting: '#c8bfff', rock: '#4a3f8f' },
  beach: { ground: '#ffe2a8', frosting: '#8ff0d8', rock: '#e8b27a' },
  neon: { ground: '#2d2a6b', frosting: '#00e5ff', rock: '#17143d' },
  castle: { ground: '#8fe08f', frosting: '#c8f5b8', rock: '#a7a0b8' },
  goo: { ground: '#c7a8ff', frosting: '#9ff58f', rock: '#7d63c4' },
};

type PropFn = (
  b: PropBuilder,
  x: number,
  y: number,
  z: number,
  s: number,
  rng: DecorRandom,
  pal: Palette,
) => void;

const lollipop: PropFn = (b, x, y, z, s, rng, pal) => {
  const h = 3.2 * s;
  b.add('cyl', x, y + h / 2, z, 0.12 * s, h, 0.12 * s, '#ffffff');
  const col = rng.pick(pal);
  const yaw = rng.range(0, Math.PI);
  b.add('cyl', x, y + h + 0.9 * s, z, 1.1 * s, 0.35 * s, 1.1 * s, col, [Math.PI / 2, yaw, 0]);
  b.add('torus', x, y + h + 0.9 * s, z, 0.62 * s, 0.62 * s, 0.9 * s, '#ffffff', [0, yaw, 0]);
};

const gumdrop: PropFn = (b, x, y, z, s, rng, pal) => {
  b.add('cone', x, y + 0.55 * s, z, 0.9 * s, 1.1 * s, 0.9 * s, rng.pick(pal));
};

const cupcake: PropFn = (b, x, y, z, s, rng, pal) => {
  b.add('cyl', x, y + 0.5 * s, z, 0.8 * s, 1 * s, 0.8 * s, '#ffd9a8');
  b.add('sphere', x, y + 1.15 * s, z, 0.95 * s, 0.6 * s, 0.95 * s, rng.pick(pal));
  b.add('sphere', x, y + 1.8 * s, z, 0.22 * s, 0.22 * s, 0.22 * s, '#ff3d6e');
};

const pine: PropFn = (b, x, y, z, s, _rng, pal) => {
  b.add('cyl', x, y + 0.4 * s, z, 0.18 * s, 0.8 * s, 0.18 * s, '#9a6a4a');
  b.add('cone', x, y + 1.3 * s, z, 1.1 * s, 1.5 * s, 1.1 * s, pal[0] ?? '#5fbf8a');
  b.add('cone', x, y + 2.2 * s, z, 0.8 * s, 1.2 * s, 0.8 * s, '#ffffff');
};

const crystal: PropFn = (b, x, y, z, s, rng, pal) => {
  const col = rng.pick(pal);
  for (let i = 0; i < 3; i++) {
    const h = rng.range(1.6, 3.4) * s;
    b.add(
      'hex',
      x + rng.range(-0.5, 0.5) * s,
      y + h * 0.4,
      z + rng.range(-0.5, 0.5) * s,
      0.35 * s,
      h,
      0.35 * s,
      col,
      [rng.range(-0.4, 0.4), rng.range(0, 3), rng.range(-0.4, 0.4)],
      0.25,
    );
  }
};

const snowman: PropFn = (b, x, y, z, s) => {
  b.add('sphere', x, y + 0.7 * s, z, 0.75 * s, 0.7 * s, 0.75 * s, '#ffffff');
  b.add('sphere', x, y + 1.65 * s, z, 0.5 * s, 0.5 * s, 0.5 * s, '#ffffff');
  b.add('cone', x, y + 1.65 * s, z + 0.55 * s, 0.1 * s, 0.4 * s, 0.1 * s, '#ff8a3d', [Math.PI / 2, 0, 0]);
};

const palm: PropFn = (b, x, y, z, s, rng) => {
  const lean = rng.range(-0.25, 0.25);
  const h = 3.6 * s;
  b.add('cyl', x, y + h / 2, z, 0.2 * s, h, 0.2 * s, '#b5875c', [0, 0, lean]);
  const tx = x - Math.sin(lean) * h;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add(
      'sphere',
      tx + Math.cos(a) * 0.9 * s,
      y + h + 0.1 * s,
      z + Math.sin(a) * 0.9 * s,
      1.1 * s,
      0.25 * s,
      0.5 * s,
      '#4fc06a',
      [0, -a, -0.3],
    );
  }
  b.add('sphere', tx, y + h, z, 0.3 * s, 0.3 * s, 0.3 * s, '#8a5a3a');
};

const mushroom: PropFn = (b, x, y, z, s, rng, pal) => {
  const h = rng.range(1, 2.2) * s;
  b.add('cyl', x, y + h / 2, z, 0.3 * s, h, 0.3 * s, '#fff3e0');
  const cap = rng.pick(pal);
  b.add('sphere', x, y + h, z, 1.1 * s, 0.6 * s, 1.1 * s, cap);
  for (let i = 0; i < 3; i++) {
    const a = rng.range(0, Math.PI * 2);
    b.add(
      'sphere',
      x + Math.cos(a) * 0.6 * s,
      y + h + 0.42 * s,
      z + Math.sin(a) * 0.6 * s,
      0.16 * s,
      0.1 * s,
      0.16 * s,
      '#ffffff',
    );
  }
};

const bush: PropFn = (b, x, y, z, s) => {
  b.add('sphere', x, y + 0.5 * s, z, 0.9 * s, 0.75 * s, 0.9 * s, '#58c86f');
  b.add('sphere', x + 0.7 * s, y + 0.4 * s, z + 0.2 * s, 0.6 * s, 0.5 * s, 0.6 * s, '#6fdc82');
};

const gear: PropFn = (b, x, y, z, s, rng, pal) => {
  const col = rng.pick(pal);
  const yaw = rng.range(0, Math.PI);
  b.add('torus', x, y + 1.6 * s, z, 1.2 * s, 1.2 * s, 1.6 * s, col, [0, yaw, 0]);
  b.add('cyl', x, y + 1.6 * s, z, 0.45 * s, 0.6 * s, 0.45 * s, '#e9edf5', [Math.PI / 2, yaw, 0]);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const dx = Math.cos(a) * 1.55 * s;
    const dy = Math.sin(a) * 1.55 * s;
    b.add(
      'box',
      x + dx * Math.cos(yaw),
      y + 1.6 * s + dy,
      z - dx * Math.sin(yaw),
      0.4 * s,
      0.4 * s,
      0.4 * s,
      col,
      [0, yaw, a],
    );
  }
};

const blocks: PropFn = (b, x, y, z, s, rng, pal) => {
  let h = 0;
  for (let i = 0; i < rng.int(2, 4); i++) {
    const sz = rng.range(0.7, 1.1) * s;
    b.add(
      'box',
      x + rng.range(-0.2, 0.2) * s,
      y + h + sz / 2,
      z + rng.range(-0.2, 0.2) * s,
      sz,
      sz,
      sz,
      rng.pick(pal),
      [0, rng.range(0, 1), 0],
    );
    h += sz;
  }
};

const iceCream: PropFn = (b, x, y, z, s, rng, pal) => {
  b.add('cone', x, y + 0.9 * s, z, 0.55 * s, 1.8 * s, 0.55 * s, '#e8b27a', [Math.PI, 0, 0]);
  b.add('sphere', x, y + 1.95 * s, z, 0.62 * s, 0.55 * s, 0.62 * s, rng.pick(pal));
  b.add('sphere', x, y + 2.5 * s, z, 0.5 * s, 0.45 * s, 0.5 * s, rng.pick(pal));
  b.add('sphere', x, y + 2.95 * s, z, 0.14 * s, 0.14 * s, 0.14 * s, '#ff3d6e');
};

const planet: PropFn = (b, x, y, z, s, rng, pal) => {
  const r = rng.range(1, 1.8) * s;
  const py = y + 3.2 * s + r;
  b.add('sphere', x, py, z, r, r, r, rng.pick(pal), undefined, 0.15);
  b.add(
    'torus',
    x,
    py,
    z,
    r * 1.5,
    r * 1.5,
    r * 0.3,
    '#ffffff',
    [Math.PI / 2 + rng.range(-0.4, 0.4), 0, rng.range(-0.4, 0.4)],
    0.2,
  );
};

const umbrella: PropFn = (b, x, y, z, s, rng, pal) => {
  const tilt = rng.range(-0.2, 0.2);
  b.add('cyl', x, y + 1.3 * s, z, 0.07 * s, 2.6 * s, 0.07 * s, '#ffffff', [tilt, 0, 0]);
  b.add('cone', x, y + 2.7 * s, z + Math.sin(tilt) * 1.3 * s, 1.5 * s, 0.6 * s, 1.5 * s, rng.pick(pal), [
    tilt,
    0,
    0,
  ]);
};

const beachBall: PropFn = (b, x, y, z, s, rng, pal) => {
  b.add('sphere', x, y + 0.5 * s, z, 0.5 * s, 0.5 * s, 0.5 * s, rng.pick(pal));
};

const neonPillar: PropFn = (b, x, y, z, s, rng, pal) => {
  const h = rng.range(2.5, 5.5) * s;
  b.add('box', x, y + h / 2, z, 0.6 * s, h, 0.6 * s, '#1d1a4a');
  const col = rng.pick(pal);
  b.add('box', x, y + h * 0.7, z, 0.66 * s, 0.18 * s, 0.66 * s, col, undefined, 1);
  b.add('box', x, y + h * 0.4, z, 0.66 * s, 0.18 * s, 0.66 * s, col, undefined, 1);
  b.add('torus', x, y + h + 0.6 * s, z, 0.6 * s, 0.6 * s, 0.6 * s, rng.pick(pal), [0, rng.range(0, 3), 0], 1);
};

const tower: PropFn = (b, x, y, z, s, rng, pal) => {
  const h = rng.range(3, 5) * s;
  b.add('cyl', x, y + h / 2, z, 0.9 * s, h, 0.9 * s, '#f3eee6');
  b.add('cyl', x, y + h + 0.2 * s, z, 1.05 * s, 0.4 * s, 1.05 * s, '#e0d8cc');
  b.add('cone', x, y + h + 1.2 * s, z, 1.1 * s, 1.8 * s, 1.1 * s, rng.pick(pal));
  b.add('box', x + 0.35 * s, y + h + 2.4 * s, z, 0.7 * s, 0.4 * s, 0.05 * s, rng.pick(pal));
  b.add('box', x, y + h * 0.65, z + 0.86 * s, 0.35 * s, 0.6 * s, 0.1 * s, '#ffd36e', undefined, 0.8);
};

const slimeBlob: PropFn = (b, x, y, z, s, rng) => {
  const col = rng.pick(['#7cf27c', '#ff7ab8', '#45f0e0']);
  b.add('sphere', x, y + 0.35 * s, z, 1.0 * s, 0.45 * s, 1.0 * s, col, undefined, 0.2);
  b.add('sphere', x + 0.6 * s, y + 0.25 * s, z + 0.4 * s, 0.45 * s, 0.3 * s, 0.45 * s, col, undefined, 0.2);
};

const SET_PROPS: Record<DecorSet, PropFn[]> = {
  candy: [lollipop, lollipop, gumdrop, cupcake, gumdrop],
  factory: [gear, blocks, blocks, gumdrop],
  frosty: [pine, pine, crystal, snowman],
  jungle: [palm, mushroom, bush, bush, palm],
  sunset: [iceCream, palm, lollipop, gumdrop],
  space: [planet, crystal, crystal, mushroom],
  beach: [palm, umbrella, beachBall, palm],
  neon: [neonPillar, neonPillar, crystal],
  castle: [tower, tower, pine, bush],
  goo: [mushroom, slimeBlob, slimeBlob, mushroom],
};

/**
 * Adds one floating island (cake-like top, frosting rim, rocky cone underside)
 * plus themed props to the builder.
 *
 * @param b - Builder.
 * @param set - Decor set.
 * @param pal - Prop colours.
 * @returns The island's top surface height (world).
 */
export function addIsland(
  b: PropBuilder,
  set: DecorSet,
  pal: Palette,
  x: number,
  y: number,
  z: number,
  radius: number,
  rng: DecorRandom,
): number {
  const st = STYLES[set];
  const th = Math.max(1.2, radius * 0.22);
  b.add('cyl', x, y, z, radius, th, radius, st.ground);
  b.add('cyl', x, y - th * 0.45, z, radius * 1.03, th * 0.35, radius * 1.03, st.frosting);
  b.add('cone', x, y - th / 2 - radius * 0.75, z, radius * 0.97, radius * 1.5, radius * 0.97, st.rock, [
    Math.PI,
    0,
    0,
  ]);
  // A smaller rock chunk under the main cone breaks the perfect symmetry.
  b.add(
    'cone',
    x + radius * 0.3,
    y - th / 2 - radius * 1.6,
    z - radius * 0.2,
    radius * 0.4,
    radius * 0.9,
    radius * 0.4,
    st.rock,
    [Math.PI, 0, 0.1],
  );

  const top = y + th / 2;
  const props = SET_PROPS[set];
  const n = Math.max(1, Math.round(radius * 0.35 + rng.range(0, 2)));
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(0, radius * 0.7);
    const s = rng.range(0.7, 1.3) * Math.min(1.6, 0.5 + radius * 0.08);
    rng.pick(props)(b, x + Math.cos(a) * r, top, z + Math.sin(a) * r, s, rng, pal);
  }
  return top;
}

/**
 * Lays out a ring of themed floating islands around a course.
 *
 * @param b - Builder the islands are appended to.
 * @param theme - Theme (decor set + colours).
 * @param opts - Layout options.
 */
export function layoutIslands(
  b: PropBuilder,
  theme: ThemeDefinition,
  opts: IslandLayoutOptions = {},
): IslandSpec[] {
  const rng = new DecorRandom(opts.seed ?? 11);
  const count = opts.count ?? 14;
  const c = opts.center ?? { x: 0, y: 0, z: 0 };
  const inner = opts.innerRadius ?? 90;
  const outer = opts.outerRadius ?? 260;
  const ex = opts.exclude;
  const margin = 26;
  const placed: IslandSpec[] = [];
  let attempts = 0;
  while (placed.length < count && attempts < count * 20) {
    attempts++;
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(inner, outer);
    const x = c.x + Math.cos(a) * d;
    const z = c.z + Math.sin(a) * d;
    if (ex && x > ex.minX - margin && x < ex.maxX + margin && z > ex.minZ - margin && z < ex.maxZ + margin)
      continue;
    const radius = rng.range(6, 18) * (0.7 + (d / outer) * 0.6);
    const y = c.y + rng.range(-30, 22);
    const bounds = islandBounds(x, y, z, radius);
    const bob = 1.6;
    bounds.min.y -= bob;
    bounds.max.y += bob;
    if (opts.keepOut && keepOutHitsBox(opts.keepOut, bounds)) continue;
    b.group(rng.range(0, Math.PI * 2), rng.range(0.6, bob));
    addIsland(b, theme.decor.set, theme.decor.colors, x, y, z, radius, rng);
    placed.push({ x, y, z, radius, bounds });
  }
  b.group(0, 0);
  return placed;
}
