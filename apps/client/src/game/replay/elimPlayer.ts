/**
 * Plays the "How you went out" replay: a short, scripted run of the replay
 * view over the live round (or the results wall), then gets out of the way.
 *
 * Responsibilities:
 * - build the replay view in time-sliced steps while the ELIMINATED stamp
 *   plays, then show it as a director overlay locked on the right player;
 * - drive the clock through the plan (quick lead-in, slow motion over the
 *   decisive moment) and stop at the end of the window; under Reduce Motion
 *   hold one still frame of the decisive moment instead;
 * - skip on any key, click, tap or pad button (and the Skip intent), and
 *   stop by itself when the show changes screen or the viewer opens;
 * - publish `elimReplay` to the UI (the watch choice waits behind it) and
 *   report `replay.elimination`.
 *
 * It never holds the show: offline the sim keeps stepping underneath, and
 * online nothing here talks to the server.
 */
import type { AnalyticsValue } from '@tumble/shared/liveops';
import { bindUI, keyboardBusy, ui } from '@tumble/ui';
import type { EliminationCauseKind } from './elimCause.ts';
import { playbackRateAt, playbackRealSeconds, type EliminationPlan } from './elimination.ts';
import type { ReplayData } from './format.ts';
import type { ReplayView } from './view.ts';

/** How long a Reduce Motion still frame stays up (s). */
export const ELIM_STILL_S = 4;
/** Give up if the replay isn't built by then: the moment has passed (s). */
export const ELIM_LOAD_TIMEOUT_S = 3;
/** Input this soon after the replay appears is the player still mashing, not a skip (s). */
const SKIP_GRACE_S = 0.35;
/** UI progress pushes per second. */
const PROGRESS_HZ = 10;

/** One elimination replay to show. */
export interface EliminationReplayRequest {
  data: ReplayData;
  plan: EliminationPlan;
  /** The cause line, names already Streamer Mode safe. */
  cause: string;
  /** Reduce Motion: a still frame instead of motion. */
  still: boolean;
  online: boolean;
}

/** What a show session uses (`GameContext.eliminations`). */
export interface EliminationReplays {
  /** The feature is on: `replays.enabled` and Settings → Elimination replay. */
  enabled(): boolean;
  /**
   * A round of the current show from the replay recorder: the round being
   * recorded so far, or a stored one. Null when it wasn't recorded.
   */
  recording(roundIndex: number): ReplayData | null;
  /** Starts a replay; false when it can't (another replay is on screen). */
  play(req: EliminationReplayRequest): boolean;
  /** Stops the replay (the show moved on, the session ended). */
  stop(): void;
  /** True while one is loading or on screen. */
  readonly playing: boolean;
}

/** How a replay ended. */
export type ElimReplayOutcome = 'watched' | 'skipped' | 'interrupted';

/** What the player needs from the app. */
export interface EliminationPlayerDeps {
  /** Builds a replay view of a recording in slices (null when cancelled). */
  loadView(data: ReplayData, isCancelled: () => boolean): Promise<ReplayView | null>;
  showOverlay(view: ReplayView): void;
  clearOverlay(): void;
  /** True while the replay viewer is open (it wins). */
  viewerOpen(): boolean;
  enabled(): boolean;
  recording(roundIndex: number): ReplayData | null;
  track(name: 'replay.elimination', props: Record<string, AnalyticsValue>): void;
  logMemory(label: string): void;
}

interface Running {
  req: EliminationReplayRequest;
  view: ReplayView | null;
  screenSeq: number;
  /** The screen the covering wipe is bringing in, which the replay plays over (not an interruption). */
  arrivingSeq: number | null;
  /** Seconds since the request (loading) or since it appeared. */
  age: number;
  shown: boolean;
  progress: number;
  pushAcc: number;
  cancelled: boolean;
}

function swallowClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

