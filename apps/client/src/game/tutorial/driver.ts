/**
 * Scripted Tumbler driving for Practice Island: the coach's demonstrations and
 * the `?autoplay=1` pilot. Deliberately simpler than the show bot brain — no
 * skill noise, no silly moments — so a demo looks the same every time and the
 * e2e autopilot is reproducible.
 *
 * A {@link RouteFollower} walks a waypoint chain cut from the round's bot nav
 * (the same `jump` / `jumpDive` / climb-press conventions the brain uses):
 * steer at the current node, and on arrival fire the node's action for the
 * leg that starts there.
 */
import type { Vec3, Waypoint } from '@tumble/shared';
import { Button, CharacterState, type CharacterInput, type CharacterStateId } from '@tumble/sim';

/** Ticks the jump button is held for a full-height jump (matches the bot brain). */
const JUMP_HOLD = 14;
/** Ticks after a jump before the dive press of a jump+dive (near the apex). */
const DIVE_DELAY = 14;
/** A Tumbler that has not closed in on its target for this long hops to unstick. */
const STUCK_HOP_TICKS = 150;

/** What the driver needs to know about its Tumbler each step. */
export interface DriverSelf {
  pos: Vec3;
  state: CharacterStateId;
  grounded: boolean;
}

/**
 * Cuts the chain of waypoints from `fromId` (following each node's first
 * successor) up to, but not including, `untilId`.
 *
 * @param nav - Round bot nav.
 * @param fromId - First waypoint.
 * @param untilId - Stop before this id (or at the chain's end).
 */
export function routeBetween(nav: readonly Waypoint[], fromId: number, untilId: number | null): Waypoint[] {
  const byId = new Map(nav.map((w) => [w.id, w]));
  const out: Waypoint[] = [];
  let cur = byId.get(fromId);
  const seen = new Set<number>();
  while (cur && cur.id !== untilId && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    const next = cur.next[0];
    cur = next === undefined ? undefined : byId.get(next);
  }
  return out;
}

/** Writes steering toward `target` into `out` (camera yaw = heading, push forward). */
export function steerTo(self: Vec3, target: Vec3, out: CharacterInput, speed = 1): number {
  const dx = target.x - self.x;
  const dz = target.z - self.z;
  const d = Math.hypot(dx, dz);
  if (d > 1e-3) out.yaw = Math.atan2(dx, dz);
  out.moveX = 0;
  out.moveZ = d < 0.35 ? 0 : Math.min(1, speed, d * 1.5);
  return d;
}

/**
 * Walks a waypoint chain, then a final stand point.
 *
 * @example
 * const f = new RouteFollower(routeBetween(round.botNav, 200, 300), station.end);
 * // each fixed step
 * if (f.step(self, tick, input) === 'done') idle();
 */
export class RouteFollower {
  private i = 0;
  private jumpUntil = -1;
  private diveAt = -1;
  private hangTicks = 0;
  private bestDist = Infinity;
  private lastProgress = 0;
  /** Ticks since the last progress (for stuck reporting). */
  stalled = 0;

  /**
   * @param nodes - Waypoints to visit in order.
   * @param finalStand - Where to stop after the last waypoint (null = stop at it).
   */
  constructor(
    private readonly nodes: readonly Waypoint[],
    private readonly finalStand: Vec3 | null,
  ) {}

  /** True once every waypoint has been reached (the final stand may remain). */
  get routeDone(): boolean {
    return this.i >= this.nodes.length;
  }

  /** Restarts from the node nearest `pos` that is not behind it (after a respawn). */
  resync(pos: Vec3): void {
    let best = this.i;
    let bestD = Infinity;
    for (let k = 0; k < this.nodes.length; k++) {
      const p = (this.nodes[k] as Waypoint).position;
      const d =
        Math.hypot(p.x - pos.x, p.z - pos.z) + Math.max(0, pos.z - p.z) * 3 + Math.abs(p.y - pos.y) * 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    this.i = best;
    this.jumpUntil = -1;
    this.diveAt = -1;
    this.bestDist = Infinity;
  }

  /**
   * One fixed step of driving.
   *
   * @param self - The Tumbler's state.
   * @param tick - Monotonic step counter.
   * @param out - Input to fill (buttons are overwritten).
   * @returns `done` once standing at the end, else `running`.
   */
  step(self: DriverSelf, tick: number, out: CharacterInput): 'running' | 'done' {
    out.buttons = 0;
    out.emote = 0;
    if (self.state === CharacterState.LedgeHang) {
      // Hanging on a lip: press jump in short pulses (presses are edge-triggered) to haul up.
      this.hangTicks++;
      if (this.hangTicks % 18 < 4) out.buttons |= Button.Jump;
      out.moveZ = 1;
      out.moveX = 0;
      return 'running';
    }
    this.hangTicks = 0;

    let target: Vec3 | null = null;
    let radius = 0.5;
    let last = false;
    while (this.i < this.nodes.length) {
      const w = this.nodes[this.i] as Waypoint;
      const dx = w.position.x - self.pos.x;
      const dz = w.position.z - self.pos.z;
      const dy = w.position.y - self.pos.y;
      if (dx * dx + dz * dz < w.radius * w.radius && dy < 2.2 && dy > -3.5) {
        this.fire(w.action, tick);
        this.i++;
        this.bestDist = Infinity;
        continue;
      }
      target = w.position;
      radius = w.radius;
      break;
    }
    if (!target) {
      if (!this.finalStand) return 'done';
      target = this.finalStand;
      radius = 0.45;
      last = true;
    }
    const d = steerTo(self.pos, target, out, last ? 0.8 : 1);
    if (tick < this.jumpUntil) out.buttons |= Button.Jump;
    if (this.diveAt >= 0 && tick >= this.diveAt && tick < this.diveAt + 3) out.buttons |= Button.Dive;

    if (d < this.bestDist - 0.25) {
      this.bestDist = d;
      this.lastProgress = tick;
    }
    this.stalled = tick - this.lastProgress;
    if (this.stalled > STUCK_HOP_TICKS && self.grounded && this.stalled % 60 === 0)
      this.jumpUntil = tick + JUMP_HOLD;
    if (last && d <= radius) {
      out.moveZ = 0;
      return 'done';
    }
    return 'running';
  }

  private fire(action: Waypoint['action'], tick: number): void {
    switch (action) {
      case 'jump':
        this.jumpUntil = tick + JUMP_HOLD;
        break;
      case 'jumpDive':
        this.jumpUntil = tick + JUMP_HOLD;
        this.diveAt = tick + DIVE_DELAY;
        break;
      case 'dive':
        this.diveAt = tick;
        break;
      default:
        break;
    }
  }
}
