/**
 * Party lobby logic (no three.js, no DOM): what every member's main menu
 * agrees on and how poses travel.
 *
 * Responsibilities:
 * - {@link assignLobbySlots}: deterministic platform slots from party state
 *   alone, so every member's screen puts the same Tumbler in the same place;
 * - {@link lobbyFraming}: camera centre/spread for the occupied slots;
 * - {@link LobbyInterpolation}: per-member snapshot buffer rendered a little
 *   in the past, allocation-free after construction;
 * - {@link LobbyFrameSender}: when the local Tumbler's pose is worth sending
 *   (10 Hz while moving, at once on a discrete change, a slow keep-alive);
 * - hangout rules: menu status chips, group framing from live positions,
 *   breaking free of a grab ({@link GrabStruggle}) and steering a
 *   non-leader's copy of the shared ball ({@link steerBall}).
 */
import {
  PARTY_LOBBY_LIMITS,
  PARTY_LOBBY_RATE,
  isNewerLobbySeq,
  type LobbyLook,
  type LobbyStatus,
  type LobbyPose,
  type PartyLobbyFrame,
} from '@tumble/shared';

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

/** A party member as the lobby needs them. */
export interface LobbyMember {
  userId: string;
  name: string;
  tag: string;
  ready: boolean;
  /** Epoch ms the member joined the party (slot order). */
  joinedAt: number;
}

/** The party as the lobby sees it. */
export interface PartyRoster {
  /** The local account. */
  selfId: string;
  leaderId: string;
  members: LobbyMember[];
}

/**
 * Lobby roster from the API party view.
 *
 * @param party - `party_update` / `GET /party` payload, or null.
 * @param selfId - Local account id.
 * @returns Null when there is no party.
 */
export function rosterFromParty(
  party: {
    leaderId: string;
    members: readonly {
      userId: string;
      displayName: string;
      tag: string;
      ready: boolean;
      joinedAt: number;
    }[];
  } | null,
  selfId: string,
): PartyRoster | null {
  if (!party) return null;
  return {
    selfId,
    leaderId: party.leaderId,
    members: party.members.map((m) => ({
      userId: m.userId,
      name: m.displayName,
      tag: m.tag,
      ready: m.ready,
      joinedAt: m.joinedAt,
    })),
  };
}

/** A member placed on the platform. */
export interface LobbySlot {
  userId: string;
  /** 0 = leader (centre), 1–3 = around. */
  slot: number;
  leader: boolean;
}

/** Home positions on the platform, by slot (feet, metres). Slot 0 is the solo spot. */
export const LOBBY_SLOT_POSITIONS: readonly { readonly x: number; readonly z: number }[] = [
  { x: 0, z: 0 },
  { x: -1.9, z: -0.8 },
  { x: 1.9, z: -0.8 },
  { x: -3.6, z: -2.1 },
];

/** Facing (yaw) for a Tumbler standing on a slot: turned slightly toward the centre. */
export function slotFacing(slot: number): number {
  return -(LOBBY_SLOT_POSITIONS[slot]?.x ?? 0) * 0.12;
}

/**
 * Places party members on the platform: the leader in slot 0 (centre), the
 * others by join order (ties broken by id). Depends only on party state, so
 * every member computes the same layout whoever is local.
 *
 * @param members - Party members in any order.
 * @param leaderId - Current leader.
 * @returns At most four slots, ordered by slot.
 * @example
 * assignLobbySlots(party.members, party.leaderId).find((s) => s.userId === me)?.slot;
 */
export function assignLobbySlots(members: readonly LobbyMember[], leaderId: string): LobbySlot[] {
  const leader = members.find((m) => m.userId === leaderId);
  const rest = members
    .filter((m) => m !== leader)
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const ordered = leader ? [leader, ...rest] : rest;
  return ordered.slice(0, LOBBY_SLOT_POSITIONS.length).map((m, slot) => ({
    userId: m.userId,
    slot,
    leader: m.userId === leaderId,
  }));
}

/** Where the lobby camera centres and how far the group spreads. */
export interface LobbyFraming {
  /** Centre of the occupied slots (m). */
  cx: number;
  cz: number;
  /** Largest slot distance from the centre (m); 0 for a solo player. */
  spread: number;
}

/**
 * Camera framing for `count` occupied slots (slots `0..count-1`). Solo gives
 * the origin with no spread, i.e. the classic framing.
 *
 * @param count - Members on the platform.
 * @param out - Reused result object.
 */
