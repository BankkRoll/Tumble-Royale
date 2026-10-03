/**
 * Lobby mini-game rules (no three.js, no DOM): Goal Rush, Hot Potato and
 * Target Hop on the menu platform.
 *
 * Responsibilities:
 * - the catalogue ({@link LOBBY_GAME_INFO}) and shared geometry/tuning
 *   (goals, fuse, targets) the view builds from;
 * - {@link LobbyGameHost}: the leader's (or solo player's) authoritative game.
 *   It owns timers, scores, eliminations and the potato, turns validated
 *   claims into events, and produces the snapshot that rides on frames;
 * - {@link LobbyGameTracker}: what changed between two snapshots (a new game,
 *   a fresh event, a phase change, the end), so every client, the leader
 *   included, plays each effect exactly once;
 * - small pure helpers: team split, goal-line test, the target under a
 *   Tumbler's feet, target placement and the winners mask.
 *
 * Determinism is not needed (menu only); what matters is that every member
 * shows the leader's numbers, which the snapshots guarantee.
 */
import {
  LOBBY_GAME_LIMITS,
  type LobbyGameClaim,
  type LobbyGameEvent,
  type LobbyGameEventKind,
  type LobbyGameKind,
  type LobbyGamePhase,
  type LobbyGameWire,
} from '@tumble/shared';

// -----------------------------------------------------------------------------
// Catalogue and tuning
// -----------------------------------------------------------------------------

/** What the picker and the intro card show for a game. */
export interface LobbyGameInfo {
  title: string;
  /** The rules in one line. */
  rule: string;
  /** Fewest players on the platform for the game to make sense. */
  minPlayers: number;
  /** Length of the play phase (s); 0 when the game ends on its own (Hot Potato). */
  playS: number;
}

/** The lobby mini-games, in picker order. */
export const LOBBY_GAME_INFO: Readonly<Record<LobbyGameKind, LobbyGameInfo>> = {
  goal: {
    title: 'Goal Rush',
    rule: 'Push or dive the ball into the other goal. First to 3 wins.',
    minPlayers: 1,
    playS: 90,
  },
  potato: {
    title: 'Hot Potato',
    rule: 'Grab or dive into someone to pass the potato before it pops.',
    minPlayers: 2,
    playS: 0,
  },
  targets: {
    title: 'Target Hop',
    rule: 'Land on the glowing targets. Gold ones are worth 3.',
    minPlayers: 1,
    playS: 45,
  },
};

/** 3-2-1-GO before play (s). */
export const LOBBY_GAME_INTRO_S = 3.5;
/** Results card before free roam returns (s). */
export const LOBBY_GAME_RESULTS_S = 5;
/** How long a cancelled game says so (s). */
export const LOBBY_GAME_CANCEL_S = 1.5;

/** Team colours and names (Goal Rush). */
export const LOBBY_TEAMS = [
  { name: 'Pink', color: '#ff4f9a' },
  { name: 'Blue', color: '#4fa3ff' },
] as const;

/**
 * Goal Rush geometry: goal 0 at `-lineX` (defended by team 0), goal 1 at
 * `+lineX`. The beach ball is 0.7 m in radius, so the mouth is wide and the
 * line sits far enough in from the 5.7 m rim wall for the ball to cross it.
 */
export const GOAL = {
  lineX: 4.3,
  /** Half the mouth width along z (m). */
  halfWidth: 1.3,
  /** Crossbar height (m). */
  height: 1.9,
  /** Ball centre past the line that counts as in (m). */
  inside: 0.25,
  /** First team to this many goals wins. */
  toWin: 3,
  /** Pause after a goal before the ball goes back to the centre (s). */
  kickoffS: 2.5,
  /** Where the ball waits for kickoff. */
  spot: { x: 0, y: 2.2, z: 0 },
} as const;

