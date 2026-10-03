/**
 * Tutorial overlay store (game → UI) and intent bus (UI → game).
 *
 * The tutorial runner writes plain state here; the overlay renders it. The
 * coach's screen anchor changes every frame, so it lives outside React state
 * (see {@link setCoachAnchor}) and the bubble moves by direct style writes.
 */
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import type { TutorialIconName } from './icons.tsx';

/** A run of prompt text, or a set of input chips (`['L-Ctrl', 'LMB']`). */
export type PromptPart = string | { keys: readonly string[] };

/** Checklist entry state. */
export type TutorialStepState = 'todo' | 'active' | 'done';

/** One checklist row. */
export interface TutorialStep {
  id: string;
  label: string;
  icon: TutorialIconName;
  state: TutorialStepState;
}

/** The objective card at the bottom of the screen. */
export interface TutorialPromptCard {
  /** Changes when the objective changes (restarts the entrance animation). */
  id: string;
  icon: TutorialIconName;
  title: string;
  parts: readonly PromptPart[];
  /** Gentle hint shown under the objective after a few failures. */
  hint: readonly PromptPart[] | null;
}

/** What the coach is saying (text only: the coach never speaks aloud). */
export interface CoachLine {
  text: string;
  mood: 'talk' | 'cheer' | 'wait';
  /** Bumps on every new line so identical text still re-animates. */
  seq: number;
}

/** End-of-tutorial card. */
export interface TutorialReadyInfo {
  xp: number;
  /** Cosmetic unlocked by finishing (null when it was already owned). */
  unlock: { name: string; icon: TutorialIconName; kind: string } | null;
  /** One line about the mini race ("You finished 2nd of 8!"). */
  raceLine: string;
  /** Rewards are granted once; replays show a friendly note instead. */
  repeat: boolean;
}

/** Input family the prompts are phrased for. */
export type TutorialDevice = 'keyboard' | 'gamepad' | 'touch';

/** Whole overlay state. */
export interface TutorialUIState {
  /** `hidden` before the island loads and after the runner tears down. */
  phase: 'hidden' | 'intro' | 'practice' | 'race' | 'ready';
  device: TutorialDevice;
  title: { title: string; subtitle: string; skipKeys: readonly string[] } | null;
  steps: TutorialStep[];
  prompt: TutorialPromptCard | null;
  coach: CoachLine | null;
  /** Pin the coach's bubble bottom-left (he is far away, e.g. cheering at the finish). */
  coachDocked: boolean;
  /** Big centred "NICE!" burst; `seq` re-triggers it. */
  success: { text: string; seq: number } | null;
  skipConfirm: boolean;
  /** Keys shown on the skip button. */
  skipKeys: readonly string[];
  ready: TutorialReadyInfo | null;
}

/** Initial (hidden) state. */
export const TUTORIAL_UI_DEFAULTS: TutorialUIState = {
  phase: 'hidden',
  device: 'keyboard',
  title: null,
  steps: [],
  prompt: null,
  coach: null,
  coachDocked: false,
  success: null,
  skipConfirm: false,
  skipKeys: ['Esc'],
  ready: null,
};

/**
 * The tutorial overlay store.
 *
 * @example
 * tutorialUi.setState({ phase: 'practice', prompt: { id: 'jump', icon: 'jump', title: 'Jump!', parts: ['Press ', { keys: ['Space'] }], hint: null } });
 */
export const tutorialUi = createStore<TutorialUIState>()(() => ({ ...TUTORIAL_UI_DEFAULTS }));

/**
 * React hook over {@link tutorialUi}.
 *
 * @param selector - Picks the slice to subscribe to.
 */
export function useTutorialUI<T>(selector: (s: TutorialUIState) => T): T {
  return useStore(tutorialUi, selector);
}

// -----------------------------------------------------------------------------
// Coach anchor (per-frame, outside React)
// -----------------------------------------------------------------------------

/** Screen-space point above the coach's head, in CSS pixels. */
export interface CoachAnchor {
  x: number;
  y: number;
  visible: boolean;
}

const anchor: CoachAnchor = { x: 0, y: 0, visible: false };
const anchorListeners = new Set<(a: CoachAnchor) => void>();

/**
 * Moves the coach's speech bubble. Call every frame; listeners update the DOM
 * directly so React never re-renders for it.
 *
 * @param x - CSS px from the left.
 * @param y - CSS px from the top.
 * @param visible - False when the coach is off screen or behind the camera.
 */
export function setCoachAnchor(x: number, y: number, visible: boolean): void {
  anchor.x = x;
  anchor.y = y;
  anchor.visible = visible;
  for (const fn of anchorListeners) fn(anchor);
}

/**
 * Subscribes to coach anchor moves.
 *
 * @returns Unsubscribe.
 */
export function onCoachAnchor(fn: (a: CoachAnchor) => void): () => void {
  anchorListeners.add(fn);
  fn(anchor);
  return () => anchorListeners.delete(fn);
}

// -----------------------------------------------------------------------------
// Intents (UI → game)
// -----------------------------------------------------------------------------

/** Intents the overlay emits. */
export interface TutorialIntents {
  /** The player confirmed skipping the tutorial. */
  skip: Record<string, never>;
  /** The player picked what to do from the ready card. */
  readyChoice: { next: 'show' | 'menu' };
}

type Handler<K extends keyof TutorialIntents> = (payload: TutorialIntents[K]) => void;
const handlers: { [K in keyof TutorialIntents]?: Set<Handler<K>> } = {};

/** Intent bus for the tutorial overlay. */
export const tutorialEvents = {
  /**
   * Emits an intent.
   *
   * @param type - Intent name.
   * @param payload - Intent data.
   */
  emit<K extends keyof TutorialIntents>(type: K, payload: TutorialIntents[K]): void {
    const set = handlers[type] as Set<Handler<K>> | undefined;
    if (set) for (const fn of [...set]) fn(payload);
  },
  /**
   * Listens for an intent.
   *
   * @returns Unsubscribe.
   */
  on<K extends keyof TutorialIntents>(type: K, fn: Handler<K>): () => void {
    let set = handlers[type] as Set<Handler<K>> | undefined;
    if (!set) {
      set = new Set();
      (handlers as Record<string, Set<Handler<K>>>)[type] = set;
    }
    set.add(fn);
    return () => set.delete(fn);
  },
};
