/**
 * The live party on the main-menu platform: fellow members' Tumblers posed
 * from their `party_lobby` frames, everyone's nameplate (Name#tag, leader
 * crown, ready chip), and the local Tumbler's frames going out.
 *
 * Responsibilities:
 * - roster → slots ({@link assignLobbySlots}); the local player stands on
 *   its own slot, not always the centre;
 * - spawn (drop-in, squash, puff) and despawn (swell, shrink, puff) as
 *   members join, leave or are kicked; members already there when the menu
 *   opens are simply standing;
 * - remote poses through {@link LobbyInterpolation} plus light smoothing;
 *   live re-skins from looks carried in frames or fetched profile cards;
 * - the local send cadence ({@link LobbyFrameSender}) with the hangout
 *   extras: menu status, grab target, the leader's ball, a member's bump;
 * - status chips (Leader / Ready / Not ready / In Locker / In Store / …)
 *   and a ring under the local Tumbler so you always know which one is you;
 * - queries the menu needs for toys and roughhousing: who is in reach for
 *   a grab, who is holding us, whose dive hit us, the leader's ball;
 * - picking a member's Tumbler for the profile card;
 * - the lobby mini-game link: the leader's game snapshot and members'
 *   claims ride on frames (the leader sends at least every
 *   `LOBBY_GAME_LIMITS.sendMs` while a game runs), and game chips (team,
 *   IT, OUT) replace the status chip on nameplates.
 *
 * Allocation-free per frame; spawns allocate once per member.
 */
import {
  LOBBY_GAME_LIMITS,
  encodeLobbyFrame,
  sanitizeLobbyFrame,
  type LobbyGameClaim,
  type LobbyGameWire,
  type LobbyExtras,
  type LobbyLook,
  type LobbyStatus,
  type LobbyPose,
  type PartyLobbyFrame,
  type PartyLobbyMessage,
} from '@tumble/shared';
import { CharacterState } from '@tumble/sim/character';
import {
  NameplateSet,
  TumblerActor,
  defaultLoadout,
  tumblerFactory,
  type CreateTumblerVisual,
  type TumblerLoadout,
} from '@tumble/render/scenes';
import {
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Raycaster,
  RingGeometry,
  Vector2,
  type Camera,
  type Object3D,
  type Scene,
} from 'three/webgpu';
import {
  LOBBY_SLOT_POSITIONS,
  LobbyFrameSender,
  LobbyInterpolation,
  assignLobbySlots,
  framePoints,
  slotFacing,
  statusChip,
  type BallState,
  type LobbyFraming,
  type LobbyMember,
  type PartyRoster,
} from './partyLobby.ts';

/** The realtime gateway as the lobby uses it. */
export interface PartyLobbyLink {
  /** Sends a frame (dropped while disconnected). */
  send(msg: PartyLobbyMessage): void;
  /** Subscribes to fellow members' frames. */
  onFrame(fn: (userId: string, frame: PartyLobbyFrame) => void): () => void;
  /** Subscribes to (re)connects. */
  onOpen(fn: () => void): () => void;
}

/** What the local Tumbler is doing this frame. */
export interface LocalLobbyState {
  /** Pose to send (already in platform coordinates). */
  pose: LobbyPose;
  /** Where the local nameplate goes (feet). */
  feet: { x: number; y: number; z: number };
}

/** Options for {@link PartyLobbyView}. */
export interface PartyLobbyViewOptions {
  scene: Scene;
  createTumbler: CreateTumblerVisual;
  link: PartyLobbyLink | null;
  /** Spawn/despawn puff at a feet position. */
  poof(at: { x: number; y: number; z: number }): void;
  /** A member joined while the menu was open (the local Tumbler waves). */
  onJoin?(userId: string): void;
  /** The leader, local or remote, changed menu status (`queue` = they hit Play). */
  onLeaderStatus?(status: LobbyStatus): void;
  /** Leader only: a member knocked the shared ball to this velocity. */
  onBump?(vx: number, vy: number, vz: number): void;
  /** Members: a frame from the leader arrived, with its game snapshot or null. */
  onLeaderGame?(game: LobbyGameWire | null): void;
  /** Leader only: a member's game claim. */
  onClaim?(userId: string, claim: LobbyGameClaim): void;
}