/** Hot Potato tuning. */
export const POTATO = {
  fuseMinS: 7,
  fuseMaxS: 11,
  /** Pause between a pop and the next potato (s). */
  breakS: 2.2,
  /** Holder must wait this long between passes (s). */
  tagCooldownS: 0.6,
  /** The potato cannot go straight back to whoever just passed it for this long (s). */
  passBackS: 1.2,
  /** Holder-side contact distance for a dive tag (m). */
  diveReach: 1.3,
  /** Leader-side distance check, generous for ~200 ms of interpolation lag (m). */
  validateM: 2.6,
} as const;

/** Target Hop tuning. */
export const TARGETS = {
  count: LOBBY_GAME_LIMITS.maxTargets,
  /** Feet within this of a target's centre count as on it (m). */
  radius: 0.8,
  /** Feet higher than this are flying over, not landing (m). */
  maxY: 0.9,
  /** Leader-side distance check (m). */
  validateM: 1.9,
  respawnS: 0.5,
  goldChance: 0.2,
  goldValue: 3,
  /** First to this many points ends the game early. */
  toWin: 15,
  /** Targets spawn within this radius (m). */
  spawnRadius: 4.4,
  /** Minimum spacing between live targets (m). */
  spacing: 1.8,
} as const;

// Targets travel in centimetres; rounding here keeps the leader's copy identical to everyone else's.
const round2 = (v: number): number => Math.round(v * 100) / 100 || 0;

/** Fixed things on the platform targets must not spawn on (x, z, clearance). */
const TARGET_KEEP_OUT: readonly (readonly [number, number, number])[] = [
  [3.2, -2.6, 1.2],
  [-1.9, -4.3, 1.1],
  [0, -5, 1.0],
];

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

/**
 * Splits players into Goal Rush teams by slot: alternate, so two players go
 * one against one, three go two against one and four go two against two.
 *
 * @param n - Players in slot order.
 * @returns Team (0/1) per player.
 * @example
 * splitTeams(4); // [0, 1, 0, 1]
 */
export function splitTeams(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i % 2);
}

/**
 * Which goal the ball is in.
 *
 * @returns 0 (the -x goal, team 0's), 1 (the +x goal) or -1.
 */
export function goalAt(x: number, y: number, z: number): -1 | 0 | 1 {
  if (Math.abs(z) > GOAL.halfWidth || y > GOAL.height) return -1;
  if (x <= -(GOAL.lineX + GOAL.inside)) return 0;
  if (x >= GOAL.lineX + GOAL.inside) return 1;
  return -1;
}

/**
 * The live target a Tumbler's feet are on.
 *
 * @param targets - Flattened `[x, z, value, gen]` per slot.
 * @returns The slot, or -1.
 */
export function targetUnder(x: number, y: number, z: number, targets: readonly number[]): number {
  if (y > TARGETS.maxY) return -1;
  for (let i = 0; i + 3 < targets.length; i += 4) {
    if (targets[i + 2]! <= 0) continue;
    if (Math.hypot(x - targets[i]!, z - targets[i + 1]!) <= TARGETS.radius) return i / 4;
  }
  return -1;
}

/**
 * Picks a spot for a new target: inside the spawn radius, clear of the pad,
 * the cannon and the Games sign, and apart from the other live targets.
 *
 * @param rng - Random source in [0, 1).
 * @param targets - Current targets (the slot being replaced should have value 0).
 * @param out - Receives `{ x, z }`.
 */
export function placeTarget(
  rng: () => number,
  targets: readonly number[],
  out: { x: number; z: number },
): void {
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * TARGETS.spawnRadius;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    let ok = true;
    for (const [kx, kz, kr] of TARGET_KEEP_OUT) if (Math.hypot(x - kx, z - kz) < kr) ok = false;
    for (let i = 0; ok && i + 3 < targets.length; i += 4)
      if (targets[i + 2]! > 0 && Math.hypot(x - targets[i]!, z - targets[i + 1]!) < TARGETS.spacing)
        ok = false;
    out.x = x;
    out.z = z;
    if (ok) return;
  }
}

/**
 * Winners of a finished game.
 *
 * - Goal Rush: the team with more goals (a draw has no winners).
 * - Hot Potato: whoever is still in.
 * - Target Hop: the top scorer(s); everyone level is a draw unless solo.
 *
 * @returns Bitmask over `players`.
 */
