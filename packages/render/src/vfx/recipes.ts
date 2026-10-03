import { Color, Vector3 } from 'three/webgpu';
import type { VfxKind, VfxSpawnOptions, VfxVec3 } from './types.ts';
import { BalloonSpec, balloonEndPosition, type BalloonPool } from './balloons.ts';
import { ConfettiShape, ConfettiSpec, type ConfettiPool } from './confetti.ts';
import { DecalKind, DecalSpec, type DecalPool } from './decals.ts';
import { analyticOffsetCpu, apexTime } from './motion.ts';
import {
  BALLOON_COLORS,
  COLORS,
  CONFETTI_COLORS,
  FIREWORK_COLORS,
  GOLD_COLORS,
  MINT_COLORS,
  TEAM_PALETTE,
  hexColor,
} from './palette.ts';
import { GlowShape, ParticleSpec, PuffShape, type ParticlePool } from './particles.ts';
import type { StunStars } from './stunStars.ts';

/**
 * Effect recipes: how each {@link VfxKind} is composed from the pools.
 *
 * Responsibilities:
 * - Resolve `VfxSpawnOptions` once per spawn into a scratch record.
 * - Schedule every phase of an effect at spawn time using GPU-side delays
 *   (rocket → burst, balloon → pop, implode → explode), so nothing needs timers.
 * - Scale particle counts by quality tier × `intensity`, sizes by `scale`.
 *
 * Nothing here allocates per spawn: specs, colours and vectors are module scratch.
 */

/** Everything a recipe can draw into. */
export interface RecipeTargets {
  glow: ParticlePool;
  puffs: ParticlePool;
  confetti: ConfettiPool;
  balloons: BalloonPool;
  decals: DecalPool;
  stars: StunStars;
  /** Current effect time (seconds). */
  now: number;
  /** Quality-tier particle multiplier (≈ 0.3 … 1.5). */
  density: number;
}

/** Last crack decal written by {@link spawnRecipe}, for early removal when the tile falls. */
export const lastCrack = { slot: -1, spawnTime: 0 };

const TAU = Math.PI * 2;

const P = new ParticleSpec();
const C = new ConfettiSpec();
const B = new BalloonSpec();
const D = new DecalSpec();
const tmpColor = new Color();
const tmpColor2 = new Color();
const dir = new Vector3();
const axisU = new Vector3();
const axisV = new Vector3();
const rnd = new Vector3();
const end = { x: 0, y: 0, z: 0 };

/** Resolved spawn options (module scratch). */
const O = {
  scale: 1,
  intensity: 1,
  delay: 0,
  color: null as Color | null,
  palette: [] as Color[],
  hasDirection: false,
  team: -1,
  playerId: -1,
  duration: -1,
};

function resolve(opts: VfxSpawnOptions | undefined): void {
  O.scale = opts?.scale ?? 1;
  O.intensity = opts?.intensity ?? 1;
  O.delay = Math.max(0, opts?.delay ?? 0);
  O.color = opts?.color ? hexColor(opts.color) : null;
  O.palette.length = 0;
  if (opts?.colors) for (const hex of opts.colors) O.palette.push(hexColor(hex));
  const d = opts?.direction;
  O.hasDirection = !!d && d.x * d.x + d.y * d.y + d.z * d.z > 1e-8;
  if (d && O.hasDirection) dir.set(d.x, d.y, d.z).normalize();
  else dir.set(0, 0, 1);
  O.team = opts?.team ?? -1;
  O.playerId = opts?.playerId ?? -1;
  O.duration = opts?.duration ?? -1;
}

const rand = (a: number, b: number): number => a + (b - a) * Math.random();

function pick(list: readonly Color[], fallback: Color): Color {
  return list[(Math.random() * list.length) | 0] ?? fallback;
}

const singleColor: Color[] = [];
const shortList: Color[] = [];

function palette(fallback: readonly Color[]): readonly Color[] {
  if (O.palette.length > 0) return O.palette;
  if (!O.color) return fallback;
  singleColor.length = 0;
  singleColor.push(O.color);
  return singleColor;
}

/** Up to three colours as a reused list (valid until the next call). */
function listOf(a: Color, b?: Color, c?: Color): readonly Color[] {
  shortList.length = 0;
  shortList.push(a);
  if (b) shortList.push(b);
  if (c) shortList.push(c);
  return shortList;
}

/** Count after tier density and intensity, at least `min`. */
function n(base: number, density: number, min = 1): number {
  return Math.max(min, Math.round(base * density * O.intensity));
}

/** Random unit vector, uniform on the sphere, into `rnd`. */
function randomUnit(): Vector3 {
  const z = rand(-1, 1);
  const a = Math.random() * TAU;
  const r = Math.sqrt(1 - z * z);
  return rnd.set(Math.cos(a) * r, z, Math.sin(a) * r);
}

