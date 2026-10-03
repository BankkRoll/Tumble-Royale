/**
 * Main menu 3D view: the themed floating platform with the player's Tumbler
 * (live loadout), party slots and drifting camera, plus "idle play": press a
 * movement key (or click the empty stage) and run, jump and dive around the
 * platform with the real Tumbler controller.
 *
 * Responsibilities:
 * - Menu input mode: mouse buttons never drive the Tumbler while this view is
 *   alive (`InputSystem.setMouseActions(false)`), restored on dispose.
 * - Idle play inside an invisible rim wall, with the candy stage dressing
 *   (bounce pad, bumpable props, confetti cannon) from {@link LobbyStage}.
 * - Camera: lobby 3/4 drift, eased third-person follow in idle play (back to
 *   the lobby framing after ~6 s idle), and the dressing-room close-up.
 * - Emotes: plays on the Tumbler (standing or in idle play), party joins in,
 *   confetti fires.
 * - Online party: members stand on shared slots (leader centre) and move
 *   live on every member's screen ({@link PartyLobbyView}); the local
 *   Tumbler's home is its own slot and the lobby framing widens to the group.
 * - Party hangout ({@link PartyHangout}): grabs, dive knocks, the shared
 *   beach ball, sitting down when idle, waving at joiners and cheering when
 *   the leader hits Play; the camera keeps the whole party in frame.
 */
import { Vector3 } from 'three/webgpu';
import { getTheme } from '@tumble/content/themes';
import type { QualityPreset } from '@tumble/render/quality';
import {
  createMainMenuStage,
  type CreateTumblerVisual,
  type MainMenuStage,
  type TumblerLoadout,
} from '@tumble/render/scenes';
import type { Rapier } from '@tumble/sim';
import { CharacterState, emptyInput } from '@tumble/sim/character';
import type { LobbyPose } from '@tumble/shared';
import type { GameAudio } from '@tumble/audio';
import { ui } from '@tumble/ui';
import type { InputSystem } from '../../input/index.ts';
import { sceneOptions } from './common.ts';
import { IdlePlay } from './idlePlay.ts';
import { LOBBY_WALL_RADIUS, LobbyStage } from './lobbyStage.ts';
import { PartyHangout } from './partyHangout.ts';
import { lobbyFraming, menuStatus, type LobbyMember, type PartyRoster } from './partyLobby.ts';
import { PartyLobbyView, type LocalLobbyState, type PartyLobbyLink } from './partyLobbyView.ts';
import type { GameView } from './types.ts';

/** Options for {@link MenuView}. */
export interface MenuViewOptions {
  R: Rapier;
  preset: QualityPreset;
  createTumbler: CreateTumblerVisual;
  loadout: TumblerLoadout;
  input: InputSystem;
  audio: GameAudio | null;
  /** Party members standing beside the player. */
  party?: readonly TumblerLoadout[];
  /** Realtime link for the live party lobby (online accounts). */
  lobbyLink?: PartyLobbyLink | null;
  /** The online party, if any. */
  roster?: PartyRoster | null;
}

/** Snapshot of the lobby Tumbler for tests and debugging. */
export interface LobbyDebugState {
  /** `CharacterState` id of the player's Tumbler. */
  state: number;
  /** Feet position (m). */
  position: { x: number; y: number; z: number };
  idlePlaying: boolean;
  /** Camera look-down angle in degrees (0 = level). */
  cameraPitch: number;
  /** Local player's party slot (0 = centre/leader or solo). */
  partySlot: number;
  /** Tumblers on the platform, the local one included. */
  partySize: number;
}

/** Seconds without input before idle play eases back to the lobby framing. */
const IDLE_RETURN_S = 6;
const EMOTE_S = 2.6;
const FOLLOW_PITCH = 0.36;
/** Dressing-room camera distance: whole Tumbler plus tall headwear with headroom. */
const DRESS_ZOOM = 7;
// Closer than this clips tall hats at the top of a 16:10 screen.
const DRESS_ZOOM_MIN = 4.8;
const DRESS_ZOOM_MAX = 9.5;
const DRESS_PORTRAIT_SCALE = 2.7;

/**
 * The menu's 3D lobby.
 *
 * @example
 * const menu = new MenuView({ R, preset, createTumbler, loadout, input, audio });
 * director.show(menu);
 * menu.setLoadout(profile.tumblerLoadout());
 */