/** Standard-mapping View button: opens quick chat, never a skip. */
const PAD_VIEW = 8;
/** Keys that open the chat. */
const CHAT_KEYS = new Set(['Enter', 'NumpadEnter', 'KeyT']);
/** Pointer targets that keep their press: the chat and real controls (the replay's own Skip included). */
const OWN_POINTER_SELECTOR =
  '.tr-chat, .tr-chat-wrap, button, a, input, textarea, select, [role="button"], [data-nav]';

/**
 * Keys and buttons that belong to something else while the replay plays:
 * typing into the chat, opening it, and push-to-talk.
 */
function passThroughKey(e: KeyboardEvent): boolean {
  if (keyboardBusy(e) || CHAT_KEYS.has(e.code)) return true;
  return ui.getState().settings.controls.keybinds.pushToTalk.includes(e.code);
}

function anyPadButton(): boolean {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  const ptt = ui.getState().settings.controls.padBinds.pushToTalk;
  for (const p of pads) {
    if (!p || !p.connected) continue;
    for (let i = 0; i < p.buttons.length; i++)
      if (p.buttons[i]?.pressed && i !== PAD_VIEW && !ptt.includes(i)) return true;
  }
  return false;
}

/**
 * The elimination replay.
 *
 * @example
 * const elim = new EliminationPlayer(deps);
 * ctx.eliminations = elim;
 * // per frame, before the director updates the view
 * elim.frame(realDt);
 */