/** Random unit vector within `spread` radians of +Y, into `rnd`. */
function randomCone(spread: number): Vector3 {
  const cosMax = Math.cos(spread);
  const y = rand(cosMax, 1);
  const a = Math.random() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return rnd.set(Math.cos(a) * r, y, Math.sin(a) * r);
}

/** Two unit vectors perpendicular to `dir`, into `axisU`/`axisV`. */
function basisAround(): void {
  if (Math.abs(dir.y) < 0.9) axisU.set(0, 1, 0);
  else axisU.set(1, 0, 0);
  axisV.crossVectors(dir, axisU).normalize();
  axisU.crossVectors(axisV, dir).normalize();
}

function at(pos: VfxVec3, s: ParticleSpec | ConfettiSpec | BalloonSpec): void {
  s.x = pos.x;
  s.y = pos.y;
  s.z = pos.z;
}

function flash(
  t: RecipeTargets,
  x: number,
  y: number,
  z: number,
  size: number,
  delay: number,
  c: Color,
  life = 0.2,
): void {
  P.reset();
  P.x = x;
  P.y = y;
  P.z = z;
  P.shape = GlowShape.flash;
  P.size0 = size * 0.6;
  P.size1 = size;
  P.life = life;
  P.delay = delay;
  P.color(c, 1.1);
  t.glow.emit(P, t.now);
}

function glowRing(
  t: RecipeTargets,
  x: number,
  y: number,
  z: number,
  size: number,
  delay: number,
  c: Color,
  life = 0.35,
): void {
  P.reset();
  P.x = x;
  P.y = y;
  P.z = z;
  P.shape = GlowShape.ring;
  P.size0 = size * 0.15;
  P.size1 = size;
  P.life = life;
  P.delay = delay;
  P.color(c, 1);
  t.glow.emit(P, t.now);
}

/** Radial sparkle burst around a point. */
function sparkBurst(
  t: RecipeTargets,
  x: number,
  y: number,
  z: number,
  count: number,
  speed: number,
  delay: number,
  colors: readonly Color[],
  size: number,
  upBias = 0.5,
): void {
  for (let i = 0; i < count; i++) {
    randomUnit();
    rnd.y = rnd.y * 0.7 + upBias;
    rnd.normalize();
    const s = speed * rand(0.55, 1);
    P.reset();
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = rnd.x * s;
    P.vy = rnd.y * s;
    P.vz = rnd.z * s;
    P.drag = 3;
    P.gravity = 2.5;
    P.life = rand(0.45, 0.8);
    P.delay = delay + rand(0, 0.04);
    P.size0 = size * rand(0.8, 1.3);
    P.size1 = size * 0.25;
    P.shape = Math.random() < 0.6 ? GlowShape.star : GlowShape.dot;
    P.spin = rand(-4, 4);
    P.twinkle = 0.55;
    P.color(pick(colors, COLORS.white), 1.15);
    t.glow.emit(P, t.now);
  }
}

// -----------------------------------------------------------------------------
// Recipes
// -----------------------------------------------------------------------------

function confetti(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const colors = palette(CONFETTI_COLORS);
  const count = n(90, t.density, 8);
  for (let i = 0; i < count; i++) {
    randomCone(0.75);
    const speed = rand(5.5, 10) * Math.sqrt(k);
    at(pos, C);
    C.vx = rnd.x * speed;
    C.vy = rnd.y * speed;
    C.vz = rnd.z * speed;
    C.drag = rand(1.9, 2.8);
    C.gravity = 9;
    C.life = rand(2.6, 3.8);
    C.delay = O.delay + rand(0, 0.08);
    const roll = Math.random();
    C.shape = roll < 0.7 ? ConfettiShape.rect : roll < 0.88 ? ConfettiShape.disc : ConfettiShape.streamer;
    C.size = rand(0.07, 0.11) * k * (C.shape === ConfettiShape.streamer ? 2.4 : 1);
    C.aspect =
      C.shape === ConfettiShape.streamer ? 0.16 : C.shape === ConfettiShape.disc ? 1 : rand(0.5, 0.75);
    C.spin = rand(6, 14);
    C.flutter = rand(0.12, 0.32) * k;
    C.flutterFreq = rand(4, 7);
    C.color(pick(colors, COLORS.white));
    t.confetti.emit(C, t.now);
  }
  sparkBurst(t, pos.x, pos.y, pos.z, n(10, t.density, 3), 4 * k, O.delay, GOLD_COLORS, 0.25 * k, 0.8);
  flash(t, pos.x, pos.y, pos.z, 1.4 * k, O.delay, COLORS.white);
}