const DROP_HEIGHT = 3.2;
const GRAVITY = 24;
const DESPAWN_S = 0.45;
/** No frame for this long: the member is shown standing back on their slot. */
const STALE_MS = 10_000;
const PLATE_HEIGHT = 2.35;
/** Leader's ball updates while it rolls (ms between frames). */
const BALL_SEND_MS = 150;
const DIVE_HIT_RADIUS = 1.1;
const GRAB_HOLD_OFFSET = 0.85;
/** A holder sends at least every 100 ms while holding; this much silence means they are gone. */
const HOLD_STALE_MS = 1000;

interface Remote {
  userId: string;
  slot: number;
  actor: TumblerActor;
  holder: Group;
  buf: LobbyInterpolation;
  pose: LobbyPose;
  /** Drop-in height above the feet (m), and its fall speed. */
  drop: number;
  dropV: number;
  /** Seconds into the despawn, or -1 while present. */
  despawnT: number;
  lastState: number;
  look: TumblerLoadout | null;
  seen: boolean;
  status: LobbyStatus;
  /** Member this one is holding. */
  grab: string | null;
  /** Seconds before this member's dive can knock us again. */
  hitCooldown: number;
}

const idlePose = (): LobbyPose => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  state: CharacterState.Idle,
  speed: 0,
  vy: 0,
  grounded: true,
  emote: null,
});

/** Plain look for the wire (the loadout object may carry extra fields). */
export function toLobbyLook(l: TumblerLoadout): LobbyLook {
  return {
    colors: [l.colors[0], l.colors[1], l.colors[2]],
    pattern: l.pattern,
    face: l.face,
    upper: l.upper,
    lower: l.lower,
    headwear: l.headwear,
    back: l.back,
    emotes: [l.emotes[0], l.emotes[1], l.emotes[2], l.emotes[3]],
    celebration: l.celebration,
    victoryPose: l.victoryPose,
    nameplate: l.nameplate,
    trail: l.trail,
  };
}

/**
 * The live party layer of the menu lobby.
 *
 * @example
 * const party = new PartyLobbyView({ scene, createTumbler, link, poof });
 * party.setRoster(roster);
 * party.update(dt, performance.now(), local);
 */
export class PartyLobbyView {
  private readonly factory: CreateTumblerVisual;
  private readonly remotes = new Map<string, Remote>();
  /** Same members as {@link remotes}, for allocation-free per-frame iteration. */
  private readonly list: Remote[] = [];
  private readonly plates = new NameplateSet({ capacity: LOBBY_SLOT_POSITIONS.length, width: 1.9 });
  private readonly sender = new LobbyFrameSender();
  private readonly looks = new Map<string, TumblerLoadout>();
  private readonly offs: (() => void)[] = [];
  private roster: PartyRoster | null = null;
  private self = { slot: 0, live: false };
  private opened = false;
  private visible = true;
  private equipped: LobbyLook | null = null;
  private selfLook: TumblerLoadout | null = null;
  private selfStatus: LobbyStatus = 'menu';
  private readonly extras: LobbyExtras = {};
  private ballOut: BallState | null = null;
  private lastBallAt = -Infinity;
  private readonly ballIn: BallState = [0, 0, 0, 0, 0, 0];
  private ballInAt = -Infinity;
  private pendingBump: [number, number, number] | null = null;
  private gameSource: (() => LobbyGameWire | null) | null = null;
  private lastGameAt = -Infinity;
  private pendingClaim: LobbyGameClaim | null = null;
  private ballEager = false;
  private readonly chips = new Map<string, string>();
  private readonly plateText: string[] = LOBBY_SLOT_POSITIONS.map(() => '');
  private readonly fx = new Float32Array(LOBBY_SLOT_POSITIONS.length);
  private readonly fz = new Float32Array(LOBBY_SLOT_POSITIONS.length);
  private readonly ring: Mesh;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hits: Object3D[] = [];

