/**
 * The built-in bot brain. Produces one {@link CharacterInput} per step through
 * the same path as human input.
 *
 * Structure:
 * - A *strategy* per round style picks a movement target: course following
 *   (races, crown climbs, towers), survival roaming (seek intact ground away
 *   from crowds and edges), wandering, team objectives (eggs → nest, ball →
 *   goal with keeper, attacker and formation roles, zones), hunt chase/flee,
 *   logic (move to the obstacle-provided safe spot, with skill-based memory
 *   scaled by the question's difficulty) and objective rounds (race to the
 *   spot an obstacle names: the nearest pickup, a scoring zone, a free seat).
 * - Course legs: run legs ease into their waypoint; action legs (jump,
 *   jump-dive, dive) run through the take-off at full speed and fire when the
 *   bot crosses the take-off line or reaches a lip, checked every step. Timed
 *   legs wait for a sweeping obstacle to clear (`waitForGap`) or for a lift /
 *   moving platform to bridge the leg (`waitForPlatform`).
 * - *Reflexes* layered on top: jumping incoming low beams / diving under high
 *   ones (predicted via obstacle poses, lasers included), hopping low lips,
 *   silly moments, emotes.
 * - *Stuck recovery* measures route progress against a fixed baseline over
 *   a time window and escalates through a plan picked by what is ahead:
 *   walls get sidesteps, back-offs and re-paths to a sibling branch; lips
 *   get hops, lunges and run-ups; open ground gets hops and lunges. Moves
 *   that leave the line check for floor first. Hanging bots haul themselves
 *   up ledges.
 * - *Skill* (clumsy/average/sharp) shapes everything: reaction delay, aim
 *   wobble, action timing error, outright mistakes, bonks and dizzy spells
 *   for clumsy bots, corner-cutting and jump-dives for sharp ones.
 *
 * Heavy queries run on a staggered decision tick (~10 Hz); other steps replay
 * the last decision (plus the cheap per-step take-off check), so the step
 * loop stays allocation-free. All randomness comes from the bot's seeded Rng.
 */
import {
  Rng,
  RoundPhase,
  vec3,
  type RoundDefinition,
  type TriggerDef,
  type Vec3,
  type Waypoint,
} from '@tumble/shared';
import { Button, CharacterState, type CharacterInput } from '../character/types.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import { navGraphFor, type NavGraph } from './nav.ts';
import { BOT_SKILLS, type BotSkillProfile } from './skill.ts';
import type { BotBrainLike, BotBrainOptions, BotSelfView, BotSkill, BotWorldView } from './types.ts';

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

/** Steps between decisions (60 Hz sim → 10 Hz thinking). */
const DECISION_TICKS = 6;
/** Steps the jump button is held for a full-height jump. */
const JUMP_HOLD_TICKS = 14;
const DIVE_HOLD_TICKS = 3;
/** Give up waiting for a gap after this long; better a comic splat than a statue. */
const MAX_GAP_WAIT_SECONDS = 6;
/** Lifts run long cycles; walking into the void is never the fallback, re-pathing is. */
const MAX_PLATFORM_WAIT_SECONDS = 24;
/** Route metres that count as "getting somewhere" within one stuck window. */
const STUCK_PROGRESS = 1;
/** A branch abandoned by the stuck routine is avoided for this long. */
const BAN_SECONDS = 12;
/** Run speed (m/s) at full stick, for arrival-time estimates. */
const RUN_SPEED = 7.4;
/** Capsule centre above the feet (radius + half height). */
const CENTRE_HEIGHT = 0.9;
/** Distance ahead of the capsule centre probed for walls and lips. */
const PROBE_AHEAD = 0.75;
/** Ground deeper than this below the feet just ahead counts as a lip. */
const LIP_DROP = 0.7;
/** Horizontal take-off legs at least this long may become jump-dives for bold bots. */
const LONG_JUMP = 3.8;
/** A silly dive needs floor this far ahead (m): roughly where a standing dive lands. */
const SILLY_DIVE_REACH = 2.5;
/**
 * Logic safe spots closer than this to the last one are the same answer (a
 * spot within a tile follows the bot as a crowd jostles it; tiles are 5 m+ apart).
 */
const LOGIC_SAME_SPOT = 2.6;

/**
 * Ball rounds: share of a team attacking the ball at once, scaled by how far
 * up the pitch it is (×0.15 at our goal to ×1.4 at theirs); the rest hold formation.
 */
const BALL_CHASE_SHARE = 0.18;
/** Ball rounds: extra attackers whatever the team size, all of them at the far goal, none at ours. */
const BALL_CHASE_UPFIELD = 2;
/** Ball rounds: formation rows span this stretch of the pitch, as fractions from our goal to theirs. */
const BALL_FORMATION_FROM = 0.3;
const BALL_FORMATION_TO = 0.85;
/** Ball rounds: keepers leave the goal mouth to clear a ball this close to it (m). */
const BALL_KEEPER_RANGE = 12;
/** Ball rounds: chance per decision of diving into a lined-up ball from close range. */
const BALL_DIVE_CHANCE = 0.3;

type Strategy = 'course' | 'survive' | 'wander' | 'team' | 'hunt' | 'logic' | 'objective';

/** One scheduled button action. */
const enum Act {
  None = 0,
  Jump = 1,
  Dive = 2,
  JumpDive = 3,
}

/** Steering overrides used by stuck recovery. */
const enum Recover {
  None = 0,
  Sidestep = 1,
  BackOff = 2,
}

/** Stuck-recovery steps, in escalation order. */
const enum Unstick {
  Jump = 0,
  Sidestep = 1,
  JumpDive = 2,
  BackOff = 3,
  Repath = 4,
  SidestepFlip = 5,
}

/**
 * Escalation plans, chosen by what the probes see ahead at each step. Steps
 * cycle; the index keeps counting across plans so a bot never retries the
 * same fix forever.
 * - Open ground (a counter-belt, a crowd, a missed lip below): keep pushing
 *   with hops and lunges, re-path only now and then. Sidestepping or backing
 *   off here only loses ground.
 * - Knee-high lip: hop, lunge, take a run-up, then try elsewhere.
 * - Wall: slide along it (solid doors), take a run-up, go around.
 */
const PLAN_OPEN: readonly Unstick[] = [
  Unstick.Jump,
  Unstick.Jump,
  Unstick.JumpDive,
  Unstick.Jump,
  Unstick.Repath,
  Unstick.JumpDive,
];
const PLAN_LIP: readonly Unstick[] = [
  Unstick.Jump,
  Unstick.JumpDive,
  Unstick.BackOff,
  Unstick.Jump,
  Unstick.Repath,
  Unstick.JumpDive,
];
const PLAN_WALL: readonly Unstick[] = [
  Unstick.Sidestep,
  Unstick.Sidestep,
  Unstick.BackOff,
  Unstick.SidestepFlip,
  Unstick.Repath,
  Unstick.SidestepFlip,
];

function strategyFor(round: RoundDefinition, nav: NavGraph, objective: boolean): Strategy {
  const mode = round.qualification.mode;
  if (mode === 'scoreTarget' || (objective && mode !== 'teamScore' && mode !== 'holdItem'))
    return 'objective';
  switch (mode) {
    case 'finish':
    case 'crownGrab':
      return 'course';
    case 'teamScore':
      return 'team';
    case 'holdItem':
      return 'hunt';
    case 'logicSurvive':
      return 'logic';
    case 'survive':
    case 'lastStanding':
      // Towers and peaks have a summit to climb to; authored patrol loops are run as laid out; open arenas and roam grids are roamed.
      if (nav.hasGoal) return 'course';
      return nav.hasEdges && nav.meanOutDegree < 1.5 ? 'course' : 'survive';
    default:
      return nav.hasEdges ? 'course' : 'wander';
  }
}

function isTakeoff(a: Waypoint['action']): boolean {
  return a === 'jump' || a === 'jumpDive' || a === 'dive';
}

// -----------------------------------------------------------------------------
// Brain
// -----------------------------------------------------------------------------

/**
 * Default bot brain. See the module docs for the behaviour model.
 */
export class DefaultBotBrain implements BotBrainLike {
  readonly id: number;
  readonly skill: BotSkill;
  private readonly rng: Rng;
  private readonly p: BotSkillProfile;
  private readonly nav: NavGraph;
  private readonly strategy: Strategy;
  private readonly anchor: Vec3;
  private readonly decisionPhase: number;
  private readonly goalTrigger: TriggerDef | null;

  // Steering.
  private readonly target = vec3();
  private hasTarget = false;
  private speed = 1;
  /** Run straight through the target (take-off approaches, flights). */
  private fullSpeed = false;
  private noise = 0;
  private noiseVel = 0;
  private yaw = 0;

  // Course following.
  private cur = -1;
  private prev = -1;
  /** Successor chosen for `cur`, so the take-off line is known on approach. */
  private succ = -1;
  /** `cur` is a take-off with a usable take-off line, checked every step. */
  private lineValid = false;
  /** The take-off line was checked against the ground (gap jumps only). */
  private lineChecked = true;
  private lineX = 0;
  private lineZ = 0;
  private shortcutTried = false;
  private atGoal = false;
  private readonly offset = vec3();
  private waitObstacle: string | null = null;
  private waitPlatform = false;
  private waitSince = 0;
  private holdGrab = false;
  private banned = -1;
  private bannedUntil = 0;
  private finishDived = false;