export function winnersOf(g: LobbyGameWire): number {
  const n = g.players.length;
  let mask = 0;
  if (g.kind === 'goal') {
    const [a, b] = g.score as [number, number];
    if (n === 1) return a + b > 0 ? 1 : 0;
    if (a === b) return 0;
    const team = a > b ? 0 : 1;
    for (let i = 0; i < n; i++) if (g.teams[i] === team) mask |= 1 << i;
    return mask;
  }
  if (g.kind === 'potato') return ~g.out & ((1 << n) - 1);
  let best = 0;
  for (let i = 0; i < n; i++) if (!(g.out & (1 << i))) best = Math.max(best, g.score[i]!);
  if (best === 0) return 0;
  let count = 0;
  let active = 0;
  for (let i = 0; i < n; i++) {
    if (g.out & (1 << i)) continue;
    active++;
    if (g.score[i] === best) {
      mask |= 1 << i;
      count++;
    }
  }
  return count > 1 && count === active ? 0 : mask;
}

/** Players not knocked out or spectating. */
export function activeCount(g: LobbyGameWire): number {
  let n = 0;
  for (let i = 0; i < g.players.length; i++) if (!(g.out & (1 << i))) n++;
  return n;
}

// -----------------------------------------------------------------------------
// Leader authority
// -----------------------------------------------------------------------------

/** A player's feet as the leader sees them. */
export interface PlayerSample {
  x: number;
  y: number;
  z: number;
}

/**
 * The leader's view of where a player is.
 *
 * @returns False when the player is not on the platform.
 */
export type PlayerLookup = (userId: string, out: PlayerSample) => boolean;

/** Why a claim was turned down (tests, debugging). */
export type ClaimVerdict =
  'ok' | 'stale' | 'not_playing' | 'not_it' | 'cooldown' | 'bad_target' | 'pass_back' | 'too_far' | 'gone';

/**
 * The authoritative lobby game, run by the party leader (or a solo player).
 *
 * @example
 * const host = new LobbyGameHost();
 * host.start('potato', roster.map((m) => m.userId));
 * // per frame
 * host.tick(dt);
 * if (host.game) frameExtras.game = host.wire();
 */
export class LobbyGameHost {
  private g: LobbyGameWire | null = null;
  private nextId: number;
  private evN = 0;
  private eventPending = false;
  private tagCooldown = 0;
  private passBack = 0;
  private prevIt = -1;
  private ballReset = false;
  private readonly respawn: number[] = [];
  private readonly spot = { x: 0, z: 0 };
  private readonly a: PlayerSample = { x: 0, y: 0, z: 0 };
  private readonly b: PlayerSample = { x: 0, y: 0, z: 0 };

  /** @param rng - Random source in [0, 1) (seeded in tests). */
  constructor(private readonly rng: () => number = Math.random) {
    this.nextId = 1 + Math.floor(rng() * 1e6);
  }

  /** The running game (null when none). Read-only for callers. */
  get game(): Readonly<LobbyGameWire> | null {
    return this.g;
  }

  /** True from the intro until the results card closes. */
  get active(): boolean {
    return this.g !== null;
  }

  /**
   * Starts a game, replacing any running one.
   *
   * @param kind - Which game.
   * @param players - Participants in slot order (1–4 user ids).
   * @returns The first snapshot.
   */
  start(kind: LobbyGameKind, players: readonly string[]): Readonly<LobbyGameWire> {
    const n = Math.min(players.length, LOBBY_GAME_LIMITS.maxPlayers);
    const list = players.slice(0, n);
    this.evN = 0;
    this.eventPending = false;
    this.tagCooldown = 0;
    this.passBack = 0;
    this.prevIt = -1;
    this.ballReset = kind === 'goal';
    this.respawn.length = 0;
    const g: LobbyGameWire = {
      op: 'start',
      id: this.nextId,
      kind,
      phase: 'intro',
      left: LOBBY_GAME_INTRO_S,
      players: list,
      teams: kind === 'goal' ? splitTeams(n) : list.map(() => 0),
      score: kind === 'goal' ? [0, 0] : list.map(() => 0),
      out: 0,
      it: -1,
      aux: 0,
      targets: [],
      win: 0,
    };
    this.nextId = (this.nextId % (2 ** 31 - 2)) + 1;
    if (kind === 'targets') {
      for (let i = 0; i < TARGETS.count; i++) {
        placeTarget(this.rng, g.targets, this.spot);
        g.targets.push(round2(this.spot.x), round2(this.spot.z), this.targetValue(), 1);
        this.respawn.push(0);
      }
    }
    this.g = g;
    return g;
  }

