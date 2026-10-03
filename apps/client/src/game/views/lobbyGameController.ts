/**
 * Runs lobby mini-games on the menu platform for the local player.
 *
 * Responsibilities:
 * - authority: the solo player or party leader owns a {@link LobbyGameHost};
 *   it ticks the game, scores goals from its own ball, judges claims (its
 *   own and members'), turns members who leave the Play tab into
 *   spectators, cancels when the leader queues or someone leaves, and puts
 *   the snapshot on outgoing frames;
 * - members: follow the leader's relayed snapshots, report their own tags
 *   and target landings as claims, and drop a game whose leader went quiet;
 * - every client: one {@link LobbyGameTracker} turns the shown snapshot into
 *   effects played exactly once (line-up, 3-2-1, goal horn and confetti,
 *   potato pops, results cheer), drives the game props
 *   ({@link LobbyGameStage}), nameplate chips and the Play tab HUD;
 * - the Games sign: running into it opens the picker.
 *
 * Allocation-free per frame except when the HUD or chips actually change.
 */
import type { GameAudio } from '@tumble/audio';
import type { MainMenuStage } from '@tumble/render/scenes';
import type { Rapier } from '@tumble/sim';
import { CharacterState } from '@tumble/sim/character';
import {
  LOBBY_GAME_INFO,
  type LobbyGameClaim,
  type LobbyGameEvent,
  type LobbyGameKind,
  type LobbyGameWire,
  type LobbyStatus,
} from '@tumble/shared';
import { ui, type LobbyGameHud } from '@tumble/ui';
import type { Object3D } from 'three/webgpu';
import type { IdlePlay } from './idlePlay.ts';
import { buildLobbyHud, eventBanner, introCountdown, type LobbyHudPlayer } from './lobbyGameHud.ts';
import {
  GOAL,
  LOBBY_SIGN,
  LOBBY_TEAMS,
  LobbyGameHost,
  LobbyGameTracker,
  POTATO,
  goalAt,
  lineUpSpot,
  targetUnder,
  type PlayerLookup,
} from './lobbyGames.ts';
import { LobbyGameStage } from './lobbyGameStage.ts';
import type { LobbyStage } from './lobbyStage.ts';
import type { PartyLobbyView } from './partyLobbyView.ts';

/** What the controller needs from the menu view. */
export interface LobbyGameDeps {
  R: Rapier;
  scene: Object3D;
  idle: IdlePlay;
  stage: MainMenuStage;
  lobby: LobbyStage;
  party: PartyLobbyView;
  audio: GameAudio | null;
  /** Enters idle play if the menu allows it; true when the Tumbler is now playable. */
  play(): boolean;
  /** True while the local Tumbler runs around (idle play). */
  playing(): boolean;
  /** The local Tumbler cheers (with confetti) for a win. */
  cheer(): void;
  /** Visual slow motion for a moment (goal replay feel). */
  slowMo(seconds: number): void;
}

/** Account id stand-in for the local player outside a party (never sent). */
const SOLO_ID = 'local-player';
/** A member drops a game whose leader has sent nothing for this long (ms). */
const LEADER_QUIET_MS = 3000;
const PLAYER_COLORS = ['#ff4f9a', '#3ee6b4', '#ffd23f', '#8a5cff'];
const CONFETTI = ['#ff4f9a', '#ffd23f', '#3ee6b4', '#5aa9ff', '#ffffff'];
const POTATO_HEAD_Y = 2.05;
const SIGN_OPEN_M = 1.25;
const SIGN_RESET_M = 2.2;

/**
 * Lobby mini-games for the menu view.
 *
 * @example
 * const games = new LobbyGameController(deps);
 * games.start('goal');
 * // per frame
 * games.update(dt, performance.now(), status);
 */
