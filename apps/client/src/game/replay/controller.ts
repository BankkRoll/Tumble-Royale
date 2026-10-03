/**
 * App-level replay system.
 *
 * Responsibilities:
 * - owns the per-show {@link ReplayLibrary} and the {@link LiveRecording} the
 *   show sessions report to, and publishes what can be watched to the UI;
 * - opens a replay (a stored round, the round in progress, or a file) as a
 *   director overlay so whatever was on screen (results wall, rewards, the
 *   spectated round, the menu) stays intact underneath, and closes it back to
 *   exactly that place, disposing every replay resource;
 * - routes viewer controls from UI intents, keyboard, gamepad, mouse drag /
 *   wheel and touch drag / pinch;
 * - saves the open recording as a file and loads files back (validated).
 */
import { getRound } from '@tumble/content/rounds';
import type { QualityPreset } from '@tumble/render/quality';
import type { CreateTumblerVisual, TumblerLoadout } from '@tumble/render/scenes';
import type { Rapier } from '@tumble/sim';
import type { MatchDeps } from '@tumble/sim/match';
import {
  bindUI,
  ui,
  type OverlayId,
  type ReplayCommand,
  type ReplayMarkerInfo,
  type ReplayRoundEntry,
  type ReplayViewerState,
  type RoundType,
} from '@tumble/ui';
import type { InputSystem } from '../../input/index.ts';
import { botLoadout, decodeLoadout } from '../cosmetics.ts';
import type { CeremonyPost } from '../views/ceremonies.ts';
import type { SceneDirector } from '../views/sceneDirector.ts';
import { PadCommands, keyCommand, moveKey } from './controls.ts';
import {
  ReplayFileError,
  decodeReplayFile,
  encodeReplayFile,
  replayFileName,
  sameGameVersion,
  type ReplayData,
  type ReplayHeader,
} from './format.ts';
import { ReplayLibrary } from './library.ts';
import { LiveRecording } from './live.ts';
import { ReplayTimeline, type ReplayMarker } from './timeline.ts';
import { ReplayView, type ReplayViewStatus } from './view.ts';

/** UI playhead updates per second (discrete changes push immediately). */
const STATUS_HZ = 15;
/** Radians of camera turn per dragged CSS pixel. */
const DRAG_LOOK = 0.006;
const STICK_LOOK = 2.6;
const STICK_DEADZONE = 0.18;

/** App services the replay system needs. */
export interface ReplayControllerDeps {
  R: Rapier;
  matchDeps: MatchDeps;
  director: SceneDirector;
  post: CeremonyPost;
  preset: () => QualityPreset;
  createTumbler: CreateTumblerVisual;
  input: InputSystem;
  /** The game canvas (drag / wheel / pinch target). */
  canvas: HTMLElement;
  /** Logs GPU memory with a label (`window.__tumble.memoryLog`). */
  logMemory: (label: string) => void;
}

interface Origin {
  overlay: OverlayId;
  screenSeq: number;
  pointerLock: boolean;
}

function deadzone(v: number): number {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}

function outcomeOf(h: ReplayHeader): ReplayRoundEntry['outcome'] {
  if (h.localId < 0) return 'spectated';
  if (h.outcome?.qualified.includes(h.localId)) return 'qualified';
  if (h.outcome?.eliminated.includes(h.localId)) return 'eliminated';
  return 'spectated';
}

/**
 * The replay system.
 *
 * @example
 * const replays = new ReplayController(deps);
 * ctx.replays = replays.live;
 * // per frame, before rendering
 * replays.frame(realDt);
 */
