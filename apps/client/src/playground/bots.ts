/**
 * Dummy wandering bots for grab and bump testing. They produce plain
 * `CharacterInput`s, exactly like humans, from a seeded RNG.
 */
import { Rng, type Vec3 } from '@tumble/shared';
import { Button, type CharacterInput } from '@tumble/sim/character';

/** Scripted wanderer: picks a heading, walks, idles, hops, then repeats. */
export class WanderBot {
  private readonly rng: Rng;
  private timer = 0;
  private heading = 0;
  private walking = false;
  private jumpTimer = 0;

  /**
   * @param seed - RNG seed (bots differ, runs repeat).
   * @param home - Centre of the wander area.
   * @param radius - Bots steer home when farther than this.
   */
  constructor(
    seed: number,
    private readonly home: Vec3,
    private readonly radius: number,
  ) {
    this.rng = new Rng(seed);
    this.heading = this.rng.range(-Math.PI, Math.PI);
  }

  /**
   * Fills `out` for one fixed step.
   *
   * @param feet - The bot's current feet position.
   */
  think(dt: number, feet: Vec3, out: CharacterInput): CharacterInput {
    this.timer -= dt;
    this.jumpTimer -= dt;
    if (this.timer <= 0) {
      this.walking = this.rng.chance(0.7);
      this.timer = this.rng.range(0.8, 2.6);
      this.heading += this.rng.range(-1.6, 1.6);
    }
    const dx = this.home.x - feet.x;
    const dz = this.home.z - feet.z;
    if (Math.hypot(dx, dz) > this.radius) {
      this.heading = Math.atan2(dx, dz);
      this.walking = true;
    }
    // World-space heading expressed as forward input with camera yaw = heading.
    out.yaw = this.heading;
    out.moveX = 0;
    out.moveZ = this.walking ? 0.75 : 0;
    out.buttons = 0;
    out.emote = 0;
    if (this.jumpTimer <= 0) {
      this.jumpTimer = this.rng.range(1.5, 4);
      if (this.rng.chance(0.5)) out.buttons |= Button.Jump;
      else if (this.rng.chance(0.15)) out.emote = this.rng.int(1, 4);
    }
    return out;
  }
}
