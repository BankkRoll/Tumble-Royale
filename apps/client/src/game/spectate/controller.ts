/**
 * The spectator camera and broadcast tools for one show session.
 *
 * Responsibilities:
 * - the camera modes (follow, free, overview, director) and comfortable
 *   transitions between them, through the round view's camera driver;
 * - the auto director, fed with standings, fates and team score swings;
 * - player switching beyond previous/next: the leader, a roster pick, the
 *   pinned player, party and club members first;
 * - the roster, broadcast overlay, help card and chroma backdrop state in the
 *   UI store, and their hotkeys and controller buttons;
 * - online, the free camera's focus hint for the server's interest
 *   management (at most 2 Hz, only when it moved).
 *
 * The session keeps the elimination flow, the spectate banner and who the
 * rig follows; it hands this controller a {@link SpectatorHost} and calls
 * {@link SpectatorController.frame} every frame while a round is on screen.
 */
import type { PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  initialSpectatorState,
  keyboardBusy,
  nextSpectatorMode,
  social,
  ui,
  type Settings,
  type SpectatorCamMode,
} from '@tumble/ui';
import type { LookDelta } from '../../input/index.ts';
import type { TouchState } from '../../input/touchState.ts';
import { menuOwnsPad } from '../inputRouting.ts';
import {
  CameraTransition,
  aimAlong,
  copyPose,
  forwardOf,
  pose,
  transitionSeconds,
  type CamPose,
  type Vec3,
} from './cameraMath.ts';
import {
  SpectatorPadEdges,
  flyAxesFromKeys,
  flyAxesFromPad,
  mergeFlyAxes,
  spectatorKeyAction,
  spectatorKeysLive,
  type SpectatorAction,
} from './controls.ts';
import {
  BroadcastDirector,
  type DirectorEvent,
  type DirectorPlayer,
  type DirectorReason,
  type DirectorRoundKind,
} from './director.ts';
import { FreeCam, freeCamBounds, type FreeCamBounds } from './freeCam.ts';
import { courseBox, overviewPose, type Box, type OverviewRound } from './overview.ts';
import { buildRoster, firstToWatch, type RosterPlayer } from './roster.ts';

/** The round view parts the controller drives. */
export interface SpectatorView {
  readonly camera: PerspectiveCamera;
  cameraDriver: ((dt: number, camera: PerspectiveCamera, focus: Vector3) => void) | null;
  readonly players: { feetOf(id: number, out: Vec3): boolean };
}

/** The live round as the controller needs it. */
export interface SpectatorRound {
  view: SpectatorView;
  def: OverviewRound & { bounds: { min: Vec3; max: Vec3 }; killY: number; type: string };
  kind: DirectorRoundKind;
  isFinal: boolean;
  qualifyTarget: number;
}

/** What the session provides. */
export interface SpectatorHost {
  /** The round on screen, or null between rounds. */
  round(): SpectatorRound | null;
  /** The local player is watching (spectating, or qualified and waiting). */
  watching(): boolean;
  /** Spectating has begun this round (the camera is no longer the local player's). */
  spectating(): boolean;
  /** Spectate candidates, playing first in standings order. */
  candidates(): number[];
  /** Everyone in the round, for the roster. */
  rosterPlayers(): RosterPlayer[];
  /** Everyone in the round, for the director (standings order). */
  directorPlayers(): DirectorPlayer[];
  /** Team scores now (empty outside team rounds). */
  teamScores(): readonly number[];
  /** Points the rig, banner and server at a player. */
  follow(id: number): void;
  /** Who the rig follows (-1 when nobody yet). */
  followedId(): number;
  /** Hides the spectate banner (free and overview cameras follow nobody). */
  clearBanner(): void;
  /** Online: where a camera that follows nobody looks (whole metres). */
  sendFocus(focus: [number, number, number]): void;
  /** Starts spectating when qualified and waiting (previous/next and the leader key do). */
  beginSpectating(): void;
  /** Steps through candidates. */
  cycle(dir: 1 | -1): void;
  settings(): Settings;
  /** Last input device, look and touch from the input layer. */
  readonly touch: TouchState;
}

