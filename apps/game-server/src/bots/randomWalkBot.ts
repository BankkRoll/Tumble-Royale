/**
 * Server-side stand-in bot for the dev sim: wanders with smoothly varying
 * heading, jumps now and then. The real MatchSim drives its own navigation
 * bots, so production rooms pass `createBot: null`.
 */
import { createCharacterFullState, type MatchPlayerInfo, type MatchSim } from '@tumble/netcode';
import { Button, type CharacterInput } from '@tumble/sim';
import { Rng } from '@tumble/shared';
import type { ServerBotBrain, ServerBotFactory } from '../room/types.ts';

class RandomWalkBot implements ServerBotBrain {
  private readonly rng: Rng;
  private heading: number;
  private turnRate = 0;
  private jumpHold = 0;
  private readonly state = createCharacterFullState();

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.heading = this.rng.range(-Math.PI, Math.PI);
  }

  think(sim: MatchSim, playerId: number, out: CharacterInput): void {
    if (this.rng.chance(0.02)) this.turnRate = this.rng.range(-2, 2);
    this.heading += this.turnRate / 60;
    if (sim.getPlayerState(playerId, this.state)) {
      const { x, z } = this.state.pos;
      // Steer home before the edge so dev bots don't all end up falling off the arena.
      if (x * x + z * z > 28 * 28) this.heading = Math.atan2(-x, -z) + this.rng.range(-0.5, 0.5);
    }
    out.yaw = this.heading;
    out.moveX = 0;
    out.moveZ = this.rng.chance(0.002) ? 0 : 1;
    if (this.jumpHold > 0) this.jumpHold--;
    else if (this.rng.chance(0.01)) this.jumpHold = this.rng.int(4, 14);
    out.buttons = this.jumpHold > 0 ? Button.Jump : 0;
    out.emote = 0;
  }
}

/**
 * Factory for {@link RandomWalkBot}s.
 *
 * @example
 * deps.createBot = randomWalkBots;
 */
export const randomWalkBots: ServerBotFactory = (info: MatchPlayerInfo, seed: number) =>
  new RandomWalkBot((seed ^ Math.imul(info.id + 1, 0x9e3779b1)) >>> 0);