function dust(t: RecipeTargets, pos: VfxVec3, big: boolean): void {
  const k = O.scale;
  const base = O.color ?? COLORS.dust;
  const count = n(big ? 14 : 6, t.density, 3);
  const back = O.hasDirection ? 0.9 : 0;
  for (let i = 0; i < count; i++) {
    const a = big ? (i / count) * TAU + rand(-0.2, 0.2) : Math.random() * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const speed = (big ? rand(2.4, 3.6) : rand(0.6, 1.4)) * k;
    const size = (big ? rand(0.26, 0.34) : rand(0.16, 0.22)) * k;
    P.reset();
    P.x = pos.x + ca * 0.18 * k;
    P.y = pos.y + size * 0.45;
    P.z = pos.z + sa * 0.18 * k;
    P.vx = ca * speed - dir.x * back;
    P.vy = big ? rand(0.3, 0.8) : rand(0.35, 0.7);
    P.vz = sa * speed - dir.z * back;
    P.drag = big ? 5 : 4;
    P.gravity = -0.35;
    P.life = big ? rand(0.6, 0.85) : rand(0.42, 0.65);
    P.delay = O.delay + rand(0, 0.04);
    P.size0 = size;
    P.size1 = size * (big ? 1.9 : 1.7);
    P.shape = PuffShape.cloud;
    tmpColor.copy(base).lerp(COLORS.cream, rand(0, 0.5));
    P.color(tmpColor);
    t.puffs.emit(P, t.now);
  }
  if (big) {
    D.x = pos.x;
    D.y = pos.y;
    D.z = pos.z;
    D.delay = O.delay;
    D.life = 0.45;
    D.size0 = 0.3 * k;
    D.size1 = 1.7 * k;
    D.kind = DecalKind.shock;
    D.alpha = 0.6;
    D.thickness = 0.2;
    D.color(COLORS.cream);
    t.decals.emit(D, t.now);
  }
}

function speedLines(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  basisAround();
  const count = n(10, t.density, 4);
  const c = O.color ?? COLORS.white;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const r = rand(0.25, 0.6) * k;
    const back = rand(0.2, 0.9) * k;
    const speed = rand(3.5, 5.5);
    P.reset();
    P.x = pos.x + (axisU.x * Math.cos(a) + axisV.x * Math.sin(a)) * r - dir.x * back;
    P.y = pos.y + (axisU.y * Math.cos(a) + axisV.y * Math.sin(a)) * r - dir.y * back;
    P.z = pos.z + (axisU.z * Math.cos(a) + axisV.z * Math.sin(a)) * r - dir.z * back;
    P.vx = -dir.x * speed;
    P.vy = -dir.y * speed;
    P.vz = -dir.z * speed;
    P.drag = 3;
    P.life = rand(0.22, 0.38);
    P.delay = O.delay + rand(0, 0.12);
    P.size0 = 0.06 * k;
    P.size1 = 0.03 * k;
    P.stretch = 0.16 * k;
    P.shape = GlowShape.streak;
    P.alpha = 0.85;
    P.color(c, 1);
    t.glow.emit(P, t.now);
  }
}

function stunStars(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const duration = O.duration > 0 ? O.duration : 1.2;
  t.stars.add(pos.x, pos.y, pos.z, O.playerId, duration, k, t.now, O.delay);
  sparkBurst(
    t,
    pos.x,
    pos.y + 0.9 * k,
    pos.z,
    n(6, t.density, 2),
    2.5 * k,
    O.delay,
    GOLD_COLORS,
    0.2 * k,
    0.3,
  );
}

