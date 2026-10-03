/**
 * Party hangout on the menu platform: the bits of roughhousing and idle life
 * that tie the local Tumbler to its party mates.
 *
 * Responsibilities:
 * - grabs: holding a member in reach when the local Tumbler grabs, and being
 *   held (pinned in front of the holder, mash jump to break free);
 * - dives: a member's dive knocks the local Tumbler over;
 * - the shared beach ball: the leader publishes it, everyone else steers
 *   their copy toward it and reports their own knocks as bumps;
 * - AFK: no input for {@link AFK_SIT_S} seconds sits the Tumbler down.
 *
 * Every client simulates only its own Tumbler and tells the others what it
 * is doing, so each effect shows the same on every screen. Allocation-free
 * per frame.
 */
import { Button, CharacterState, emptyInput } from '@tumble/sim/character';
import { LOBBY_SIT_STATE } from '@tumble/shared';
import type { MainMenuStage } from '@tumble/render/scenes';
import type { InputSystem } from '../../input/index.ts';
import type { IdlePlay } from './idlePlay.ts';
import type { LobbyStage } from './lobbyStage.ts';
import { AFK_SIT_S, GRAB_MAX_S, GrabStruggle, steerBall, type BallState } from './partyLobby.ts';
import type { PartyLobbyView } from './partyLobbyView.ts';

/** What the hangout needs from the menu view. */
export interface PartyHangoutDeps {
  idle: IdlePlay;
  stage: MainMenuStage;
  lobby: LobbyStage;
  party: PartyLobbyView;
  input: InputSystem;
}

const GRAB_REACH = 1.4;
const GRAB_BREAK_DIST = 2.6;
const TACKLE_SPEED = 7;
/** A local velocity jump this large right after a step means our Tumbler hit the ball. */
const BUMP_DV = 1.5;
/** After a local knock, our copy of the ball rolls freely this long before the leader's state wins again. */
const BUMP_GRACE_S = 0.6;

/**
 * Hangout behaviour for the local Tumbler.
 *
 * @example
 * const hangout = new PartyHangout({ idle, stage, lobby, party, input });
 * if (!hangout.updateHeld(dt, playing)) moveNormally();
 * hangout.afterMove(dt, now, playing);
 */
export class PartyHangout {
  readonly struggle = new GrabStruggle();
  private holding: string | null = null;
  private freedFrom: string | null = null;
  private holdT = 0;
  private afk = 0;
  private prevJump = false;
  private readonly input = emptyInput();
  private readonly ball: BallState = [0, 0, 0, 0, 0, 0];
  private readonly prev: BallState = [0, 0, 0, 0, 0, 0];
  private readonly target: BallState = [0, 0, 0, 0, 0, 0];
  private hasPrev = false;
  private bumpGrace = 0;
  private readonly pin = { x: 0, y: 0, z: 0 };
  private readonly dir = { x: 0, z: 0 };
  private readonly feet = { x: 0, y: 0, z: 0 };

  constructor(private readonly d: PartyHangoutDeps) {}

  /** True while sat down for being idle. */
  get sitting(): boolean {
    return this.afk >= AFK_SIT_S;
  }

  /** Any player activity: stands back up. */
  wake(): void {
    if (this.sitting) {
      const a = this.d.stage.playerAnim;
      if (a.state === LOBBY_SIT_STATE) {
        a.state = CharacterState.Idle;
        a.stateTime = 0;
      }
    }
    this.afk = 0;
  }

  /**
   * Being held by a member: pins the Tumbler in front of them and counts
   * jump presses. Call before normal movement.
   *
   * @returns True while held (skip normal movement this frame).
   */
  updateHeld(dt: number, playing: boolean): boolean {
    const p = this.d.party;
    const s = this.struggle;
    let by = p.live ? p.holderOfSelf() : null;
    // Broke free while their frames still name us: that grab is spent until they let go.
    if (by && by === this.freedFrom) by = null;
    else if (by !== this.freedFrom) this.freedFrom = null;
    if (by && !s.by) {
      if (!s.start(by)) {
        s.update(dt);
        return false;
      }
      this.wake();
      this.prevJump = true;
    } else if (!by && s.by) {
      s.release();
      this.free(playing);
      return false;
    }
    if (!s.by) {
      s.update(dt);
      return false;
    }
    const holder = s.by;
    this.d.input.sample(this.d.idle.yaw, this.input);
    const jump = (this.input.buttons & Button.Jump) !== 0;
    if (jump && !this.prevJump) s.press();
    this.prevJump = jump;
    if (s.update(dt) || !p.holdPoint(holder, this.pin)) {
      s.release();
      this.freedFrom = holder;
      this.free(playing);
      return false;
    }
    this.d.idle.driven = false;
    this.d.stage.playerObject.position.set(this.pin.x, this.pin.y, this.pin.z);
    const a = this.d.stage.playerAnim;
    if (a.state !== CharacterState.Grabbed) a.stateTime = 0;
    a.state = CharacterState.Grabbed;
    a.speed = 0;
    a.verticalSpeed = 0;
    a.grounded = false;
    a.emote = null;
    return true;
  }