export function lobbyFraming(count: number, out: LobbyFraming = { cx: 0, cz: 0, spread: 0 }): LobbyFraming {
  const n = Math.max(1, Math.min(LOBBY_SLOT_POSITIONS.length, count));
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += LOBBY_SLOT_POSITIONS[i]!.x;
    cz += LOBBY_SLOT_POSITIONS[i]!.z;
  }
  cx /= n;
  cz /= n;
  let spread = 0;
  for (let i = 0; i < n; i++)
    spread = Math.max(spread, Math.hypot(LOBBY_SLOT_POSITIONS[i]!.x - cx, LOBBY_SLOT_POSITIONS[i]!.z - cz));
  out.cx = cx;
  out.cz = cz;
  out.spread = spread;
  return out;
}

// -----------------------------------------------------------------------------
// Interpolation
// -----------------------------------------------------------------------------

/** How far behind real time remote members are drawn (ms): 1.5 send intervals of slack. */
export const LOBBY_INTERP_DELAY_MS = 160;
/** A jump this large between snapshots is a teleport (respawn, slot change): snap, don't glide. */
const TELEPORT_M = 3.5;
const CAPACITY = 16;
// A little over the gateway's look interval so clock jitter never gets a look stripped.
const LOOK_GAP_MS = PARTY_LOBBY_LIMITS.lookMinIntervalMs + 150;

interface Snap extends LobbyPose {
  t: number;
}

const newSnap = (): Snap => ({
  t: 0,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  state: 0,
  speed: 0,
  vy: 0,
  grounded: true,
  emote: null,
});

const newSnapScratch: Snap = newSnap();

function copyPose(dst: LobbyPose, src: LobbyPose): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.yaw = src.yaw;
  dst.state = src.state;
  dst.speed = src.speed;
  dst.vy = src.vy;
  dst.grounded = src.grounded;
  dst.emote = src.emote;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

/**
 * Snapshot buffer for one remote member, sampled {@link LOBBY_INTERP_DELAY_MS}
 * in the past and linearly interpolated (yaw along the short arc). Holds the
 * newest pose rather than extrapolating. Discrete fields (state, emote) come
 * from the older snapshot of the pair, so they change exactly when the
 * sender's did, one delay later.
 *
 * @example
 * buf.push(frame, performance.now());
 * buf.sample(performance.now(), anim);
 */
export class LobbyInterpolation {
  private readonly ring: Snap[] = Array.from({ length: CAPACITY }, newSnap);
  private head = 0;
  private count = 0;
  private lastSeq = -1;

  /** Snapshots held. */
  get size(): number {
    return this.count;
  }

  /** Receive time of the newest snapshot (ms), or -Infinity. */
  get newestAt(): number {
    return this.count ? this.at(this.count - 1).t : -Infinity;
  }

  private at(i: number): Snap {
    return this.ring[(this.head + i) % CAPACITY]!;
  }

  private append(pose: LobbyPose, t: number): void {
    const s = this.ring[(this.head + this.count) % CAPACITY]!;
    if (this.count === CAPACITY) this.head = (this.head + 1) % CAPACITY;
    else this.count++;
    copyPose(s, pose);
    s.t = t;
  }

  /**
   * Adds a frame received at `now`. Stale or duplicate sequence numbers are
   * ignored.
   *
   * @returns False when the frame was dropped as out of order.
   */
  push(frame: PartyLobbyFrame, now: number): boolean {
    if (!isNewerLobbySeq(frame.seq, this.lastSeq)) return false;
    this.lastSeq = frame.seq;
    if (this.count) {
      const last = this.at(this.count - 1);
      if (Math.hypot(frame.x - last.x, frame.z - last.z) > TELEPORT_M) this.count = 0;
      else if (now - last.t > PARTY_LOBBY_RATE.movingMs * 2.5) {
        // After a quiet spell (standing still, keep-alives only) the sender
        // started moving: pin the old pose one interval back so the glide
        // starts now instead of skipping most of the way at once.
        const hold = newSnapScratch;
        copyPose(hold, last);
        this.append(hold, now - PARTY_LOBBY_RATE.movingMs);
      }
    }
    this.append(frame, now);
    return true;
  }

  /** Places a pose directly (first sight, slot home), dropping history. */
  reset(pose: LobbyPose, now: number): void {
    this.count = 0;
    this.append(pose, now);
  }

  /** Forgets the sender's sequence (they left; a rejoin starts fresh). */
  clear(): void {
    this.count = 0;
    this.lastSeq = -1;
  }