  /**
   * Leader only: true once per kickoff (game start, after each goal), when
   * the ball should go back to {@link GOAL.spot}.
   */
  takeBallReset(): boolean {
    const r = this.ballReset;
    this.ballReset = false;
    return r;
  }

  /** True while the Goal Rush ball must wait on the spot (intro, after a goal). */
  get ballHeld(): boolean {
    const g = this.g;
    return !!g && g.kind === 'goal' && (g.phase === 'intro' || (g.phase === 'play' && g.aux > 0));
  }

  /**
   * Advances timers and phase changes.
   *
   * @param dt - Seconds.
   */
  tick(dt: number): void {
    const g = this.g;
    if (!g) return;
    g.left = Math.max(0, g.left - dt);
    if (g.phase === 'results') {
      if (g.left <= 0) this.g = null;
      return;
    }
    if (g.phase === 'intro') {
      if (g.left <= 0) this.beginPlay(g);
      return;
    }
    this.tagCooldown = Math.max(0, this.tagCooldown - dt);
    this.passBack = Math.max(0, this.passBack - dt);
    if (g.kind === 'goal') this.tickGoal(g, dt);
    else if (g.kind === 'potato') this.tickPotato(g, dt);
    else this.tickTargets(g, dt);
  }

  private beginPlay(g: LobbyGameWire): void {
    g.phase = 'play';
    g.left = LOBBY_GAME_INFO[g.kind].playS;
    if (g.kind === 'potato') this.dropPotato(g);
  }

  private tickGoal(g: LobbyGameWire, dt: number): void {
    if (g.aux > 0) {
      g.aux = Math.max(0, g.aux - dt);
      if (g.aux === 0) this.ballReset = true;
    }
    if (g.left <= 0) this.finish(g);
  }

  private tickPotato(g: LobbyGameWire, dt: number): void {
    g.aux = Math.max(0, g.aux - dt);
    if (g.aux > 0) return;
    if (g.it < 0) {
      this.dropPotato(g);
      return;
    }
    const popped = g.it;
    g.out |= 1 << popped;
    g.it = -1;
    this.event('pop', popped, -1);
    if (activeCount(g) <= 1) this.finish(g);
    else g.aux = POTATO.breakS;
  }

  /** A fresh potato lands on a random player still in. */
  private dropPotato(g: LobbyGameWire): void {
    const pick = this.randomActive(g, -1);
    if (pick < 0) {
      this.finish(g);
      return;
    }
    g.it = pick;
    g.aux = POTATO.fuseMinS + this.rng() * (POTATO.fuseMaxS - POTATO.fuseMinS);
    this.prevIt = -1;
    this.passBack = 0;
    this.tagCooldown = POTATO.tagCooldownS;
    this.event('tag', -1, pick);
  }

  private tickTargets(g: LobbyGameWire, dt: number): void {
    for (let s = 0; s < this.respawn.length; s++) {
      if (this.respawn[s]! <= 0) continue;
      this.respawn[s] = Math.max(0, this.respawn[s]! - dt);
      if (this.respawn[s]! > 0) continue;
      placeTarget(this.rng, g.targets, this.spot);
      const i = s * 4;
      g.targets[i] = round2(this.spot.x);
      g.targets[i + 1] = round2(this.spot.z);
      g.targets[i + 2] = this.targetValue();
      g.targets[i + 3] = g.targets[i + 3]! + 1;
    }
    if (g.left <= 0) this.finish(g);
  }

  private targetValue(): number {
    return this.rng() < TARGETS.goldChance ? TARGETS.goldValue : 1;
  }

