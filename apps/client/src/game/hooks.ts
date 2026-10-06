/**
 * `window.__tumble`: automation and console hooks shared by the game and the
 * Phase 0 test scene. Playwright waits on `ready` and reads the rest.
 */
import type { ui as uiStore, UIIntentName } from '@tumble/ui';
import type { DeterminismReport } from '../debug/determinism.ts';
import type { LoadTimings } from './round/loadPipeline.ts';
import type { LobbyDebugState } from './views/menuView.ts';

/** Debug hooks exposed on `window.__tumble`. */
export interface TumbleHooks {
  /** True once boot finished and frames are rendering. */
  ready: boolean;
  /** Backend that actually initialised (`webgpu` | `webgl2`). */
  backend: string;
  /** Smoothed frames per second. */
  fps: () => number;
  /** Frames rendered so far. */
  frames: number;
  /** Runs the client ↔ server Rapier determinism check. */
  determinism: () => Promise<DeterminismReport>;
  /** Current UI screen id (game only). */
  screen?: () => string;
  /** Show phase name, or `none` outside a show (game only). */
  showPhase?: () => string;
  /** Round id being played, or null (game only). */
  roundId?: () => string | null;
  /** Round phase id, or null (game only). */
  roundPhase?: () => number | null;
  /** End-of-show recap once a show finished (game only). */
  summary?: () => unknown;
  /** GPU resources alive (geometries/textures) (game only). */
  memory?: () => { geometries: number; textures: number };
  /** Draw calls in the last frame (game only). */
  drawCalls?: () => number;
  /** Renderables the active view draws this frame, by name (dev and sandbox builds only). */
  drawBreakdown?: () => Record<string, number>;
  /** What the next frame actually draws, per pass (`main`, `shadow:<n>`, `post`), by name (dev and sandbox builds only). */
  drawPasses?: () => Promise<Record<string, Record<string, number>>>;
  /** Smoothed wall time of one offline sim step in ms; 0 outside an offline show (game only). */
  simStepMs?: () => number;
  /** Tumblers in the current round (game only). */
  tumblers?: () => number;
  /** Active quality tier (game only). */
  tier?: () => string;
  /**
   * Recent round builds, newest last: per-step wall/busy time and the longest
   * main-thread block (game only). Also in the Performance panel as
   * `tumble:load:<round>:<step>` measures.
   */
  loadTimings?: LoadTimings[];
  /** Per-round GPU memory log (game only). */
  memoryLog?: { round: string; geometries: number; textures: number }[];
  /** Online account state (game only): null when playing offline. */
  account?: () => {
    userId: string;
    name: string;
    partyCode: string | null;
    partySize: number;
    leader: boolean;
  } | null;
  /** The UI store, for tests that inspect or drive menus (game only). */
  ui?: typeof uiStore;
  /** Emits a UI intent as if the player clicked it (tests). */
  emit?: (name: UIIntentName, payload?: unknown) => void;
  /** Main-menu lobby Tumbler (state, feet, idle play, camera pitch); null outside the menu (game only). */
  lobbyState?: () => LobbyDebugState | null;
  /** Local Tumbler in the current round: character state id, grab target, feet position (game only). */
  localPlayer?: () => {
    state: number;
    grabTarget: number;
    x: number;
    y: number;
    z: number;
    grabs: number;
  } | null;
  /** True while queued with the matchmaker (game only). */
  queued?: () => boolean;
}

declare global {
  interface Window {
    __tumble?: TumbleHooks;
  }
}

export {};