/** Director captions shown on the overlay and toolbar. */
const REASON_TEXT: Readonly<Record<DirectorReason, string>> = {
  opening: 'Course overview',
  leader: 'In the lead',
  closeRace: 'Neck and neck',
  bubble: 'On the bubble',
  danger: 'Close call',
  teamSwing: 'Team on the move',
  final: 'The final',
  quiet: 'Course overview',
  pinned: 'Pinned',
};

/** Seconds between director decisions. */
const DIRECTOR_STEP_S = 0.25;
/** Seconds between roster refreshes. */
const ROSTER_STEP_S = 0.5;
/** Seconds between focus hints, and how far the focus must move to send another (m). */
const FOCUS_STEP_S = 0.5;
const FOCUS_MOVE_M = 6;
/** A knocked-out pinned player stays on screen this long before the camera moves on. */
const PIN_LINGER_S = 2.5;

/**
 * Spectator camera, director and broadcast tools.
 *
 * @example
 * const spec = new SpectatorController(host);
 * // per frame while a round is on screen:
 * spec.frame(realDt, look);
 */
export class SpectatorController {
  private mode: SpectatorCamMode = 'follow';
  private pinnedId: number | null = null;
  private live = false;
  private readonly director: BroadcastDirector;
  private readonly freeCam = new FreeCam();
  private readonly transition = new CameraTransition();
  private pendingFrom: CamPose | null = null;
  private readonly scratch = pose();
  private readonly target = pose();
  private readonly fwd: Vec3 = { x: 0, y: 0, z: 0 };
  private bounds: FreeCamBounds | null = null;
  private box: Box | null = null;
  private roundRef: SpectatorRound | null = null;
  private clock = 0;
  private directorAcc = DIRECTOR_STEP_S;
  private rosterAcc = ROSTER_STEP_S;
  private focusAcc = 0;
  private lastFocus: Vec3 | null = null;
  private lastTeams: readonly number[] = [];
  private pinLostAt = -1;
  private readonly held = new Set<string>();
  private readonly pad = new SpectatorPadEdges();
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };
  private readonly onBlur = (): void => this.held.clear();
  private disposed = false;

  /**
   * @param host - The session's side of the contract.
   * @param opts.prefer - Party/club test for the director's tie-break.
   */
  constructor(
    private readonly host: SpectatorHost,
    opts: { prefer?: ReadonlySet<number> } = {},
  ) {
    this.director = new BroadcastDirector(opts.prefer ? { prefer: opts.prefer } : {});
    ui.getState().setSpectator(initialSpectatorState(false));
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Current camera mode. */
  get cameraMode(): SpectatorCamMode {
    return this.mode;
  }

  /** True while the spectate banner should name a player (follow, or the director following someone). */
  get followsPlayers(): boolean {
    return this.mode === 'follow' || (this.mode === 'director' && this.director.shot.kind === 'follow');
  }

  /** The pinned player, if any. */
  get pinned(): number | null {
    return this.pinnedId;
  }

  /**
   * A private show's spectator seat: starts with the broadcast overlay and
   * shows the help card once so the controls are discoverable.
   */
  enableBroadcastSeat(): void {
    ui.getState().patchSpectator({ broadcast: true, help: true });
  }

  /**
   * Who to watch when spectating starts: the pinned player if still playing,
   * else a party or club member, else the leader.
   *
   * @param list - Candidates, playing first in standings order.
   * @param isParty - Party test.
   * @param isClub - Club test.
   */
  firstTarget(
    list: readonly number[],
    isParty: (id: number) => boolean,
    isClub: (id: number) => boolean,
  ): number | undefined {
    if (this.pinnedId !== null && list.includes(this.pinnedId)) return this.pinnedId;
    return firstToWatch(list, isParty, isClub);
  }

  /** Spectating started this round: tools go live with the viewer's camera mode. */
  goLive(): void {
    const r = this.host.round();
    if (!r) return;
    this.attach(r);
    this.live = true;
    this.clock = 0;
    this.director.reset(0);
    this.directorAcc = DIRECTOR_STEP_S;
    this.rosterAcc = ROSTER_STEP_S;
    this.lastTeams = [...this.host.teamScores()];
    if (this.mode === 'free') this.freeCam.reset(this.cameraPose(r.view.camera, this.scratch));
    else if (this.mode !== 'follow') this.pendingFrom = this.cameraPose(r.view.camera, pose());
    if (this.mode === 'free' || this.mode === 'overview') this.host.clearBanner();
    ui.getState().patchSpectator({ live: true, mode: this.mode, note: null });
    this.publishRoster();
  }

  /**
   * The rig is about to cut to another player: remember where the camera is
   * so the next frame blends from here (or cuts, when that is kinder).
   */
  beforeCut(): void {
    const r = this.roundRef;
    if (!r || !this.live || this.pendingFrom) return;
    this.pendingFrom = this.cameraPose(r.view.camera, pose());
  }

  /** The round left the screen (results, show end): tools go quiet, choices are kept. */
  goQuiet(): void {
    if (!this.live && !this.roundRef) return;
    this.live = false;
    this.detach();
    this.held.clear();
    this.pad.reset();
    const s = ui.getState();
    s.patchSpectator({ live: false, roster: [], note: null, help: false });
    if (s.overlay === 'spectatorRoster') s.setOverlay('none');
  }

  /**
   * A sim event for the director (fates) and the pin.
   *
   * @param e - What happened.
   */
  note(e: DirectorEvent): void {
    if (!this.live) return;
    this.director.note(e, this.clock);
    if (e.kind === 'eliminated' && e.id === this.pinnedId) this.pinLostAt = this.clock;
  }

  // ---------------------------------------------------------------------------
  // Actions (hotkeys, buttons, UI intents)
  // ---------------------------------------------------------------------------

  /**
   * Handles a keydown while watching. Call before the session's own keys.
   *
   * @param e - The key event.
   * @returns True when the key was a spectator key (it is then consumed).
   */
  handleKey(e: KeyboardEvent): boolean {
    if (keyboardBusy(e)) return false;
    const s = ui.getState();
    const watching = this.host.watching();
    if (!spectatorKeysLive(s, watching)) return false;
    if (!e.repeat) this.held.add(e.code);
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
    const action = spectatorKeyAction(e.code, s.settings.controls.keybinds, this.mode);
    if (!action) return false;
    // Tab would move browser focus; the roster takes it instead.
    if (e.code === 'Tab') e.preventDefault();
    this.act(action);
    return true;
  }

  /**
   * Runs a spectator action.
   *
   * @param a - The action.
   */
  act(a: SpectatorAction): void {
    const s = ui.getState();
    switch (a) {
      case 'prev':
      case 'next':
        this.manual();
        this.host.cycle(a === 'next' ? 1 : -1);
        return;
      case 'camera':
        this.setMode(nextSpectatorMode(this.mode));
        return;
      case 'leader':
        this.follow(-1);
        return;
      case 'roster':
        if (this.host.spectating())
          s.setOverlay(s.overlay === 'spectatorRoster' ? 'none' : 'spectatorRoster');
        return;
      case 'pin': {
        const id = this.host.followedId();
        this.pin(this.pinnedId !== null && (this.pinnedId === id || !this.followsPlayers) ? null : id);
        return;
      }
      case 'broadcast':
        this.toggle('overlay');
        return;
      case 'help':
        this.toggle('help');
        return;
      case 'chroma':
        this.toggle('chroma');
        return;
    }
  }

  /**
   * Switches camera mode with a smooth (or, with Reduce Motion, instant)
   * hand-over from where the camera is now.
   *
   * @param mode - New mode.
   */
  setMode(mode: SpectatorCamMode): void {
    if (mode === this.mode) return;
    const r = this.roundRef;
    if (r && this.live) {
      const from = this.cameraPose(r.view.camera, pose());
      if (mode === 'free') {
        this.freeCam.reset(from);
        this.transition.stop();
        this.pendingFrom = null;
      } else this.pendingFrom = from;
    }
    this.mode = mode;
    this.lastFocus = null;
    if (mode === 'director') this.director.reset(this.clock);
    if (mode === 'free' || mode === 'overview') this.host.clearBanner();
    else if (this.live && this.host.spectating() && mode === 'follow') {
      const id = this.host.followedId();
      if (id >= 0) this.host.follow(id);
    }
    ui.getState().patchSpectator({ mode, note: null });
  }

  /**
   * Follows a player picked on the roster (or the leader with -1), leaving
   * the free, overview and director cameras for a plain follow.
   *
   * @param id - Player id, or -1 for the leader.
   */
  follow(id: number): void {
    if (!this.host.spectating()) {
      this.host.beginSpectating();
      if (!this.host.spectating()) return;
    }
    const list = this.host.candidates();
    const target = id >= 0 ? id : list[0];
    if (target === undefined) return;
    this.manual();
    this.host.follow(target);
  }

  /**
   * Pins a player (null unpins). The camera, director included, stays on a
   * pinned player while they play; follow mode jumps to them now.
   *
   * @param id - Player id, or null.
   */
  pin(id: number | null): void {
    const next = id !== null && id >= 0 ? id : null;
    this.pinnedId = next;
    this.pinLostAt = -1;
    ui.getState().patchSpectator({ pinnedId: next });
    if (next !== null && this.live && next !== this.host.followedId()) this.follow(next);
    this.publishRoster();
  }

  /**
   * Broadcast overlay, help card or chroma backdrop on/off.
   *
   * @param what - Which.
   * @param on - New state (omit to toggle).
   */
  toggle(what: 'overlay' | 'help' | 'chroma', on?: boolean): void {
    const s = ui.getState();
    const cur = s.spectator;
    if (!cur) return;
    if (what === 'overlay') {
      const next = on ?? !cur.broadcast;
      s.patchSpectator({ broadcast: next, ...(next ? {} : { chroma: false }) });
    } else if (what === 'help') s.patchSpectator({ help: on ?? !cur.help });
    else {
      const next = on ?? !cur.chroma;
      // The backdrop only exists behind the broadcast overlay: asking for it turns the overlay on.
      s.patchSpectator({ chroma: next, ...(next ? { broadcast: true } : {}) });
    }
  }

  /** A manual player pick leaves the auto and detached cameras for follow. */
  private manual(): void {
    if (this.mode !== 'follow') this.setMode('follow');
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  /**
   * Per-frame work while a round is on screen.
   *
   * @param dt - Real frame delta (s).
   * @param look - Look delta read this frame (used by the free camera).
   * @returns True when the free camera consumed the look (the rig must not also turn).
   */
  frame(dt: number, look: LookDelta): boolean {
    const r = this.host.round();
    if (r !== this.roundRef) {
      if (this.roundRef) this.detach();
      if (r && this.live) this.attach(r);
    }
    if (!this.live || !r) return false;
    this.clock += dt;
    this.pollPad();
    if (this.mode === 'free') {
      const s = ui.getState();
      // A key held when the player list or chat opened must not keep the camera flying.
      if (!spectatorKeysLive(s, true) || social.getState().chat.open) this.held.clear();
      const keys = flyAxesFromKeys(this.held, s.settings.controls.keybinds);
      const axes = mergeFlyAxes(mergeFlyAxes(keys, this.padAxes()), {
        x: this.host.touch.stick.x,
        z: this.host.touch.stick.y,
        y: 0,
        boost: false,
      });
      this.freeCam.step(
        { ...axes, lookYaw: look.yaw, lookPitch: look.pitch },
        dt,
        this.bounds ?? freeCamBounds(r.def),
      );
    }
    this.directorAcc += dt;
    if (this.directorAcc >= DIRECTOR_STEP_S) {
      this.directorAcc = 0;
      this.runDirector(r);
      this.keepPin();
    }
    this.rosterAcc += dt;
    if (this.rosterAcc >= ROSTER_STEP_S) {
      this.rosterAcc = 0;
      this.publishRoster();
    }
    return this.mode === 'free';
  }

  /** Feeds the director and acts on its shot (director mode only). */
  private runDirector(r: SpectatorRound): void {
    const teams = this.host.teamScores();
    for (let i = 0; i < teams.length; i++) {
      const delta = (teams[i] ?? 0) - (this.lastTeams[i] ?? 0);
      if (delta !== 0) this.director.note({ kind: 'teamScore', team: i, delta }, this.clock);
    }
    this.lastTeams = [...teams];
    if (this.mode !== 'director') return;
    const pinned = this.pinnedId;
    const players = this.host.directorPlayers();
    if (pinned !== null && players.some((p) => p.id === pinned && p.status === 'playing')) {
      if (this.host.followedId() !== pinned) this.host.follow(pinned);
      ui.getState().patchSpectator({ note: REASON_TEXT.pinned });
      return;
    }
    const before = this.director.shot;
    const shot = this.director.update({
      time: this.clock,
      kind: r.kind,
      isFinal: r.isFinal,
      qualifyTarget: r.qualifyTarget,
      players,
    });
    if (shot.kind === 'follow') {
      if (before.kind !== 'follow' || before.id !== shot.id || this.host.followedId() !== shot.id) {
        if (before.kind === 'overview') this.pendingFrom = this.cameraPose(r.view.camera, pose());
        this.host.follow(shot.id);
      }
    } else if (before.kind !== 'overview') {
      this.pendingFrom = this.cameraPose(r.view.camera, pose());
      this.host.clearBanner();
    }
    ui.getState().patchSpectator({ note: REASON_TEXT[shot.reason] });
  }

  /** A knocked-out pinned player stays a moment, then follow mode moves on (the pin stays for later rounds). */
  private keepPin(): void {
    if (this.pinLostAt < 0 || this.mode !== 'follow') return;
    if (this.clock - this.pinLostAt < PIN_LINGER_S) return;
    this.pinLostAt = -1;
    if (this.host.followedId() === this.pinnedId) this.host.cycle(1);
  }

  /**
   * True when follow mode should hold on a knocked-out player instead of
   * cycling away at once (they are pinned and the linger has not run out).
   *
   * @param id - The followed player.
   */
  holdsKnockedOut(id: number): boolean {
    return this.pinnedId === id && this.pinLostAt >= 0 && this.clock - this.pinLostAt < PIN_LINGER_S;
  }

  /** Publishes the roster for the toolbar, overlay and player list. */
  private publishRoster(): void {
    if (!this.live) return;
    const roster = buildRoster(this.host.rosterPlayers(), {
      streamerMode: this.host.settings().gameplay.streamerMode,
      pinnedId: this.pinnedId,
      followingId: this.followsPlayers ? this.host.followedId() : null,
    });
    ui.getState().patchSpectator({ roster });
  }

  // ---------------------------------------------------------------------------
  // Camera
  // ---------------------------------------------------------------------------

  /** Called by the round view after the rig placed the camera. */
  private readonly drive = (dt: number, camera: PerspectiveCamera, focus: Vector3): void => {
    const r = this.roundRef;
    if (!r || !this.live || !this.host.spectating()) return;
    const want = this.target;
    let detached = false;
    if (this.mode === 'free') {
      copyPose(this.freeCam.pose, want);
      detached = true;
    } else if (
      this.mode === 'overview' ||
      (this.mode === 'director' && this.director.shot.kind === 'overview')
    ) {
      copyPose(this.overview(r, camera), want);
      detached = true;
    } else this.cameraPose(camera, want);
    if (this.pendingFrom) {
      const reduce = this.host.settings().accessibility.reduceMotion;
      this.transition.start(this.pendingFrom, transitionSeconds(this.pendingFrom, want, reduce));
      this.pendingFrom = null;
    }
    if (!detached && !this.transition.active) return;
    const out = this.transition.apply(want, dt, this.scratch);
    this.applyPose(camera, out);
    if (detached) {
      forwardOf(out, this.fwd);
      // Shadows and environment detail centre on what the camera looks at, ~25 m ahead.
      focus.set(out.x + this.fwd.x * 25, out.y + this.fwd.y * 25, out.z + this.fwd.z * 25);
      this.hint(focus, dt);
    }
  };

  /** Online interest hint for a camera that follows nobody: at most 2 Hz, only after it moved. */
  private hint(focus: Vec3, dt: number): void {
    this.focusAcc += dt;
    if (this.focusAcc < FOCUS_STEP_S) return;
    const last = this.lastFocus;
    if (last && Math.hypot(focus.x - last.x, focus.y - last.y, focus.z - last.z) < FOCUS_MOVE_M) return;
    this.focusAcc = 0;
    this.lastFocus = { x: focus.x, y: focus.y, z: focus.z };
    this.host.sendFocus([Math.round(focus.x), Math.round(focus.y), Math.round(focus.z)]);
  }

  private overview(r: SpectatorRound, camera: PerspectiveCamera): CamPose {
    this.box ??= courseBox(r.def);
    return overviewPose(this.box, camera.fov, camera.aspect);
  }

  private cameraPose(camera: PerspectiveCamera, out: CamPose): CamPose {
    out.x = camera.position.x;
    out.y = camera.position.y;
    out.z = camera.position.z;
    // A camera looks down its local −Z axis. Read from the quaternion: the rig has just turned
    // the camera this frame and the world matrix only catches up at render time.
    const { x, y, z, w } = camera.quaternion;
    return aimAlong({ x: -2 * (x * z + w * y), y: -2 * (y * z - w * x), z: -(1 - 2 * (x * x + y * y)) }, out);
  }

  private applyPose(camera: PerspectiveCamera, p: CamPose): void {
    forwardOf(p, this.fwd);
    camera.position.set(p.x, p.y, p.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(p.x + this.fwd.x, p.y + this.fwd.y, p.z + this.fwd.z);
    camera.updateMatrixWorld();
  }

  private attach(r: SpectatorRound): void {
    this.roundRef = r;
    this.bounds = freeCamBounds(r.def);
    this.box = null;
    r.view.cameraDriver = this.drive;
  }

  private detach(): void {
    const r = this.roundRef;
    if (r && r.view.cameraDriver === this.drive) r.view.cameraDriver = null;
    this.roundRef = null;
    this.transition.stop();
    this.pendingFrom = null;
    this.lastFocus = null;
  }

  // ---------------------------------------------------------------------------
  // Controller
  // ---------------------------------------------------------------------------

  private gamepad(): Gamepad | null {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }

  /** Spectator buttons on the controller, only while menus do not own the pad. */
  private pollPad(): void {
    const s = ui.getState();
    const gp = this.gamepad();
    if (!gp || menuOwnsPad(s, false) || s.screen !== 'round' || social.getState().chat.open) {
      this.pad.reset();
      return;
    }
    const down = (i: number): boolean => {
      const b = gp.buttons[i];
      return !!b && (b.pressed || b.value > 0.5);
    };
    for (const a of this.pad.update(down, s.settings.controls.padBinds)) this.act(a);
  }

  private padAxes(): ReturnType<typeof flyAxesFromPad> {
    const s = ui.getState();
    const gp = this.gamepad();
    if (!gp || menuOwnsPad(s, false)) return { x: 0, y: 0, z: 0, boost: false };
    return flyAxesFromPad(gp.axes, (i) => gp.buttons[i]?.value ?? 0);
  }

  /** Removes listeners and the camera driver; the UI state goes with the session. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    ui.getState().setSpectator(null);
  }
}
