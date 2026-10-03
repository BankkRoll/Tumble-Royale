/**
 * Lag-compensated grab and dive-hit assist (SPEC: ≤ 150 ms rewind).
 *
 * A client predicts its own Tumbler at the present but sees everyone else
 * interpolated in the past (render delay + half its RTT). When it grabs or
 * dives at what it saw, the authoritative sim, which only knows the present,
 * can miss. After every authoritative step this checks each human's fresh
 * grab press / dive against the other players' poses rewound to that
 * client's view time ({@link LagCompensator}, capped at 150 ms) and, when the
 * client's view says it connected, applies the hit through the sim's own
 * `assistGrab` / `assistTackle`, which keep every normal eligibility rule.
 *
 * Design (see DECISIONS.md "Lag compensation as server hit assist"): the
 * rewind never moves bodies and never runs inside `MatchSim.step`, so the
 * match sim stays a deterministic function of its inputs plus these explicit,
 * logged assists; it can only ever ADD a hit the client saw, bounded by a
 * present-day distance check so nobody is yanked across the map.
 */
import { MAX_ENTITIES, type MatchSim } from '@tumble/netcode';
import { Button, CharacterState, type CharacterFullState, type CharacterInput } from '@tumble/sim';
import { DEFAULT_TUNING } from '@tumble/sim/character';
import type { Vec3 } from '@tumble/shared';
import type { LagCompensator } from './lagcomp.ts';

/** Remote render delay the client uses for interpolation (InterpolationClock default). */
export const CLIENT_INTERP_DELAY_MS = 100;

/** Tuning for {@link HitAssist}. */
export interface HitAssistOptions {
  /** Client remote render delay (ms). */
  interpDelayMs?: number;
  /** Steps after a grab press during which the assist may fire (9 = 150 ms). */
  grabWindowSteps?: number;
  /**
   * Extra present-day distance (m) a target may have moved away from where
   * the grabber could reach it and still be assisted.
   */
  maxCatchUp?: number;
}

/** Counters for metrics and tests. */
export interface HitAssistCounters {
  grabs: number;
  tackles: number;
}

const FREE_STATES: ReadonlySet<number> = new Set([
  CharacterState.Idle,
  CharacterState.Run,
  CharacterState.Jump,
  CharacterState.Fall,
]);
const NOT_HITTABLE: ReadonlySet<number> = new Set([
  CharacterState.Stunned,
  CharacterState.Grabbed,
  CharacterState.Finished,
  CharacterState.Spectating,
  CharacterState.Eliminated,
  CharacterState.Respawning,
]);
const NEVER = 1 << 30;

/**
 * Per-room hit assist state. Allocation-free per step.
 *
 * @example
 * const assist = new HitAssist(room.lagComp);
 * // after sim.step(), for each human:
 * assist.afterStep(sim, id, input, roundPlayers, simTick, session.rttMs);
 */
export class HitAssist {
  readonly counters: HitAssistCounters = { grabs: 0, tackles: 0 };
  private readonly grabAge = new Int32Array(MAX_ENTITIES).fill(NEVER);
  private readonly heldGrab = new Uint8Array(MAX_ENTITIES);
  /** 1 while a dive is in progress that already got (or needs no more) an assist. */
  private readonly diveSpent = new Uint8Array(MAX_ENTITIES);
  private readonly self: CharacterFullState;
  private readonly other: CharacterFullState;
  private readonly rewound: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly center: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly interpDelayMs: number;
  private readonly grabWindowSteps: number;
  private readonly maxCatchUp: number;
  private readonly grabReach = DEFAULT_TUNING.grabRadius + DEFAULT_TUNING.radius;
  private readonly tackleReach = DEFAULT_TUNING.radius * 2 + 0.2;

  /**
   * @param lag - The room's pose history.
   * @param makeState - Allocates a full character state (netcode helper).
   * @param opts - Tuning.
   */
  constructor(
    private readonly lag: LagCompensator,
    makeState: () => CharacterFullState,
    opts: HitAssistOptions = {},
  ) {
    this.self = makeState();
    this.other = makeState();
    this.interpDelayMs = opts.interpDelayMs ?? CLIENT_INTERP_DELAY_MS;
    this.grabWindowSteps = opts.grabWindowSteps ?? 9;
    this.maxCatchUp = opts.maxCatchUp ?? 1.2;
  }