function slimeSplash(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const base = O.color ?? COLORS.slime;
  const g = 14;
  const count = n(26, t.density, 6);
  const bias = O.hasDirection ? 1.2 : 0;
  let splats = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const out = rand(1.2, 3.6) * k;
    const vy = rand(4, 8.5) * Math.sqrt(k);
    const size = rand(0.12, 0.24) * k;
    const life = Math.min(1.3, Math.max(0.35, (2 * vy) / g));
    P.reset();
    P.x = pos.x;
    P.y = pos.y + 0.05;
    P.z = pos.z;
    P.vx = Math.cos(a) * out + dir.x * bias;
    P.vy = vy;
    P.vz = Math.sin(a) * out + dir.z * bias;
    P.gravity = g;
    P.life = life;
    P.delay = O.delay + rand(0, 0.05);
    P.size0 = size;
    P.size1 = size * 0.7;
    P.shape = PuffShape.droplet;
    tmpColor.copy(base).lerp(COLORS.white, rand(0, 0.25));
    P.color(tmpColor);
    t.puffs.emit(P, t.now);
    if (splats < 5 && Math.random() < 0.35) {
      splats++;
      analyticOffsetCpu(P.vx, P.vy, P.vz, 0, g, life, end);
      D.x = pos.x + end.x;
      D.y = pos.y;
      D.z = pos.z + end.z;
      D.delay = P.delay + life;
      D.life = 1.1;
      D.size0 = 0.08 * k;
      D.size1 = rand(0.2, 0.32) * k;
      D.kind = DecalKind.splat;
      D.alpha = 0.95;
      D.color(base);
      t.decals.emit(D, t.now);
    }
  }
  D.x = pos.x;
  D.y = pos.y;
  D.z = pos.z;
  D.delay = O.delay;
  D.life = 1.8;
  D.size0 = 0.3 * k;
  D.size1 = 1.3 * k;
  D.kind = DecalKind.splat;
  D.alpha = 1;
  D.color(base);
  t.decals.emit(D, t.now);
  D.life = 0.55;
  D.size0 = 0.4 * k;
  D.size1 = 2.2 * k;
  D.kind = DecalKind.ring;
  D.thickness = 0.14;
  D.alpha = 0.8;
  tmpColor.copy(base).lerp(COLORS.white, 0.45);
  D.color(tmpColor);
  t.decals.emit(D, t.now);
}

function fireworks(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const colors = palette(FIREWORK_COLORS);
  const rockets = Math.max(1, Math.min(6, Math.round(rand(3, 5.99) * Math.min(1.2, O.intensity))));
  const g = 9.8;
  for (let r = 0; r < rockets; r++) {
    const delay = O.delay + r * 0.32 + rand(0, 0.15);
    const ox = rand(-2.5, 2.5) * k;
    const oz = rand(-2.5, 2.5) * k;
    const vy = rand(11, 14) * Math.sqrt(k);
    const vx = rand(-1, 1);
    const vz = rand(-1, 1);
    const tApex = apexTime(vy, g);
    analyticOffsetCpu(vx, vy, vz, 0, g, tApex, end);
    const bx = pos.x + ox + end.x;
    const by = pos.y + end.y;
    const bz = pos.z + oz + end.z;

    P.reset();
    P.x = pos.x + ox;
    P.y = pos.y;
    P.z = pos.z + oz;
    P.vx = vx;
    P.vy = vy;
    P.vz = vz;
    P.gravity = g;
    P.life = tApex;
    P.delay = delay;
    P.size0 = P.size1 = 0.14 * k;
    P.stretch = 0.035;
    P.shape = GlowShape.streak;
    P.color(COLORS.cream, 1.2);
    t.glow.emit(P, t.now);

    const trailSparks = n(8, t.density, 3);
    for (let i = 0; i < trailSparks; i++) {
      const st = (i / trailSparks) * tApex * 0.95;
      analyticOffsetCpu(vx, vy, vz, 0, g, st, end);
      P.reset();
      P.x = pos.x + ox + end.x;
      P.y = pos.y + end.y;
      P.z = pos.z + oz + end.z;
      P.vx = rand(-0.4, 0.4);
      P.vy = rand(-1.2, -0.2);
      P.vz = rand(-0.4, 0.4);
      P.gravity = 2;
      P.life = rand(0.35, 0.6);
      P.delay = delay + st;
      P.size0 = 0.16 * k;
      P.size1 = 0.03;
      P.twinkle = 0.8;
      P.color(COLORS.gold, 1.2);
      t.glow.emit(P, t.now);
    }

    const primary = pick(colors, COLORS.gold);
    const secondary = pick(colors, COLORS.white);
    const burstDelay = delay + tApex;
    const sparks = n(60, t.density, 12);
    const speed = rand(6.5, 8.5) * k;
    for (let i = 0; i < sparks; i++) {
      randomUnit();
      const s = speed * rand(0.85, 1);
      P.reset();
      P.x = bx;
      P.y = by;
      P.z = bz;
      P.vx = rnd.x * s;
      P.vy = rnd.y * s;
      P.vz = rnd.z * s;
      P.drag = 1.5;
      P.gravity = 3.2;
      P.life = rand(1.1, 1.6);
      P.delay = burstDelay;
      P.size0 = 0.34 * k;
      P.size1 = 0.08 * k;
      P.twinkle = 0.65;
      if (Math.random() < 0.4) {
        P.shape = GlowShape.streak;
        P.stretch = 0.06;
      } else {
        P.shape = GlowShape.dot;
      }
      P.color(Math.random() < 0.75 ? primary : secondary, 1.25);
      t.glow.emit(P, t.now);
    }
    flash(t, bx, by, bz, 1.8 * k, burstDelay, primary, 0.2);
    glowRing(t, bx, by, bz, 3.6 * k, burstDelay, secondary, 0.3);
  }
}

