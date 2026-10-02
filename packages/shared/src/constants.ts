/** Fixed simulation rate shared by client prediction and the authoritative server. */
export const SIM_HZ = 60;

/** Length of one simulation step in seconds. */
export const SIM_DT = 1 / SIM_HZ;

/** Server network tick rate. Each network tick advances {@link SIM_STEPS_PER_TICK} sim steps. */
export const SERVER_TICK_HZ = 30;

/** Number of fixed sim steps per server network tick. */
export const SIM_STEPS_PER_TICK = SIM_HZ / SERVER_TICK_HZ;

/** Rate at which the server broadcasts snapshots to clients. */
export const SNAPSHOT_HZ = 30;

/** Default world gravity in m/s². Heavier than Earth so jumps feel snappy rather than floaty. */
export const GRAVITY_Y = -24;

/** Hard cap on players in a single show, including bots. */
export const MAX_PLAYERS = 60;

/** Default target player count for a show. */
export const DEFAULT_SHOW_PLAYERS = 40;