  private randomActive(g: LobbyGameWire, except: number): number {
    let count = 0;
    for (let i = 0; i < g.players.length; i++) if (!(g.out & (1 << i)) && i !== except) count++;
    if (count === 0) return -1;
    let k = Math.floor(this.rng() * count);
    for (let i = 0; i < g.players.length; i++) {
      if (g.out & (1 << i) || i === except) continue;
      if (k-- === 0) return i;
    }
    return -1;
  }

  private event(k: LobbyGameEventKind, a: number, b: number): void {
    const g = this.g;
    if (!g) return;
    g.ev = { n: ++this.evN, k, a, b };
    this.eventPending = true;
  }

  private finish(g: LobbyGameWire): void {
    g.phase = 'results';
    g.left = LOBBY_GAME_RESULTS_S;
    g.it = -1;
    g.aux = 0;
    g.win = winnersOf(g);
    g.reason = 'done';
  }

  /**
   * The ball (leader-simulated) crossed a goal line.
   *
   * @param goal - Which goal (see {@link goalAt}).
   * @returns True when it counted.
   */
  scoreGoal(goal: 0 | 1): boolean {
    const g = this.g;
    if (!g || g.kind !== 'goal' || g.phase !== 'play' || g.aux > 0) return false;
    // A ball in goal 0 (team 0's) scores for team 1; solo, every goal is yours.
    const team = g.players.length === 1 ? 0 : goal === 0 ? 1 : 0;
    g.score[team] = Math.min(LOBBY_GAME_LIMITS.maxScore, g.score[team]! + 1);
    this.event('goal', team, goal);
    if (g.score[team]! >= GOAL.toWin) this.finish(g);
    else g.aux = GOAL.kickoffS;
    return true;
  }

  /**
   * Judges a claim (a member's, relayed; or the leader's own).
   *
   * @param from - Claiming user.
   * @param c - The claim.
   * @param at - Where the leader sees players.
   * @returns `ok` when it changed the game.
   */
  claim(from: string, c: LobbyGameClaim, at: PlayerLookup): ClaimVerdict {
    const g = this.g;
    if (!g || c.id !== g.id) return 'stale';
    if (g.phase !== 'play') return 'stale';
    const me = g.players.indexOf(from);
    if (me < 0 || g.out & (1 << me)) return 'not_playing';
    if (!at(from, this.a)) return 'gone';
    if (c.k === 'tag') {
      if (g.kind !== 'potato') return 'stale';
      if (g.it !== me) return 'not_it';
      if (this.tagCooldown > 0) return 'cooldown';
      const to = c.target ? g.players.indexOf(c.target) : -1;
      if (to < 0 || to === me || g.out & (1 << to)) return 'bad_target';
      if (to === this.prevIt && this.passBack > 0) return 'pass_back';
      if (!at(c.target!, this.b)) return 'gone';
      if (Math.hypot(this.a.x - this.b.x, this.a.z - this.b.z) > POTATO.validateM) return 'too_far';
      g.it = to;
      this.prevIt = me;
      this.passBack = POTATO.passBackS;
      this.tagCooldown = POTATO.tagCooldownS;
      this.event('tag', me, to);
      return 'ok';
    }
    if (g.kind !== 'targets') return 'stale';
    const s = c.t ?? -1;
    const i = s * 4;
    if (s < 0 || i + 3 >= g.targets.length || g.targets[i + 2]! <= 0 || g.targets[i + 3] !== c.g)
      return 'stale';
    if (Math.hypot(this.a.x - g.targets[i]!, this.a.z - g.targets[i + 1]!) > TARGETS.validateM)
      return 'too_far';
    g.score[me] = Math.min(LOBBY_GAME_LIMITS.maxScore, g.score[me]! + g.targets[i + 2]!);
    g.targets[i + 2] = 0;
    this.respawn[s] = TARGETS.respawnS;
    this.event('hit', me, s);
    if (g.score[me]! >= TARGETS.toWin) this.finish(g);
    return 'ok';
  }

