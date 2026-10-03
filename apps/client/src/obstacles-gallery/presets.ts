/**
 * Gallery-only placement tweaks: how each obstacle sits in its cell and where
 * the demo balls drop, so every type shows off its interaction. Types without
 * a preset (e.g. a freshly landed set B) use sensible defaults.
 */
import type { Vec3 } from '@tumble/shared';

/** Per-type gallery staging. */
export interface GalleryPreset {
  /** Offset of the instance from the cell centre (m). */
  offset?: Vec3;
  /** Yaw in degrees. */
  yaw?: number;
  /** Param overrides applied before the module's schema defaults. */
  params?: Record<string, unknown>;
  /** Ball drop area relative to the cell centre. */
  spawn?: { x: number; z: number; radius: number; height: number };
  /** Initial ball velocity (m/s), e.g. to run balls at doors. */
  ballVelocity?: Vec3;
  /** Demo balls for this cell. */
  balls?: number;
}

/** Slime keyframes that bob up and down for the whole gallery session. */
function slimeLoop(): { t: number; h: number }[] {
  const k: { t: number; h: number }[] = [];
  for (let i = 0; i < 120; i++) k.push({ t: i * 6, h: i % 2 === 0 ? -0.8 : 1.4 });
  return k;
}

/** Staging for known types. */
export const GALLERY_PRESETS: Partial<Record<string, GalleryPreset>> = {
  spinwheel: { params: { tiers: 2, reversePeriod: 7 }, spawn: { x: 0, z: 0, radius: 6, height: 6 } },
  pendulumHammer: { spawn: { x: 0, z: 0, radius: 3, height: 3 } },
  sweeperArm: { params: { accel: 0.05, upperArmHeight: 2.2 }, spawn: { x: 0, z: 0, radius: 7, height: 4 } },
  bumperPillar: { params: { orbitRadius: 3, bobAmplitude: 0.3 }, spawn: { x: 0, z: 0, radius: 4, height: 6 } },
  punchWall: { offset: { x: 0, y: 0, z: -4 }, spawn: { x: 0, z: -1.5, radius: 3, height: 4 } },
  doorGauntlet: {
    offset: { x: 0, y: 0, z: -3 },
    params: { rows: 2, doorsPerRow: 4, resetAfter: 5 },
    spawn: { x: 0, z: -9, radius: 3, height: 1.5 },
    ballVelocity: { x: 0, y: 0, z: 9 },
    balls: 6,
  },
  conveyorBelt: { offset: { x: 0, y: 0.6, z: 0 }, params: { pattern: 'switch', switchPeriod: 4 }, spawn: { x: 0, z: 0, radius: 3, height: 3 } },
  tiltPlatform: { offset: { x: 0, y: 3.6, z: 0 }, params: { columnHeight: 3.2 }, spawn: { x: 2, z: 1, radius: 2, height: 8 } },
  seesaw: { spawn: { x: -3.5, z: 0, radius: 1, height: 6 } },
  fanZone: { offset: { x: 0, y: 1.8, z: -6 }, spawn: { x: 0, z: 0, radius: 3, height: 5 } },
  bouncePad: { spawn: { x: 0, z: 0, radius: 0.8, height: 5 } },
  fallingTiles: { offset: { x: 0, y: 3, z: 0 }, params: { cols: 7, rows: 7, respawnTime: 4 }, spawn: { x: 0, z: 0, radius: 6, height: 9 }, balls: 6 },
  risingSlime: { params: { width: 24, depth: 24, keyframes: slimeLoop() }, spawn: { x: 0, z: 0, radius: 8, height: 6 } },
  boulderLane: { offset: { x: 0, y: 0, z: -11 }, params: { length: 22, laneSpacing: 4 }, spawn: { x: 0, z: 0, radius: 5, height: 3 } },
  spinningDisc: { offset: { x: 0, y: 1, z: 0 }, params: { bumps: 4, wobbleDeg: 4, reversePeriod: 6 }, spawn: { x: 0, z: 0, radius: 5, height: 5 } },
  movingPlatform: {
    offset: { x: 0, y: 2, z: 0 },
    params: { points: [{ x: 0, y: 0, z: -6 }, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 6 }] },
    spawn: { x: 0, z: 0, radius: 6, height: 7 },
  },
};

/** Fallback staging for unknown types. */
export const DEFAULT_PRESET: Required<Pick<GalleryPreset, 'spawn' | 'balls'>> = {
  spawn: { x: 0, z: 0, radius: 5, height: 6 },
  balls: 4,
};
