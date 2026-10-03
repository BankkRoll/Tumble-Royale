/**
 * Practice Island layout: the shared numbers the round geometry, its bot
 * route and the client's tutorial runner all read, so a station moved here
 * moves everywhere.
 *
 * Travel is +Z. Floor tops step up as the island climbs:
 * start/move/jump 0 → 0.8 → grab plaza 0.2 → ledge 2.6 → bounce shelf 6.2
 * (tiles, checkpoint, race start) → race descends to 2.2 at the finish.
 */
import type { Vec3 } from '@tumble/shared';

/** Station ids in play order. `race` is the closing mini race. */
export type PracticeStationId =
  'move' | 'jump' | 'dive' | 'grab' | 'climb' | 'bounce' | 'tiles' | 'checkpoint' | 'race';

/** Axis-aligned box (world space). */
export interface ZoneBox {
  min: Vec3;
  max: Vec3;
}

/** One teaching station. */
export interface PracticeStation {
  id: PracticeStationId;
  /** Where the coach stands to introduce the station (also where the player arrives). */
  start: Vec3;
  /** Where the coach waits after demonstrating (the next station's start). */
  end: Vec3;
  /** The player standing (feet) inside this box has physically cleared the station. */
  goal: ZoneBox;
  /** First waypoint id of the station's route (ids are grouped by hundreds). */
  navFrom: number;
  /** Checkpoint index the player respawns at while on this station. */
  checkpoint: number;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): ZoneBox => ({
  min: v(x0, y0, z0),
  max: v(x1, y1, z1),
});

/** Walkable tops and section edges (metres). */
export const ISLAND = {
  plazaZ0: -6,
  moveZ1: 28,
  jumpA: { z0: 29.5, z1: 33.5, top: 0 },
  jumpB: { z0: 35, z1: 39, top: 0.8 },
  jumpC: { z0: 41, z1: 48, top: 0.8 },
  /** Dive gap: edge to edge, landing 0.6 m lower. Jump alone falls ~0.6 m short; jump+dive clears by ~1 m. */
  diveGap: 5,
  grabTop: 0.2,
  grabZ0: 53,
  grabZ1: 67,
  ledgeTop: 2.6,
  ledgeZ1: 75.5,
  padZ: 72.5,
  shelfTop: 6.2,
  shelfZ1: 83,
  tilesZ: 88.53,
  checkpointZ0: 94.05,
  checkpointGateZ: 97,
  raceGateZ: 106.5,
  racePlazaZ0: 108,
  startGateZ: 116.5,
  raceTrackZ0: 118,
  rampZ0: 138,
  rampZ1: 150,
  raceLowTop: 2.2,
  gapZ0: 172,
  gapZ1: 174,
  finishZ: 186,
  endZ: 192,
} as const;

/** Stations in order, with their coach points and success boxes. */
export const PRACTICE_STATIONS: readonly PracticeStation[] = [
  {
    id: 'move',
    start: v(-1.6, 0, 3),
    end: v(1.2, 0, 25.5),
    goal: box(-5, -0.5, 23.5, 5, 3, 28),
    navFrom: 100,
    checkpoint: 0,
  },
  {
    id: 'jump',
    start: v(1.2, 0, 25.5),
    end: v(1.6, ISLAND.jumpC.top, 44.5),
    goal: box(-4.5, ISLAND.jumpC.top - 0.3, 42, 4.5, ISLAND.jumpC.top + 3, 48),
    navFrom: 200,
    checkpoint: 1,
  },
  {
    id: 'dive',
    start: v(1.6, ISLAND.jumpC.top, 44.5),
    end: v(1.8, ISLAND.grabTop, 59),
    goal: box(-7, ISLAND.grabTop - 0.3, 53.4, 7, ISLAND.grabTop + 3, 67),
    navFrom: 300,
    checkpoint: 2,
  },
  {
    id: 'grab',
    start: v(1.8, ISLAND.grabTop, 59),
    end: v(0, ISLAND.grabTop, 61),
    goal: box(-7, ISLAND.grabTop - 0.3, 53, 7, ISLAND.grabTop + 3, 67),
    navFrom: 400,
    checkpoint: 3,
  },
  {
    id: 'climb',
    start: v(0, ISLAND.grabTop, 61),
    end: v(1.8, ISLAND.ledgeTop, 69.5),
    goal: box(-6, ISLAND.ledgeTop - 0.3, 67.2, 6, ISLAND.ledgeTop + 3, 75.5),
    navFrom: 410,
    checkpoint: 3,
  },
  {
    id: 'bounce',
    start: v(1.8, ISLAND.ledgeTop, 69.5),
    end: v(1.6, ISLAND.shelfTop, 80.5),
    goal: box(-5, ISLAND.shelfTop - 0.3, 75.6, 5, ISLAND.shelfTop + 3, 83),
    navFrom: 500,
    checkpoint: 4,
  },
  {
    id: 'tiles',
    start: v(1.6, ISLAND.shelfTop, 80.5),
    end: v(2.2, ISLAND.shelfTop, 100),
    goal: box(-6, ISLAND.shelfTop - 0.3, 94.3, 6, ISLAND.shelfTop + 3, 108),
    navFrom: 600,
    checkpoint: 5,
  },
  {
    id: 'checkpoint',
    start: v(2.2, ISLAND.shelfTop, 100),
    end: v(-2.4, ISLAND.shelfTop, 104.5),
    goal: box(-6, ISLAND.shelfTop - 0.3, 96, 6, ISLAND.shelfTop + 3, 108),
    navFrom: 700,
    checkpoint: 6,
  },
  {
    id: 'race',
    start: v(-2.4, ISLAND.shelfTop, 104.5),
    end: v(0, ISLAND.shelfTop, 112),
    goal: box(-7, ISLAND.shelfTop - 0.3, ISLAND.raceGateZ, 7, ISLAND.shelfTop + 3, ISLAND.startGateZ),
    navFrom: 800,
    checkpoint: 6,
  },
];

/** Practice spawn: the player and the coach side by side on the start plaza. */
export const PRACTICE_SPAWN = { origin: v(0, 0.1, 0), yaw: 0, cols: 2, spacing: 2.4 } as const;

/** Mini race spawn grid on the race plaza behind the start gate. */
export const RACE_SPAWN = {
  origin: v(0, ISLAND.shelfTop + 0.1, 112),
  yaw: 0,
  cols: 4,
  spacing: 1.8,
} as const;

/** Mini race time limit (s). */
export const RACE_SECONDS = 90;

/** Where the coach cheers from during the mini race (beside, not inside, the finish trigger). */
export const COACH_PODIUM: Vec3 = v(9.4, 3.0, 188);

/** The diving board off the checkpoint terrace used for the fall/respawn demo. */
export const FALL_BOARD: Vec3 = v(9.2, ISLAND.shelfTop, 102.25);