  // Scheduled actions.
  private actAt = -1;
  private act: Act = Act.None;
  private diveAt = -1;
  private jumpUntil = -1;
  private diveUntil = -1;

  // Stuck detection: progress against a baseline fixed for a whole window.
  private stuckRef = 0;
  private readonly stuckRefPos = vec3();
  private stuckRefTick = -1;
  private stuckLevel = 0;
  private stuckStep = 0;
  private lastEscalateTick = -1e9;
  private recover: Recover = Recover.None;
  private recoverUntil = 0;
  private sideDir = 1;

  // Wander / survive / team / logic.
  private nextRetarget = 0;
  private wanderValid = false;
  private roamAngle = 0;
  private useHints = true;
  private readonly layerAnchor = vec3();
  private layerAnchorY = Number.NaN;
  private logicKnown = false;
  private readonly logicSpot = vec3(Number.NaN, 0, 0);
  /** Ball rounds: lowest ball-centre height above our feet seen so far, i.e. the ball's radius. */
  private ballRadius = Infinity;
  private emoteCooldown = 0;

  // Flavour.
  private wasQualified = false;
  private wasStunned = false;
  private dizzyUntil = -1;
  private hangSince = -1;
  private hangWait = 0;

  // Scratch.
  private readonly s1 = vec3();
  private readonly s2 = vec3();
  private readonly s3 = vec3();

  constructor(opts: BotBrainOptions) {
    this.id = opts.id;
    this.skill = opts.skill;
    this.rng = new Rng(opts.seed);
    this.p = BOT_SKILLS[opts.skill];
    this.nav = navGraphFor(opts.round);
    this.strategy = strategyFor(opts.round, this.nav, opts.objective ?? false);
    this.decisionPhase = ((opts.id % DECISION_TICKS) + DECISION_TICKS) % DECISION_TICKS;
    this.goalTrigger =
      opts.round.triggers.find((t) => t.kind === 'crown') ??
      opts.round.triggers.find((t) => t.kind === 'finish') ??
      null;
    this.anchor = { ...opts.round.spawn.origin };
    if (this.strategy !== 'course' && this.nav.size > 0) {
      let x = 0;
      let y = 0;
      let z = 0;
      for (const w of this.nav.nodes) {
        x += w.position.x;
        y += w.position.y;
        z += w.position.z;
      }
      this.anchor.x = x / this.nav.size;
      this.anchor.y = y / this.nav.size;
      this.anchor.z = z / this.nav.size;
    }
    this.speed = this.p.speed;
    this.sideDir = this.rng.chance(0.5) ? 1 : -1;
    this.roamAngle = this.rng.range(0, Math.PI * 2);
  }

  /** Current stuck-escalation level (0 = making progress). For tests and debug overlays. */
  get stuckLevelNow(): number {
    return this.stuckLevel;
  }

  /** Id of the waypoint currently headed for, or -1. For tests and debug overlays. */
  get currentWaypointId(): number {
    return this.cur >= 0 ? (this.nav.nodes[this.cur] as Waypoint).id : -1;
  }

  onRespawn(): void {
    this.cur = -1;
    this.prev = -1;
    this.succ = -1;
    this.lineValid = false;
    this.atGoal = false;
    this.waitObstacle = null;
    this.act = Act.None;
    this.actAt = -1;
    this.diveAt = -1;
    this.holdGrab = false;
    this.stuckRefTick = -1;
    this.stuckLevel = 0;
    this.stuckStep = 0;
    this.recover = Recover.None;
    this.nextRetarget = 0;
    this.wanderValid = false;
    this.layerAnchorY = Number.NaN;
  }

  think(view: BotWorldView, self: BotSelfView, out: CharacterInput): void {
    const tick = view.tick;
    out.buttons = 0;
    out.emote = 0;
    out.moveX = 0;
    out.moveZ = 0;
    const decide = tick % DECISION_TICKS === this.decisionPhase;

    if (view.phase < RoundPhase.Playing || self.status !== PlayerRoundStatus.Playing) {
      this.idle(view, self, out, decide);
      return;
    }

    if (decide) {
      this.hasTarget = false;
      this.fullSpeed = false;
      this.speed = this.p.speed;
      this.holdGrab = false;
      switch (this.strategy) {
        case 'course':
          this.decideCourse(view, self);
          break;
        case 'survive':
          this.decideSurvive(view, self);
          break;
        case 'wander':
          this.decideWander(view, self, 4.5);
          break;
        case 'team':
          this.decideTeam(view, self);
          break;
        case 'hunt':
          this.decideHunt(view, self);
          break;
        case 'logic':
          this.decideLogic(view, self);
          break;
        case 'objective':
          this.decideObjective(view, self);
          break;
      }
      this.trackStun(view, self);
      this.ledgeReflex(view, self);
      this.reflexes(view, self);
      this.checkStuck(view, self);
      this.silly(view, self);
    } else if (this.lineValid && this.lineChecked && this.waitObstacle === null && !this.atGoal) {
      this.stepTakeoff(view, self);
    }

    this.steer(view, self, out);
    this.applyActions(view, out);
    if (this.holdGrab) out.buttons |= Button.Grab;
  }

  // ---------------------------------------------------------------------------
  // Course following
  // ---------------------------------------------------------------------------

  private decideCourse(view: BotWorldView, self: BotSelfView): void {
    const nav = this.nav;
    if (nav.size === 0) {
      this.seekGoal(view, self);
      return;
    }
    if (this.cur >= 0 && !this.atGoal && self.grounded) {
      // Knocked or fallen to a lower level: the leg is out of reach, rejoin from here. Both ends must be
      // well above us, or a long uphill leg (ramps, bowls) would count as a fall.
      const w = (nav.nodes[this.cur] as Waypoint).position;
      const feet = self.pos.y - CENTRE_HEIGHT;
      const fromY = this.prev >= 0 ? (nav.nodes[this.prev] as Waypoint).position.y : -Infinity;
      if (feet < w.y - 3.5 && feet < fromY - 3.5) this.cur = -1;
    }
    if (this.cur < 0) {
      this.prev = -1;
      this.atGoal = false;
      this.setCur(nav.resume(self.pos, view.time < this.bannedUntil ? this.banned : -1));
    }
    if (this.atGoal) {
      this.seekGoal(view, self);
      return;
    }
    this.classifyTakeoff(view);
    const wp = nav.nodes[this.cur] as Waypoint;
    if (this.arrivedAt(view, self, wp)) {
      this.arrive(view, self);
      if (this.atGoal) {
        this.seekGoal(view, self);
        return;
      }
    } else if (this.trySharpShortcut(view, self, wp)) {
      this.arrive(view, self);
      if (this.atGoal) {
        this.seekGoal(view, self);
        return;
      }
    }
    if (this.waitObstacle !== null && this.prev >= 0) {
      if (this.legIsClear(view, self)) {
        this.waitObstacle = null;
      } else {
        // Hold position on the from-waypoint, facing the danger, fidgeting a little.
        const from = nav.nodes[this.prev] as Waypoint;
        this.setTarget(from.position.x, from.position.y, from.position.z);
        this.speed = 0;
        this.faceTowards(self.pos, (nav.nodes[this.cur] as Waypoint).position);
        return;
      }
    }
    this.aimAtCur(self);
    this.finishDive(view, self);
  }

  /** Sets the steering target for the current waypoint. */
  private aimAtCur(self: BotSelfView): void {
    const wp = this.nav.nodes[this.cur] as Waypoint;
    if (this.lineValid) {
      // Aim through the take-off along the jump direction so the launch heads for the landing.
      this.setTarget(
        wp.position.x + this.offset.x + this.lineX * 2.5,
        wp.position.y,
        wp.position.z + this.offset.z + this.lineZ * 2.5,
      );
      this.fullSpeed = true;
    } else {
      this.setTarget(wp.position.x + this.offset.x, wp.position.y, wp.position.z + this.offset.z);
    }
    if (this.prev >= 0) {
      const a = (this.nav.nodes[this.prev] as Waypoint).action;
      if (a === 'grab' || a === 'climb') this.holdGrab = true;
      // Mid-flight toward the landing: easing off would drop us short.
      if (isTakeoff(a) && !self.grounded) this.fullSpeed = true;
    }
  }