function qualifySparkle(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const count = n(50, t.density, 10);
  const colors = O.palette.length > 0 ? O.palette : null;
  for (let i = 0; i < count; i++) {
    P.reset();
    P.x = pos.x;
    P.y = pos.y + rand(0, 0.3);
    P.z = pos.z;
    P.vy = rand(2.2, 4.2) * k;
    P.drag = 0.6;
    P.gravity = -0.8;
    P.orbitRadius = rand(0.45, 0.85) * k;
    P.orbitSpeed = rand(3.5, 5.5) * (i % 2 === 0 ? 1 : -1);
    P.life = rand(1.1, 1.7);
    P.delay = O.delay + (i / count) * 0.6;
    P.size0 = rand(0.26, 0.4) * k;
    P.size1 = 0.06;
    P.shape = Math.random() < 0.7 ? GlowShape.star : GlowShape.dot;
    P.spin = rand(-3, 3);
    P.twinkle = 0.5;
    const c = colors
      ? pick(colors, COLORS.gold)
      : (O.color ?? (i % 3 === 0 ? pick(MINT_COLORS, COLORS.mint) : pick(GOLD_COLORS, COLORS.gold)));
    P.color(c, 1.2);
    t.glow.emit(P, t.now);
  }
  D.x = pos.x;
  D.y = pos.y;
  D.z = pos.z;
  D.delay = O.delay;
  D.life = 0.7;
  D.size0 = 0.3 * k;
  D.size1 = 1.8 * k;
  D.kind = DecalKind.ring;
  D.thickness = 0.12;
  D.alpha = 0.9;
  D.color(O.color ?? COLORS.gold);
  t.decals.emit(D, t.now);
  D.delay = O.delay + 0.15;
  D.size1 = 1.2 * k;
  D.color(COLORS.mint);
  t.decals.emit(D, t.now);
  flash(t, pos.x, pos.y + 0.8 * k, pos.z, 2.2 * k, O.delay, O.color ?? COLORS.gold, 0.3);
}

function eliminationPoof(t: RecipeTargets, pos: VfxVec3, withBalloons: boolean): void {
  const k = O.scale;
  const cloud = O.color ?? COLORS.cloud;
  const big = n(14, t.density, 6);
  for (let i = 0; i < big; i++) {
    randomUnit();
    const s = rand(1.8, 3.6) * k;
    P.reset();
    P.x = pos.x + rnd.x * 0.35 * k;
    P.y = pos.y + rnd.y * 0.35 * k;
    P.z = pos.z + rnd.z * 0.35 * k;
    P.vx = rnd.x * s;
    P.vy = rnd.y * s * 0.7 + 0.5;
    P.vz = rnd.z * s;
    P.drag = 4.5;
    P.gravity = -0.5;
    P.life = rand(0.7, 1.05);
    P.delay = O.delay + rand(0, 0.05);
    P.size0 = rand(0.45, 0.6) * k;
    P.size1 = rand(0.8, 1.05) * k;
    P.shape = PuffShape.cloud;
    tmpColor.copy(cloud).lerp(COLORS.cream, rand(0, 0.15));
    P.color(tmpColor);
    t.puffs.emit(P, t.now);
  }
  const ring = n(10, t.density, 4);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * TAU;
    P.reset();
    P.x = pos.x;
    P.y = pos.y - 0.2 * k;
    P.z = pos.z;
    P.vx = Math.cos(a) * 4.5 * k;
    P.vy = rand(0, 0.6);
    P.vz = Math.sin(a) * 4.5 * k;
    P.drag = 6;
    P.life = rand(0.5, 0.7);
    P.delay = O.delay;
    P.size0 = 0.25 * k;
    P.size1 = 0.45 * k;
    P.shape = PuffShape.cloud;
    P.color(cloud);
    t.puffs.emit(P, t.now);
  }
  flash(t, pos.x, pos.y, pos.z, 2.6 * k, O.delay, COLORS.white, 0.22);
  sparkBurst(t, pos.x, pos.y, pos.z, n(12, t.density, 4), 5 * k, O.delay, GOLD_COLORS, 0.28 * k, 0.4);
  if (!withBalloons) return;

  const colors = palette(BALLOON_COLORS);
  const balloons = Math.max(1, Math.min(6, Math.round(rand(3, 5.99) * Math.min(1.2, O.intensity))));
  for (let i = 0; i < balloons; i++) {
    const a = (i / balloons) * TAU + rand(-0.3, 0.3);
    const c = colors[i % colors.length] ?? COLORS.danger;
    at(pos, B);
    B.y = pos.y + 0.3 * k;
    B.vx = Math.cos(a) * rand(0.6, 1.2) * k;
    B.vy = rand(1.2, 1.9) * k;
    B.vz = Math.sin(a) * rand(0.6, 1.2) * k;
    B.drag = 1.2;
    B.gravity = -3.4 * k;
    B.life = rand(1.5, 2.3);
    B.delay = O.delay + 0.08 + i * 0.06;
    B.size = rand(0.3, 0.38) * k;
    B.swayAmp = rand(0.15, 0.28) * k;
    B.swayFreq = rand(2.6, 3.8);
    B.color(c);
    t.balloons.emit(B, t.now);
    balloonEndPosition(B, end);
    const popAt = B.delay + B.life;
    flash(t, end.x, end.y, end.z, 1.1 * k, popAt, COLORS.white, 0.16);
    tmpColor2.copy(c).lerp(COLORS.white, 0.35);
    sparkBurst(t, end.x, end.y, end.z, n(9, t.density, 3), 3.5 * k, popAt, GOLD_COLORS, 0.2 * k, 0.2);
    const bits = n(6, t.density, 2);
    for (let j = 0; j < bits; j++) {
      randomUnit();
      C.x = end.x;
      C.y = end.y;
      C.z = end.z;
      C.vx = rnd.x * 3.5 * k;
      C.vy = rnd.y * 3 * k + 1;
      C.vz = rnd.z * 3.5 * k;
      C.drag = 2.6;
      C.gravity = 8;
      C.life = rand(1, 1.5);
      C.delay = popAt;
      C.shape = ConfettiShape.rect;
      C.size = 0.08 * k;
      C.aspect = rand(0.5, 0.9);
      C.spin = rand(8, 14);
      C.flutter = 0.12 * k;
      C.flutterFreq = 6;
      C.color(j % 2 === 0 ? c : tmpColor2);
      t.confetti.emit(C, t.now);
    }
  }
}