export class LobbyGameController {
  private readonly host = new LobbyGameHost();
  private readonly tracker = new LobbyGameTracker();
  private remote: LobbyGameWire | null = null;
  private remoteAt = 0;
  private remoteLeader: string | null = null;
  private props: LobbyGameStage | null = null;
  private banner: LobbyGameHud['banner'] = null;
  private bannerSeq = 0;
  private fuseTotal = 1;
  private lastCount = -1;
  private claimCooldown = 0;
  private claimedSlot = -1;
  private claimedGen = -1;
  private sparkT = 0;
  private signNear = false;
  private status: LobbyStatus = 'menu';
  private access = { canStart: true, players: 1 };
  /** Last HUD inputs, so the store (and React) only hears about real changes. */
  private readonly sig = new Float64Array(10).fill(NaN);
  private readonly sigNext = new Float64Array(10);
  private readonly chips = new Map<string, string>();
  private readonly feet = { x: 0, y: 0, z: 0 };
  private readonly other = { x: 0, y: 0, z: 0 };
  private readonly ball: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  private readonly spot: [number, number, number, number, number, number] = [
    GOAL.spot.x,
    GOAL.spot.y,
    GOAL.spot.z,
    0,
    0,
    0,
  ];
  private readonly line = { x: 0, z: 0, yaw: 0 };
  private readonly claimMsg: LobbyGameClaim = { id: 0, k: 'hit' };
  private readonly lookup: PlayerLookup = (id, out) => {
    if (id === this.selfId) {
      const p = this.d.stage.playerObject.position;
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      return true;
    }
    return this.d.party.memberFeet(id, out);
  };
  private readonly who = (id: string): LobbyHudPlayer => {
    const g = this.tracker.game;
    const i = g ? g.players.indexOf(id) : -1;
    const name = this.d.party.memberName(id) || (id === this.selfId ? 'You' : 'Player');
    return { name, color: this.d.party.memberColor(id) ?? PLAYER_COLORS[Math.max(0, i) % 4]! };
  };
  private readonly isOut = (id: string): boolean => {
    const g = this.tracker.game;
    if (!g) return true;
    const i = g.players.indexOf(id);
    return i < 0 || (g.out & (1 << i)) !== 0;
  };

  constructor(private readonly d: LobbyGameDeps) {}

  /** The local player's id in games: their account id in a party, a stand-in solo. */
  get selfId(): string {
    return this.d.party.selfId ?? SOLO_ID;
  }

  /** True while the local player owns the game (solo, or the party leader). */
  get authority(): boolean {
    return !this.d.party.live || this.d.party.isLeader;
  }