  /** Makes `i` the current waypoint and pre-picks its successor and take-off line. */
  private setCur(i: number): void {
    const nav = this.nav;
    this.cur = i;
    this.lineValid = false;
    this.shortcutTried = false;
    if (i < 0) {
      this.succ = -1;
      return;
    }
    const banned = this.bannedUntil > 0 ? this.banned : -1;
    this.succ = nav.chooseNext(i, this.rng, this.p.branchGreed, banned);
    const w = nav.nodes[i] as Waypoint;
    if (isTakeoff(w.action)) {
      const from =
        this.succ >= 0 ? w.position : this.prev >= 0 ? (nav.nodes[this.prev] as Waypoint).position : null;
      const to = this.succ >= 0 ? (nav.nodes[this.succ] as Waypoint).position : w.position;
      if (from) {
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const l = Math.hypot(dx, dz);
        // Climb chains stack waypoints on one spot: no line there, the radius test handles them.
        // Jump-ups onto ledges (climb risers) launch from a run-up, which the radius test gives; the line is for gaps.
        if (l > 0.5 && to.y - from.y < 0.8) {
          this.lineValid = true;
          this.lineX = dx / l;
          this.lineZ = dz / l;
          this.lineChecked = false;
        }
      }
    }
    this.pickOffset();
  }

  /**
   * The take-off line is for jumps across gaps. When the floor runs on
   * between the take-off and the landing (hops over beams, onto stones,
   * anchor to anchor), the authored radius decides instead, as it always has.
   */
  private classifyTakeoff(view: BotWorldView): void {
    if (this.lineChecked || !this.lineValid || this.succ < 0) {
      this.lineChecked = true;
      return;
    }
    this.lineChecked = true;
    const a = (this.nav.nodes[this.cur] as Waypoint).position;
    const b = (this.nav.nodes[this.succ] as Waypoint).position;
    const P = this.s3;
    for (let k = 1; k <= 4; k++) {
      const f = k / 5;
      P.x = a.x + (b.x - a.x) * f;
      P.y = a.y + (b.y - a.y) * f + 0.5;
      P.z = a.z + (b.z - a.z) * f;
      if (!view.groundBelow(P, 2)) return;
    }
    this.lineValid = false;
    this.pickOffset();
  }

  /** Arrival test used on decision ticks. */
  private arrivedAt(view: BotWorldView, self: BotSelfView, wp: Waypoint): boolean {
    if (this.lineValid) return this.takeoffReached(view, self, wp);
    const dx = wp.position.x - self.pos.x;
    const dz = wp.position.z - self.pos.z;
    const dy = wp.position.y - self.pos.y;
    return dx * dx + dz * dz < wp.radius * wp.radius && dy < 2.2 && dy > -3.5;
  }

  /** Per-step take-off check between decisions, so jumps leave from the lip and not 0.1 s late. */
  private stepTakeoff(view: BotWorldView, self: BotSelfView): void {
    if (this.cur < 0) return;
    const wp = this.nav.nodes[this.cur] as Waypoint;
    if (!this.takeoffReached(view, self, wp)) return;
    this.arrive(view, self);
    if (this.atGoal) {
      this.seekGoal(view, self);
      return;
    }
    if (this.waitObstacle === null) this.aimAtCur(self);
  }

  /**
   * Take-off trigger: crossing the take-off line (a plane through the
   * waypoint, normal to the jump direction, anticipated by a speed-scaled
   * lead), reaching a lip on the approach, or being stalled against a riser
   * near the waypoint. Jumps need ground (or coyote time) under them, so a
   * bot still in the air waits for touchdown.
   */
  private takeoffReached(view: BotWorldView, self: BotSelfView, wp: Waypoint): boolean {
    const rx = self.pos.x - wp.position.x;
    const rz = self.pos.z - wp.position.z;
    const dy = wp.position.y - self.pos.y;
    if (!(dy < 2.2 && dy > -3.5)) return false;
    const along = rx * this.lineX + rz * this.lineZ;
    const lateral = Math.abs(rx * this.lineZ - rz * this.lineX);
    const needsGround = wp.action !== 'dive';
    if (needsGround && !self.grounded) return false;
    const hs = Math.hypot(self.vel.x, self.vel.z);
    const lead = Math.min(0.6, Math.max(0.15, hs * 0.08));
    const near = lateral < wp.radius + 1;
    if (along >= -lead && near) return true;
    if (along > -2.5 && rx * rx + rz * rz < 16) {
      const probe = this.s3;
      probe.x = self.pos.x + this.lineX * (PROBE_AHEAD - 0.15);
      probe.y = self.pos.y;
      probe.z = self.pos.z + this.lineZ * (PROBE_AHEAD - 0.15);
      if (!view.groundBelow(probe, CENTRE_HEIGHT + LIP_DROP)) return true;
    }
    const r = Math.min(wp.radius, 0.75);
    return rx * rx + rz * rz < r * r || (hs < 1.2 && rx * rx + rz * rz < wp.radius * wp.radius);
  }

  private arrive(view: BotWorldView, self: BotSelfView): void {
    const nav = this.nav;
    this.prev = this.cur;
    const from = nav.nodes[this.prev] as Waypoint;
    let next = this.succ;
    if (next < 0 && (nav.nextIdx[this.prev] as number[]).length > 0)
      next = nav.chooseNext(this.prev, this.rng, this.p.branchGreed);
    this.waitObstacle = null;
    if (next < 0) {
      this.atGoal = true;
      this.lineValid = false;
      return;
    }
    this.setCur(next);
    switch (from.action) {
      case 'jump':
        this.schedule(view, this.boldJump(view, self, from, next) ? Act.JumpDive : Act.Jump, 0);
        break;
      case 'dive':
        this.schedule(view, Act.Dive, 0.05);
        break;
      case 'jumpDive':
        this.schedule(view, Act.JumpDive, 0);
        break;
      case 'waitForGap':
      case 'waitForPlatform':
        if (from.timeAgainst) {
          const platform = from.action === 'waitForPlatform';
          // Being reckless at a lift means stepping into the void: nobody is that clumsy.
          if (platform || !this.rng.chance(this.p.recklessChance)) {
            this.waitObstacle = from.timeAgainst;
            this.waitPlatform = platform;
            this.waitSince = view.time;
          }
        }
        break;
      default:
        break;
    }
    if (this.waitObstacle !== null && this.legIsClear(view, self)) this.waitObstacle = null;
  }