export class ReplayController {
  readonly library = new ReplayLibrary();
  readonly live: LiveRecording;
  private view: ReplayView | null = null;
  private data: ReplayData | null = null;
  private origin: Origin | null = null;
  private readonly pad = new PadCommands();
  private readonly held = new Set<string>();
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private statusAcc = 0;
  private readonly status: ReplayViewStatus = {
    time: 0,
    duration: 0,
    playing: false,
    speed: 1,
    camera: 'follow',
    target: -1,
  };
  private readonly pushed: ReplayViewStatus = { ...this.status };
  private readonly padPressed: boolean[] = [];
  private readonly offs: (() => void)[] = [];
  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };
  private readonly onPointerDown = (e: PointerEvent): void => this.pointerDown(e);
  private readonly onPointerMove = (e: PointerEvent): void => this.pointerMove(e);
  private readonly onPointerUp = (e: PointerEvent): void => this.pointerUp(e);
  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.view?.zoom(-Math.sign(e.deltaY));
  };
  private readonly onBlur = (): void => this.held.clear();

  constructor(private readonly deps: ReplayControllerDeps) {
    this.live = new LiveRecording(this.library, () => this.publish());
    this.offs.push(
      bindUI({
        onReplayOpen: ({ key }) => {
          const entry = this.library.get(key);
          if (entry) this.open(entry.data, 'show');
          else this.toast('That replay is no longer available');
        },
        onReplayOpenLive: () => {
          const data = this.live.snapshot();
          if (data && data.header.frameCount > 1) this.open(data, 'show');
          else this.toast('Nothing recorded yet');
        },
        onReplayOpenFile: ({ name, bytes }) => this.openFile(name, bytes),
        onReplayCommand: (cmd) => this.command(cmd),
      }),
    );
  }

  /** True while the viewer is open. */
  get active(): boolean {
    return this.view !== null;
  }

  // ---------------------------------------------------------------------------
  // Library → UI
  // ---------------------------------------------------------------------------

  private publish(): void {
    const s = ui.getState();
    s.setReplays(
      this.library.list().map((e) => {
        const h = e.data.header;
        return {
          key: e.key,
          roundIndex: h.roundIndex,
          name: h.roundName,
          type: (h.isFinal ? 'final' : h.roundType) as RoundType,
          isFinal: h.isFinal,
          outcome: outcomeOf(h),
          duration: h.duration,
        };
      }),
    );
    s.setReplayLive(this.live.recording);
  }

  private toast(title: string, body?: string): void {
    ui.getState().pushToast({ kind: 'info', title, ...(body ? { body } : {}), variant: 'card' });
  }

  // ---------------------------------------------------------------------------
  // Open / exit
  // ---------------------------------------------------------------------------

  private openFile(name: string, bytes: ArrayBuffer): void {
    let data: ReplayData;
    try {
      data = decodeReplayFile(new Uint8Array(bytes));
    } catch (err) {
      const msg = err instanceof ReplayFileError ? err.message : 'The file could not be read.';
      ui.getState().showDialog({
        id: 'replay-open-failed',
        kind: 'error',
        title: "Can't play that replay",
        body: `${name}: ${msg}`,
        code: err instanceof ReplayFileError ? `E-REPLAY-${err.problem.toUpperCase()}` : 'E-REPLAY',
      });
      return;
    }
    if (!sameGameVersion(data.header.gameVersion))
      this.toast(
        `Recorded on version ${data.header.gameVersion}`,
        'Courses may have changed since, so things might not line up.',
      );
    this.open(data, 'file');
  }

  /**
   * Opens the viewer over whatever is on screen.
   *
   * @param data - Recording.
   * @param origin - Where it came from (files can't be re-saved from the viewer).
   * @returns False when the round can't be rebuilt (unknown round in this build).
   */
  open(data: ReplayData, origin: 'show' | 'file'): boolean {
    if (this.view) this.exit();
    const h = data.header;
    const round = getRound(h.roundId);
    if (!round) {
      ui.getState().showDialog({
        id: 'replay-open-failed',
        kind: 'error',
        title: "Can't play that replay",
        body: `This version of the game doesn't have the round "${h.roundName}".`,
        code: 'E-REPLAY-ROUND',
      });
      return false;
    }
    const loadouts = new Map<number, TumblerLoadout>();
    for (const p of h.players)
      loadouts.set(p.id, decodeLoadout(JSON.stringify(p.loadout ?? '')) ?? botLoadout(h.seed, p.id, p.name));
    const set = ui.getState().settings;
    let view: ReplayView;
    try {
      view = new ReplayView({
        R: this.deps.R,
        deps: this.deps.matchDeps,
        round,
        timeline: new ReplayTimeline(data),
        loadouts,
        createTumbler: this.deps.createTumbler,
        preset: this.deps.preset(),
        post: this.deps.post,
        nameplates: set.gameplay.nameplates,
        streamerMode: set.gameplay.streamerMode,
        reduceShake: set.accessibility.reduceShake,
      });
    } catch (err) {
      console.error('[replay] could not build the replay', err);
      ui.getState().showDialog({
        id: 'replay-open-failed',
        kind: 'error',
        title: "Can't play that replay",
        body: 'The recording is damaged or from an incompatible version.',
        code: 'E-REPLAY-BUILD',
      });
      return false;
    }
    const s = ui.getState();
    const input = this.deps.input;
    this.origin = { overlay: s.overlay, screenSeq: s.screenSeq, pointerLock: input.settings.pointerLock };
    input.settings.pointerLock = false;
    if (document.pointerLockElement) document.exitPointerLock();
    if (s.overlay !== 'none') s.setOverlay('none');
    s.setEmoteWheel(false);
    this.view = view;
    this.data = data;
    this.deps.director.showOverlay(view);
    this.listen(true);
    this.held.clear();
    this.pad.reset(this.readPad());
    this.statusAcc = 0;
    s.setReplay(this.viewerState(view, data, origin));
    this.deps.logMemory(`replay:${h.roundId}:open`);
    return true;
  }

  /** Closes the viewer and returns to where it was opened from. */
  exit(): void {
    const view = this.view;
    if (!view) return;
    this.view = null;
    this.data = null;
    this.listen(false);
    this.held.clear();
    this.pointers.clear();
    this.deps.director.clearOverlay();
    const o = this.origin;
    this.origin = null;
    const s = ui.getState();
    s.setReplay(null);
    if (o) {
      this.deps.input.settings.pointerLock = o.pointerLock;
      // Only restore the menu we came from if the show didn't move on meanwhile.
      if (o.screenSeq === s.screenSeq && o.overlay !== 'none') s.setOverlay(o.overlay);
    }
    this.deps.logMemory(`replay:${view.timeline.header.roundId}:closed`);
  }

  private viewerState(view: ReplayView, data: ReplayData, origin: 'show' | 'file'): ReplayViewerState {
    const h = data.header;
    const name = (id: number): string => h.players.find((p) => p.id === id)?.name ?? `Tumbler ${id}`;
    const markers: ReplayMarkerInfo[] = view.timeline.markers.map((m: ReplayMarker) => ({
      t: m.t,
      kind: m.kind,
      label:
        m.kind === 'localQualified'
          ? 'You qualified!'
          : m.kind === 'localEliminated'
            ? 'You were knocked out'
            : m.kind === 'qualified'
              ? `${name(m.player)} qualified`
              : `${name(m.player)} is out`,
    }));
    view.status(this.status);
    return {
      title: h.roundName,
      subtitle: `${h.isFinal ? 'Final' : `Round ${h.roundIndex + 1}`} · ${h.showName}`,
      time: 0,
      duration: view.timeline.duration,
      playing: this.status.playing,
      speed: this.status.speed,
      camera: this.status.camera,
      povAvailable: view.povAvailable,
      target: this.targetInfo(view.targetId),
      markers,
      canSave: origin === 'show',
      origin,
    };
  }

  private targetInfo(id: number): ReplayViewerState['target'] {
    const h = this.view?.timeline.header ?? this.data?.header;
    if (!h || id < 0) return null;
    const i = h.players.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const p = h.players[i] as ReplayHeader['players'][number];
    const colors = (p.loadout as { colors?: unknown } | null)?.colors;
    const color = Array.isArray(colors) && typeof colors[0] === 'string' ? colors[0] : '#ff6fb5';
    return { name: id === h.localId ? `${p.name} (you)` : p.name, color, index: i, count: h.players.length };
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  private command(cmd: ReplayCommand): void {
    const view = this.view;
    if (!view) return;
    if (cmd.type === 'exit') {
      this.exit();
      return;
    }
    if (cmd.type === 'save') {
      this.save();
      return;
    }
    view.command(cmd);
    this.pushStatus(true);
  }

  private save(): void {
    const data = this.data;
    if (!data) return;
    const bytes = encodeReplayFile(data);
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
      {
        type: 'application/octet-stream',
      },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = replayFileName(data.header);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    ui.getState().pushToast({
      kind: 'success',
      title: 'Replay saved',
      body: `${a.download} (${Math.max(1, Math.round(bytes.length / 1024))} KB)`,
      variant: 'card',
    });
  }

  private pushStatus(force: boolean): void {
    const view = this.view;
    if (!view) return;
    const st = view.status(this.status);
    const p = this.pushed;
    const discrete =
      st.playing !== p.playing || st.speed !== p.speed || st.camera !== p.camera || st.target !== p.target;
    if (!force && !discrete && this.statusAcc < 1 / STATUS_HZ) return;
    this.statusAcc = 0;
    const patch: Partial<ReplayViewerState> = { time: st.time };
    if (discrete || force) {
      patch.playing = st.playing;
      patch.speed = st.speed;
      patch.camera = st.camera;
      if (force || st.target !== p.target) patch.target = this.targetInfo(st.target);
    }
    ui.getState().patchReplay(patch);
    p.time = st.time;
    p.playing = st.playing;
    p.speed = st.speed;
    p.camera = st.camera;
    p.target = st.target;
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  /**
   * Per-frame input and UI sync (the director updates the view itself).
   *
   * @param realDt - Unscaled frame delta (s).
   */
  frame(realDt: number): void {
    const view = this.view;
    if (!view) return;
    const s = ui.getState();
    // The online show doesn't wait: if it changed screens underneath, the replay yields to it.
    if (this.origin && s.screenSeq !== this.origin.screenSeq) {
      this.exit();
      return;
    }
    const modal = s.dialog !== null || s.overlay !== 'none';
    const pressed = this.readPad();
    const gp = this.gamepad();
    if (!modal) {
      for (const cmd of this.pad.update(pressed)) this.command(cmd);
      if (!this.view) return;
    } else this.pad.reset(pressed);

    let mx = 0;
    let mz = 0;
    let my = 0;
    if (!modal) {
      for (const code of this.held) {
        const m = moveKey(code);
        if (m) {
          mx += m[0];
          mz += m[1];
        } else if (code === 'KeyR') my += 1;
        else if (code === 'KeyF') my -= 1;
      }
      if (gp) {
        mx += deadzone(gp.axes[0] ?? 0);
        mz -= deadzone(gp.axes[1] ?? 0);
        const lx = deadzone(gp.axes[2] ?? 0);
        const ly = deadzone(gp.axes[3] ?? 0);
        if (this.pad.zoomHeld) view.zoom(-ly * realDt * 8);
        else view.look(lx * STICK_LOOK * realDt, ly * STICK_LOOK * 0.7 * realDt);
      }
    }
    view.move.x = Math.max(-1, Math.min(1, mx));
    view.move.z = Math.max(-1, Math.min(1, mz));
    view.move.y = Math.max(-1, Math.min(1, my));

    this.statusAcc += realDt;
    this.pushStatus(false);
  }

  private gamepad(): Gamepad | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }

  private readPad(): boolean[] {
    const out = this.padPressed;
    out.length = 0;
    const gp = this.gamepad();
    if (!gp) return out;
    for (let i = 0; i < gp.buttons.length; i++) {
      const b = gp.buttons[i];
      out.push(!!b && (b.pressed || b.value > 0.5));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // DOM input
  // ---------------------------------------------------------------------------

  private listen(on: boolean): void {
    const c = this.deps.canvas;
    const fn = on ? 'addEventListener' : 'removeEventListener';
    // Capture on window: viewer keys must not also reach the show (Esc menu) or menu navigation.
    window[fn]('keydown', this.onKeyDown as EventListener, true);
    window[fn]('keyup', this.onKeyUp as EventListener, true);
    window[fn]('blur', this.onBlur);
    c[fn]('pointerdown', this.onPointerDown as EventListener);
    window[fn]('pointermove', this.onPointerMove as EventListener);
    window[fn]('pointerup', this.onPointerUp as EventListener);
    window[fn]('pointercancel', this.onPointerUp as EventListener);
    c[fn]('wheel', this.onWheel as EventListener, { passive: false } as AddEventListenerOptions);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const s = ui.getState();
    if (!this.view || s.dialog || s.overlay !== 'none') return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) &&
      (target as HTMLInputElement).type !== 'range'
    )
      return;
    if (moveKey(e.code) || e.code === 'KeyR' || e.code === 'KeyF') {
      this.held.add(e.code);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const cmd = keyCommand(e.code, e.shiftKey);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && (cmd.type === 'toggle' || cmd.type === 'exit' || cmd.type === 'camera')) return;
    this.command(cmd);
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.view) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) this.pinch = this.pinchDistance();
  }

  private pointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    const view = this.view;
    if (!prev || !view) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    if (this.pointers.size >= 2) {
      const d = this.pinchDistance();
      if (this.pinch > 0 && d > 0) view.zoom(Math.log(d / this.pinch) / Math.log(1 / 0.88));
      this.pinch = d;
      return;
    }
    view.look(dx * DRAG_LOOK, dy * DRAG_LOOK);
  }

  private pointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    this.pinch = this.pointers.size === 2 ? this.pinchDistance() : 0;
  }

  private pinchDistance(): number {
    const it = this.pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  /** Closes the viewer and unsubscribes (app teardown). */
  dispose(): void {
    this.exit();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