export class MenuView implements GameView {
  readonly kind = 'menu';
  readonly stage: MainMenuStage;
  private readonly idle: IdlePlay;
  private readonly lobby: LobbyStage;
  private playing = false;
  private loadout: TumblerLoadout;
  private emoteOverride: string | null = null;
  private emoteOverrideTime = 0;
  private wasEmoting = false;
  private celebrateCooldown = 0;
  private celebratePending = false;
  private readonly partyJoin: { slot: number; at: number; id: string }[] = [];
  private settleTime = 0;
  private stillTime = 0;
  private t = 0;
  private readonly camDir = new Vector3();
  private readonly camTarget = new Vector3();
  private readonly baseFov: number;
  private readonly partyLobby: PartyLobbyView;
  private readonly localPose: LobbyPose = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    state: CharacterState.Idle,
    speed: 0,
    vy: 0,
    grounded: true,
    emote: null,
  };
  private readonly local: LocalLobbyState = { pose: this.localPose, feet: { x: 0, y: 0, z: 0 } };
  private readonly framing = lobbyFraming(1);
  private readonly frameGoal = lobbyFraming(1);
  private readonly hangout: PartyHangout;

  constructor(private readonly opts: MenuViewOptions) {
    this.loadout = opts.loadout;
    this.party = opts.party ?? [];
    this.stage = createMainMenuStage({
      ...sceneOptions(getTheme('candy'), opts.preset, opts.createTumbler),
      player: opts.loadout,
      party: opts.party ?? [],
    });
    this.baseFov = this.stage.camera.fov;
    this.idle = new IdlePlay(opts.R, this.stage.platformRadius + 0.6, opts.input, opts.audio);
    this.idle.addRimWall(LOBBY_WALL_RADIUS);
    this.lobby = new LobbyStage(this.stage.scene, this.idle, opts.R, opts.preset);
    this.partyLobby = new PartyLobbyView({
      scene: this.stage.scene,
      createTumbler: opts.createTumbler,
      link: opts.lobbyLink ?? null,
      poof: (at) => this.lobby.poof(at),
      onJoin: () => this.lobbyClip('wave'),
      onLeaderStatus: (status) => {
        if (status === 'queue') this.emote('cheer');
      },
      onBump: (vx, vy, vz) => this.lobby.kickBall(vx, vy, vz),
    });
    this.hangout = new PartyHangout({
      idle: this.idle,
      stage: this.stage,
      lobby: this.lobby,
      party: this.partyLobby,
      input: opts.input,
    });
    this.partyLobby.setEquippedLook(opts.loadout);
    this.setPartyRoster(opts.roster ?? null, false);
    this.idle.onStep = (events) => {
      this.lobby.handleSimEvents(events);
      for (const e of events) if (e.type === 'emote') this.celebratePending = true;
    };
    opts.input.setMouseActions(false);
  }

  get scene(): GameView['scene'] {
    return this.stage.scene;
  }

  get camera(): GameView['camera'] {
    return this.stage.camera;
  }

  get grade(): GameView['grade'] {
    return this.stage.grade;
  }

  /** True while the player is running around the platform. */
  get idlePlaying(): boolean {
    return this.playing;
  }

  /** Updates the Tumbler's look (locker equips, welcome colours). */
  setLoadout(l: TumblerLoadout): void {
    this.loadout = l;
    this.stage.setPlayerLoadout(l);
  }

  /** Shows party members beside the player (up to three). */
  setParty(members: readonly TumblerLoadout[]): void {
    this.party = members;
    if (this.dressing) return;
    // The live party draws real members; the static stand-ins would double them.
    if (this.partyLobby.live) this.stage.setParty([null, null, null]);
    else this.stage.setParty([members[0] ?? null, members[1] ?? null, members[2] ?? null]);
  }

  /** Party members' looks by account (profile cards), for the live party. */
  setPartyLooks(members: readonly { userId: string; loadout: TumblerLoadout }[]): void {
    for (const m of members) this.partyLobby.setLook(m.userId, m.loadout);
  }

  /** The equipped look changed (not a preview): party mates re-skin live. */
  setEquippedLook(l: TumblerLoadout): void {
    this.partyLobby.setEquippedLook(l);
  }

  /**
   * Applies the online party: shared slots, live members, and the local
   * Tumbler's home moves to its own slot.
   *
   * @param roster - The party, or null when not in one.
   * @param animate - Puff when the local Tumbler changes slot (off while building the view).
   */
  setPartyRoster(roster: PartyRoster | null, animate = true): void {
    const before = this.partyLobby.selfHome();
    const wasLive = this.partyLobby.live;
    this.partyLobby.setRoster(roster);
    const home = this.partyLobby.selfHome();
    this.idle.setSpawn(home.x, home.z);
    // The invisible controller would otherwise keep shoving props around the old slot.
    if (!this.playing) this.idle.reset();
    if (wasLive !== this.partyLobby.live) this.setParty(this.party);
    if (!animate || home === before || this.playing || this.dressing) return;
    // Standing Tumbler hops to its new slot (promotion, someone left).
    this.lobby.poof({ x: before.x, y: 0, z: before.z });
    this.lobby.poof({ x: home.x, y: 0, z: home.z });
    this.lobby.clearArea(home.x, home.z, 1.4);
  }

  /**
   * The party member whose Tumbler is under a screen point (opens their card).
   *
   * @param ndcX - Normalised device X (-1..1).
   * @param ndcY - Normalised device Y (-1..1, up).
   */
  memberAt(ndcX: number, ndcY: number): LobbyMember | null {
    return this.partyLobby.memberAt(ndcX, ndcY, this.camera);
  }

  /**
   * Plays an emote on the lobby Tumbler (standing or in idle play); outside
   * the dressing room the party joins in and the confetti cannon fires.
   *
   * @param id - Emote item id (`emote.wave`).
   */
  emote(id: string): void {
    this.lobbyClip(id);
    if (this.dressing) return;
    this.celebrate(id);
  }

  /** Plays a clip on the local Tumbler without the confetti (join wave). */
  private lobbyClip(id: string): void {
    this.hangout.wake();
    if (this.playing) {
      this.emoteOverride = id;
      this.emoteOverrideTime = 1;
      this.idle.queueEmote(1);
      this.stillTime = 0;
    } else this.stage.playEmote(0, id, EMOTE_S);
  }

  /** Enters/leaves idle play. */
  setIdlePlay(on: boolean): void {
    if (on === this.playing) return;
    if (on && this.dressing) return;
    this.playing = on;
    this.hangout.wake();
    this.stage.setPlayable(on);
    this.stillTime = 0;
    this.emoteOverride = null;
    if (on) {
      this.idle.driven = true;
      this.idle.reset();
      // Drop presses latched while the menu had focus (a Space on a button, a stray click) so they can't fire now.
      this.opts.input.sample(0, emptyInput());
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      this.followInit = false;
      return;
    }
    const feet = this.idle.sample().feet;
    const home = this.partyLobby.selfHome();
    if (Math.hypot(feet.x - home.x, feet.z - home.z) > 0.8) {
      this.lobby.poof(feet);
      this.lobby.poof({ x: home.x, y: 0, z: home.z });
    }
    const a = this.stage.playerAnim;
    a.state = CharacterState.Idle;
    a.stateTime = 0;
    a.speed = 0;
    a.verticalSpeed = 0;
    a.grounded = true;
    a.emote = null;
    a.facing = 0;
    this.idle.reset();
    this.idle.driven = false;
    this.lobby.clearArea(home.x, home.z, 1.4);
    // Keep stepping briefly so props knocked into the air land instead of freezing mid-flight.
    this.settleTime = 3;
  }

  /** Tumbler state, feet position and camera pitch (automation hook). */
  debugState(): LobbyDebugState {
    const cam = this.camera;
    cam.getWorldDirection(this.camDir);
    const pitch = (-Math.asin(Math.max(-1, Math.min(1, this.camDir.y))) * 180) / Math.PI;
    if (this.playing) {
      const c = this.idle.ctrl;
      const { feet } = this.idle.sample();
      return {
        state: c.state,
        position: { x: feet.x, y: feet.y, z: feet.z },
        idlePlaying: true,
        cameraPitch: pitch,
        partySlot: this.partyLobby.selfSlot,
        partySize: this.partyLobby.memberCount,
      };
    }
    const p = this.stage.playerObject.position;
    return {
      state: this.stage.playerAnim.state,
      position: { x: p.x, y: p.y, z: p.z },
      idlePlaying: false,
      cameraPitch: pitch,
      partySlot: this.partyLobby.selfSlot,
      partySize: this.partyLobby.memberCount,
    };
  }

  update(dt: number, realDt: number): void {
    this.t += realDt;
    // NOTE: re-asserted every frame because a new MenuView can be built before the previous one is disposed.
    this.opts.input.setMouseActions(false);
    if (!this.playing && !this.dressing && this.canIdlePlay() && this.opts.input.movementKeyHeld(true))
      this.setIdlePlay(true);
    else if (this.playing && !this.canIdlePlay()) this.setIdlePlay(false);

    const now = performance.now();
    const ui$ = ui.getState();
    this.partyLobby.setStatus(menuStatus(ui$.screen, ui$.menuTab, ui$.overlay));
    const live = this.partyLobby.live;
    // The shared ball keeps rolling for everyone, so a live party always steps the little world.
    if (this.hangout.updateHeld(realDt, this.playing)) this.idle.advance(realDt);
    else if (this.playing) this.updateIdlePlay(realDt);
    else {
      // Slides to the centre for the dressing-room close-up, back to its slot after.
      const home = this.partyLobby.selfHome();
      const k = 1 - this.dressK;
      this.stage.playerObject.position.set(home.x * k, 0, home.z * k);
      if (this.settleTime > 0 || live) {
        this.settleTime -= realDt;
        this.idle.advance(realDt);
      }
      if (this.dressing) this.dressingIdle(realDt);
    }
    this.celebrateCooldown -= realDt;
    if (this.celebratePending) {
      this.celebratePending = false;
      const slot = this.idle.ctrl.emote;
      const id = this.emoteOverride ?? this.loadout.emotes[slot - 1] ?? 'emote.wave';
      this.celebrate(id);
    }
    // Dressing counts as activity: nobody should sit down in the Locker close-up.
    if (live)
      this.hangout.afterMove(
        realDt,
        now,
        this.playing,
        this.dressing || (this.playing && this.stillTime === 0),
      );
    this.updatePartyJoin();
    this.stage.update(dt);
    this.frameCamera(realDt);
    this.partyLobby.update(realDt, now, this.sampleLocal());
    this.lobby.update(realDt, this.camera);
  }

  /** The local Tumbler as party mates should see it (standing on its slot while dressing). */
  private sampleLocal(): LocalLobbyState {
    const o = this.stage.playerObject;
    const a = this.stage.playerAnim;
    const pose = this.localPose;
    const f = this.local.feet;
    f.x = o.position.x;
    f.y = o.position.y;
    f.z = o.position.z;
    if (this.dressing) {
      const home = this.partyLobby.selfHome();
      pose.x = home.x;
      pose.y = 0;
      pose.z = home.z;
      pose.yaw = this.partyLobby.selfHomeYaw();
      pose.state = CharacterState.Idle;
      pose.speed = 0;
      pose.vy = 0;
      pose.grounded = true;
      pose.emote = null;
      return this.local;
    }
    pose.x = f.x;
    pose.y = f.y;
    pose.z = f.z;
    // The standing Tumbler's idle sway is cosmetic; sending it would stream frames forever.
    pose.yaw = this.playing ? a.facing : this.partyLobby.selfHomeYaw();
    pose.state = a.state;
    pose.speed = a.speed;
    pose.vy = a.verticalSpeed;
    pose.grounded = a.grounded;
    pose.emote = a.state === CharacterState.Emote ? a.emote : null;
    return this.local;
  }

  private canIdlePlay(): boolean {
    const s = ui.getState();
    return s.screen === 'menu' && s.menuTab === 'play' && s.overlay === 'none' && !s.dialog;
  }

  private updateIdlePlay(realDt: number): void {
    this.camera.getWorldDirection(this.camDir);
    this.idle.yaw = Math.atan2(this.camDir.x, this.camDir.z);
    this.idle.advance(realDt);
    const { feet, vel } = this.idle.sample();
    this.stage.playerObject.position.set(feet.x, feet.y, feet.z);
    const c = this.idle.ctrl;
    const emoting = c.state === CharacterState.Emote;
    this.emoteOverrideTime -= realDt;
    if ((this.wasEmoting && !emoting) || (!emoting && this.emoteOverrideTime <= 0)) this.emoteOverride = null;
    this.wasEmoting = emoting;
    const slotEmote = c.emote > 0 ? (this.loadout.emotes[c.emote - 1] ?? null) : null;
    // The stage advances and renders its own Tumbler; idle play only feeds it the physics pose.
    const a = this.stage.playerAnim;
    const speed = Math.hypot(vel.x, vel.z);
    a.state = c.state;
    a.stateTime = c.stateTime;
    a.speed = speed;
    a.verticalSpeed = vel.y;
    a.facing = c.facing;
    a.grounded = c.grounded;
    a.emote = emoting ? (this.emoteOverride ?? slotEmote) : null;
    a.lookAt = this.camera.getWorldPosition(this.camTarget);

    const active =
      this.opts.input.movementKeyHeld() ||
      speed > 0.4 ||
      !c.grounded ||
      (c.state !== CharacterState.Idle && !emoting);
    this.stillTime = active ? 0 : this.stillTime + realDt;
  }

  private celebrate(id: string): void {
    if (this.celebrateCooldown > 0) return;
    this.celebrateCooldown = 0.8;
    const p = this.stage.playerObject.position;
    this.lobby.celebrate(p);
    this.partyJoin.length = 0;
    // Live party members emote on their own; only the stand-ins join in.
    if (this.partyLobby.live) return;
    for (let slot = 1; slot <= 3; slot++) this.partyJoin.push({ slot, at: this.t + 0.18 * slot + 0.1, id });
  }

  private updatePartyJoin(): void {
    for (let i = this.partyJoin.length - 1; i >= 0; i--) {
      const j = this.partyJoin[i]!;
      if (this.t < j.at) continue;
      this.stage.playEmote(j.slot, j.id, EMOTE_S);
      this.partyJoin.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------------
  // Camera framing: lobby drift, idle-play follow and the dressing room. Every
  // pose is computed each frame and blended with eased weights, so any switch
  // (start/stop idle play, idle timeout, locker) glides instead of cutting.
  // ---------------------------------------------------------------------------

  private dressing = false;
  private dressK = 0;
  private followK = 0;
  private followInit = false;
  private followYaw = 0;
  private turnYaw = 0;
  private turnTarget = 0;
  private zoom = DRESS_ZOOM;
  private idleEmoteIn = 4;
  private party: readonly TumblerLoadout[] = [];
  private readonly lobbyPos = new Vector3();
  private readonly lobbyLook = new Vector3();
  private readonly lobbyLookGoal = new Vector3();
  private readonly followLook = new Vector3();
  private readonly followPos = new Vector3();
  private readonly wantPos = new Vector3();
  private readonly wantLook = new Vector3();
  private readonly dressPos = new Vector3();
  private readonly dressLook = new Vector3();

  /**
   * Store/Locker framing: the Tumbler centred in the left stage area (top on
   * portrait screens), close up, on a drag-to-spin turntable.
   */
  setDressingRoom(on: boolean): void {
    if (on === this.dressing) return;
    this.dressing = on;
    this.lobby.setDressing(on);
    if (on) {
      this.setIdlePlay(false);
      this.turnTarget = 0;
      this.zoom = DRESS_ZOOM;
      this.idleEmoteIn = 3;
      this.stage.setParty([null, null, null]);
      this.partyLobby.setVisible(false);
    } else {
      this.turnTarget = 0;
      this.setParty(this.party);
      this.partyLobby.setVisible(true);
    }
  }

  /** Turntable input from the dressing-room stage. */
  turntable(rotate: number, zoom: number): void {
    if (!this.dressing) return;
    this.turnTarget += rotate;
    this.zoom = Math.max(DRESS_ZOOM_MIN, Math.min(DRESS_ZOOM_MAX, this.zoom - zoom * 0.45));
  }

  private dressingIdle(realDt: number): void {
    this.idleEmoteIn -= realDt;
    if (this.idleEmoteIn > 0) return;
    this.idleEmoteIn = 7 + Math.random() * 4;
    const pick = this.loadout.emotes[Math.floor(Math.random() * this.loadout.emotes.length)];
    if (pick && this.stage.playerAnim.emote === null) this.stage.playEmote(0, pick, EMOTE_S);
  }

  private frameCamera(realDt: number): void {
    const cam = this.camera;
    const portrait = cam.aspect < 1;
    const p = this.stage.playerObject.position;
    const ease = (rate: number): number => 1 - Math.exp(-realDt * rate);

    // Exponential approach reads as a ~400 ms ease for the locker, slower and softer for play.
    this.dressK += ((this.dressing ? 1 : 0) - this.dressK) * ease(9);
    if (Math.abs(this.dressK - (this.dressing ? 1 : 0)) < 0.002) this.dressK = this.dressing ? 1 : 0;
    const wantFollow = this.playing && this.stillTime < IDLE_RETURN_S ? 1 : 0;
    this.followK += (wantFollow - this.followK) * ease(this.playing ? 2.4 : 3.5);
    this.turnYaw += (this.turnTarget - this.turnYaw) * ease(10);
    this.stage.playerObject.rotation.y =
      this.dressing || this.dressK > 0.01 ? this.turnYaw : this.playing ? 0 : this.partyLobby.selfHomeYaw();

    // Lobby: a slow 3/4 drift around the party's centre (the origin solo), pulled back to fit
    // the group; during idle play it keeps the Tumbler in frame wherever it runs.
    // Live parties frame where everyone actually is, eased so wandering members never jerk the view.
    const goal = this.partyLobby.live
      ? this.partyLobby.groupFraming(p.x, p.z, this.frameGoal)
      : lobbyFraming(1, this.frameGoal);
    const fr = this.framing;
    const fk = ease(1.2);
    fr.cx += (goal.cx - fr.cx) * fk;
    fr.cz += (goal.cz - fr.cz) * fk;
    fr.spread += (goal.spread - fr.spread) * fk;
    const dist = (portrait ? 12.8 : 9.6) + fr.spread * (portrait ? 1.7 : 1.1);
    const height = (portrait ? 3.6 : 2.8) + fr.spread * 0.25;
    const yaw = Math.sin(this.t * 0.11) * 0.2;
    this.lobbyPos.set(
      fr.cx + Math.sin(yaw) * dist,
      height + Math.sin(this.t * 0.23) * 0.12,
      fr.cz + Math.cos(yaw) * dist,
    );
    const track = this.playing ? (portrait ? 0.85 : 0.6) : 0;
    this.lobbyLookGoal.set(
      fr.cx + (p.x - fr.cx) * track,
      1.0 + Math.max(0, p.y) * 0.4 * track,
      fr.cz + (p.z - fr.cz) * track,
    );
    this.lobbyLook.lerp(this.lobbyLookGoal, ease(3));

    // Follow: behind/beside the Tumbler at ~20° down, look point eased (vertical slower so jumps don't bob the view).
    if (this.followK > 0.001 || this.playing) {
      if (!this.followInit) {
        this.followInit = true;
        this.followYaw = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
        this.followLook.set(p.x, p.y + 0.95, p.z);
      }
      if (this.playing) this.followYaw -= this.opts.input.readLook(realDt).yaw;
      const k = ease(7);
      this.followLook.x += (p.x - this.followLook.x) * k;
      this.followLook.z += (p.z - this.followLook.z) * k;
      this.followLook.y += (p.y + 0.95 - this.followLook.y) * ease(3);
      const fd = portrait ? 9.6 : 7.4;
      const h = Math.cos(FOLLOW_PITCH) * fd;
      this.followPos.set(
        this.followLook.x + Math.sin(this.followYaw) * h,
        this.followLook.y + Math.sin(FOLLOW_PITCH) * fd,
        this.followLook.z + Math.cos(this.followYaw) * h,
      );
    }

    const f = this.followK * this.followK * (3 - 2 * this.followK);
    this.wantPos.lerpVectors(this.lobbyPos, this.followPos, f);
    this.wantLook.lerpVectors(this.lobbyLook, this.followLook, f);

    const d = this.dressK * this.dressK * (3 - 2 * this.dressK);
    if (d > 0) {
      // Portrait shows the Tumbler in the top ~30% band above the UI, so it sits twice as far back to fit hat to feet.
      const far = portrait ? DRESS_PORTRAIT_SCALE : 1;
      this.dressPos.set(0, portrait ? 1.9 : 1.5, this.zoom * far);
      this.dressLook.set(0, portrait ? 1.1 : 0.85, 0);
      this.wantPos.lerp(this.dressPos, d);
      this.wantLook.lerp(this.dressLook, d);
    }
    cam.position.copy(this.wantPos);
    cam.lookAt(this.wantLook);
    const fov = (portrait ? 50 : this.baseFov) * (1 - d) + this.baseFov * d;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    // Shift the projection so the subject sits in the stage area instead of mid-screen.
    const aspect = cam.aspect;
    const w = aspect * 1000;
    const offX = portrait ? 0 : 0.3 * w * d;
    const offY = portrait ? 1000 * 0.27 * d : 0;
    if (d > 0.001) cam.setViewOffset(w, 1000, offX, offY, w, 1000);
    else if (cam.view?.enabled) cam.clearViewOffset();
  }

  resize(width: number, height: number): void {
    this.stage.resize(width, height);
  }

  dispose(): void {
    this.opts.input.setMouseActions(true);
    this.partyLobby.dispose();
    this.lobby.dispose();
    this.idle.dispose();
    this.stage.dispose();
  }
}
