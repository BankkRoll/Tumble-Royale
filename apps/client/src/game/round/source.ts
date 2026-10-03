/**
 * Where a round's renderable state comes from. The round view only talks to a
 * {@link RoundSource}, so the same visuals run offline (fixed-step sim with
 * render interpolation) and online (local prediction + interpolated remotes).
 */
import { CharacterFlag, CharacterState, type CharacterFullState } from '@tumble/sim';
import { createCharacterFullState } from '@tumble/sim/character';
import { DEFAULT_TUNING } from '@tumble/sim/character';
import type { MatchPlayerInfo, MatchSimHandle } from '@tumble/sim/match';
import { RoundPhase, SIM_DT } from '@tumble/shared';
import type { RenderEntityState } from '@tumble/netcode';
import type { NetGameSession } from '../../net/index.ts';

/** Capsule centre → feet. */
export const FOOT_OFFSET = DEFAULT_TUNING.radius + DEFAULT_TUNING.halfHeight;

/** One player's render state for this frame (capsule centre, world space). */
export interface PlayerSample {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  state: number;
  stateTime: number;
  facing: number;
  grounded: boolean;
  flags: number;
  /** Emote slot 1–4 playing, or 0. */
  emote: number;
}

/** @returns A zeroed sample (preallocate; sources fill in place). */
export function createPlayerSample(): PlayerSample {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, state: 0, stateTime: 0, facing: 0, grounded: true, flags: 0, emote: 0 };
}

/** Render-side view of a running round. */
export interface RoundSource {
  readonly sim: MatchSimHandle;
  readonly players: readonly MatchPlayerInfo[];
  /** Local player id, or -1 when spectating the whole round. */
  readonly localId: number;
  /** False once the sim has been disposed (stop querying physics). */
  readonly alive: boolean;
  /** Match time to pose obstacles and level animation at. */
  renderTime(): number;
  /** Fills `out` for player `id`; false when unknown/absent. */
  sample(id: number, out: PlayerSample): boolean;
}

const AIRBORNE = new Set<number>([CharacterState.Jump, CharacterState.Fall, CharacterState.Dive, CharacterState.Bounce, CharacterState.Stunned, CharacterState.LedgeHang]);

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}

// -----------------------------------------------------------------------------
// Offline
// -----------------------------------------------------------------------------

/**
 * Offline source: captures every player after each fixed step and
 * interpolates between the last two steps with the stepper's alpha.
 */
export class OfflineRoundSource implements RoundSource {
  /** Fraction of a step past the last captured state (set by the runner). */
  alpha = 0;
  private readonly index = new Map<number, number>();
  private readonly prev: Float64Array;
  private readonly curr: CharacterFullState[];
  private readonly has: Uint8Array;
  private captured = false;

  /**
   * @param sim - The round's match sim.
   * @param players - Entrants.
   * @param localId - Local player id or -1.
   * @param isAlive - Whether the sim is still live (the show disposes it).
   */
  constructor(
    readonly sim: MatchSimHandle,
    readonly players: readonly MatchPlayerInfo[],
    readonly localId: number,
    private readonly isAlive: () => boolean,
  ) {
    players.forEach((p, i) => this.index.set(p.id, i));
    this.prev = new Float64Array(players.length * 4);
    this.curr = players.map(() => createCharacterFullState());
    this.has = new Uint8Array(players.length);
  }

  get alive(): boolean {
    return this.isAlive();
  }

  /** Records the post-step state of every player (call after each fixed step). */
  capture(): void {
    if (!this.alive) return;
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const c = this.curr[i] as CharacterFullState;
      const o = i * 4;
      this.prev[o] = c.pos.x;
      this.prev[o + 1] = c.pos.y;
      this.prev[o + 2] = c.pos.z;
      this.prev[o + 3] = c.facing;
      this.has[i] = this.sim.getPlayerState((this.players[i] as MatchPlayerInfo).id, c) ? 1 : 0;
      if (!this.captured) {
        this.prev[o] = c.pos.x;
        this.prev[o + 1] = c.pos.y;
        this.prev[o + 2] = c.pos.z;
        this.prev[o + 3] = c.facing;
      }
    }
    this.captured = true;
  }

  renderTime(): number {
    const p = this.sim.phase;
    const advancing = p === RoundPhase.Countdown || p === RoundPhase.Playing || p === RoundPhase.Overtime || p === RoundPhase.RoundEnd;
    return advancing ? this.sim.time - SIM_DT + this.alpha * SIM_DT : this.sim.time;
  }

  sample(id: number, out: PlayerSample): boolean {
    const i = this.index.get(id);
    if (i === undefined || !this.has[i]) return false;
    const c = this.curr[i] as CharacterFullState;
    const o = i * 4;
    const t = this.alpha;
    const px = this.prev[o] as number;
    const py = this.prev[o + 1] as number;
    const pz = this.prev[o + 2] as number;
    // A respawn teleport would smear the Tumbler across the course for a frame.
    const jump = Math.abs(c.pos.x - px) + Math.abs(c.pos.y - py) + Math.abs(c.pos.z - pz) > 3;
    out.x = jump ? c.pos.x : px + (c.pos.x - px) * t;
    out.y = jump ? c.pos.y : py + (c.pos.y - py) * t;
    out.z = jump ? c.pos.z : pz + (c.pos.z - pz) * t;
    out.facing = lerpAngle(this.prev[o + 3] as number, c.facing, t);
    out.vx = c.vel.x;
    out.vy = c.vel.y;
    out.vz = c.vel.z;
    out.state = c.state;
    out.stateTime = c.stateTime;
    out.grounded = c.grounded;
    out.flags = c.flags;
    out.emote = c.emote;
    return true;
  }
}

// -----------------------------------------------------------------------------
// Online
// -----------------------------------------------------------------------------

/**
 * Online source: the local player from prediction (smoothed corrections),
 * everyone else from snapshot interpolation.
 */
export class OnlineRoundSource implements RoundSource {
  constructor(
    readonly sim: MatchSimHandle,
    readonly players: readonly MatchPlayerInfo[],
    readonly localId: number,
    private readonly session: NetGameSession,
  ) {}

  get alive(): boolean {
    return this.session.sim === this.sim;
  }

  renderTime(): number {
    return this.sim.time;
  }

  sample(id: number, out: PlayerSample): boolean {
    let e: RenderEntityState | undefined;
    if (id === this.localId) {
      if (!this.session.prediction) return false;
      e = this.session.local;
    } else e = this.session.remotes.get(id);
    if (!e) return false;
    out.x = e.pos.x;
    out.y = e.pos.y;
    out.z = e.pos.z;
    out.vx = e.vel.x;
    out.vy = e.vel.y;
    out.vz = e.vel.z;
    out.state = e.state;
    out.stateTime = e.stateTime;
    out.facing = e.facing;
    out.grounded = !AIRBORNE.has(e.state);
    out.flags = e.flags;
    out.emote = 0;
    return true;
  }
}

/** True when the flags mark a respawn-grace ghost (not a finished/qualified one). */
export function isRespawnGhost(sample: PlayerSample): boolean {
  return (sample.flags & CharacterFlag.Ghost) !== 0 && sample.state !== CharacterState.Finished;
}
