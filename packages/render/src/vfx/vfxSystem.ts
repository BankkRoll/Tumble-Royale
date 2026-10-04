import { Group, type Camera, type Color, type Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { SimEvent } from '@tumble/sim';
import type {
  GroundProbe,
  TrailHandle,
  TrailStyle,
  VfxBudget,
  VfxKind,
  VfxSpawnOptions,
  VfxSystem,
  VfxSystemOptions,
  VfxVec3,
} from './types.ts';
import { BalloonPool } from './balloons.ts';
import { DEFAULT_VFX_BUDGET, MAX_VFX_BUDGET, mergeBudget } from './budget.ts';
import { ConfettiPool } from './confetti.ts';
import { DecalPool } from './decals.ts';
import { GlowShape, ParticlePool, ParticleSpec } from './particles.ts';
import { lastCrack, spawnPoofLite, spawnRecipe, type RecipeTargets } from './recipes.ts';
import { BlobShadows } from './shadows.ts';
import { StunStars, type AnchorLookup } from './stunStars.ts';
import { TrailPool } from './trails.ts';

/**
 * The VFX system: owns every pool and maps gameplay events to effects.
 *
 * Responsibilities:
 * - Builds the pools (≈ 7 draw calls + 1 per visible trail; idle pools draw nothing).
 * - Advances the single shared time uniform and flushes each pool's dirty range.
 * - Keeps player anchors (ids 0–255) for events that carry no position and for
 *   effects that follow a player.
 * - `handleSimEvent`: the gameplay → effect mapping.
 * - Budget changes and teardown.
 */

/** Anchor slots: the whole 8-bit wire id space, players and spectators alike. */
const MAX_IDS = 256;
/** Feet → body-centre offset (m); sim events report feet, anchors are body centres. */
const BODY_CENTRE = 0.8;
/** Live tile-crack decals tracked so a falling tile can retire its crack. */
const MAX_TRACKED_CRACKS = 64;
/** Share of the particle budget given to the additive glow pool (the rest is puffs). */
const GLOW_SHARE = 0.6;
/** Balloons are few and short-lived; this ceiling covers a mass elimination. */
const BALLOON_CAPACITY = 96;
/** Ground decals are short-lived; tile cracks are the long ones. */
const DECAL_CAPACITY = 192;

const WIND_CUE = /wind|fan(?!off)|gust|blow/i;
const QUIET_CUE = /beep|hum|creak|off|reverse|switch|gate|warn|respawn|spawn|whoosh/i;
const BLAST_CUE = /cannon|fire|thump|land|boulder/i;
const HIT_CUE = /slam|punch|hit|bonk|pow|boing|honk|squash|zap|pop/i;
const SPLASH_CUE = /splash/i;
const CRACK_CUE = /crack|collapse|break|fall/i;

/**
 * Creates the VFX system. Add `system.object` to the scene and call `update`
 * every frame before rendering.
 *
 * @param opts - Budget, ground probe, tile resolver and theme void style.
 * @returns The system.
 * @example
 * const vfx = createVfxSystem({ budget: vfxBudgetForTier('high'), groundProbe });
 * scene.add(vfx.object);
 * vfx.spawn('confetti', { x: 0, y: 2, z: 0 }, { scale: 1.2 });
 * // per frame:
 * vfx.update(dt, camera);
 */
export function createVfxSystem(opts: VfxSystemOptions = {}): VfxSystem {
  let budget = mergeBudget(DEFAULT_VFX_BUDGET, opts.budget);
  const alloc = {
    particles: Math.max(budget.particles, MAX_VFX_BUDGET.particles),
    confetti: Math.max(budget.confetti, MAX_VFX_BUDGET.confetti),
    trails: Math.max(budget.trails, MAX_VFX_BUDGET.trails),
    shadows: Math.max(budget.shadows, MAX_VFX_BUDGET.shadows),
  };

  const time = uniform(0);
  let now = 0;
  const root = new Group();
  root.name = 'vfx';

  const glow = new ParticlePool('glow', Math.ceil(alloc.particles * GLOW_SHARE), time);
  const puffs = new ParticlePool('puff', Math.ceil(alloc.particles * (1 - GLOW_SHARE)), time);
  const confetti = new ConfettiPool(alloc.confetti, time);
  const balloons = new BalloonPool(BALLOON_CAPACITY, time);
  const decals = new DecalPool(DECAL_CAPACITY, time);
  const stars = new StunStars();
  const shadows = new BlobShadows(alloc.shadows, budget.shadows);
  shadows.setProbe(opts.groundProbe ?? null);

  const trailSpec = new ParticleSpec();
  const trailEmit = (style: number, x: number, y: number, z: number, c: Color): void => {
    const s = trailSpec.reset();
    s.x = x + (Math.random() - 0.5) * 0.25;
    s.y = y + (Math.random() - 0.5) * 0.25;
    s.z = z + (Math.random() - 0.5) * 0.25;
    if (style === 2) {
      s.vy = 0.5 + Math.random() * 0.4;
      s.drag = 1;
      s.gravity = -0.4;
      s.life = 0.7 + Math.random() * 0.4;
      s.size0 = s.size1 = 0.09 + Math.random() * 0.08;
      s.shape = GlowShape.ring;
      s.alpha = 0.7;
    } else {
      s.vy = -0.3;
      s.life = 0.4 + Math.random() * 0.25;
      s.size0 = 0.16;
      s.size1 = 0.03;
      s.shape = GlowShape.star;
      s.spin = 3;
      s.twinkle = 0.7;
    }
    s.color(c, 1.15);
    glow.emit(s, now);
  };
  const trails = new TrailPool(root, alloc.trails, budget.trails, time, trailEmit);

  root.add(
    shadows.object,
    decals.object,
    puffs.object,
    confetti.object,
    balloons.object,
    stars.object,
    glow.object,
  );

  const targets: RecipeTargets = { glow, puffs, confetti, balloons, decals, stars, now: 0, density: 1 };

  const anchors = new Float32Array(MAX_IDS * 3);
  const heading = new Float32Array(MAX_IDS * 3);
  const known = new Uint8Array(MAX_IDS);

  const crackObstacle: string[] = new Array<string>(MAX_TRACKED_CRACKS).fill('');
  const crackTile = new Int32Array(MAX_TRACKED_CRACKS).fill(-1);
  const crackSlot = new Int32Array(MAX_TRACKED_CRACKS).fill(-1);
  const crackSpawn = new Float64Array(MAX_TRACKED_CRACKS);
  let crackNext = 0;

  let tileResolver = opts.tileResolver ?? null;
  const voidStyle = opts.voidStyle ?? 'clouds';

  const scratchPos = { x: 0, y: 0, z: 0 };
  const scratchPos2 = { x: 0, y: 0, z: 0 };
  const scratchDir = { x: 0, y: 0, z: 0 };
  const so: VfxSpawnOptions = {};

  const anchorLookup: AnchorLookup = {
    getAnchor(id: number, out: Vector3): boolean {
      if (id < 0 || id >= MAX_IDS || !known[id]) return false;
      out.set(anchors[id * 3] ?? 0, anchors[id * 3 + 1] ?? 0, anchors[id * 3 + 2] ?? 0);
      return true;
    },
  };

  function applyBudget(next: VfxBudget): void {
    budget = next;
    glow.setCapacity(Math.ceil(budget.particles * GLOW_SHARE));
    puffs.setCapacity(Math.ceil(budget.particles * (1 - GLOW_SHARE)));
    confetti.setCapacity(budget.confetti);
    trails.setCapacity(budget.trails);
    shadows.setCapacity(budget.shadows);
    targets.density = Math.min(1.5, Math.max(0.3, budget.particles / DEFAULT_VFX_BUDGET.particles));
  }
  applyBudget(budget);

  /** Clears the shared options record so handler spawns never allocate. */
  function options(): VfxSpawnOptions {
    so.color = undefined;
    so.colors = undefined;
    so.scale = undefined;
    so.intensity = undefined;
    so.direction = undefined;
    so.team = undefined;
    so.delay = undefined;
    so.playerId = undefined;
    so.duration = undefined;
    return so;
  }

  /** Writes the player's anchor (or the fallback) into `out`. */
  function anchorOr(id: number, fallback: VfxVec3 | null, out: VfxVec3): boolean {
    if (id >= 0 && id < MAX_IDS && known[id]) {
      out.x = anchors[id * 3] ?? 0;
      out.y = anchors[id * 3 + 1] ?? 0;
      out.z = anchors[id * 3 + 2] ?? 0;
      return true;
    }
    if (!fallback) return false;
    out.x = fallback.x;
    out.y = fallback.y + BODY_CENTRE;
    out.z = fallback.z;
    return true;
  }

  function spawn(kind: VfxKind, pos: VfxVec3, o?: VfxSpawnOptions): void {
    targets.now = now;
    spawnRecipe(kind, targets, pos, o);
  }

  function trackCrack(obstacle: string, tile: number): void {
    const i = crackNext;
    crackNext = (crackNext + 1) % MAX_TRACKED_CRACKS;
    crackObstacle[i] = obstacle;
    crackTile[i] = tile;
    crackSlot[i] = lastCrack.slot;
    crackSpawn[i] = lastCrack.spawnTime;
  }

  function retireCrack(obstacle: string, tile: number): void {
    for (let i = 0; i < MAX_TRACKED_CRACKS; i++) {
      if (crackTile[i] !== tile || crackObstacle[i] !== obstacle) continue;
      decals.kill(crackSlot[i] ?? -1, crackSpawn[i] ?? 0, now);
      crackTile[i] = -1;
    }
  }

  /** Splash tint for liquid voids; null for voids you poof out of. */
  function voidSplashColor(): string | null {
    switch (voidStyle) {
      case 'slime':
        return '#8cff5a';
      case 'water':
        return '#5fc8ff';
      case 'lava':
        return '#ff6a2a';
      default:
        return null;
    }
  }

  function handleSimEvent(e: SimEvent): void {
    targets.now = now;
    switch (e.type) {
      case 'jump': {
        const o = options();
        o.scale = 0.8;
        spawnRecipe('dust', targets, e.pos, o);
        return;
      }
      case 'land': {
        const impact = e.impact;
        if (impact < 2.5) return;
        const o = options();
        if (impact > 9) {
          o.scale = Math.min(1.6, 0.7 + impact / 20);
          spawnRecipe('landDust', targets, e.pos, o);
        } else {
          o.scale = 0.6 + impact / 15;
          spawnRecipe('dust', targets, e.pos, o);
        }
        return;
      }
      case 'dive': {
        const id = e.player;
        let dx = 0;
        let dz = 1;
        if (id >= 0 && id < MAX_IDS && known[id]) {
          dx = heading[id * 3] ?? 0;
          dz = heading[id * 3 + 2] ?? 1;
        }
        scratchDir.x = dx;
        scratchDir.y = 0;
        scratchDir.z = dz;
        anchorOr(id, e.pos, scratchPos);
        const o = options();
        o.direction = scratchDir;
        spawnRecipe('speedLines', targets, scratchPos, o);
        o.scale = 0.7;
        spawnRecipe('dust', targets, e.pos, o);
        return;
      }
      case 'stun': {
        const strength = Math.max(0, Math.min(2, e.strength));
        scratchPos.x = e.pos.x;
        scratchPos.y = e.pos.y + BODY_CENTRE;
        scratchPos.z = e.pos.z;
        const o = options();
        o.playerId = e.player;
        o.duration = 0.9 + 0.6 * strength;
        o.scale = 0.9 + 0.15 * Math.min(1, strength);
        spawnRecipe('stunStars', targets, scratchPos, o);
        return;
      }
      case 'bounce':
        spawnRecipe('bounceRing', targets, e.pos, options());
        return;
      case 'fellOut': {
        const tint = voidSplashColor();
        const o = options();
        if (tint) {
          o.color = tint;
          spawnRecipe('slimeSplash', targets, e.pos, o);
        } else {
          o.scale = 0.8;
          spawnPoofLite(targets, e.pos, o);
        }
        return;
      }
      case 'respawn': {
        scratchPos.x = e.pos.x;
        scratchPos.y = e.pos.y + BODY_CENTRE;
        scratchPos.z = e.pos.z;
        const o = options();
        o.scale = 0.6;
        o.intensity = 0.6;
        spawnRecipe('teleport', targets, scratchPos, o);
        return;
      }
      case 'checkpoint':
        if (anchorOr(e.player, null, scratchPos)) spawnRecipe('sparkle', targets, scratchPos, options());
        return;
      case 'finish':
        if (anchorOr(e.player, null, scratchPos)) {
          const o = options();
          o.scale = 0.6;
          o.intensity = 0.5;
          scratchPos.y -= BODY_CENTRE;
          spawnRecipe('fireworks', targets, scratchPos, o);
        }
        return;
      case 'qualified':
        if (anchorOr(e.player, null, scratchPos)) {
          spawnRecipe('confetti', targets, scratchPos, options());
          scratchPos.y -= BODY_CENTRE;
          spawnRecipe('qualifySparkle', targets, scratchPos, options());
        }
        return;
      case 'eliminated':
        if (anchorOr(e.player, null, scratchPos))
          spawnRecipe('eliminationPoof', targets, scratchPos, options());
        return;
      case 'tileWarn':
        if (tileResolver?.(e.obstacle, e.tile, scratchPos)) {
          const o = options();
          o.duration = 1.2;
          spawnRecipe('tileCrack', targets, scratchPos, o);
          trackCrack(e.obstacle, e.tile);
        }
        return;
      case 'tileFell':
        retireCrack(e.obstacle, e.tile);
        if (tileResolver?.(e.obstacle, e.tile, scratchPos))
          spawnRecipe('dust', targets, scratchPos, options());
        return;
      case 'obstacleCue':
        handleCue(e.cue, e.pos);
        return;
      case 'teleport': {
        scratchPos.x = e.from.x;
        scratchPos.y = e.from.y + BODY_CENTRE;
        scratchPos.z = e.from.z;
        scratchPos2.x = e.to.x;
        scratchPos2.y = e.to.y + BODY_CENTRE;
        scratchPos2.z = e.to.z;
        const o = options();
        o.scale = 0.8;
        spawnRecipe('teleport', targets, scratchPos, o);
        o.delay = 0.12;
        spawnRecipe('teleport', targets, scratchPos2, o);
        return;
      }
      case 'score':
        if (anchorOr(e.player, null, scratchPos)) {
          const o = options();
          // Individual points (score-target hunts) sparkle on the scorer; team points puff team smoke.
          if (e.team < 0) {
            o.scale = 0.7;
            spawnRecipe('sparkle', targets, scratchPos, o);
            return;
          }
          o.team = e.team;
          scratchPos.y -= BODY_CENTRE * 0.5;
          spawnRecipe('teamSmoke', targets, scratchPos, o);
        }
        return;
      case 'propPickup':
        if (anchorOr(e.player, null, scratchPos)) {
          const o = options();
          o.scale = 0.8;
          spawnRecipe('sparkle', targets, scratchPos, o);
        }
        return;
      default:
        return;
    }
  }

  function handleCue(cue: string, pos: VfxVec3): void {
    if (WIND_CUE.test(cue)) {
      spawnRecipe('windStreaks', targets, pos, options());
    } else if (QUIET_CUE.test(cue)) {
      return;
    } else if (SPLASH_CUE.test(cue)) {
      const o = options();
      o.scale = 0.7;
      const tint = voidSplashColor();
      if (tint) o.color = tint;
      spawnRecipe('slimeSplash', targets, pos, o);
    } else if (BLAST_CUE.test(cue)) {
      spawnRecipe('dust', targets, pos, options());
      spawnRecipe('pop', targets, pos, options());
    } else if (HIT_CUE.test(cue)) {
      spawnRecipe('pop', targets, pos, options());
      const o = options();
      o.scale = 0.7;
      spawnRecipe('bounceRing', targets, pos, o);
    } else if (CRACK_CUE.test(cue)) {
      spawnRecipe('dust', targets, pos, options());
    } else {
      spawnRecipe('sparkle', targets, pos, options());
    }
  }

  const system: VfxSystem = {
    object: root,
    spawn,
    handleSimEvent,
    setPlayerPosition(id: number, x: number, y: number, z: number): void {
      if (id < 0 || id >= MAX_IDS) return;
      const o = id * 3;
      if (known[id]) {
        const dx = x - (anchors[o] ?? 0);
        const dz = z - (anchors[o + 2] ?? 0);
        const d2 = dx * dx + dz * dz;
        // Only meaningful moves update the heading, so a dive from a standstill keeps the last facing.
        if (d2 > 1e-5) {
          const inv = 1 / Math.sqrt(d2);
          heading[o] = dx * inv;
          heading[o + 1] = 0;
          heading[o + 2] = dz * inv;
        }
      } else {
        heading[o] = 0;
        heading[o + 1] = 0;
        heading[o + 2] = 1;
      }
      anchors[o] = x;
      anchors[o + 1] = y;
      anchors[o + 2] = z;
      known[id] = 1;
    },
    setShadowCount(count: number): void {
      shadows.setCount(count);
    },
    setShadow(index: number, x: number, y: number, z: number, radius?: number): void {
      shadows.set(index, x, y, z, radius);
    },
    acquireTrail(style: TrailStyle, color?: string): TrailHandle | null {
      return trails.acquire(style, color);
    },
    update(dt: number, camera: Camera): void {
      if (dt > 0 && Number.isFinite(dt)) now += Math.min(dt, 0.25);
      time.value = now;
      targets.now = now;
      glow.update(now);
      puffs.update(now);
      confetti.update(now);
      balloons.update(now);
      decals.update(now);
      stars.update(now, anchorLookup);
      trails.update(now, camera);
    },
    clear(): void {
      glow.clear();
      puffs.clear();
      confetti.clear();
      balloons.clear();
      decals.clear();
      stars.clear();
      trails.clear();
      crackTile.fill(-1);
      // Rebasing keeps the float32 shader clock precise across a long session.
      now = 0;
      time.value = 0;
      targets.now = 0;
    },
    setGroundProbe(probe: GroundProbe | null): void {
      shadows.setProbe(probe);
    },
    setBudget(next: Partial<VfxBudget>): void {
      applyBudget(mergeBudget(budget, next));
    },
    dispose(): void {
      glow.dispose();
      puffs.dispose();
      confetti.dispose();
      balloons.dispose();
      decals.dispose();
      stars.dispose();
      shadows.dispose();
      trails.dispose();
      root.removeFromParent();
      tileResolver = null;
      known.fill(0);
    },
  };
  return system;
}
