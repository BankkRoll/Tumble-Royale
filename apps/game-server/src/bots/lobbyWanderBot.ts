/**
 * Bots on the pre-show platform: stroll between random spots, pause, emote,
 * hop now and then. Driven by the room through the same input path as humans
 * so the lobby sim stays a pure function of inputs; seeded per bot, so a
 * given show seed always produces the same lobby choreography.
 */
import { createCharacterFullState, type MatchPlayerInfo, type MatchSim } from '@tumble/netcode';
import { Button, type CharacterInput } from '@tumble/sim';
import { Rng } from '@tumble/shared';
import type { ServerBotBrain } from '../room/types.ts';

const SALT = 0x10bb_7a1c;
/** Bots stay well inside the platform edge (the lobby disc is ~17 m). */
const ROAM_RADIUS = 12;

class LobbyWanderBot implements ServerBotBrain {
  private readonly rng: Rng;
  private readonly state = createCharacterFullState();
  private targetX = 0;
  private targetZ = 0;
  private wait: number;
  private jumpHold = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
    this.wait = this.rng.int(30, 150);
    this.pick();
  }

  private pick(): void {
    const a = this.rng.range(-Math.PI, Math.PI);
    const d = Math.sqrt(this.rng.next()) * ROAM_RADIUS;
    this.targetX = Math.sin(a) * d;
    this.targetZ = Math.cos(a) * d;
  }

  think(sim: MatchSim, playerId: number, out: CharacterInput): void {
    out.moveX = 0;
    out.moveZ = 0;
    out.buttons = 0;
    out.emote = 0;
    if (this.wait > 0) {
      this.wait--;
      if (this.wait === 0) this.pick();
      return;
    }
    if (!sim.getPlayerState(playerId, this.state)) return;
    const dx = this.targetX - this.state.pos.x;
    const dz = this.targetZ - this.state.pos.z;
    if (dx * dx + dz * dz < 0.6) {
      this.wait = this.rng.int(60, 240);
      const roll = this.rng.next();
      // Arrived: sometimes emote (a one-step slot press, like the emote wheel), sometimes hop.
      if (roll < 0.3) out.emote = this.rng.int(1, 4);
      else if (roll < 0.45) this.jumpHold = this.rng.int(4, 12);
      return;
    }
    out.yaw = Math.atan2(dx, dz);
    out.moveZ = 1;
    if (this.jumpHold > 0) {
      this.jumpHold--;
      out.buttons = Button.Jump;
    } else if (this.rng.chance(0.004)) {
      this.jumpHold = this.rng.int(4, 12);
    }
  }
}

/**
 * Creates a lobby bot brain.
 *
 * @param info - The bot.
 * @param seed - Show seed.
 * @returns A deterministic wanderer.
 * @example
 * slot.lobbyBrain = createLobbyWanderBot(info, seed);
 */
export function createLobbyWanderBot(info: MatchPlayerInfo, seed: number): ServerBotBrain {
  return new LobbyWanderBot((seed ^ SALT ^ Math.imul(info.id + 1, 0x9e3779b1)) >>> 0);
}