function crownShine(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const span = O.duration > 0 ? O.duration : 1.2;
  const count = n(Math.round(12 * Math.max(1, span)), t.density, 4);
  const colors = palette(GOLD_COLORS);
  for (let i = 0; i < count; i++) {
    randomUnit();
    rnd.y = Math.abs(rnd.y) * 0.8 + 0.1;
    const r = rand(0.35, 0.75) * k;
    P.reset();
    P.x = pos.x + rnd.x * r;
    P.y = pos.y + rnd.y * r;
    P.z = pos.z + rnd.z * r;
    P.vy = rand(0.1, 0.4);
    P.life = rand(0.45, 0.8);
    P.delay = O.delay + rand(0, Math.max(0, span - 0.5));
    P.size0 = rand(0.22, 0.36) * k;
    P.size1 = 0.05;
    P.shape = GlowShape.star;
    P.spin = rand(-2, 2);
    P.twinkle = 0.7;
    P.color(pick(colors, COLORS.gold), 1.3);
    t.glow.emit(P, t.now);
  }
}

function bounceRing(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const c = O.color ?? COLORS.cyan;
  D.x = pos.x;
  D.y = pos.y;
  D.z = pos.z;
  D.kind = DecalKind.ring;
  D.alpha = 1;
  for (let i = 0; i < 2; i++) {
    D.delay = O.delay + i * 0.09;
    D.life = 0.5 - i * 0.08;
    D.size0 = 0.25 * k;
    D.size1 = (i === 0 ? 1.9 : 1.3) * k;
    D.thickness = i === 0 ? 0.14 : 0.2;
    tmpColor.copy(c).lerp(COLORS.white, i * 0.5);
    D.color(tmpColor);
    t.decals.emit(D, t.now);
  }
  sparkBurst(
    t,
    pos.x,
    pos.y + 0.2,
    pos.z,
    n(10, t.density, 3),
    4 * k,
    O.delay,
    O.color ? listOf(c) : MINT_COLORS,
    0.22 * k,
    0.9,
  );
  flash(t, pos.x, pos.y + 0.15, pos.z, 1.2 * k, O.delay, c, 0.15);
}