  /**
   * Writes the pose to show at `now` into `out`.
   *
   * @returns False when nothing has been received yet.
   */
  sample(now: number, out: LobbyPose): boolean {
    if (!this.count) return false;
    const rt = now - LOBBY_INTERP_DELAY_MS;
    // Drop snapshots fully behind the render time, keeping one before it.
    while (this.count > 2 && this.at(1).t <= rt) {
      this.head = (this.head + 1) % CAPACITY;
      this.count--;
    }
    const a = this.at(0);
    if (this.count === 1 || rt <= a.t) {
      copyPose(out, a);
      return true;
    }
    const b = this.at(1);
    if (rt >= b.t && this.count === 2) {
      copyPose(out, b);
      return true;
    }
    const k = Math.min(1, Math.max(0, (rt - a.t) / Math.max(1, b.t - a.t)));
    copyPose(out, a);
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.yaw = lerpAngle(a.yaw, b.yaw, k);
    out.speed = a.speed + (b.speed - a.speed) * k;
    out.vy = a.vy + (b.vy - a.vy) * k;
    return true;
  }
}

// -----------------------------------------------------------------------------
// Sending
// -----------------------------------------------------------------------------

/**
 * Send policy for the local Tumbler: every {@link PARTY_LOBBY_RATE.movingMs}
 * while it moves, immediately (but never closer than `minGapMs`) when its
 * state, emote or grounding changes or a look is pending, and a keep-alive
 * every `heartbeatMs` otherwise. The look rides along until a frame carries it.
 *
 * @example
 * if (sender.due(now, pose)) socket.send(sender.take(now, pose));
 */
export class LobbyFrameSender {
  private readonly last: LobbyPose = newSnap();
  private lastAt = -Infinity;
  private sent = false;
  private seq = 0;
  private look: LobbyLook | null = null;
  private lookAt = -Infinity;
  private force = false;

  /**
   * Queues the equipped look for the next frame that may carry one (equip,
   * or a member joined). Held back while the gateway would still strip it.
   */
  announceLook(look: LobbyLook): void {
    this.look = look;
  }

  private lookReady(now: number): boolean {
    return this.look !== null && now - this.lookAt >= LOOK_GAP_MS;
  }

  /** Sends at the next opportunity regardless of change (roster change, reconnect). */
  poke(): void {
    this.force = true;
  }

  /** True when a frame should go out now. */
  due(now: number, pose: LobbyPose): boolean {
    const gap = now - this.lastAt;
    if (gap < PARTY_LOBBY_RATE.minGapMs) return false;
    if (!this.sent || this.force || this.lookReady(now)) return true;
    const l = this.last;
    if (pose.state !== l.state || pose.emote !== l.emote || pose.grounded !== l.grounded) return true;
    const moved =
      Math.abs(pose.x - l.x) > 0.01 ||
      Math.abs(pose.z - l.z) > 0.01 ||
      Math.abs(pose.y - l.y) > 0.01 ||
      Math.abs(lerpAngle(l.yaw, pose.yaw, 1) - l.yaw) > 0.02;
    if ((moved || pose.speed > 0.05) && gap >= PARTY_LOBBY_RATE.movingMs) return true;
    return gap >= PARTY_LOBBY_RATE.heartbeatMs;
  }

  /**
   * Records a send and returns what to put on the wire.
   *
   * @returns Sequence number and the look to include (null if none pending).
   */
  take(now: number, pose: LobbyPose): { seq: number; look: LobbyLook | null } {
    copyPose(this.last, pose);
    this.lastAt = now;
    this.sent = true;
    this.force = false;
    this.seq = (this.seq + 1) % 2 ** 31;
    if (!this.lookReady(now)) return { seq: this.seq, look: null };
    const look = this.look;
    this.look = null;
    this.lookAt = now;
    return { seq: this.seq, look };
  }
}

// -----------------------------------------------------------------------------
// Hangout
// -----------------------------------------------------------------------------

/** Seconds without input before a member sits down. */
export const AFK_SIT_S = 20;

/**
 * A member's menu status from the UI state: queueing, Locker, Store, away
 * (another tab or an overlay), else in the lobby.
 *
 * @param screen - Current screen id.
 * @param menuTab - Current menu tab.
 * @param overlay - Open overlay (`none` when closed).
 */
export function menuStatus(screen: string, menuTab: string, overlay: string): LobbyStatus {
  if (screen === 'matchmaking') return 'queue';
  if (screen !== 'menu') return 'away';
  if (menuTab === 'locker') return 'locker';
  if (menuTab === 'store') return 'store';
  if (menuTab !== 'play' || (overlay !== 'none' && overlay !== 'friends')) return 'away';
  return 'menu';
}

