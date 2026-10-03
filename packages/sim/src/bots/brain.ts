/**
 * The built-in bot brain. Produces one {@link CharacterInput} per step through
 * the same path as human input.
 *
 * Structure:
 * - A *strategy* per round style picks a movement target: course following
 *   (races, crown climbs, towers), wandering on safe ground (survival, paint),
 *   team objectives (eggs → nest, ball → goal, zones), hunt chase/flee, and
 *   logic (move to the obstacle-provided safe spot, with skill-based memory).
 * - *Reflexes* layered on top: jumping incoming low beams / diving under high
 *   ones (predicted via obstacle poses), stuck recovery, silly moments, emotes.
 * - *Skill* (clumsy/average/sharp) shapes everything: reaction delay, aim
 *   wobble, action timing error and outright mistakes.
 *
 * Heavy queries run on a staggered decision tick (~10 Hz); every other step
 * replays the last decision, so the step loop stays allocation-free.
 */
import { Rng, RoundPhase, vec3, type RoundDefinition, type TriggerDef, type Vec3, type Waypoint } from '@tumble/shared';
import { Button, CharacterState, type CharacterInput } from '../character/types.ts';
import { PlayerRoundStatus } from '../match/types.ts';
import { navGraphFor, type NavGraph } from './nav.ts';
import { BOT_SKILLS, type BotSkillProfile } from './skill.ts';
import type { BotBrainLike, BotBrainOptions, BotSelfView, BotSkill, BotWorldView } from './types.ts';

/** Steps between decisions (60 Hz sim → 10 Hz thinking). */
const DECISION_TICKS = 6;
/** Steps the jump button is held for a full-height jump. */
const JUMP_HOLD_TICKS = 14;
const DIVE_HOLD_TICKS = 3;
/** Give up waiting for a gap after this long; better a comic splat than a statue. */
const MAX_GAP_WAIT_SECONDS = 6;

type Strategy = 'course' | 'wander' | 'team' | 'hunt' | 'logic';

/** One scheduled button action. */
const enum Act {
  None = 0,
  Jump = 1,
  Dive = 2,
  JumpDive = 3,
}