  /**
   * Bold bots stretch a jump into a jump-dive when the far side of the gap is
   * beyond a plain jump's reach (≈ 4.2 m on the flat) but the landing is low
   * and roomy. The gap is measured with ground probes along the leg.
   */
  private boldJump(view: BotWorldView, self: BotSelfView, from: Waypoint, landing: number): boolean {
    if (this.p.jumpDiveChance <= 0) return false;
    const to = this.nav.nodes[landing] as Waypoint;
    if (to.action !== 'run' || to.radius < 1.2 || to.position.y > from.position.y + 0.3) return false;
    const dx = to.position.x - self.pos.x;
    const dz = to.position.z - self.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < LONG_JUMP) return false;
    const P = this.s3;
    let gapAt = -1;
    for (let k = 1; k <= 7; k++) {
      P.x = self.pos.x + (dx / len) * k * 0.75;
      P.y = self.pos.y;
      P.z = self.pos.z + (dz / len) * k * 0.75;
      const ground = view.groundBelow(P, CENTRE_HEIGHT + LIP_DROP);
      if (!ground && gapAt < 0) gapAt = k;
      else if (ground && gapAt >= 0) return k * 0.75 > LONG_JUMP && this.rng.chance(this.p.jumpDiveChance);
    }
    return false;
  }

  /**
   * Corner cutting: near a plain run waypoint, a skilled bot heads straight
   * for the one after when the floor between is continuous and level.
   */
  private trySharpShortcut(view: BotWorldView, self: BotSelfView, wp: Waypoint): boolean {
    if (this.shortcutTried || this.p.shortcutChance <= 0 || this.succ < 0 || this.prev < 0) return false;
    if (wp.action !== 'run' || (this.nav.nodes[this.prev] as Waypoint).action !== 'run') return false;
    // Line-up waypoints before take-offs and timed legs are there for the approach angle.
    if ((this.nav.nodes[this.succ] as Waypoint).action !== 'run') return false;
    const dx = wp.position.x - self.pos.x;
    const dz = wp.position.z - self.pos.z;
    const reach = wp.radius * 2 + 1.5;
    if (dx * dx + dz * dz > reach * reach) return false;
    this.shortcutTried = true;
    if (!self.grounded || !this.rng.chance(this.p.shortcutChance)) return false;
    const to = (this.nav.nodes[this.succ] as Waypoint).position;
    if (Math.abs(to.y - wp.position.y) > 0.4 || Math.abs(wp.position.y - (self.pos.y - CENTRE_HEIGHT)) > 0.6)
      return false;
    const P = this.s3;
    for (let k = 1; k <= 3; k++) {
      const f = k / 4;
      P.x = self.pos.x + (to.x - self.pos.x) * f;
      P.y = self.pos.y + 0.3;
      P.z = self.pos.z + (to.z - self.pos.z) * f;
      if (!view.groundBelow(P, CENTRE_HEIGHT + 0.9)) return false;
    }
    return true;
  }

  /** Whether the timed leg prev → cur may be taken now. */
  private legIsClear(view: BotWorldView, self: BotSelfView): boolean {
    const waited = view.time - this.waitSince;
    if (this.waitPlatform) {
      if (this.platformBridges(view, self)) return true;
      if (waited > MAX_PLATFORM_WAIT_SECONDS) {
        this.giveUpBranch(view, self);
        return this.waitObstacle === null;
      }
      return false;
    }
    if (waited > MAX_GAP_WAIT_SECONDS) return true;
    return this.gapIsOpen(view, self);
  }

  /**
   * Samples the obstacle's predicted clearance at the crossing point over the
   * window in which we would be there; open when every sample is clear.
   */
  private gapIsOpen(view: BotWorldView, self: BotSelfView): boolean {
    const id = this.waitObstacle as string;
    const from = (this.nav.nodes[this.prev] as Waypoint).position;
    const to = (this.nav.nodes[this.cur] as Waypoint).position;
    // Only the stretch of the crossing near the obstacle matters; far ends are always clear.
    const centre = this.s2;
    closestOnSegment(from, to, this.nav.obstaclePos.get(id) ?? midpoint(from, to, centre), centre);
    const len = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    const ux = (to.x - from.x) / len;
    const uz = (to.z - from.z) / len;
    const runSpeed = 6.5 * this.p.speed;
    const reaction = this.reactionDelay();
    const need = 0.9 + this.p.gapMargin;
    // Clumsy bots glance; everyone else checks the whole crossing (coarse sampling misses narrow hammer heads).
    const samples = this.skill === 'clumsy' ? 3 : 6;
    const P = this.s1;
    for (let k = 0; k < samples; k++) {
      const off = -3 + (6 * k) / (samples - 1);
      P.x = centre.x + ux * off;
      P.y = self.pos.y;
      P.z = centre.z + uz * off;
      const arrive = reaction + Math.hypot(P.x - self.pos.x, P.z - self.pos.z) / runSpeed;
      for (let w = -1; w <= 1; w++) {
        const ahead = arrive + w * 0.15;
        if (ahead > 0 && view.obstacleClearance(id, P, ahead) < need) return false;
      }
    }
    return true;
  }

  /**
   * Boarding test for lifts and moving platforms: every sample along the leg
   * from here to the target must have something to stand on when we would
   * reach it — the platform (predicted from its pose) or, where the platform
   * is not around, static ground. The last sample is also checked a moment
   * after arrival so we don't step on just as it leaves.
   */
  private platformBridges(view: BotWorldView, self: BotSelfView): boolean {
    const id = this.waitObstacle as string;
    const to = (this.nav.nodes[this.cur] as Waypoint).position;
    const feetY = self.pos.y - CENTRE_HEIGHT;
    const runSpeed = RUN_SPEED * this.p.speed;
    const reaction = this.p.reactionMax;
    const P = this.s1;
    const n = 4;
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      P.x = self.pos.x + (to.x - self.pos.x) * f;
      P.z = self.pos.z + (to.z - self.pos.z) * f;
      P.y = feetY + (to.y - feetY) * f + 0.3;
      const ahead = reaction + Math.hypot(P.x - self.pos.x, P.z - self.pos.z) / runSpeed;
      const onPlatform = view.obstacleClearance(id, P, ahead) < 0.55;
      // Boarding: the landing must still be there a moment after we arrive.
      if (onPlatform && (k < n || view.obstacleClearance(id, P, ahead + 0.6) < 0.55)) continue;
      // Static ground only counts where the platform is not now (the ray would see the platform too).
      if (view.obstacleClearance(id, P, 0) < 1.5 || !view.groundBelow(P, 1.2)) return false;
    }
    return true;
  }

  private seekGoal(view: BotWorldView, self: BotSelfView): void {
    const g = this.goalTrigger;
    if (!g) {
      // Summits of survival towers: hold the top without wandering off it.
      this.decideSurvive(view, self);
      return;
    }
    this.setTarget(g.position.x, g.position.y, g.position.z);
    this.fullSpeed = g.kind === 'finish';
    const dx = g.position.x - self.pos.x;
    const dz = g.position.z - self.pos.z;
    if (g.kind === 'crown' && dx * dx + dz * dz < 9) {
      this.holdGrab = true;
      if (self.grounded && this.act === Act.None) this.act = Act.Jump;
    }
    this.finishDive(view, self);
  }

  /** Diving across the line: showboating that occasionally pays off. */
  private finishDive(view: BotWorldView, self: BotSelfView): void {
    const g = this.goalTrigger;
    if (this.finishDived || !g || g.kind !== 'finish' || !self.grounded || this.act !== Act.None) return;
    if (this.cur >= 0 && this.succ >= 0) return;
    const dx = g.position.x - self.pos.x;
    const dz = g.position.z - self.pos.z;
    const range = this.skill === 'clumsy' ? 6 : 4;
    if (dx * dx + dz * dz > range * range || Math.abs(g.position.y - self.pos.y) > g.size.y) return;
    this.finishDived = true;
    if (this.rng.chance(this.p.finishDiveChance)) this.schedule(view, Act.Dive, 0);
  }

  // ---------------------------------------------------------------------------
  // Survival roaming
  // ---------------------------------------------------------------------------

  /**
   * Survival: pick a spot a couple of metres away, biased toward the middle
   * of the current level, away from nearby players and in a slowly turning
   * roam direction; obstacles that know safe ground (intact tiles, behind a
   * rope's sweep) refine it. Never steps where no floor is seen ahead.
   */
  private decideSurvive(view: BotWorldView, self: BotSelfView): void {
    this.updateLayerAnchor(self);
    if (view.time >= this.nextRetarget) {
      this.nextRetarget = view.time + this.rng.range(1.5, 3.5);
      this.roamAngle += this.rng.range(-1.6, 1.6);
      // Reading the obstacles is a skill: clumsy bots often just wander.
      this.useHints = this.rng.chance(this.p.hazardAwareness * this.p.hazardAwareness);
    }
    let cx = this.layerAnchor.x - self.pos.x;
    let cz = this.layerAnchor.z - self.pos.z;
    const cd = Math.hypot(cx, cz);
    const pull = Math.min(1.6, cd / 5);
    if (cd > 1e-3) {
      cx = (cx / cd) * pull;
      cz = (cz / cd) * pull;
    }
    let ax = 0;
    let az = 0;
    for (const peer of view.peers) {
      if (peer.id === this.id || peer.status !== PlayerRoundStatus.Playing) continue;
      const dx = self.pos.x - peer.pos.x;
      const dz = self.pos.z - peer.pos.z;
      if (Math.abs(self.pos.y - peer.pos.y) > 2) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 > 12 || d2 < 1e-4) continue;
      ax += dx / d2;
      az += dz / d2;
    }
    let hx = cx + ax * 1.5 + Math.cos(this.roamAngle) * 0.7;
    let hz = cz + az * 1.5 + Math.sin(this.roamAngle) * 0.7;
    const hl = Math.hypot(hx, hz) || 1;
    hx /= hl;
    hz /= hl;
    const spot = this.s2;
    spot.x = self.pos.x + hx * 2.5;
    spot.y = self.pos.y;
    spot.z = self.pos.z + hz * 2.5;
    const hintX = spot.x;
    const hintZ = spot.z;
    if (this.useHints && view.safeSpot(spot) && Math.abs(spot.y - (self.pos.y - CENTRE_HEIGHT)) < 3) {
      this.setTarget(spot.x, spot.y, spot.z);
    } else {
      this.setTarget(hintX, self.pos.y, hintZ);
    }
    this.speed = this.p.speed * 0.8;
    // Don't step into holes or off the edge; turn the roam direction instead.
    const dir = this.dirTo(self.pos, this.target, this.s1);
    const ahead = this.s3;
    ahead.x = self.pos.x + dir.x * 1.2;
    ahead.y = self.pos.y + 0.3;
    ahead.z = self.pos.z + dir.z * 1.2;
    if (!view.groundBelow(ahead, CENTRE_HEIGHT + 1.5)) {
      this.speed = 0;
      this.roamAngle += Math.PI * this.rng.range(0.5, 1);
      this.nextRetarget = view.time + this.rng.range(0.8, 1.6);
    }
  }

  /** Centroid of the waypoints on the bot's current level (recomputed when it changes level). */
  private updateLayerAnchor(self: BotSelfView): void {
    const feet = self.pos.y - CENTRE_HEIGHT;
    if (Math.abs(feet - this.layerAnchorY) < 1.5) return;
    this.layerAnchorY = feet;
    let x = 0;
    let z = 0;
    let n = 0;
    for (const w of this.nav.nodes) {
      if (Math.abs(w.position.y - feet) > 2.5) continue;
      x += w.position.x;
      z += w.position.z;
      n++;
    }
    if (n > 0) {
      this.layerAnchor.x = x / n;
      this.layerAnchor.z = z / n;
    } else {
      this.layerAnchor.x = this.anchor.x;
      this.layerAnchor.z = this.anchor.z;
    }
    this.layerAnchor.y = feet;
  }

  // ---------------------------------------------------------------------------
  // Other strategies
  // ---------------------------------------------------------------------------

  private decideWander(view: BotWorldView, self: BotSelfView, radius: number): void {
    const spot = this.s2;
    spot.x = self.pos.x;
    spot.y = self.pos.y;
    spot.z = self.pos.z;
    if (view.safeSpot(spot)) {
      this.setTarget(spot.x, spot.y, spot.z);
      return;
    }
    if (view.time >= this.nextRetarget || !this.wanderValid) {
      this.wanderValid = true;
      this.nextRetarget = view.time + this.rng.range(1.5, 3.5);
      for (let tries = 0; tries < 5; tries++) {
        const a = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(0, radius);
        spot.x = this.anchor.x + Math.cos(a) * r;
        spot.z = this.anchor.z + Math.sin(a) * r;
        spot.y = self.pos.y + 1;
        if (view.groundBelow(spot, 8)) {
          this.target.x = spot.x;
          this.target.y = self.pos.y;
          this.target.z = spot.z;
          break;
        }
      }
    }
    this.hasTarget = true;
    this.speed = this.p.speed * 0.75;
    // Don't step into holes that opened since we picked the spot.
    this.dirTo(self.pos, this.target, spot);
    spot.x = self.pos.x + spot.x * 1.2;
    spot.z = self.pos.z + spot.z * 1.2;
    spot.y = self.pos.y + 0.5;
    if (!view.groundBelow(spot, 6)) {
      this.nextRetarget = 0;
      this.speed = 0;
    }
  }

  private decideTeam(view: BotWorldView, self: BotSelfView): void {
    const round = view.round;
    let nest: TriggerDef | null = null;
    let goal: TriggerDef | null = null;
    let zone: TriggerDef | null = null;
    for (const t of round.triggers) {
      if (t.kind === 'nest' && t.index === self.team) nest = t;
      else if (t.kind === 'goal' && t.index === self.team) goal = t;
      else if (t.kind === 'zone' && t.index === self.team) zone = t;
    }
    const prop = this.s1;
    if (nest) {
      if (self.state === CharacterState.Carry) {
        this.setTarget(nest.position.x, nest.position.y, nest.position.z);
        this.speed = this.p.speed * 0.9;
        // Releasing Grab drops the prop: keep holding until inside the nest, then let go to deposit.
        this.holdGrab = sqDistXZ(nest.position, self.pos) > 2.25;
        return;
      }
      if (this.nearestProp(view, self, prop, nest)) {
        this.setTarget(prop.x, prop.y, prop.z);
        const d2 = sqDistXZ(prop, self.pos);
        if (d2 < 4) this.holdGrab = true;
        return;
      }
    } else if (goal) {
      if (this.nearestProp(view, self, prop, null)) {
        this.decideBall(view, self, prop, goal);
        return;
      }
    } else if (zone) {
      if (
        Math.abs(self.pos.x - zone.position.x) > zone.size.x / 2 - 0.5 ||
        Math.abs(self.pos.z - zone.position.z) > zone.size.z / 2 - 0.5
      ) {
        this.setTarget(zone.position.x, zone.position.y, zone.position.z);
        return;
      }
    }
    // Painting rounds and fallbacks: roam widely so every step covers new ground.
    this.decideWander(view, self, 9);
    this.speed = this.p.speed;
  }

  /**
   * Ball play. A whole team rushing the ball only builds a scrum that pins it
   * in place, so roles are re-dealt every decision:
   * - keepers (the lowest ids: one from four teammates up, two from twenty)
   *   hold the goal mouth and clear a ball that comes close;
   * - the few teammates nearest the ball attack it: get round to the side
   *   away from the goal they score in, then run (and dive) through it;
   * - everyone else holds a formation slot that slides with the ball, so the
   *   pitch stays covered and the nearest of them takes over as it rolls by.
   */
  private decideBall(view: BotWorldView, self: BotSelfView, ball: Vec3, goal: TriggerDef): void {
    let own: TriggerDef | null = null;
    for (const t of view.round.triggers) {
      if (t.kind === 'goal' && t.index !== self.team) {
        own = t;
        break;
      }
    }
    const feet = self.pos.y - CENTRE_HEIGHT;
    // A resting ball's centre sits one radius above the turf, so the lowest centre seen is the radius.
    if (self.grounded && ball.y - feet > 0.6 && ball.y - feet < this.ballRadius)
      this.ballRadius = ball.y - feet;
    const r = Number.isFinite(this.ballRadius) ? Math.min(3, this.ballRadius) : 1.6;

    let mates = 0;
    let idRank = 0;
    let closer = 0;
    const mine = sqDistXZ(ball, self.pos);
    for (const peer of view.peers) {
      if (peer.id === this.id || peer.team !== self.team || peer.status !== PlayerRoundStatus.Playing)
        continue;
      mates++;
      if (peer.id < this.id) idRank++;
      if (sqDistXZ(ball, peer.pos) < mine) closer++;
    }
    const size = mates + 1;
    if (!own) {
      this.attackBall(view, self, ball, r, goal.position);
      return;
    }
    const axis = this.dirTo(own.position, goal.position, this.s3);
    const length = Math.sqrt(sqDistXZ(own.position, goal.position));
    const bx = ball.x - own.position.x;
    const bz = ball.z - own.position.z;
    const ballAlong = bx * axis.x + bz * axis.z;
    const ballLat = bx * axis.z - bz * axis.x;
    const keepers = size >= 4 ? 1 : 0;

    if (idRank < keepers) {
      if (sqDistXZ(ball, own.position) < BALL_KEEPER_RANGE ** 2) {
        this.attackBall(view, self, ball, r, goal.position);
        return;
      }
      const mouth = own.size.x / 2 - 1;
      const side = Math.max(
        -mouth,
        Math.min(mouth, ballLat * 0.3 + (keepers > 1 ? (idRank === 0 ? -2 : 2) : 0)),
      );
      this.holdSpot(
        self,
        own.position.x + axis.x * 4 + axis.z * side,
        own.position.y,
        own.position.z + axis.z * 4 - axis.x * side,
      );
      return;
    }
    // Teams commit more players the further up the pitch the ball is, so attackers outnumber defenders at
    // either end; even numbers everywhere pin the ball in a scrum in front of each goal.
    const upfield = Math.max(0, Math.min(1, ballAlong / Math.max(1, length)));
    const chasers =
      1 +
      Math.round(BALL_CHASE_UPFIELD * upfield) +
      Math.ceil(size * BALL_CHASE_SHARE * (0.15 + 1.25 * upfield));
    if (closer < chasers) {
      this.attackBall(view, self, ball, r, goal.position);
      return;
    }

    // Formation: rows from our third up to their box, five lanes across, all leaning toward the ball.
    const slot = idRank - keepers;
    const rows = Math.max(1, Math.ceil((size - keepers) / 5));
    const lane = (slot % 5) - 2;
    const row = Math.floor(slot / 5);
    let along =
      length * (BALL_FORMATION_FROM + ((BALL_FORMATION_TO - BALL_FORMATION_FROM) * (row + 0.5)) / rows);
    let lat = lane * length * 0.085;
    along += (ballAlong - along) * 0.35;
    lat += (ballLat - lat) * 0.35;
    const wing = length * 0.2;
    lat = Math.max(-wing, Math.min(wing, lat));
    this.holdSpot(
      self,
      own.position.x + axis.x * along + axis.z * lat,
      self.pos.y,
      own.position.z + axis.z * along - axis.x * lat,
    );
  }

  /** Walks to a spot and stands there (an intentional wait, not stuck). */
  private holdSpot(self: BotSelfView, x: number, y: number, z: number): void {
    this.setTarget(x, y, z);
    if ((self.pos.x - x) ** 2 + (self.pos.z - z) ** 2 < 0.8) this.speed = 0;
  }

  /**
   * Kicks a ball of radius `r` toward `aim`: from the wrong side, circle round
   * it; once behind, line up and run through it, diving in from close range.
   */
  private attackBall(view: BotWorldView, self: BotSelfView, ball: Vec3, r: number, aim: Vec3): void {
    const dir = this.dirTo(ball, aim, this.s3);
    const rx = self.pos.x - ball.x;
    const rz = self.pos.z - ball.z;
    const along = rx * dir.x + rz * dir.z;
    // Perpendicular offset: positive to the right of the ball's path.
    const lat = rx * dir.z - rz * dir.x;
    if (along > -0.4 * r) {
      const side = lat >= 0 ? 1 : -1;
      const out = r + 1.6;
      this.setTarget(
        ball.x + dir.z * side * out - dir.x * r * 0.7,
        ball.y,
        ball.z - dir.x * side * out - dir.z * r * 0.7,
      );
      return;
    }
    if (Math.abs(lat) > r * 0.6) {
      this.setTarget(ball.x - dir.x * (r + 1), ball.y, ball.z - dir.z * (r + 1));
      return;
    }
    this.setTarget(ball.x + dir.x * 2, ball.y, ball.z + dir.z * 2);
    this.fullSpeed = true;
    const gap = Math.sqrt(rx * rx + rz * rz) - r;
    if (
      gap < 1.4 &&
      self.grounded &&
      this.act === Act.None &&
      this.rng.chance(BALL_DIVE_CHANCE * (1 - this.p.mistakeChance))
    ) {
      this.schedule(view, Act.Dive, this.reactionDelay() * 0.3);
    }
  }

  private nearestProp(
    view: BotWorldView,
    self: BotSelfView,
    out: Vec3,
    excludeIn: TriggerDef | null,
  ): boolean {
    const n = view.propCount();
    let best = Infinity;
    const p = this.s2;
    for (let i = 0; i < n; i++) {
      view.propPosition(i, p);
      if (excludeIn && insideBox(excludeIn, p)) continue;
      const d = sqDistXZ(p, self.pos) + ((p.y - self.pos.y) * 2) ** 2;
      if (d < best) {
        best = d;
        out.x = p.x;
        out.y = p.y;
        out.z = p.z;
      }
    }
    return best < Infinity;
  }

  private decideHunt(view: BotWorldView, self: BotSelfView): void {
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    let by = 0;
    for (const peer of view.peers) {
      if (peer.id === this.id || peer.status !== PlayerRoundStatus.Playing) continue;
      if (self.hasItem ? peer.hasItem : !peer.hasItem) continue;
      const d = sqDistXZ(peer.pos, self.pos);
      if (d < best) {
        best = d;
        bx = peer.pos.x;
        by = peer.pos.y;
        bz = peer.pos.z;
      }
    }
    if (best === Infinity) {
      this.decideWander(view, self, 6);
      return;
    }
    const dist = Math.sqrt(best);
    if (self.hasItem) {
      if (dist > 12) {
        this.decideWander(view, self, 6);
        return;
      }
      // Run away, bending toward the arena centre so we don't flee off the edge.
      const ax = self.pos.x - bx;
      const az = self.pos.z - bz;
      const inv = 1 / Math.max(dist, 0.001);
      const cx = this.anchor.x - self.pos.x;
      const cz = this.anchor.z - self.pos.z;
      const cl = Math.max(Math.hypot(cx, cz), 0.001);
      const tx = self.pos.x + ax * inv * 4 + (cx / cl) * 2.5;
      const tz = self.pos.z + az * inv * 4 + (cz / cl) * 2.5;
      this.setTarget(tx, self.pos.y, tz);
      if (dist < 2.2 && this.act === Act.None && this.rng.chance(0.5)) this.schedule(view, Act.Jump, 0);
      return;
    }
    this.setTarget(bx, by, bz);
    if (dist < 1.8) this.holdGrab = true;
    else if (dist < 4 && this.act === Act.None && this.rng.chance(0.15 * (1 - this.p.mistakeChance))) {
      this.schedule(view, Act.Dive, this.reactionDelay() * 0.5);
    }
  }

  private decideLogic(view: BotWorldView, self: BotSelfView): void {
    const spot = this.s2;
    spot.x = self.pos.x;
    spot.y = self.pos.y;
    spot.z = self.pos.z;
    if (view.safeSpot(spot, this.id)) {
      // Spots inside one tile shift as a crowd jostles the bot; only a new tile is a new answer.
      const changed =
        (spot.x - this.logicSpot.x) ** 2 + (spot.z - this.logicSpot.z) ** 2 > LOGIC_SAME_SPOT ** 2 ||
        Number.isNaN(this.logicSpot.x);
      if (changed) {
        this.logicSpot.x = spot.x;
        this.logicSpot.y = spot.y;
        this.logicSpot.z = spot.z;
        // Skill sets how often a bot slips on the hardest questions; easy ones (a glowing answer) rarely trip anyone.
        const difficulty = view.logicDifficulty?.() ?? 1;
        this.logicKnown = this.rng.chance(1 - (1 - this.p.memory) * difficulty);
        // A wrong guess is a nearby spot: close enough to look plausible.
        this.offset.x = this.logicKnown ? 0 : this.rng.range(-4, 4);
        this.offset.z = this.logicKnown ? 0 : this.rng.range(-4, 4);
        if (!this.logicKnown) {
          // Misremembering means the wrong tile, not walking off the edge of the board.
          const probe = this.s3;
          probe.x = spot.x + this.offset.x;
          probe.y = spot.y + 1;
          probe.z = spot.z + this.offset.z;
          if (!view.groundBelow(probe, 3)) {
            this.offset.x = -this.offset.x;
            this.offset.z = -this.offset.z;
          }
        }
        this.nextRetarget = view.time + this.reactionDelay() * 2;
      }
      if (view.time >= this.nextRetarget) {
        // Standing still once there: a bot leaning on its spot shoves the crowd around it off the tile.
        this.holdSpot(
          self,
          this.logicSpot.x + this.offset.x,
          this.logicSpot.y,
          this.logicSpot.z + this.offset.z,
        );
        // Tiles that already dropped are holes, not a short cut.
        const dir = this.dirTo(self.pos, this.target, this.s3);
        if (this.speed > 0 && !this.floorAt(view, self, dir.x, dir.z)) this.speed = 0;
        return;
      }
      this.speed = 0;
      this.hasTarget = false;
      return;
    }
    this.decideWander(view, self, 3);
  }

  /**
   * Objective rounds: run for the spot the obstacles name (the nearest pickup,
   * a scoring zone, a free seat). A new spot is only noticed after the bot's
   * reaction delay, so sharp bots win close races; raised targets get a hop
   * from close range. Standing on the spot is an intentional wait, not stuck.
   */
  private decideObjective(view: BotWorldView, self: BotSelfView): void {
    const spot = this.s2;
    spot.x = self.pos.x;
    spot.y = self.pos.y;
    spot.z = self.pos.z;
    if (!view.safeSpot(spot)) {
      this.logicKnown = false;
      this.decideWander(view, self, 6);
      return;
    }
    const moved = (spot.x - this.logicSpot.x) ** 2 + (spot.z - this.logicSpot.z) ** 2 > 0.8;
    if (moved || !this.logicKnown) {
      // Remember where we were heading; the new spot takes over once we react to it.
      if (!this.logicKnown) {
        this.offset.x = spot.x;
        this.offset.y = spot.y;
        this.offset.z = spot.z;
      } else {
        this.offset.x = this.logicSpot.x;
        this.offset.y = this.logicSpot.y;
        this.offset.z = this.logicSpot.z;
      }
      this.logicSpot.x = spot.x;
      this.logicSpot.y = spot.y;
      this.logicSpot.z = spot.z;
      this.logicKnown = true;
      this.nextRetarget = view.time + this.reactionDelay();
    } else {
      this.logicSpot.y = spot.y;
    }
    const goal = view.time >= this.nextRetarget ? this.logicSpot : this.offset;
    this.setTarget(goal.x, goal.y, goal.z);
    const d = Math.hypot(goal.x - self.pos.x, goal.z - self.pos.z);
    const rise = goal.y - (self.pos.y - CENTRE_HEIGHT);
    if (d < 0.45 && rise < 0.3) {
      this.speed = 0;
      return;
    }
    this.speed = this.p.speed;
    if (rise > 0.35 && rise < 2.2 && d < 2.4 && self.grounded && this.act === Act.None)
      this.schedule(view, Act.Jump, this.reactionDelay() * 0.3);
  }

  // ---------------------------------------------------------------------------
  // Reflexes
  // ---------------------------------------------------------------------------

  /**
   * Hanging from a ledge: haul up (jump) once the reaction delay has passed
   * when the route goes up or onward; let go (dive) when it leads back down.
   */
  private ledgeReflex(view: BotWorldView, self: BotSelfView): void {
    if (self.state !== CharacterState.LedgeHang) {
      this.hangSince = -1;
      return;
    }
    if (this.hangSince < 0) {
      this.hangSince = view.time;
      this.hangWait = this.reactionDelay() + (this.skill === 'clumsy' ? this.rng.range(0, 0.6) : 0);
    }
    if (view.time - this.hangSince < this.hangWait || this.act !== Act.None || view.tick < this.jumpUntil)
      return;
    const below = this.hasTarget && this.target.y < self.pos.y - CENTRE_HEIGHT - 2.5;
    this.act = below ? Act.Dive : Act.Jump;
    this.actAt = view.tick;
    this.hangSince = view.time;
    this.hangWait = 0.6;
  }

  private reflexes(view: BotWorldView, self: BotSelfView): void {
    if (!self.grounded || this.act !== Act.None) return;
    const lead = this.reactionDelay() + 0.25;
    const feet = this.s1;
    feet.x = self.pos.x;
    feet.y = self.pos.y - 0.55;
    feet.z = self.pos.z;
    const now = view.hazardDistance(feet, 5, 0);
    // Touching it already means we're probably standing on it (moving platform).
    if (now < 5 && now > 0.3) {
      const soon = view.hazardDistance(feet, 5, lead);
      if (soon < 0.7 && soon < now - 0.15 && this.rng.chance(this.p.hazardAwareness)) {
        this.schedule(view, Act.Jump, Math.max(0, lead - 0.3));
        return;
      }
    }
    const head = this.s1;
    head.y = self.pos.y + 0.7;
    const nowHead = view.hazardDistance(head, 5, 0);
    if (nowHead < 5 && nowHead > 0.3) {
      const soon = view.hazardDistance(head, 5, lead);
      if (soon < 0.5 && soon < nowHead - 0.15 && this.rng.chance(this.p.hazardAwareness * 0.7)) {
        this.schedule(view, Act.Dive, Math.max(0, lead - 0.35));
        return;
      }
    }
    // A knee-high lip or step we're pushing against: hop it (clumsy bots may bonk first).
    if (
      this.hasTarget &&
      this.speed > 0 &&
      this.recover === Recover.None &&
      (this.strategy === 'course' || this.strategy === 'objective')
    ) {
      if (
        Math.hypot(self.vel.x, self.vel.z) < 2.5 &&
        this.blockedAhead(view, self) === 1 &&
        !this.rng.chance(this.p.bonkChance)
      ) {
        this.schedule(view, Act.Jump, this.reactionDelay() * 0.5);
      }
    }
  }

  /**
   * Probes the space just ahead toward the target with downward rays (which
   * see level geometry and every fixed or moving obstacle part).
   *
   * @returns 0 clear, 1 a low blocker worth hopping, 2 a wall too tall to hop.
   */
  private blockedAhead(view: BotWorldView, self: BotSelfView): number {
    if (!this.hasTarget) return 0;
    const dx = this.target.x - self.pos.x;
    const dz = this.target.z - self.pos.z;
    const l = Math.hypot(dx, dz);
    if (l < 0.3) return 0;
    const P = this.s3;
    P.x = self.pos.x + (dx / l) * PROBE_AHEAD;
    P.z = self.pos.z + (dz / l) * PROBE_AHEAD;
    // From head height down to half a metre above the feet (above step height).
    P.y = self.pos.y + 0.95;
    if (!view.groundBelow(P, 1.35)) return 0;
    // Anything in the top 0.45 m means the obstacle reaches above a full jump.
    return view.groundBelow(P, 0.45) ? 2 : 1;
  }

  // ---------------------------------------------------------------------------
  // Stuck recovery
  // ---------------------------------------------------------------------------

  /** Route progress metric: remaining path length when the course has a goal, else distance to target. */
  private routeMetric(self: BotSelfView): number {
    const tx = this.target.x - self.pos.x;
    const ty = (this.target.y - (self.pos.y - CENTRE_HEIGHT)) * 0.5;
    const tz = this.target.z - self.pos.z;
    const d = Math.hypot(tx, ty, tz);
    if (this.cur < 0) return d;
    const g = this.nav.goalDist[this.cur] as number;
    return g < Number.MAX_VALUE ? g + d : d;
  }

  /**
   * Escalating stuck recovery. Progress is measured against a baseline that
   * stays fixed for a whole window (`stuckSeconds`), so the recovery moves
   * themselves don't count as progress; the level only decays after a full
   * window of real progress with no escalation, so recovering bots don't
   * flip-flop between fixes.
   */
  private checkStuck(view: BotWorldView, self: BotSelfView): void {
    const tick = view.tick;
    if (this.recover !== Recover.None && tick < this.recoverUntil) {
      // Sliding sideways or backing off must not walk us off a narrow bridge.
      const hs = Math.hypot(self.vel.x, self.vel.z);
      if (hs > 0.5) {
        const P = this.s3;
        P.x = self.pos.x + (self.vel.x / hs) * 1.0;
        P.y = self.pos.y;
        P.z = self.pos.z + (self.vel.z / hs) * 1.0;
        if (!view.groundBelow(P, CENTRE_HEIGHT + 1.5)) {
          this.recover = Recover.None;
          this.sideDir = -this.sideDir;
        }
      }
    }
    const course = this.strategy === 'course' && !this.atGoal && this.cur >= 0;
    if (this.speed === 0 || !this.hasTarget || self.state === CharacterState.LedgeClimb) {
      // Intentional waits (gaps, lifts, logic) and ledge hangs pause the clock.
      this.stuckRefTick = -1;
      return;
    }
    const metric = course ? this.routeMetric(self) : 0;
    if (this.stuckRefTick < 0) {
      this.resetStuckWindow(tick, metric, self);
      return;
    }
    const gained = course
      ? this.stuckRef - metric
      : Math.hypot(
          self.pos.x - this.stuckRefPos.x,
          self.pos.y - this.stuckRefPos.y,
          self.pos.z - this.stuckRefPos.z,
        );
    const windowTicks = Math.round(this.p.stuckSeconds / view.dt);
    if (gained >= STUCK_PROGRESS * (course ? 1 : 1.5)) {
      this.resetStuckWindow(tick, metric, self);
      if (tick - this.lastEscalateTick > windowTicks * 2) {
        this.stuckLevel = 0;
        this.stuckStep = 0;
      }
      return;
    }
    if (tick - this.stuckRefTick < windowTicks) return;
    this.resetStuckWindow(tick, metric, self);
    this.lastEscalateTick = tick;
    this.stuckLevel++;
    const blocked = this.blockedAhead(view, self);
    const plan = blocked === 2 ? PLAN_WALL : blocked === 1 ? PLAN_LIP : PLAN_OPEN;
    const step = plan[this.stuckStep % plan.length] as Unstick;
    this.stuckStep++;
    this.unstick(view, self, step);
  }

  private resetStuckWindow(tick: number, metric: number, self: BotSelfView): void {
    this.stuckRefTick = tick;
    this.stuckRef = metric;
    this.stuckRefPos.x = self.pos.x;
    this.stuckRefPos.y = self.pos.y;
    this.stuckRefPos.z = self.pos.z;
  }

  /**
   * Performs one recovery step. Every move that leaves the line toward the
   * target first checks for floor where it would take the bot; a recovery
   * that walks a stuck bot off a narrow bridge is worse than staying stuck,
   * so unsafe moves degrade to a plain hop.
   */
  private unstick(view: BotWorldView, self: BotSelfView, step: Unstick): void {
    const tick = view.tick;
    const fx = this.target.x - self.pos.x;
    const fz = this.target.z - self.pos.z;
    const fl = Math.hypot(fx, fz) || 1;
    const ux = fx / fl;
    const uz = fz / fl;
    switch (step) {
      case Unstick.Jump:
        this.schedule(view, Act.Jump, 0);
        break;
      case Unstick.Sidestep:
      case Unstick.SidestepFlip: {
        if (step === Unstick.SidestepFlip) this.sideDir = -this.sideDir;
        // Strafe right (+moveX) is (cos yaw, −sin yaw) = (uz, −ux) for forward (ux, uz).
        if (!this.floorAt(view, self, uz * this.sideDir * 1.5, -ux * this.sideDir * 1.5))
          this.sideDir = -this.sideDir;
        if (!this.floorAt(view, self, uz * this.sideDir * 1.5, -ux * this.sideDir * 1.5)) {
          this.schedule(view, Act.Jump, 0);
          break;
        }
        this.recover = Recover.Sidestep;
        this.recoverUntil = tick + Math.round(this.rng.range(0.7, 1.1) / view.dt);
        if (this.blockedAhead(view, self) !== 2) this.schedule(view, Act.Jump, 0.15);
        break;
      }
      case Unstick.JumpDive:
        // A lunge covers ~4 m: only with floor (or the far lip) to land on.
        this.schedule(view, this.floorAt(view, self, ux * 3.5, uz * 3.5) ? Act.JumpDive : Act.Jump, 0);
        break;
      case Unstick.BackOff:
        if (!this.floorAt(view, self, -ux * 1.5, -uz * 1.5)) {
          this.schedule(view, Act.Jump, 0);
          break;
        }
        this.recover = Recover.BackOff;
        this.recoverUntil = tick + Math.round(this.rng.range(0.5, 0.8) / view.dt);
        break;
      case Unstick.Repath:
        this.giveUpBranch(view, self);
        break;
    }
  }

  /** @returns True when there is floor at most 1.5 m below the feet at offset (dx, dz). */
  private floorAt(view: BotWorldView, self: BotSelfView, dx: number, dz: number): boolean {
    const P = this.s3;
    P.x = self.pos.x + dx;
    P.y = self.pos.y + 0.3;
    P.z = self.pos.z + dz;
    return view.groundBelow(P, CENTRE_HEIGHT + 1.8);
  }

  /** Abandons the current branch: a sibling from the last waypoint, else rejoin the graph elsewhere. */
  private giveUpBranch(view: BotWorldView, self: BotSelfView): void {
    this.waitObstacle = null;
    this.nextRetarget = 0;
    this.wanderValid = false;
    this.roamAngle += Math.PI;
    if (this.strategy !== 'course' || this.atGoal) return;
    const stuckOn = this.cur;
    this.banned = stuckOn;
    this.bannedUntil = view.time + BAN_SECONDS;
    const sib = this.prev >= 0 ? this.nav.sibling(this.prev, stuckOn, this.rng) : -1;
    if (sib >= 0) {
      this.setCur(sib);
      return;
    }
    this.prev = -1;
    this.setCur(this.nav.resume(self.pos, stuckOn));
  }

  // ---------------------------------------------------------------------------
  // Flavour
  // ---------------------------------------------------------------------------

  private silly(view: BotWorldView, self: BotSelfView): void {
    if (this.act !== Act.None) return;
    if (this.rng.chance(this.p.sillyPerSecond * DECISION_TICKS * view.dt)) {
      const dive = this.rng.chance(0.5);
      // Unforced antics are for open ground: on a crowded logic tile a dive past the edge was most of the
      // early eliminations (six or seven a board round at 100 bots).
      if (
        dive &&
        !this.floorAt(
          view,
          self,
          Math.sin(this.yaw) * SILLY_DIVE_REACH,
          Math.cos(this.yaw) * SILLY_DIVE_REACH,
        )
      )
        return;
      this.schedule(view, dive ? Act.Dive : Act.Jump, 0);
    }
  }

  /** Clumsy bots stagger about for a moment after getting back up from a stun. */
  private trackStun(view: BotWorldView, self: BotSelfView): void {
    const stunned = self.state === CharacterState.Stunned || self.state === CharacterState.GetUp;
    if (this.wasStunned && !stunned && this.rng.chance(this.p.dizzyChance)) {
      this.dizzyUntil = view.tick + Math.round(this.rng.range(0.4, 0.9) / view.dt);
    }
    this.wasStunned = stunned;
    // Staggering is for open ground: never sway a bot off a ledge.
    if (view.tick < this.dizzyUntil && this.hasTarget) {
      const dx = this.target.x - self.pos.x;
      const dz = this.target.z - self.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      if (
        !this.floorAt(view, self, (dz / l) * 1.5, (-dx / l) * 1.5) ||
        !this.floorAt(view, self, (-dz / l) * 1.5, (dx / l) * 1.5)
      )
        this.dizzyUntil = -1;
    }
  }

  private idle(view: BotWorldView, self: BotSelfView, out: CharacterInput, decide: boolean): void {
    if (this.nav.size > 0 && this.cur < 0 && view.phase < RoundPhase.Playing) {
      const first = this.nav.nodes[this.nav.nearest(self.pos)] as Waypoint;
      this.faceTowards(self.pos, first.position);
    }
    out.yaw = this.yaw;
    if (!decide) {
      this.applyActions(view, out);
      return;
    }
    this.emoteCooldown -= DECISION_TICKS * view.dt;
    const celebrating = self.status === PlayerRoundStatus.Qualified;
    if (celebrating && !this.wasQualified) {
      this.wasQualified = true;
      if (this.rng.chance(this.p.celebrateChance)) {
        out.emote = this.rng.int(1, 4);
        out.buttons |= Button.Emote;
        this.emoteCooldown = 2;
        if (this.act === Act.None) this.schedule(view, Act.Jump, 0.3);
        this.applyActions(view, out);
        return;
      }
    }
    const rate = celebrating ? this.p.emotePerSecond * 6 : this.p.emotePerSecond;
    if (this.emoteCooldown <= 0 && this.rng.chance(rate * DECISION_TICKS * view.dt)) {
      out.emote = this.rng.int(1, 4);
      out.buttons |= Button.Emote;
      this.emoteCooldown = 3;
    } else if (view.phase === RoundPhase.Countdown && this.rng.chance(0.04) && this.act === Act.None) {
      // Hopping on the start gate is half the fun of a countdown.
      this.schedule(view, Act.Jump, 0);
    }
    this.applyActions(view, out);
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  private steer(view: BotWorldView, self: BotSelfView, out: CharacterInput): void {
    // Smoothed random wobble: a damped spring driven by noise reads as "human" aim.
    this.noiseVel +=
      (this.rng.range(-1, 1) * this.p.aimNoise * 8 - this.noise * 4 - this.noiseVel * 2) * view.dt;
    this.noise += this.noiseVel * view.dt;
    if (!this.hasTarget) {
      out.yaw = this.yaw;
      return;
    }
    const dx = this.target.x - self.pos.x;
    const dz = this.target.z - self.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) this.yaw = Math.atan2(dx, dz);
    out.yaw = this.yaw + this.noise;
    // Ease off when arriving so we don't overshoot narrow platforms (never on take-off runs).
    const arrive = this.fullSpeed || d >= 1.2 ? 1 : Math.max(0.35, d / 1.2);
    out.moveZ = this.speed * arrive;
    out.moveX = 0;
    if (this.speed === 0) {
      out.moveZ = 0;
      // Fidget while waiting so the crowd at a gate looks alive.
      if (this.rng.chance(0.02)) out.moveX = this.rng.range(-0.4, 0.4);
      return;
    }
    const tick = view.tick;
    if (this.recover !== Recover.None) {
      if (tick >= this.recoverUntil) this.recover = Recover.None;
      else if (this.recover === Recover.Sidestep) {
        out.moveX = this.sideDir;
        out.moveZ = 0.45 * this.speed;
      } else {
        out.moveZ = -0.8;
        out.moveX = this.sideDir * 0.3;
      }
    }
    if (tick < this.dizzyUntil) {
      // Seeing stars: the stick sways side to side.
      out.yaw += Math.sin(tick * 0.35) * 1.1;
      out.moveZ *= 0.6;
    }
  }

  private applyActions(view: BotWorldView, out: CharacterInput): void {
    const t = view.tick;
    if (this.act !== Act.None && t >= this.actAt) {
      if ((this.act === Act.Jump || this.act === Act.JumpDive) && t < this.jumpUntil) {
        // Still holding the last jump: release for a tick so the new press registers.
        this.jumpUntil = t;
        this.actAt = t + 1;
      } else {
        if (this.act === Act.Jump || this.act === Act.JumpDive) this.jumpUntil = t + JUMP_HOLD_TICKS;
        if (this.act === Act.Dive) this.diveUntil = t + DIVE_HOLD_TICKS;
        if (this.act === Act.JumpDive) this.diveAt = t + Math.round(0.28 / view.dt);
        this.act = Act.None;
      }
    }
    if (this.diveAt >= 0 && t >= this.diveAt) {
      this.diveUntil = t + DIVE_HOLD_TICKS;
      this.diveAt = -1;
    }
    if (t < this.jumpUntil) out.buttons |= Button.Jump;
    if (t < this.diveUntil) out.buttons |= Button.Dive;
  }

  /**
   * Queues an action `delay` seconds from now, applying the skill's timing
   * error (centred slightly late, as human presses are)
   * and, sometimes, a comic mistake.
   */
  private schedule(view: BotWorldView, act: Act, delay: number): void {
    let a = act;
    let d = delay + 0.02 + this.gauss() * this.p.jumpTimingError;
    if (this.rng.chance(this.p.mistakeChance)) {
      const r = this.rng.next();
      if (r < 0.35) return;
      if (r < 0.6) d -= 0.2;
      else if (r < 0.85) d += 0.2;
      else a = act === Act.Dive ? Act.Jump : Act.Dive;
    }
    this.act = a;
    this.actAt = view.tick + Math.max(0, Math.round(d / view.dt));
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  private setTarget(x: number, y: number, z: number): void {
    this.target.x = x;
    this.target.y = y;
    this.target.z = z;
    this.hasTarget = true;
  }

  private faceTowards(from: Vec3, to: Vec3): void {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    if (dx * dx + dz * dz > 1e-4) this.yaw = Math.atan2(dx, dz);
  }

  private pickOffset(): void {
    if (this.cur < 0) return;
    const w = this.nav.nodes[this.cur] as Waypoint;
    const r = w.radius * this.p.lateralSpread * Math.sqrt(this.rng.next());
    const a = this.rng.range(0, Math.PI * 2);
    this.offset.x = Math.cos(a) * r;
    this.offset.z = Math.sin(a) * r;
    if (this.lineValid) {
      // Take-offs spread bots across the lip only, at most half the radius.
      const across = (this.offset.x * this.lineZ - this.offset.z * this.lineX) * 0.5;
      this.offset.x = across * this.lineZ;
      this.offset.z = -across * this.lineX;
    }
  }

  private reactionDelay(): number {
    return this.rng.range(this.p.reactionMin, this.p.reactionMax);
  }

  private gauss(): number {
    // Irwin–Hall approximation: cheap, bounded, good enough for timing jitter.
    return this.rng.next() + this.rng.next() + this.rng.next() - 1.5;
  }

  /** Unit XZ direction from `a` to `b` into `out`. */
  private dirTo(a: Vec3, b: Vec3, out: Vec3): Vec3 {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l;
    out.y = 0;
    out.z = dz / l;
    return out;
  }
}

function sqDistXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function insideBox(t: TriggerDef, p: Vec3): boolean {
  return (
    Math.abs(p.x - t.position.x) <= t.size.x / 2 &&
    Math.abs(p.y - t.position.y) <= t.size.y / 2 &&
    Math.abs(p.z - t.position.z) <= t.size.z / 2
  );
}

function midpoint(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  out.x = (a.x + b.x) / 2;
  out.y = (a.y + b.y) / 2;
  out.z = (a.z + b.z) / 2;
  return out;
}

function closestOnSegment(a: Vec3, b: Vec3, p: Vec3, out: Vec3): Vec3 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  let s = l2 > 1e-9 ? ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2 : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  out.x = a.x + dx * s;
  out.y = a.y + dy * s;
  out.z = a.z + dz * s;
  return out;
}

/**
 * Creates the built-in bot brain.
 *
 * @param opts - Bot id, skill tier, seed and round.
 * @returns A brain to drive one bot's input every step.
 * @example
 * const brain = createBotBrain({ id: 7, skill: 'sharp', seed: 1234, round });
 * brain.think(view, self, input);
 */
export function createBotBrain(opts: BotBrainOptions): BotBrainLike {
  return new DefaultBotBrain(opts);
}