  /** True while a game (intro to results) is showing. */
  get active(): boolean {
    return this.tracker.game !== null;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Starts a game for everyone on the platform (solo player or leader only).
   *
   * @returns False when the local player may not start it or too few are here.
   */
  start(kind: LobbyGameKind): boolean {
    if (!this.authority) return false;
    const players = this.d.party.live ? this.d.party.memberIds() : [SOLO_ID];
    if (players.length < LOBBY_GAME_INFO[kind].minPlayers) return false;
    this.host.start(kind, players);
    for (const id of players)
      if (id !== this.selfId && this.d.party.memberStatus(id) !== 'menu') this.host.spectate(id);
    return true;
  }

  /** Ends the running game (solo player or leader only). */
  stop(): void {
    if (this.authority) this.host.cancel();
  }

  /** Members: the leader's latest snapshot (null = the leader is not running a game). */
  onLeaderGame(game: LobbyGameWire | null): void {
    if (this.authority) return;
    this.remote = game;
    this.remoteAt = performance.now();
    this.remoteLeader = this.d.party.leaderId;
  }

  /** Leader: a member's claim. */
  onClaim(userId: string, claim: LobbyGameClaim): void {
    if (this.d.party.isLeader) this.host.claim(userId, claim, this.lookup);
  }

  /**
   * The party changed: a game whose players are no longer all here is
   * cancelled, a solo game ends when a party forms, and a member who stops
   * being led by the game's leader drops it.
   */
  onRoster(): void {
    const g = this.host.game;
    if (g) {
      const live = this.d.party.live;
      if (live && !this.d.party.isLeader) this.host.clear();
      else if (!live && g.players.length > 1) this.host.cancel();
      else if (live) {
        const ids = this.d.party.memberIds();
        if (g.players.length === 1 || g.players.some((id) => !ids.includes(id))) this.host.cancel();
      }
    }
    if (this.remote && (!this.d.party.live || this.d.party.leaderId !== this.remoteLeader))
      this.remote = null;
  }

  /**
   * The menu view's ray hit the Games sign or the local Tumbler ran into
   * it: open the picker.
   */
  openPicker(): void {
    ui.getState().setLobbyGames({ pickerOpen: true });
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  /**
   * Advances the game.
   *
   * @param dt - Real frame delta (s).
   * @param now - `performance.now()` (ms).
   * @param status - Local menu status (`menu` on the Play tab).
   */
  update(dt: number, now: number, status: LobbyStatus): void {
    this.status = status;
    this.claimCooldown = Math.max(0, this.claimCooldown - dt);
    this.publishAccess();
    if (this.authority) this.runHost(dt);
    else {
      this.d.party.setGameSource(null);
      if (this.host.active) this.host.clear();
      if (this.remote && now - this.remoteAt > LEADER_QUIET_MS) this.remote = null;
    }

    const shown = this.authority ? this.host.game : this.remote;
    const c = this.tracker.update(shown);
    if (c.ended) this.teardown();
    const g = this.tracker.game;
    if (g) {
      if (c.started) this.setup(g);
      if (c.phase) this.onPhase(g);
      if (c.event) this.onEvent(g, c.event);
      this.frame(g, dt, now);
    } else this.updateSign();
  }

  private runHost(dt: number): void {
    const host = this.host;
    const party = this.d.party;
    const g = host.game;
    if (!g) {
      party.setGameSource(null);
      party.setBallEager(false);
      return;
    }
    if (this.status === 'queue') host.cancel();
    else if (this.status !== 'menu') host.spectate(this.selfId);
    if (party.live)
      for (let i = 0; i < g.players.length; i++) {
        const id = g.players[i]!;
        if (id !== this.selfId && party.memberStatus(id) !== 'menu') host.spectate(id);
      }
    if (g.kind === 'goal') {
      const lobby = this.d.lobby;
      if (host.takeBallReset() || host.ballHeld) lobby.writeBall(this.spot);
      else {
        lobby.readBall(this.ball);
        const goal = goalAt(this.ball[0], this.ball[1], this.ball[2]);
        if (goal >= 0) host.scoreGoal(goal as 0 | 1);
      }
    }
    host.tick(dt);
    if (party.live && party.isLeader && host.game) {
      party.setGameSource(this.wire);
      party.setBallEager(host.game.kind === 'goal');
    } else {
      party.setGameSource(null);
      party.setBallEager(false);
    }
  }

  private readonly wire = (): LobbyGameWire | null => this.host.wire() as LobbyGameWire | null;

  /** Per-frame work while a game shows. */
  private frame(g: Readonly<LobbyGameWire>, dt: number, now: number): void {
    const me = g.players.indexOf(this.selfId);
    const playing = me >= 0 && (g.out & (1 << me)) === 0 && this.status === 'menu';
    const p = this.d.stage.playerObject.position;
    const props = this.props;
    const elapsed = this.authority ? 0 : (now - this.remoteAt) / 1000;
    const left = Math.max(0, g.left - elapsed);
    const aux = Math.max(0, g.aux - elapsed);

    if (g.phase === 'intro') {
      const n = introCountdown(left);
      if (n !== this.lastCount && n > 0) this.cue('countdown.tick');
      this.lastCount = n;
    }

    if (props) {
      props.setVisible(this.status !== 'locker' && this.status !== 'store');
      props.update(dt);
      if (g.kind === 'potato') {
        const holder = g.it >= 0 ? g.players[g.it]! : null;
        if (holder && this.lookup(holder, this.other)) {
          const heat = Math.min(1, Math.max(0, 1 - aux / Math.max(0.1, this.fuseTotal)));
          props.setPotato(true, this.other.x, this.other.y + POTATO_HEAD_Y, this.other.z, heat);
          this.sparkT -= dt * (1 + heat * 3);
          if (this.sparkT <= 0) {
            this.sparkT = 0.35;
            this.d.lobby.vfx.spawn(
              'sparkle',
              { x: this.other.x, y: this.other.y + POTATO_HEAD_Y + 0.3, z: this.other.z },
              { color: heat > 0.7 ? '#ff4a1c' : '#ffd23f', scale: 0.35 + heat * 0.3, intensity: 0.4 },
            );
          }
        } else props.setPotato(false);
      } else if (g.kind === 'targets') props.setTargets(g.targets);
    }

    if (g.phase === 'play' && playing) this.localClaims(g, me, p);
    this.publishHud(g, left, aux, playing);
  }

  /** Tags and target landings by the local Tumbler. */
  private localClaims(g: Readonly<LobbyGameWire>, me: number, p: { x: number; y: number; z: number }): void {
    if (this.claimCooldown > 0) return;
    const c = this.claimMsg;
    c.id = g.id;
    if (g.kind === 'potato' && g.it === me && this.d.playing()) {
      const ctrl = this.d.idle.ctrl;
      const party = this.d.party;
      let target: string | null = null;
      if (ctrl.state === CharacterState.Dive || ctrl.state === CharacterState.DiveSlide)
        target = party.memberNear(p.x, p.z, POTATO.diveReach, this.isOut);
      else if (ctrl.state === CharacterState.Grab) {
        target = party.memberInReach(p.x, p.z, ctrl.facing, 1.4);
        if (target && this.isOut(target)) target = null;
      }
      if (!target) return;
      c.k = 'tag';
      c.target = target;
      delete c.t;
      delete c.g;
      this.send(c);
      return;
    }
    if (g.kind === 'targets') {
      const slot = targetUnder(p.x, p.y, p.z, g.targets);
      if (slot < 0) return;
      const gen = g.targets[slot * 4 + 3]!;
      if (slot === this.claimedSlot && gen === this.claimedGen) return;
      this.claimedSlot = slot;
      this.claimedGen = gen;
      c.k = 'hit';
      c.t = slot;
      c.g = gen;
      delete c.target;
      this.send(c);
    }
  }

  private send(c: LobbyGameClaim): void {
    this.claimCooldown = 0.3;
    if (this.authority) this.host.claim(this.selfId, c, this.lookup);
    // The claim object is reused; the relay link serialises it on the next frame.
    else this.d.party.claim({ ...c });
  }

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  private setup(g: Readonly<LobbyGameWire>): void {
    this.props?.dispose();
    this.props = new LobbyGameStage(this.d.scene, this.d.idle, this.d.R, g.kind);
    this.d.lobby.setArena(true);
    this.banner = null;
    this.lastCount = -1;
    this.claimedSlot = -1;
    this.claimedGen = -1;
    this.fuseTotal = Math.max(1, g.aux);
    this.sig.fill(NaN);
    ui.getState().setLobbyGames({ pickerOpen: false });
    this.cue('ui.whoosh');
    const me = g.players.indexOf(this.selfId);
    if (me < 0 || g.phase !== 'intro' || this.status !== 'menu' || !this.d.play()) return;
    if (!lineUpSpot(g, me, this.line)) return;
    const o = this.d.stage.playerObject.position;
    this.d.lobby.poof(o);
    this.d.idle.ctrl.teleport({ x: this.line.x, y: 0.05, z: this.line.z }, this.line.yaw);
    this.d.lobby.poof({ x: this.line.x, y: 0, z: this.line.z });
  }

  private teardown(): void {
    this.props?.dispose();
    this.props = null;
    this.d.lobby.setArena(false);
    this.d.party.setGameChips(null);
    this.d.party.setBallEager(false);
    this.chips.clear();
    this.banner = null;
    this.sig.fill(NaN);
    ui.getState().setLobbyGames({ hud: null });
  }

  private onPhase(g: Readonly<LobbyGameWire>): void {
    if (g.phase === 'play') {
      this.cue('countdown.go');
      return;
    }
    if (g.phase !== 'results') return;
    this.cue('round.whistle');
    if (g.reason === 'cancel') return;
    const me = g.players.indexOf(this.selfId);
    for (let i = 0; i < g.players.length; i++) {
      if (!(g.win & (1 << i)) || !this.lookup(g.players[i]!, this.other)) continue;
      this.d.lobby.vfx.spawn(
        'confetti',
        { x: this.other.x, y: this.other.y + 2.6, z: this.other.z },
        { colors: CONFETTI, intensity: 1 },
      );
    }
    if (me >= 0 && g.win & (1 << me)) {
      this.cue('crowd.cheer');
      this.d.cheer();
    }
  }

  private onEvent(g: Readonly<LobbyGameWire>, ev: LobbyGameEvent): void {
    const vfx = this.d.lobby.vfx;
    const me = g.players.indexOf(this.selfId);
    const { a, b } = ev;
    const shown = eventBanner(g as LobbyGameWire, ev, this.selfId, this.who);
    if (shown) this.banner = { ...shown, seq: ++this.bannerSeq };
    switch (ev.k) {
      case 'goal': {
        const sx = b === 0 ? -1 : 1;
        const team = g.players.length === 1 ? 0 : a;
        const color = LOBBY_TEAMS[team]!.color;
        const at = { x: sx * (GOAL.lineX + 0.5), y: 1.1, z: 0 };
        vfx.spawn(
          'confetti',
          { x: at.x, y: at.y + 1.6, z: at.z },
          { colors: [color, '#ffffff', '#ffd23f'], intensity: 1.5 },
        );
        vfx.spawn('bounceRing', at, { color, scale: 1.6 });
        vfx.spawn('fireworks', { x: at.x * 0.6, y: 3.5, z: -1 }, { colors: [color, '#ffffff'], delay: 0.15 });
        this.cue('team.horn');
        this.cue('crowd.cheer');
        this.d.slowMo(0.7);
        break;
      }
      case 'tag': {
        if (b >= 0 && this.lookup(g.players[b]!, this.other)) {
          vfx.spawn(
            'pop',
            { x: this.other.x, y: this.other.y + POTATO_HEAD_Y, z: this.other.z },
            { scale: 0.7 },
          );
          vfx.spawn(
            'sparkle',
            { x: this.other.x, y: this.other.y + 1.2, z: this.other.z },
            { color: '#ff8a3d' },
          );
        }
        if (a < 0) this.fuseTotal = Math.max(1, g.aux);
        this.cue(a < 0 ? 'alarm.blip' : 'punch.thwack');
        break;
      }
      case 'pop': {
        if (a >= 0 && this.lookup(g.players[a]!, this.other)) {
          const o = this.other;
          vfx.spawn('pop', { x: o.x, y: o.y + POTATO_HEAD_Y, z: o.z }, { scale: 1.6 });
          vfx.spawn('eliminationPoof', { x: o.x, y: o.y + 1, z: o.z });
          vfx.spawn(
            'confetti',
            { x: o.x, y: o.y + 2.4, z: o.z },
            { colors: ['#ff4a1c', '#ffd23f'], intensity: 0.6 },
          );
        }
        this.cue('cannon.thump');
        if (a === me) {
          this.cue('eliminated.trombone');
          if (this.d.playing()) this.d.idle.ctrl.knock({ x: 0, y: 9, z: 0 }, true);
        }
        break;
      }
      case 'hit': {
        const i = b * 4;
        if (i + 1 < g.targets.length) {
          const at = { x: g.targets[i]!, y: 0.3, z: g.targets[i + 1]! };
          vfx.spawn('sparkle', at, { color: '#ffd23f', scale: 1.1 });
          vfx.spawn('bounceRing', at, { color: '#3ee6b4' });
        }
        this.cue(a === me ? 'egg.pickup' : 'popup.pop');
        break;
      }
      default:
        break;
    }
  }

  private cue(name: string): void {
    this.d.audio?.playCue(name);
  }

  // ---------------------------------------------------------------------------
  // HUD, chips, picker access and the sign
  // ---------------------------------------------------------------------------

  private publishHud(g: Readonly<LobbyGameWire>, left: number, aux: number, playing: boolean): void {
    const fuse = g.kind === 'potato' && g.it >= 0 ? Math.min(1, aux / Math.max(0.1, this.fuseTotal)) : -1;
    let scores = 0;
    for (let i = 0; i < g.score.length; i++) scores = scores * 131 + g.score[i]!;
    const s = this.sig;
    const next = this.sigNext;
    next[0] = g.id;
    next[1] = g.phase === 'intro' ? 0 : g.phase === 'play' ? 1 : 2;
    next[2] = g.phase === 'intro' ? introCountdown(left) : Math.ceil(left);
    next[3] = Math.round(fuse * 20);
    next[4] = scores;
    next[5] = g.out;
    next[6] = g.it;
    next[7] = this.banner?.seq ?? 0;
    next[8] = playing ? 1 : 0;
    next[9] = g.win;
    let same = true;
    for (let i = 0; i < next.length; i++) if (s[i] !== next[i]) same = false;
    if (same) return;
    s.set(next);
    const hud = buildLobbyHud(
      g as LobbyGameWire,
      this.selfId,
      this.who,
      { left, fuse: fuse < 0 ? null : fuse },
      this.banner,
      !playing && g.phase !== 'results',
    );
    ui.getState().setLobbyGames({ hud });
    this.publishChips(g);
  }

  private publishChips(g: Readonly<LobbyGameWire>): void {
    if (!this.d.party.live) return;
    const chips = this.chips;
    chips.clear();
    for (let i = 0; i < g.players.length; i++) {
      const id = g.players[i]!;
      const out = (g.out & (1 << i)) !== 0;
      let chip: string;
      if (g.kind === 'goal') chip = out ? 'WATCHING' : LOBBY_TEAMS[g.teams[i]!]!.name.toUpperCase();
      else if (g.kind === 'potato') chip = g.it === i ? 'IT' : out ? 'OUT' : 'SAFE';
      else chip = out ? 'WATCHING' : `${g.score[i]} PTS`;
      chips.set(id, chip);
    }
    this.d.party.setGameChips(chips);
  }

  private publishAccess(): void {
    const party = this.d.party;
    const canStart = this.authority;
    const players = party.live ? party.memberCount : 1;
    if (canStart === this.access.canStart && players === this.access.players) return;
    this.access.canStart = canStart;
    this.access.players = players;
    ui.getState().setLobbyGames({ canStart, players });
  }

  /** Running into the Games sign opens the picker (once per visit). */
  private updateSign(): void {
    if (!this.d.playing()) {
      this.signNear = false;
      return;
    }
    const p = this.d.stage.playerObject.position;
    const d = Math.hypot(p.x - LOBBY_SIGN.x, p.z - LOBBY_SIGN.z);
    if (d < SIGN_OPEN_M) {
      this.d.lobby.highlightSign();
      if (!this.signNear) {
        this.signNear = true;
        this.cue('ui.whoosh');
        this.openPicker();
      }
    } else if (d > SIGN_RESET_M) this.signNear = false;
  }

  /** The game showing (debug/automation; allocates, never call per frame). */
  debugGame(): { kind: LobbyGameKind; phase: string; score: number[] } | null {
    const g = this.tracker.game;
    return g ? { kind: g.kind, phase: g.phase, score: g.score.slice() } : null;
  }

  /** Ends any game without a card and releases its props (menu closing). */
  dispose(): void {
    this.host.clear();
    this.tracker.reset();
    this.remote = null;
    this.d.party.setGameSource(null);
    this.teardown();
  }
}