  constructor(private readonly opts: PartyLobbyViewOptions) {
    this.factory = tumblerFactory(opts.createTumbler);
    opts.scene.add(this.plates.object);
    this.ring = new Mesh(
      new RingGeometry(0.62, 0.78, 40),
      new MeshBasicNodeMaterial({
        color: new Color('#ffe066'),
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.name = 'lobby-you-ring';
    opts.scene.add(this.ring);
    if (opts.link) {
      this.offs.push(
        opts.link.onFrame((userId, frame) => this.receive(userId, frame, performance.now())),
        opts.link.onOpen(() => this.sender.poke()),
      );
    }
  }

  /** True with two or more members: the shared layout is in effect. */
  get live(): boolean {
    return this.self.live;
  }

  /** The local player's slot (0 when solo). */
  get selfSlot(): number {
    return this.self.slot;
  }

  /** Members on the platform, including the local player (1 when solo). */
  /** Other members as drawn here (debug/automation; allocates, never call per frame). */
  debugRemotes(): { userId: string; slot: number; x: number; z: number }[] {
    return this.list.map((r) => ({
      userId: r.userId,
      slot: r.slot,
      x: r.holder.position.x,
      z: r.holder.position.z,
    }));
  }

  get memberCount(): number {
    return this.self.live ? (this.roster?.members.length ?? 1) : 1;
  }

  /**
   * Applies the party (null = offline/solo). Joiners drop in, leavers poof;
   * on the first roster everyone already present is simply there.
   */
  setRoster(roster: PartyRoster | null): void {
    const slots = roster ? assignLobbySlots(roster.members, roster.leaderId) : [];
    const live = !!roster && slots.length >= 2 && slots.some((s) => s.userId === roster.selfId);
    this.roster = live ? roster : null;
    const animate = this.opened;
    this.opened = true;
    const keep = new Set<string>();
    if (live) {
      for (const s of slots) {
        if (s.userId === roster.selfId) {
          this.self.slot = s.slot;
          continue;
        }
        keep.add(s.userId);
        const r = this.remotes.get(s.userId);
        if (r && r.despawnT < 0) {
          r.slot = s.slot;
          if (!r.seen) this.placeHome(r);
        } else {
          this.spawn(s.userId, s.slot, animate);
          if (animate) this.opts.onJoin?.(s.userId);
        }
      }
    } else this.self.slot = 0;
    for (const r of this.remotes.values()) if (!keep.has(r.userId) && r.despawnT < 0) this.despawn(r);
    this.self.live = live;
    if (live) {
      // Someone new needs our pose and look now, not at the next keep-alive.
      this.sender.poke();
      if (this.equipped) this.sender.announceLook(this.equipped);
    }
    this.plates.object.visible = live && this.visible;
    this.ring.visible = live && this.visible;
    this.drawPlates();
  }

  /** True when the local player leads a live party (owns the shared ball). */
  get isLeader(): boolean {
    return this.self.live && this.roster?.leaderId === this.roster?.selfId;
  }

  /** The local player's menu status; the party sees it above their Tumbler. */
  setStatus(status: LobbyStatus): void {
    if (status === this.selfStatus) return;
    this.selfStatus = status;
    this.sender.poke();
    this.drawPlates();
    if (this.isLeader) this.opts.onLeaderStatus?.(status);
  }

  /** Who the local Tumbler is holding (null to let go). */
  setGrab(userId: string | null): void {
    if ((this.extras.grab ?? null) === userId) return;
    if (userId) this.extras.grab = userId;
    else delete this.extras.grab;
    this.sender.poke();
  }

  /** Leader: the shared ball's state this frame (read by reference when sending). */
  setBallOut(state: BallState | null): void {
    this.ballOut = state;
  }

  /**
   * Leader: where the game snapshot for each outgoing frame comes from, or
   * null when no game runs. Called only when a frame is actually sent, so
   * the snapshot's op (`event` vs `state`) describes what went on the wire.
   */
  setGameSource(source: (() => LobbyGameWire | null) | null): void {
    if (source && !this.gameSource) this.sender.poke();
    this.gameSource = source;
  }

  /** Non-leader: a game claim for the leader to judge (rides on the next frame). */
  claim(c: LobbyGameClaim): void {
    if (!this.self.live || this.isLeader) return;
    this.pendingClaim = c;
    this.sender.poke();
  }

  /** Leader: keep the ball state flowing even while it rests (a game moved it). */
  setBallEager(on: boolean): void {
    this.ballEager = on;
  }

  /**
   * Game chips over members' Tumblers (`PINK`, `IT`, `OUT`); a member
   * without one shows their status chip. Null clears every chip.
   */
  setGameChips(chips: ReadonlyMap<string, string> | null): void {
    let same = (chips?.size ?? 0) === this.chips.size;
    if (same && chips) for (const [k, v] of chips) if (this.chips.get(k) !== v) same = false;
    if (same) return;
    this.chips.clear();
    if (chips) for (const [k, v] of chips) this.chips.set(k, v);
    this.drawPlates();
  }

  /** Party members in slot order (the local player included); empty when not live. */
  memberIds(): string[] {
    const r = this.roster;
    if (!this.self.live || !r) return [];
    return assignLobbySlots(r.members, r.leaderId).map((s) => s.userId);
  }

  /** The local account id while live, else null. */
  get selfId(): string | null {
    return this.self.live ? (this.roster?.selfId ?? null) : null;
  }

  /** The party leader's id while live, else null. */
  get leaderId(): string | null {
    return this.self.live ? (this.roster?.leaderId ?? null) : null;
  }

  /** A member's display name ('' when unknown). */
  memberName(userId: string): string {
    return this.roster?.members.find((m) => m.userId === userId)?.name ?? '';
  }

  /** A member's main colour (their look), or null when unknown. */
  memberColor(userId: string): string | null {
    if (userId === this.roster?.selfId) return this.selfLook?.colors[0] ?? null;
    return this.looks.get(userId)?.colors[0] ?? null;
  }

  /** A remote member's menu status (`menu` when unknown or local). */
  memberStatus(userId: string): LobbyStatus {
    const r = this.remotes.get(userId);
    return r && r.despawnT < 0 ? r.status : 'menu';
  }

  /**
   * Where a remote member's feet are drawn.
   *
   * @returns False when they are not on the platform.
   */
  memberFeet(userId: string, out: { x: number; y: number; z: number }): boolean {
    const r = this.remotes.get(userId);
    if (!r || r.despawnT >= 0) return false;
    out.x = r.holder.position.x;
    out.y = r.holder.position.y;
    out.z = r.holder.position.z;
    return true;
  }

  /**
   * The nearest member within `reach` of a point, ignoring facing (a dive
   * that reaches someone tags them whichever way they face).
   *
   * @param skip - Optional filter: members it returns true for are ignored.
   */
  memberNear(x: number, z: number, reach: number, skip?: (userId: string) => boolean): string | null {
    let best: string | null = null;
    let bestD = reach;
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!;
      if (r.despawnT >= 0 || skip?.(r.userId)) continue;
      const d = Math.hypot(r.holder.position.x - x, r.holder.position.z - z);
      if (d > bestD) continue;
      best = r.userId;
      bestD = d;
    }
    return best;
  }

  /** Non-leader: the local Tumbler knocked the ball; the leader applies the new velocity. */
  bump(vx: number, vy: number, vz: number): void {
    if (!this.self.live || this.isLeader) return;
    this.pendingBump = [vx, vy, vz];
    this.sender.poke();
  }

  /**
   * Non-leader: the leader's latest ball state.
   *
   * @param now - `performance.now()` (ms).
   * @param out - Receives the state.
   * @returns Its age in seconds, or -1 when there is none (or we lead).
   */
  ballTarget(now: number, out: BallState): number {
    if (!this.self.live || this.isLeader || this.ballInAt === -Infinity) return -1;
    for (let i = 0; i < 6; i++) out[i] = this.ballIn[i]!;
    return (now - this.ballInAt) / 1000;
  }

  /** A member's current (interpolated) `CharacterState`, or -1 when absent. */
  memberState(userId: string): number {
    const r = this.remotes.get(userId);
    return r && r.despawnT < 0 ? r.pose.state : -1;
  }

  /** The member whose frames say they are holding the local player, if any. */
  holderOfSelf(): string | null {
    const self = this.roster?.selfId;
    if (!self) return null;
    const now = performance.now();
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!;
      // A holder whose frames stopped (closed the menu mid-grab) no longer holds anyone.
      if (r.despawnT < 0 && r.grab === self && now - r.buf.newestAt < HOLD_STALE_MS) return r.userId;
    }
    return null;
  }

  /**
   * The nearest member in front of a point within `reach` (grab target).
   *
   * @param facing - Yaw the grabber faces (radians).
   */
  memberInReach(x: number, z: number, facing: number, reach: number): string | null {
    const fx = Math.sin(facing);
    const fz = Math.cos(facing);
    let best: string | null = null;
    let bestD = reach;
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!;
      if (r.despawnT >= 0) continue;
      const dx = r.holder.position.x - x;
      const dz = r.holder.position.z - z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || (d > 0.05 && (dx * fx + dz * fz) / d < 0.3)) continue;
      best = r.userId;
      bestD = d;
    }
    return best;
  }

  /**
   * Where a member holds what they grab: in front of their chest.
   *
   * @returns False when the member is not on the platform.
   */
  holdPoint(userId: string, out: { x: number; y: number; z: number }): boolean {
    const r = this.remotes.get(userId);
    if (!r || r.despawnT >= 0) return false;
    const h = r.holder.position;
    out.x = h.x + Math.sin(r.pose.yaw) * GRAB_HOLD_OFFSET;
    out.y = h.y + 0.35;
    out.z = h.z + Math.cos(r.pose.yaw) * GRAB_HOLD_OFFSET;
    return true;
  }

  /**
   * A member diving into the point: writes the push direction (away from the
   * diver) and starts that diver's cooldown.
   *
   * @returns True on a hit.
   */
  diveHit(x: number, z: number, out: { x: number; z: number }): boolean {
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i]!;
      if (r.despawnT >= 0 || r.hitCooldown > 0) continue;
      if (r.pose.state !== CharacterState.Dive || r.pose.speed < 2) continue;
      const dx = x - r.holder.position.x;
      const dz = z - r.holder.position.z;
      const d = Math.hypot(dx, dz);
      if (d > DIVE_HIT_RADIUS) continue;
      r.hitCooldown = 1.2;
      out.x = d > 0.01 ? dx / d : Math.sin(r.pose.yaw);
      out.z = d > 0.01 ? dz / d : Math.cos(r.pose.yaw);
      return true;
    }
    return false;
  }

  /**
   * Centre and spread of everyone actually on the platform (live positions),
   * so the camera keeps the whole party in frame as they wander.
   *
   * @param x - Local Tumbler feet X.
   * @param z - Local Tumbler feet Z.
   * @param out - Reused result.
   */
  groupFraming(x: number, z: number, out: LobbyFraming): LobbyFraming {
    let n = 0;
    this.fx[n] = x;
    this.fz[n++] = z;
    if (this.self.live) {
      for (let i = 0; i < this.list.length && n < this.fx.length; i++) {
        const r = this.list[i]!;
        if (r.despawnT >= 0 || !r.holder.visible) continue;
        this.fx[n] = r.holder.position.x;
        this.fz[n++] = r.holder.position.z;
      }
    }
    return framePoints(this.fx, this.fz, n, out);
  }

  /** A member's look from their profile card (initial skin). Frames' looks win later. */
  setLook(userId: string, look: TumblerLoadout): void {
    if (this.looks.has(userId) && this.remotes.get(userId)?.look) return;
    this.applyLook(userId, look);
  }

  /** The local player's equipped look changed: party mates re-skin. */
  setEquippedLook(look: TumblerLoadout): void {
    const next = toLobbyLook(look);
    const prev = this.equipped;
    this.equipped = next;
    this.selfLook = look;
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    if (this.self.live) this.sender.announceLook(next);
    this.drawPlates();
  }

  /** Dressing room: party and plates step out of the close-up. */
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    for (const r of this.remotes.values()) r.holder.visible = on;
    this.plates.object.visible = on && this.self.live;
    this.ring.visible = on && this.self.live;
  }

  /** Home feet position of the local player. */
  selfHome(): { readonly x: number; readonly z: number } {
    return LOBBY_SLOT_POSITIONS[this.self.slot] ?? LOBBY_SLOT_POSITIONS[0]!;
  }

  /** Facing for the local player standing on its slot. */
  selfHomeYaw(): number {
    return slotFacing(this.self.slot);
  }

  /**
   * The party member whose Tumbler is under a screen point.
   *
   * @param ndcX - Normalised device X (-1..1).
   * @param ndcY - Normalised device Y (-1..1, up).
   * @returns The member, or null (empty stage, the local player, solo).
   */
  memberAt(ndcX: number, ndcY: number, camera: Camera): LobbyMember | null {
    if (!this.self.live || !this.visible) return null;
    this.hits.length = 0;
    for (const r of this.remotes.values()) if (r.despawnT < 0) this.hits.push(r.holder);
    this.raycaster.setFromCamera(this.ndc.set(ndcX, ndcY), camera);
    const hit = this.raycaster.intersectObjects(this.hits, true)[0];
    if (!hit) return null;
    for (const r of this.remotes.values()) {
      let o: Object3D | null = hit.object;
      while (o && o !== r.holder) o = o.parent;
      if (o) return this.roster?.members.find((m) => m.userId === r.userId) ?? null;
    }
    return null;
  }

  /**
   * Advances remote members, plates and the local send.
   *
   * @param dt - Frame delta (s).
   * @param now - `performance.now()` (ms).
   * @param local - Local Tumbler state, or null while it should not be sent.
   */
  update(dt: number, now: number, local: LocalLobbyState | null): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.updateRemote(this.list[i]!, dt, now);
    if (!this.self.live) return;
    if (local) {
      const f = local.feet;
      this.plates.setPosition(this.self.slot, f.x, f.y + PLATE_HEIGHT, f.z);
      this.ring.position.set(f.x, Math.max(0, f.y) + 0.04, f.z);
      const link = this.opts.link;
      const ball = this.isLeader ? this.ballOut : null;
      if (
        ball &&
        now - this.lastBallAt >= BALL_SEND_MS &&
        (this.ballEager || Math.hypot(ball[3], ball[4], ball[5]) > 0.05)
      )
        this.sender.poke();
      const gameSource = this.isLeader ? this.gameSource : null;
      if (gameSource && now - this.lastGameAt >= LOBBY_GAME_LIMITS.sendMs) this.sender.poke();
      if (link && this.sender.due(now, local.pose)) {
        const { seq, look } = this.sender.take(now, local.pose);
        const x = this.extras;
        if (this.selfStatus !== 'menu') x.status = this.selfStatus;
        else delete x.status;
        if (ball) {
          x.ball = ball;
          this.lastBallAt = now;
        } else delete x.ball;
        if (this.pendingBump) x.bump = this.pendingBump;
        else delete x.bump;
        this.pendingBump = null;
        const game = gameSource?.() ?? null;
        if (game) {
          x.game = game;
          this.lastGameAt = now;
        } else delete x.game;
        if (this.pendingClaim) x.claim = this.pendingClaim;
        else delete x.claim;
        this.pendingClaim = null;
        link.send(encodeLobbyFrame(local.pose, seq, look, x));
      }
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    for (const r of this.remotes.values()) this.free(r);
    this.remotes.clear();
    this.plates.dispose();
    this.ring.removeFromParent();
    this.ring.geometry.dispose();
    (this.ring.material as MeshBasicNodeMaterial).dispose();
  }

  // ---------------------------------------------------------------------------
  // Remote members
  // ---------------------------------------------------------------------------

  private receive(userId: string, raw: PartyLobbyFrame, now: number): void {
    const r = this.remotes.get(userId);
    if (!r || r.despawnT >= 0) return;
    // Already clamped by the gateway; re-checked so a bad relay can never break the scene.
    const frame = sanitizeLobbyFrame(raw, () => true);
    if (!frame) return;
    if (!r.seen) {
      r.seen = true;
      r.buf.reset(frame, now);
    } else r.buf.push(frame, now);
    if (frame.look) this.applyLook(userId, frame.look);
    r.grab = frame.grab ?? null;
    const leaderId = this.roster?.leaderId;
    const status = frame.status ?? 'menu';
    if (status !== r.status) {
      r.status = status;
      this.drawPlates();
      if (userId === leaderId) this.opts.onLeaderStatus?.(status);
    }
    if (frame.ball && userId === leaderId && !this.isLeader) {
      for (let i = 0; i < 6; i++) this.ballIn[i] = frame.ball[i]!;
      this.ballInAt = now;
    }
    if (frame.bump && this.isLeader) this.opts.onBump?.(frame.bump[0], frame.bump[1], frame.bump[2]);
    if (userId === leaderId && !this.isLeader) this.opts.onLeaderGame?.(frame.game ?? null);
    if (frame.claim && this.isLeader) this.opts.onClaim?.(userId, frame.claim);
  }

  private applyLook(userId: string, look: TumblerLoadout): void {
    this.looks.set(userId, look);
    const r = this.remotes.get(userId);
    if (r) {
      r.look = look;
      r.actor.visual.setLoadout(look);
    }
    this.drawPlates();
  }

  private spawn(userId: string, slot: number, animate: boolean): void {
    const old = this.remotes.get(userId);
    // A leaver who rejoins mid-despawn: finish the old body at once.
    if (old) this.free(old);
    const look = this.looks.get(userId) ?? null;
    const actor = new TumblerActor(this.factory, look ?? defaultLoadout());
    const holder = new Group();
    holder.add(actor.object);
    holder.visible = this.visible;
    this.opts.scene.add(holder);
    const r: Remote = {
      userId,
      slot,
      actor,
      holder,
      buf: new LobbyInterpolation(),
      pose: idlePose(),
      drop: animate ? DROP_HEIGHT : 0,
      dropV: 0,
      despawnT: -1,
      lastState: -1,
      look,
      seen: false,
      status: 'menu',
      grab: null,
      hitCooldown: 0,
    };
    this.remotes.set(userId, r);
    this.list.push(r);
    this.placeHome(r);
    holder.position.set(r.pose.x, 0, r.pose.z);
    if (animate) actor.object.scale.set(0.75, 1.3, 0.75);
  }

  private placeHome(r: Remote): void {
    const home = LOBBY_SLOT_POSITIONS[r.slot] ?? LOBBY_SLOT_POSITIONS[0]!;
    const p = r.pose;
    p.x = home.x;
    p.y = 0;
    p.z = home.z;
    p.yaw = slotFacing(r.slot);
    p.state = CharacterState.Idle;
    p.speed = 0;
    p.vy = 0;
    p.grounded = true;
    p.emote = null;
    r.buf.reset(p, performance.now());
  }

  private despawn(r: Remote): void {
    r.despawnT = 0;
    r.buf.clear();
    this.opts.poof(r.holder.position);
  }

  private free(r: Remote): void {
    r.actor.dispose();
    r.holder.removeFromParent();
    if (this.remotes.get(r.userId) === r) this.remotes.delete(r.userId);
    const i = this.list.indexOf(r);
    if (i >= 0) this.list.splice(i, 1);
  }

  private updateRemote(r: Remote, dt: number, now: number): void {
    const obj = r.actor.object;
    if (r.despawnT >= 0) {
      r.despawnT += dt;
      const k = Math.min(1, r.despawnT / DESPAWN_S);
      // Brief swell, then shrink to nothing while spinning.
      const s = k < 0.2 ? 1 + k * 0.6 : Math.max(0.001, 1.12 * (1 - (k - 0.2) / 0.8));
      obj.scale.setScalar(s);
      obj.rotation.y += dt * 14 * k;
      r.actor.update(dt);
      if (k >= 1) this.free(r);
      return;
    }
    r.hitCooldown = Math.max(0, r.hitCooldown - dt);
    if (r.seen && now - r.buf.newestAt > STALE_MS) {
      r.seen = false;
      this.placeHome(r);
    }
    r.buf.sample(now, r.pose);
    const p = r.pose;
    const h = r.holder.position;
    const dx = p.x - h.x;
    const dz = p.z - h.z;
    if (dx * dx + dz * dz > 4) h.set(p.x, p.y, p.z);
    else {
      // Interpolated frames are already smooth; this only takes the edge off arrival jitter.
      const k = 1 - Math.exp(-dt * 18);
      h.x += dx * k;
      h.y += (p.y - h.y) * k;
      h.z += dz * k;
    }

    if (r.drop > 0) {
      r.dropV += GRAVITY * dt;
      r.drop = Math.max(0, r.drop - r.dropV * dt);
      obj.position.y = r.drop;
      if (r.drop === 0) {
        r.actor.kick(0.9);
        obj.scale.setScalar(1);
        this.opts.poof(h);
      }
    }

    const a = r.actor.anim;
    const emoting = p.state === CharacterState.Emote && p.emote !== null;
    const state = p.state === CharacterState.Emote && !emoting ? CharacterState.Idle : p.state;
    if (state !== r.lastState) {
      if (r.lastState === CharacterState.Fall && p.grounded) a.impulse = 0.6;
      r.lastState = state;
      a.stateTime = 0;
    }
    a.state = state;
    a.speed = p.speed;
    a.verticalSpeed = r.drop > 0 ? -r.dropV : p.vy;
    a.facing = p.yaw;
    a.grounded = p.grounded && r.drop === 0;
    a.emote = emoting ? p.emote : null;
    r.actor.update(dt);
    this.plates.setPosition(r.slot, h.x, h.y + r.drop + PLATE_HEIGHT, h.z);
  }

  // ---------------------------------------------------------------------------
  // Nameplates
  // ---------------------------------------------------------------------------

  /** Redraws plates whose text changed (canvas work, so never per frame). */
  private drawPlates(): void {
    const roster = this.roster;
    const used = new Set<number>();
    if (roster) {
      for (const s of assignLobbySlots(roster.members, roster.leaderId)) {
        const m = roster.members.find((x) => x.userId === s.userId)!;
        const self = m.userId === roster.selfId;
        const look = self ? this.selfLook : this.looks.get(m.userId);
        const status = self ? this.selfStatus : (this.remotes.get(m.userId)?.status ?? 'menu');
        const label = `${s.leader ? '👑 ' : ''}${m.name}${m.tag ? `#${m.tag}` : ''}`;
        const chip = this.chips.get(m.userId) ?? statusChip(status, s.leader, m.ready);
        const accent = look?.colors[0] ?? '#ff6fb5';
        const key = `${label}|${chip}|${accent}`;
        used.add(s.slot);
        if (this.plateText[s.slot] === key) continue;
        this.plateText[s.slot] = key;
        this.plates.setName(s.slot, label, accent, chip);
        this.plates.setScale(s.slot, 1);
      }
    }
    for (let i = 0; i < this.plateText.length; i++) {
      if (used.has(i) || this.plateText[i] === '') continue;
      this.plateText[i] = '';
      this.plates.setScale(i, 0);
    }
  }
}