function strategyFor(round: RoundDefinition): Strategy {
  switch (round.qualification.mode) {
    case 'finish':
    case 'crownGrab':
      return 'course';
    case 'teamScore':
      return 'team';
    case 'holdItem':
      return 'hunt';
    case 'logicSurvive':
      return 'logic';
    default:
      return round.botNav.some((w) => w.next.length > 0) ? 'course' : 'wander';
  }
}

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
  private noise = 0;
  private noiseVel = 0;
  private yaw = 0;

  // Course following.
  private cur = -1;
  private prev = -1;
  private minRank = -1;
  private atGoal = false;
  private readonly offset = vec3();
  private waitObstacle: string | null = null;
  private waitSince = 0;
  private holdGrab = false;

  // Scheduled actions.
  private actAt = -1;
  private act: Act = Act.None;
  private diveAt = -1;
  private jumpUntil = -1;
  private diveUntil = -1;

  // Stuck detection.
  private bestDist = Infinity;
  private lastProgressTick = 0;
  private stuckLevel = 0;
  private readonly lastPos = vec3();

  // Wander / team / logic.
  private nextRetarget = 0;
  private wanderValid = false;
  private logicKnown = false;
  private readonly logicSpot = vec3(Number.NaN, 0, 0);
  private emoteCooldown = 0;

  // Scratch.
  private readonly s1 = vec3();
  private readonly s2 = vec3();

  constructor(opts: BotBrainOptions) {
    this.id = opts.id;
    this.skill = opts.skill;
    this.rng = new Rng(opts.seed);
    this.p = BOT_SKILLS[opts.skill];
    this.nav = navGraphFor(opts.round);
    this.strategy = strategyFor(opts.round);
    this.decisionPhase = ((opts.id % DECISION_TICKS) + DECISION_TICKS) % DECISION_TICKS;
    this.goalTrigger =
      opts.round.triggers.find((t) => t.kind === 'crown') ?? opts.round.triggers.find((t) => t.kind === 'finish') ?? null;
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
  }

  onRespawn(): void {
    this.cur = -1;
    this.prev = -1;
    this.atGoal = false;
    this.waitObstacle = null;
    this.act = Act.None;
    this.actAt = -1;
    this.diveAt = -1;
    this.holdGrab = false;
    this.bestDist = Infinity;
    this.stuckLevel = 0;
    this.nextRetarget = 0;
    this.wanderValid = false;
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
      this.speed = this.p.speed;
      this.holdGrab = false;
      switch (this.strategy) {
        case 'course':
          this.decideCourse(view, self);
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
      }
      this.reflexes(view, self);
      this.checkStuck(view, self);
      this.silly(view);
    }

    this.steer(view, self, out);
    this.applyActions(view, out);
    if (this.holdGrab) out.buttons |= Button.Grab;
  }

  // ---------------------------------------------------------------------------
  // Strategies
  // ---------------------------------------------------------------------------

  private decideCourse(view: BotWorldView, self: BotSelfView): void {
    const nav = this.nav;
    if (nav.size === 0) {
      this.seekGoal(self);
      return;
    }
    if (this.cur < 0) {
      this.cur = nav.nearest(self.pos, this.minRank - 1);
      this.prev = -1;
      this.atGoal = false;
      this.pickOffset();
    }
    if (this.atGoal) {
      this.seekGoal(self);
      return;
    }
    let wp = nav.nodes[this.cur] as Waypoint;
    const dx = wp.position.x - self.pos.x;
    const dz = wp.position.z - self.pos.z;
    const dy = wp.position.y - self.pos.y;
    if (dx * dx + dz * dz < wp.radius * wp.radius && dy < 2.2 && dy > -3.5) {
      this.arrive(view);
      if (this.atGoal) {
        this.seekGoal(self);
        return;
      }
      wp = nav.nodes[this.cur] as Waypoint;
    }
    if (this.waitObstacle !== null && this.prev >= 0) {
      if (this.gapIsOpen(view, self)) {
        this.waitObstacle = null;
      } else {
        // Hold position on the from-waypoint, facing the danger, fidgeting a little.
        const from = nav.nodes[this.prev] as Waypoint;
        this.setTarget(from.position.x, from.position.y, from.position.z);
        this.speed = 0;
        this.faceTowards(self.pos, wp.position);
        return;
      }
    }
    this.setTarget(wp.position.x + this.offset.x, wp.position.y, wp.position.z + this.offset.z);
    if (this.holdGrabOnLeg()) this.holdGrab = true;
  }

  private arrive(view: BotWorldView): void {
    const nav = this.nav;
    this.prev = this.cur;
    const from = nav.nodes[this.prev] as Waypoint;
    this.minRank = Math.max(this.minRank, nav.rank[this.prev] as number);
    const next = nav.chooseNext(this.prev, this.rng, this.p.branchGreed);
    this.bestDist = Infinity;
    this.lastProgressTick = view.tick;
    if (next < 0) {
      this.atGoal = true;
      return;
    }
    this.cur = next;
    this.pickOffset();
    switch (from.action) {
      case 'jump':
        this.schedule(view, Act.Jump, 0.02);
        break;
      case 'dive':
        this.schedule(view, Act.Dive, 0.08);
        break;
      case 'jumpDive':
        this.schedule(view, Act.JumpDive, 0.02);
        break;
      case 'waitForGap':
        if (from.timeAgainst && !this.rng.chance(this.p.recklessChance)) {
          this.waitObstacle = from.timeAgainst;
          this.waitSince = view.time;
        }
        break;
      default:
        break;
    }
  }

  /** Grab/climb legs: hold grab the whole way so ledges catch us. */
  private holdGrabOnLeg(): boolean {
    if (this.prev < 0) return false;
    const a = (this.nav.nodes[this.prev] as Waypoint).action;
    return a === 'grab' || a === 'climb';
  }

  /**
   * Samples the obstacle's predicted clearance at the crossing point over the
   * window in which we would be there; open when every sample is clear.
   */
  private gapIsOpen(view: BotWorldView, self: BotSelfView): boolean {
    const id = this.waitObstacle as string;
    if (view.time - this.waitSince > MAX_GAP_WAIT_SECONDS) return true;
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
    const samples = this.skill === 'sharp' ? 6 : this.skill === 'average' ? 4 : 2;
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

  private seekGoal(self: BotSelfView): void {
    const g = this.goalTrigger;
    if (!g) {
      this.decideWanderNoQuery(self, 2);
      return;
    }
    this.setTarget(g.position.x, g.position.y, g.position.z);
    const dx = g.position.x - self.pos.x;
    const dz = g.position.z - self.pos.z;
    if (g.kind === 'crown' && dx * dx + dz * dz < 9) {
      this.holdGrab = true;
      if (self.grounded && this.act === Act.None) this.act = Act.Jump;
    }
  }

  private decideWander(view: BotWorldView, self: BotSelfView, radius: number): void {
    const spot = this.s2;
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

  private decideWanderNoQuery(self: BotSelfView, radius: number): void {
    const a = this.rng.range(0, Math.PI * 2);
    this.setTarget(self.pos.x + Math.cos(a) * radius, self.pos.y, self.pos.z + Math.sin(a) * radius);
    this.speed = 0.4;
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
        const toGoal = this.s2;
        this.dirTo(prop, goal.position, toGoal);
        const bx = prop.x - toGoal.x * 1.4;
        const bz = prop.z - toGoal.z * 1.4;
        const behind = (self.pos.x - bx) ** 2 + (self.pos.z - bz) ** 2 < 1.5;
        if (behind) {
          this.setTarget(prop.x + toGoal.x, prop.y, prop.z + toGoal.z);
          if (this.rng.chance(0.08) && this.act === Act.None) this.schedule(view, Act.Dive, 0);
        } else {
          this.setTarget(bx, prop.y, bz);
        }
        return;
      }
    } else if (zone) {
      if (Math.abs(self.pos.x - zone.position.x) > zone.size.x / 2 - 0.5 || Math.abs(self.pos.z - zone.position.z) > zone.size.z / 2 - 0.5) {
        this.setTarget(zone.position.x, zone.position.y, zone.position.z);
        return;
      }
    }
    // Painting rounds and fallbacks: roam widely so every step covers new ground.
    this.decideWander(view, self, 9);
    this.speed = this.p.speed;
  }

  private nearestProp(view: BotWorldView, self: BotSelfView, out: Vec3, excludeIn: TriggerDef | null): boolean {
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
    // Lead the target a little; sharp bots lead more accurately.
    this.setTarget(bx, by, bz);
    if (dist < 1.8) this.holdGrab = true;
    else if (dist < 4 && this.act === Act.None && this.rng.chance(0.15 * (1 - this.p.mistakeChance))) {
      this.schedule(view, Act.Dive, this.reactionDelay() * 0.5);
    }
  }

  private decideLogic(view: BotWorldView, self: BotSelfView): void {
    const spot = this.s2;
    if (view.safeSpot(spot)) {
      const changed = !(Math.abs(spot.x - this.logicSpot.x) < 0.01 && Math.abs(spot.z - this.logicSpot.z) < 0.01);
      if (changed) {
        this.logicSpot.x = spot.x;
        this.logicSpot.y = spot.y;
        this.logicSpot.z = spot.z;
        this.logicKnown = this.rng.chance(this.p.memory);
        // A wrong guess is a nearby spot: close enough to look plausible.
        this.offset.x = this.logicKnown ? 0 : this.rng.range(-4, 4);
        this.offset.z = this.logicKnown ? 0 : this.rng.range(-4, 4);
        this.nextRetarget = view.time + this.reactionDelay() * 2;
      }
      if (view.time >= this.nextRetarget) {
        this.setTarget(this.logicSpot.x + this.offset.x, this.logicSpot.y, this.logicSpot.z + this.offset.z);
        return;
      }
      this.speed = 0;
      this.hasTarget = false;
      return;
    }
    this.decideWander(view, self, 3);
  }

  // ---------------------------------------------------------------------------
  // Reflexes
  // ---------------------------------------------------------------------------

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
      }
    }
  }

  private checkStuck(view: BotWorldView, self: BotSelfView): void {
    if (this.speed === 0 || !this.hasTarget) {
      this.lastProgressTick = view.tick;
      this.bestDist = Infinity;
      return;
    }
    const metric =
      this.strategy === 'course' && !this.atGoal
        ? Math.hypot(this.target.x - self.pos.x, (this.target.y - self.pos.y) * 0.5, this.target.z - self.pos.z)
        : -Math.hypot(self.pos.x - this.lastPos.x, self.pos.z - this.lastPos.z);
    if (this.strategy !== 'course' || this.atGoal) {
      // Displacement-based: reset the reference whenever we've moved a metre.
      if (-metric > 1) {
        this.lastPos.x = self.pos.x;
        this.lastPos.z = self.pos.z;
        this.lastProgressTick = view.tick;
        this.stuckLevel = 0;
      }
    } else if (metric < this.bestDist - 0.4) {
      this.bestDist = metric;
      this.lastProgressTick = view.tick;
      this.stuckLevel = 0;
    }
    if ((view.tick - this.lastProgressTick) * view.dt < this.p.stuckSeconds) return;
    this.lastProgressTick = view.tick;
    this.bestDist = Infinity;
    this.stuckLevel++;
    if (this.stuckLevel === 1) this.schedule(view, Act.Jump, 0);
    else if (this.stuckLevel === 2) this.schedule(view, Act.JumpDive, 0);
    else {
      this.stuckLevel = 0;
      this.cur = -1;
      this.waitObstacle = null;
      this.nextRetarget = 0;
    }
  }

  private silly(view: BotWorldView): void {
    if (this.act !== Act.None) return;
    if (this.rng.chance(this.p.sillyPerSecond * DECISION_TICKS * view.dt)) {
      this.schedule(view, this.rng.chance(0.5) ? Act.Dive : Act.Jump, 0);
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
    this.noiseVel += (this.rng.range(-1, 1) * this.p.aimNoise * 8 - this.noise * 4 - this.noiseVel * 2) * view.dt;
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
    // Ease off when arriving so we don't overshoot narrow platforms.
    const arrive = d < 1.2 ? Math.max(0.35, d / 1.2) : 1;
    out.moveZ = this.speed * arrive;
    out.moveX = 0;
    if (this.speed === 0) {
      out.moveZ = 0;
      // Fidget while waiting so the crowd at a gate looks alive.
      if (this.rng.chance(0.02)) out.moveX = this.rng.range(-0.4, 0.4);
    }
  }

  private applyActions(view: BotWorldView, out: CharacterInput): void {
    const t = view.tick;
    if (this.act !== Act.None && t >= this.actAt) {
      if (this.act === Act.Jump || this.act === Act.JumpDive) this.jumpUntil = t + JUMP_HOLD_TICKS;
      if (this.act === Act.Dive) this.diveUntil = t + DIVE_HOLD_TICKS;
      if (this.act === Act.JumpDive) this.diveAt = t + Math.round(0.28 / view.dt);
      this.act = Act.None;
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
   * error and, sometimes, a comic mistake.
   */
  private schedule(view: BotWorldView, act: Act, delay: number): void {
    let a = act;
    let d = delay + this.gauss() * this.p.jumpTimingError;
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