export class EliminationPlayer implements EliminationReplays {
  private run: Running | null = null;
  private padHeld = true;
  private readonly offs: (() => void)[] = [];
  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.run?.shown || e.repeat || passThroughKey(e)) return;
    // Capture phase: the key must not also reach the show (Esc menu, spectate keys) or menu
    // navigation. Browser shortcuts (F-keys, Ctrl/Cmd/Alt combos) still skip but keep working.
    if (!/^F\d+$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (this.run.age >= SKIP_GRACE_S) this.finish('skipped');
  };
  private readonly onPointer = (e: PointerEvent): void => {
    if (!this.run?.shown) return;
    const target = e.target as Element | null;
    if (typeof target?.closest === 'function' && target.closest(OWN_POINTER_SELECTOR)) return;
    e.stopPropagation();
    if (this.run.age < SKIP_GRACE_S) return;
    this.finish('skipped');
    // The watch choice appears under the finger as the replay goes: the tap's click must not press it.
    window.addEventListener('click', swallowClick, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener('click', swallowClick, { capture: true }), 600);
  };

  constructor(private readonly deps: EliminationPlayerDeps) {
    this.offs.push(
      bindUI({
        onElimReplaySkip: () => {
          if (this.run) this.finish('skipped');
        },
      }),
    );
  }

  get playing(): boolean {
    return this.run !== null;
  }

  enabled(): boolean {
    return this.deps.enabled();
  }

  recording(roundIndex: number): ReplayData | null {
    return this.deps.recording(roundIndex);
  }

  play(req: EliminationReplayRequest): boolean {
    if (this.run || this.deps.viewerOpen()) return false;
    const s = ui.getState();
    const run: Running = {
      req,
      view: null,
      screenSeq: s.screenSeq,
      // A knock-out at the round's end starts while the wipe to the results wall is still covering.
      arrivingSeq: s.wipe.phase === 'covering' && s.wipe.target ? s.screenSeq + 1 : null,
      age: 0,
      shown: false,
      progress: 0,
      pushAcc: 0,
      cancelled: false,
    };
    this.run = run;
    s.setElimReplay({ mode: 'loading', cause: req.cause, progress: 0, slow: false });
    this.deps
      .loadView(req.data, () => run.cancelled)
      .then((view) => {
        if (!view) return;
        if (run.cancelled || this.run !== run) {
          view.dispose();
          return;
        }
        this.show(run, view);
      })
      .catch((err: unknown) => {
        console.warn('[replay] elimination replay could not be built', err);
        if (this.run === run) this.finish('interrupted');
      });
    return true;
  }

  private show(run: Running, view: ReplayView): void {
    const { plan, still } = run.req;
    const p = plan.playback;
    run.view = view;
    run.shown = true;
    run.age = 0;
    view.lockFollow(plan.follow);
    if (still) {
      view.clock.seek(p.focus);
      view.clock.playing = false;
    } else {
      view.clock.seek(p.start);
      view.clock.setExactSpeed(playbackRateAt(p, p.start));
      view.clock.playing = true;
    }
    this.deps.showOverlay(view);
    this.deps.logMemory(`replay:${view.timeline.header.roundId}:elimination`);
    this.padHeld = true;
    this.listen(true);
    ui.getState().patchElimReplay({
      mode: still ? 'still' : 'playing',
      progress: 0,
      slow: !still && playbackRateAt(p, p.start) < 1,
    });
  }

  /**
   * Per-frame driving (before the director updates the view).
   *
   * @param realDt - Unscaled frame delta (s).
   */
  frame(realDt: number): void {
    const run = this.run;
    if (!run) return;
    run.age += realDt;
    const s = ui.getState();
    if (s.screenSeq !== run.screenSeq) {
      if (s.screenSeq !== run.arrivingSeq) {
        this.finish('interrupted');
        return;
      }
      run.screenSeq = s.screenSeq;
      run.arrivingSeq = null;
    }
    if (!run.view) {
      if (run.age > ELIM_LOAD_TIMEOUT_S) this.finish('interrupted');
      return;
    }
    const pad = anyPadButton();
    const pressed = pad && !this.padHeld;
    this.padHeld = pad;
    if (pressed && run.age >= SKIP_GRACE_S) {
      this.finish('skipped');
      return;
    }
    const view = run.view;
    const p = run.req.plan.playback;
    let slow = false;
    if (run.req.still) {
      run.progress = Math.min(1, run.age / ELIM_STILL_S);
      if (run.age >= ELIM_STILL_S) {
        this.finish('watched');
        return;
      }
    } else {
      const t = view.clock.time;
      if (t >= p.end - 1e-3 || !view.clock.playing) {
        this.finish('watched');
        return;
      }
      const rate = playbackRateAt(p, t);
      view.clock.setExactSpeed(rate);
      slow = rate < 1;
      run.progress = Math.max(0, Math.min(1, (t - p.start) / Math.max(1e-3, p.end - p.start)));
    }
    run.pushAcc += realDt;
    if (run.pushAcc >= 1 / PROGRESS_HZ) {
      run.pushAcc = 0;
      s.patchElimReplay({ progress: Math.round(run.progress * 50) / 50, slow });
    }
  }

  /** Stops the replay without counting it as watched or skipped. */
  stop(): void {
    if (this.run) this.finish('interrupted');
  }

  private finish(outcome: ElimReplayOutcome): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    run.cancelled = true;
    this.listen(false);
    if (run.view) {
      // The director disposes the overlay; a view that never made it on screen is disposed here.
      this.deps.clearOverlay();
    }
    ui.getState().setElimReplay(null);
    const kind: EliminationCauseKind = run.req.plan.cause.kind;
    this.deps.track('replay.elimination', {
      outcome: run.shown ? outcome : 'unavailable',
      cause: kind,
      still: run.req.still,
      online: run.req.online,
      seconds: Math.round(playbackRealSeconds(run.req.plan.playback) * 10) / 10,
    });
  }

  private listen(on: boolean): void {
    const fn = on ? 'addEventListener' : 'removeEventListener';
    window[fn]('keydown', this.onKey as EventListener, true);
    window[fn]('pointerdown', this.onPointer as EventListener, true);
  }

  /** App teardown. */
  dispose(): void {
    this.stop();
    for (const off of this.offs) off();
    this.offs.length = 0;
  }
}