function windStreaks(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const c = O.color ?? COLORS.wind;
  const count = n(14, t.density, 4);
  basisAround();
  for (let i = 0; i < count; i++) {
    P.reset();
    let vx: number;
    let vy: number;
    let vz: number;
    if (O.hasDirection) {
      const u = rand(-1.5, 1.5) * k;
      const v = rand(-1, 1) * k;
      const along = rand(-1.2, 0.6) * k;
      P.x = pos.x + axisU.x * u + axisV.x * v + dir.x * along;
      P.y = pos.y + axisU.y * u + axisV.y * v + dir.y * along;
      P.z = pos.z + axisU.z * u + axisV.z * v + dir.z * along;
      const s = rand(9, 13);
      vx = dir.x * s;
      vy = dir.y * s;
      vz = dir.z * s;
    } else {
      // No direction: an omnidirectional horizontal gust radiating from the source.
      const a = Math.random() * TAU;
      const s = rand(7, 10);
      P.x = pos.x + Math.cos(a) * 0.4 * k;
      P.y = pos.y + rand(-0.4, 0.8) * k;
      P.z = pos.z + Math.sin(a) * 0.4 * k;
      vx = Math.cos(a) * s;
      vy = 0;
      vz = Math.sin(a) * s;
    }
    P.vx = vx;
    P.vy = vy;
    P.vz = vz;
    P.life = rand(0.32, 0.5);
    P.delay = O.delay + rand(0, 0.45);
    P.size0 = P.size1 = 0.07 * k;
    P.stretch = 0.075;
    P.shape = GlowShape.streak;
    P.alpha = 0.6;
    P.color(c, 1);
    t.glow.emit(P, t.now);
  }
}

function tileCrack(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const life = O.duration > 0 ? O.duration : 1;
  D.x = pos.x;
  D.y = pos.y;
  D.z = pos.z;
  D.delay = O.delay;
  D.life = life;
  D.size0 = D.size1 = 1.1 * k;
  D.kind = DecalKind.crack;
  D.alpha = 1;
  D.color(O.color ?? COLORS.crack);
  lastCrack.slot = t.decals.emit(D, t.now);
  lastCrack.spawnTime = t.now + O.delay;
  const bits = n(4, t.density, 2);
  for (let i = 0; i < bits; i++) {
    const a = Math.random() * TAU;
    P.reset();
    P.x = pos.x + Math.cos(a) * 0.5 * k;
    P.y = pos.y + 0.08;
    P.z = pos.z + Math.sin(a) * 0.5 * k;
    P.vx = Math.cos(a) * 0.4;
    P.vy = rand(0.6, 1.2);
    P.vz = Math.sin(a) * 0.4;
    P.gravity = 6;
    P.life = rand(0.3, 0.45);
    P.delay = O.delay + rand(0, 0.3);
    P.size0 = 0.12 * k;
    P.size1 = 0.16 * k;
    P.shape = PuffShape.cloud;
    P.color(COLORS.dust);
    t.puffs.emit(P, t.now);
  }
}

function teamSmoke(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const base = O.color ?? TEAM_PALETTE[O.team] ?? COLORS.white;
  const count = n(16, t.density, 5);
  for (let i = 0; i < count; i++) {
    P.reset();
    P.x = pos.x + rand(-0.3, 0.3) * k;
    P.y = pos.y + rand(0, 0.3) * k;
    P.z = pos.z + rand(-0.3, 0.3) * k;
    P.vx = rand(-0.5, 0.5);
    P.vy = rand(1.4, 2.6) * k;
    P.vz = rand(-0.5, 0.5);
    P.drag = 1.2;
    P.gravity = -0.7;
    P.life = rand(1, 1.6);
    P.delay = O.delay + rand(0, 0.45);
    P.size0 = rand(0.22, 0.3) * k;
    P.size1 = rand(0.55, 0.75) * k;
    P.shape = PuffShape.smoke;
    tmpColor.copy(base).lerp(COLORS.white, rand(0, 0.3));
    P.color(tmpColor);
    t.puffs.emit(P, t.now);
  }
}

function teleport(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const c = O.color ?? COLORS.teleport;
  const implode = 0.26;
  const inCount = n(20, t.density, 5);
  for (let i = 0; i < inCount; i++) {
    randomUnit();
    const r = rand(0.9, 1.4) * k;
    P.reset();
    P.x = pos.x + rnd.x * r;
    P.y = pos.y + rnd.y * r;
    P.z = pos.z + rnd.z * r;
    P.vx = (-rnd.x * r) / implode;
    P.vy = (-rnd.y * r) / implode;
    P.vz = (-rnd.z * r) / implode;
    P.life = implode;
    P.delay = O.delay;
    P.size0 = 0.08 * k;
    P.size1 = 0.18 * k;
    P.stretch = 0.03;
    P.shape = GlowShape.streak;
    P.color(i % 2 === 0 ? c : COLORS.cyan, 1.2);
    t.glow.emit(P, t.now);
  }
  const bang = O.delay + implode;
  sparkBurst(
    t,
    pos.x,
    pos.y,
    pos.z,
    n(24, t.density, 6),
    5.5 * k,
    bang,
    O.color ? listOf(c) : listOf(c, COLORS.cyan, COLORS.white),
    0.24 * k,
    0.2,
  );
  flash(t, pos.x, pos.y, pos.z, 2.4 * k, bang, c, 0.24);
  glowRing(t, pos.x, pos.y, pos.z, 3 * k, bang, COLORS.cyan, 0.35);
  D.x = pos.x;
  D.y = pos.y - 0.8 * k;
  D.z = pos.z;
  D.delay = bang;
  D.life = 0.5;
  D.size0 = 0.3 * k;
  D.size1 = 1.6 * k;
  D.kind = DecalKind.ring;
  D.thickness = 0.16;
  D.alpha = 0.9;
  D.color(c);
  t.decals.emit(D, t.now);
}