  private free(playing: boolean): void {
    const o = this.d.stage.playerObject.position;
    const idle = this.d.idle;
    idle.ctrl.teleport({ x: o.x, y: Math.max(0.05, o.y), z: o.z });
    idle.driven = playing;
    if (playing) idle.ctrl.knock({ x: 0, y: 5, z: 0 }, false);
    const a = this.d.stage.playerAnim;
    a.state = playing ? CharacterState.Jump : CharacterState.Idle;
    a.stateTime = 0;
    a.grounded = !playing;
    a.impulse = 0.8;
    this.d.lobby.poof(o);
  }

  /**
   * After normal movement: grabbing, dive knocks, the shared ball and AFK.
   *
   * @param dt - Frame delta (s).
   * @param now - `performance.now()` (ms).
   * @param playing - Idle play (the physics Tumbler) is active.
   * @param active - The player did something this frame (moved, emoted, jumped).
   */
  afterMove(dt: number, now: number, playing: boolean, active: boolean): void {
    const p = this.d.party;
    const o = this.d.stage.playerObject.position;
    const a = this.d.stage.playerAnim;
    if (this.struggle.by) {
      this.syncBall(dt, now);
      return;
    }

    // Grabbing a member in reach.
    const c = this.d.idle.ctrl;
    if (playing && p.live && !this.holding && c.state === CharacterState.Grab) {
      const target = p.memberInReach(o.x, o.z, c.facing, GRAB_REACH);
      if (target) {
        this.holding = target;
        this.holdT = 0;
        p.setGrab(target);
      }
    }
    if (this.holding) {
      this.holdT += dt;
      const ok = p.holdPoint(this.holding, this.pin);
      const far = !ok || Math.hypot(this.pin.x - o.x, this.pin.z - o.z) > GRAB_BREAK_DIST;
      // Their frames take a moment to show them grabbed; after that, them not being held means they broke free.
      const broke = this.holdT > 0.6 && p.memberState(this.holding) !== CharacterState.Grabbed;
      // Letting go of the grab button (the controller leaves Grab) drops them too.
      const letGo = c.state !== CharacterState.Grab;
      if (!playing || far || broke || letGo || this.holdT > GRAB_MAX_S + 0.4) {
        this.holding = null;
        p.setGrab(null);
      }
    }

    // A member's dive knocks us over.
    if (p.live && p.diveHit(o.x, o.z, this.dir)) {
      this.wake();
      if (playing) c.applyTackle(this.dir.x, this.dir.z, TACKLE_SPEED);
      else a.impulse = 1;
    }

    this.syncBall(dt, now);

    // Idle life: sit down after a while with nothing happening.
    if (active || a.state === CharacterState.Emote || this.holding) this.wake();
    else this.afk += dt;
    if (this.sitting && (a.state === CharacterState.Idle || a.state === LOBBY_SIT_STATE)) {
      if (a.state !== LOBBY_SIT_STATE) a.stateTime = 0;
      a.state = LOBBY_SIT_STATE;
    }
  }

  private syncBall(dt: number, now: number): void {
    const p = this.d.party;
    const lobby = this.d.lobby;
    if (!p.live) {
      p.setBallOut(null);
      this.hasPrev = false;
      return;
    }
    lobby.readBall(this.ball);
    if (p.isLeader) {
      p.setBallOut(this.ball);
      this.hasPrev = false;
      return;
    }
    p.setBallOut(null);
    const b = this.ball;
    if (this.hasPrev) {
      // Horizontal only: floor bounces flip vy every hop without anyone touching the ball.
      const dv = Math.hypot(b[3] - this.prev[3], b[5] - this.prev[5]);
      this.d.idle.ctrl.getFeet(this.feet);
      const near = Math.hypot(b[0] - this.feet.x, b[2] - this.feet.z) < 1.8;
      if (dv > BUMP_DV && near) {
        p.bump(b[3], b[4], b[5]);
        this.bumpGrace = BUMP_GRACE_S;
      }
    }
    if (this.bumpGrace > 0) this.bumpGrace -= dt;
    else {
      const age = p.ballTarget(now, this.target);
      if (age >= 0) {
        steerBall(b, this.target, age, dt);
        lobby.writeBall(b);
      }
    }
    for (let i = 0; i < 6; i++) this.prev[i] = b[i]!;
    this.hasPrev = true;
  }
}