/**
 * The chip above a member's Tumbler: where they are in the menu first, then
 * their party role or ready state.
 *
 * @param status - Menu status.
 * @param leader - Leads the party.
 * @param ready - Ready flag (leaders are always ready).
 */
export function statusChip(status: LobbyStatus, leader: boolean, ready: boolean): string {
  switch (status) {
    case 'locker':
      return 'IN LOCKER';
    case 'store':
      return 'IN STORE';
    case 'queue':
      return 'SEARCHING';
    case 'away':
      return 'AWAY';
    default:
      return leader ? 'LEADER' : ready ? 'READY' : 'NOT READY';
  }
}

/**
 * Centre and spread of points on the platform (the members' feet), for a
 * camera that keeps the whole party in frame.
 *
 * @param xs - X coordinates.
 * @param zs - Z coordinates.
 * @param n - Points to use.
 * @param out - Reused result.
 */
export function framePoints(
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  n: number,
  out: LobbyFraming,
): LobbyFraming {
  if (n <= 0) {
    out.cx = out.cz = out.spread = 0;
    return out;
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += xs[i]!;
    cz += zs[i]!;
  }
  cx /= n;
  cz /= n;
  let spread = 0;
  for (let i = 0; i < n; i++) spread = Math.max(spread, Math.hypot(xs[i]! - cx, zs[i]! - cz));
  out.cx = cx;
  out.cz = cz;
  out.spread = spread;
  return out;
}

/** Jump presses that break a grab. */
export const GRAB_MASH_PRESSES = 5;
/** A grab lets go on its own after this long (s). */
export const GRAB_MAX_S = 3;

/**
 * Being held by a party member: mash jump to break free, or wait it out.
 *
 * @example
 * if (frame.grab === selfId) struggle.start(senderId);
 * if (jumpPressed) struggle.press();
 * if (struggle.update(dt)) release();
 */
export class GrabStruggle {
  /** Member holding us, or null. */
  by: string | null = null;
  private presses = 0;
  private t = 0;
  /** Seconds after breaking free during which the same grab is ignored (no instant re-grab). */
  private cooldown = 0;

  /**
   * Starts being held.
   *
   * @returns False while still shaking off the previous grab.
   */
  start(by: string): boolean {
    if (this.by || this.cooldown > 0) return false;
    this.by = by;
    this.presses = 0;
    this.t = 0;
    return true;
  }

  /** One jump press while held. */
  press(): void {
    if (this.by) this.presses++;
  }

  /** The holder let go (their frames stopped naming us). */
  release(): void {
    if (!this.by) return;
    this.by = null;
    this.cooldown = 1;
  }

  /**
   * Advances time.
   *
   * @returns True on the frame the grab breaks (mashed free or timed out).
   */
  update(dt: number): boolean {
    if (!this.by) {
      this.cooldown = Math.max(0, this.cooldown - dt);
      return false;
    }
    this.t += dt;
    if (this.presses < GRAB_MASH_PRESSES && this.t < GRAB_MAX_S) return false;
    this.release();
    return true;
  }
}

/** A ball state `[x, y, z, vx, vy, vz]`. */
export type BallState = [number, number, number, number, number, number];

/**
 * Non-leader ball correction: where the local ball should be after `dt`,
 * steering toward the leader's last state extrapolated by its age. Snaps
 * when far off (a reset, a missed bounce), otherwise eases so the ball never
 * visibly teleports.
 *
 * @param local - Local ball state, updated in place.
 * @param target - Leader's last relayed state.
 * @param age - Seconds since that state arrived (capped for extrapolation).
 * @param dt - Frame delta (s).
 */
export function steerBall(local: BallState, target: Readonly<BallState>, age: number, dt: number): void {
  const a = Math.min(age, 0.25);
  const tx = target[0] + target[3] * a;
  const ty = Math.max(target[1], target[1] + target[4] * a);
  const tz = target[2] + target[5] * a;
  const dx = tx - local[0];
  const dy = ty - local[1];
  const dz = tz - local[2];
  if (dx * dx + dy * dy + dz * dz > 2.25) {
    local[0] = tx;
    local[1] = ty;
    local[2] = tz;
  } else {
    const k = 1 - Math.exp(-dt * 8);
    local[0] += dx * k;
    local[1] += dy * k;
    local[2] += dz * k;
  }
  local[3] = target[3];
  local[4] = target[4];
  local[5] = target[5];
}