  /** Forgets press/dive tracking (new round). */
  reset(): void {
    this.grabAge.fill(NEVER);
    this.heldGrab.fill(0);
    this.diveSpent.fill(0);
  }

  /**
   * Checks one human after an authoritative step.
   *
   * @param sim - The authoritative sim.
   * @param id - The human's player id.
   * @param input - The input the sim just consumed for them.
   * @param peers - Everyone in the round.
   * @param simTick - Global sim tick of the state the step produced.
   * @param rttMs - The human's RTT estimate.
   */
  afterStep(
    sim: MatchSim,
    id: number,
    input: CharacterInput,
    peers: readonly number[],
    simTick: number,
    rttMs: number,
  ): void {
    if (id < 0 || id >= MAX_ENTITIES || !sim.getPlayerState(id, this.self)) return;
    const grab = (input.buttons & Button.Grab) !== 0;
    if (grab && !this.heldGrab[id]) this.grabAge[id] = 0;
    else if (grab) this.grabAge[id] = Math.min(NEVER, this.grabAge[id]! + 1);
    else this.grabAge[id] = NEVER;
    this.heldGrab[id] = grab ? 1 : 0;

    const s = this.self;
    const diving = s.state === CharacterState.Dive || s.state === CharacterState.DiveSlide;
    if (!diving) this.diveSpent[id] = 0;
    if (this.lag.newestTick < 0) return;
    const viewTick = this.lag.viewTickFor(simTick, rttMs, this.interpDelayMs);

    // Grab with no target is the empty-handed reach pose, i.e. the sim's own query missed.
    const reaching = s.state === CharacterState.Grab && s.grabTarget < 0;
    if (
      grab &&
      this.grabAge[id]! <= this.grabWindowSteps &&
      (reaching || FREE_STATES.has(s.state)) &&
      sim.assistGrab
    ) {
      const c = this.center;
      const range = DEFAULT_TUNING.grabRange;
      c.x = s.pos.x + Math.sin(s.facing) * range;
      c.y = s.pos.y + 0.1;
      c.z = s.pos.z + Math.cos(s.facing) * range;
      const target = this.nearest(sim, id, peers, viewTick, c, this.grabReach, range + this.grabReach);
      if (target >= 0 && sim.assistGrab(id, target)) {
        this.counters.grabs++;
        this.grabAge[id] = NEVER;
      }
    }

    if (diving && !this.diveSpent[id] && sim.assistTackle) {
      const speed = Math.hypot(s.vel.x, s.vel.z);
      if (speed < DEFAULT_TUNING.diveHitThreshold) return;
      const victim = this.nearest(
        sim,
        id,
        peers,
        viewTick,
        s.pos,
        this.tackleReach,
        this.tackleReach + this.maxCatchUp,
      );
      if (victim >= 0 && sim.assistTackle(id, victim, speed)) {
        this.counters.tackles++;
        this.diveSpent[id] = 1;
      }
    }
  }

  /**
   * The peer whose REWOUND position is nearest `at` within `reach`, and whose
   * present position is still within `presentReach` of the actor.
   */
  private nearest(
    sim: MatchSim,
    id: number,
    peers: readonly number[],
    viewTick: number,
    at: Vec3,
    reach: number,
    presentReach: number,
  ): number {
    const self = this.self;
    const p = this.rewound;
    const o = this.other;
    let best = -1;
    let bestD = reach;
    const presentLimit = presentReach + this.maxCatchUp;
    this.lag.rewind(viewTick, (view) => {
      for (const peer of peers) {
        if (peer === id || !view.position(peer, p)) continue;
        const d = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z);
        if (d > bestD) continue;
        if (!sim.getPlayerState(peer, o) || NOT_HITTABLE.has(o.state)) continue;
        const now = Math.hypot(o.pos.x - self.pos.x, o.pos.y - self.pos.y, o.pos.z - self.pos.z);
        if (now > presentLimit) continue;
        best = peer;
        bestD = d;
      }
    });
    return best;
  }
}