function sparkle(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const colors = O.palette.length > 0 ? O.palette : O.color ? null : GOLD_COLORS;
  if (colors)
    sparkBurst(t, pos.x, pos.y, pos.z, n(14, t.density, 4), 2.8 * k, O.delay, colors, 0.24 * k, 0.6);
  else {
    tmpColor.copy(O.color ?? COLORS.interact);
    sparkBurst(
      t,
      pos.x,
      pos.y,
      pos.z,
      n(14, t.density, 4),
      2.8 * k,
      O.delay,
      listOf(tmpColor, COLORS.white),
      0.24 * k,
      0.6,
    );
  }
  flash(t, pos.x, pos.y, pos.z, 0.9 * k, O.delay, O.color ?? COLORS.interact, 0.18);
}

function pop(t: RecipeTargets, pos: VfxVec3): void {
  const k = O.scale;
  const c = O.color ?? COLORS.white;
  flash(t, pos.x, pos.y, pos.z, 1.2 * k, O.delay, c, 0.16);
  glowRing(t, pos.x, pos.y, pos.z, 1.5 * k, O.delay, c, 0.22);
  const count = n(6, t.density, 3);
  for (let i = 0; i < count; i++) {
    randomUnit();
    P.reset();
    P.x = pos.x;
    P.y = pos.y;
    P.z = pos.z;
    P.vx = rnd.x * 4 * k;
    P.vy = rnd.y * 4 * k;
    P.vz = rnd.z * 4 * k;
    P.drag = 6;
    P.life = 0.25;
    P.delay = O.delay;
    P.size0 = 0.14 * k;
    P.size1 = 0.04 * k;
    P.stretch = 0.04;
    P.shape = GlowShape.streak;
    P.color(c, 1);
    t.glow.emit(P, t.now);
  }
}

/**
 * Spawns one effect into the pools.
 *
 * @param kind - Effect.
 * @param t - Pools + time.
 * @param pos - World position (feet/ground level for ground effects).
 * @param opts - Options; see {@link VfxSpawnOptions}.
 */
export function spawnRecipe(kind: VfxKind, t: RecipeTargets, pos: VfxVec3, opts?: VfxSpawnOptions): void {
  resolve(opts);
  switch (kind) {
    case 'confetti':
      return confetti(t, pos);
    case 'dust':
      return dust(t, pos, false);
    case 'landDust':
      return dust(t, pos, true);
    case 'speedLines':
      return speedLines(t, pos);
    case 'stunStars':
      return stunStars(t, pos);
    case 'slimeSplash':
      return slimeSplash(t, pos);
    case 'fireworks':
      return fireworks(t, pos);
    case 'qualifySparkle':
      return qualifySparkle(t, pos);
    case 'eliminationPoof':
      return eliminationPoof(t, pos, true);
    case 'crownShine':
      return crownShine(t, pos);
    case 'bounceRing':
      return bounceRing(t, pos);
    case 'windStreaks':
      return windStreaks(t, pos);
    case 'tileCrack':
      return tileCrack(t, pos);
    case 'teamSmoke':
      return teamSmoke(t, pos);
    case 'teleport':
      return teleport(t, pos);
    case 'sparkle':
      return sparkle(t, pos);
    case 'pop':
      return pop(t, pos);
  }
}

/**
 * Elimination puff without the balloons (falling out of a cloud void).
 *
 * @param t - Pools + time.
 * @param pos - World position.
 * @param opts - Options.
 */
export function spawnPoofLite(t: RecipeTargets, pos: VfxVec3, opts?: VfxSpawnOptions): void {
  resolve(opts);
  eliminationPoof(t, pos, false);
}

/** Every effect kind, in a stable order (lab buttons, tests). */
export const VFX_KINDS: readonly VfxKind[] = [
  'confetti',
  'dust',
  'landDust',
  'speedLines',
  'stunStars',
  'slimeSplash',
  'fireworks',
  'qualifySparkle',
  'eliminationPoof',
  'crownShine',
  'bounceRing',
  'windStreaks',
  'tileCrack',
  'teamSmoke',
  'teleport',
  'sparkle',
  'pop',
];
