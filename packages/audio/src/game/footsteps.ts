/**
 * Footstep cadence from character speed and surface: decides *when* a foot
 * lands so callers that only know "player X moves at 5 m/s on ice" still get
 * natural steps. Pure and allocation-free per update.
 */

/** Surface kinds (mirrors `SurfaceKind` in `@tumble/sim`). */
export type FootSurface = 'normal' | 'ice' | 'slime' | 'conveyor' | 'sticky' | 'bouncy' | 'slide';

/** Footstep sound per surface. */
export const FOOTSTEP_SOUNDS: Readonly<Record<FootSurface, string>> = {
  normal: 'step.normal',
  ice: 'step.ice',
  slime: 'step.slime',
  conveyor: 'step.metal',
  sticky: 'step.sticky',
  bouncy: 'step.bouncy',
  slide: 'step.slide',
};

/** Below this speed (m/s) a Tumbler is standing still. */
export const MIN_STEP_SPEED = 0.6;

/**
 * Steps per second for a running speed. Stubby legs: cadence rises fast at
 * first and then saturates (you can't wiggle faster than ~5.5 steps/s).
 *
 * @param speed - Horizontal speed m/s.
 * @param surface - Surface (sticky is slower and heavier, ice is shuffly).
 * @returns Steps per second (0 when standing).
 */
export function stepRate(speed: number, surface: FootSurface = 'normal'): number {
  if (speed < MIN_STEP_SPEED) return 0;
  const base = 1.6 + 4 * (1 - Math.exp(-speed / 4));
  const mul = surface === 'sticky' ? 0.7 : surface === 'ice' ? 1.15 : 1;
  return Math.min(5.5, base * mul);
}

/**
 * Per-player phase accumulators. Call {@link FootstepCadence.update} every
 * frame; it returns true when a footstep should play.
 *
 * @example
 * const cadence = new FootstepCadence(40);
 * if (cadence.update(id, speed, grounded, 'ice', dt)) audio.engine.play('step.ice', { pos });
 */
export class FootstepCadence {
  private readonly phase: Float32Array;
  private readonly wasGrounded: Uint8Array;

  /**
   * @param maxPlayers - Highest player index + 1.
   */
  constructor(maxPlayers = 64) {
    this.phase = new Float32Array(maxPlayers);
    this.wasGrounded = new Uint8Array(maxPlayers);
  }

  /**
   * Advances one player's cadence.
   *
   * @param player - Player index.
   * @param speed - Horizontal speed m/s.
   * @param grounded - On the ground this frame.
   * @param surface - Ground surface.
   * @param dt - Frame seconds.
   * @returns true when a foot lands this frame.
   */
  update(player: number, speed: number, grounded: boolean, surface: FootSurface, dt: number): boolean {
    if (player < 0 || player >= this.phase.length) return false;
    const was = this.wasGrounded[player] === 1;
    this.wasGrounded[player] = grounded ? 1 : 0;
    if (!grounded) {
      // Arm a step for the moment we land so running off a ledge and back on doesn't double up with the land sound.
      this.phase[player] = 0.5;
      return false;
    }
    const rate = stepRate(speed, surface);
    if (rate === 0) {
      this.phase[player] = 0.6;
      return false;
    }
    if (!was) return false;
    let p = (this.phase[player] as number) + rate * dt;
    let fire = false;
    if (p >= 1) {
      p -= Math.floor(p);
      fire = true;
    }
    this.phase[player] = p;
    return fire;
  }

  /** Forgets a player's phase (respawn, leave). */
  reset(player: number): void {
    if (player < 0 || player >= this.phase.length) return;
    this.phase[player] = 0;
    this.wasGrounded[player] = 0;
  }
}