  /**
   * A player stopped playing (opened another menu tab, went away): they
   * watch the rest of the game. A potato they held moves on; a game left
   * without enough players ends.
   */
  spectate(userId: string): void {
    const g = this.g;
    if (!g || g.phase === 'results') return;
    const i = g.players.indexOf(userId);
    if (i < 0 || g.out & (1 << i)) return;
    g.out |= 1 << i;
    this.event('out', i, -1);
    const left = activeCount(g);
    if (left === 0) {
      this.cancel();
      return;
    }
    if (g.kind === 'potato') {
      if (left <= 1 && g.phase === 'play') {
        this.finish(g);
        return;
      }
      if (left <= 1) {
        this.cancel();
        return;
      }
      if (g.it === i) {
        g.it = this.randomActive(g, -1);
        g.aux = Math.max(g.aux, 3);
        this.event('tag', -1, g.it);
      }
    }
  }

  /** Ends the game at once with a short "cancelled" card. */
  cancel(): void {
    const g = this.g;
    if (!g) return;
    if (g.phase === 'results' && g.reason === 'cancel') return;
    g.phase = 'results';
    g.left = LOBBY_GAME_CANCEL_S;
    g.it = -1;
    g.aux = 0;
    g.win = 0;
    g.reason = 'cancel';
  }

  /** Drops the game without a card (the menu is closing). */
  clear(): void {
    this.g = null;
  }

  /**
   * The snapshot to put on the next frame, with its op set: `start` during
   * the intro, `end` on the results card, `event` the first time a new event
   * goes out, else `state`.
   */
  wire(): Readonly<LobbyGameWire> | null {
    const g = this.g;
    if (!g) return null;
    if (g.phase === 'intro') g.op = 'start';
    else if (g.phase === 'results') g.op = 'end';
    else g.op = this.eventPending ? 'event' : 'state';
    this.eventPending = false;
    if (g.op !== 'end') delete g.reason;
    return g;
  }
}

// -----------------------------------------------------------------------------
// Change tracking (every client)
// -----------------------------------------------------------------------------

/** What changed with the latest snapshot. Reused between calls. */
export interface LobbyGameChange {
  /** A different game began (or the first snapshot of one arrived). */
  started: boolean;
  /** The phase changed (includes `started`). */
  phase: LobbyGamePhase | null;
  /** A fresh event to play. */
  event: LobbyGameEvent | null;
  /** The game is over (the leader stopped sending it, or it was replaced). */
  ended: boolean;
}

/**
 * Follows the game every client shows (the host's on the leader, relayed
 * snapshots on members) and reports each start, phase change, event and end
 * once, so effects never double up when the same snapshot arrives again.
 *
 * @example
 * const c = tracker.update(snapshot);
 * if (c.event) playEffect(c.event);
 */
export class LobbyGameTracker {
  /** The game shown, or null. */
  game: Readonly<LobbyGameWire> | null = null;
  private evN = 0;
  // Kept apart from `game`: the leader passes its host's live object, which mutates in place.
  private id = 0;
  private phase: LobbyGamePhase | null = null;
  private readonly change: LobbyGameChange = { started: false, phase: null, event: null, ended: false };

  /**
   * Takes the latest snapshot (null = no game).
   *
   * @returns What changed (the same object every call).
   */
  update(next: Readonly<LobbyGameWire> | null): LobbyGameChange {
    const c = this.change;
    c.started = false;
    c.phase = null;
    c.event = null;
    c.ended = false;
    if (!next) {
      if (this.game) c.ended = true;
      this.reset();
      return c;
    }
    if (!this.game || this.id !== next.id) {
      if (this.game) c.ended = true;
      c.started = true;
      c.phase = next.phase;
      // An event that happened before we joined in is history, not news.
      this.evN = next.ev?.n ?? 0;
    } else if (this.phase !== next.phase) c.phase = next.phase;
    if (next.ev && next.ev.n > this.evN) {
      this.evN = next.ev.n;
      c.event = next.ev;
    }
    this.game = next;
    this.id = next.id;
    this.phase = next.phase;
    return c;
  }

  /** Forgets the game (menu closing). */
  reset(): void {
    this.game = null;
    this.evN = 0;
    this.id = 0;
    this.phase = null;
  }
}
