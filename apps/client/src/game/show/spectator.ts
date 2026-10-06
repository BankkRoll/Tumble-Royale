/**
 * What a show does with a local player who is no longer racing: knocked out
 * mid-round, out of the show after a results wall, qualified and waiting for
 * the round to end, or watching the rest of the show as a spectator.
 *
 * Responsibilities:
 * - the elimination flow decisions (sheet, auto "Keep watching", the
 *   post-results choice) as pure functions the session and tests share;
 * - spectate target lists and cycling;
 * - gamepad shoulder-button edges for spectate cycling.
 *
 * Everything here is free of DOM, three.js and store access so it can be unit
 * tested in Node.
 */
import { MAX_ENTITIES } from '@tumble/netcode';

/**
 * True for a spectator seat's player id: the game server hands spectators ids
 * above the player range, so they never collide with a Tumbler entity.
 *
 * @param id - The id from the server's Welcome.
 */
export function isSpectatorId(id: number): boolean {
  return id >= MAX_ENTITIES;
}

/** The local player's decision about the rest of the show once they are out. */
export type WatchDecision = 'undecided' | 'watching';

/** Seconds the "ELIMINATED" stamp plays before the choice sheet slides in. */
export const ELIMINATED_SHEET_DELAY_S = 1.6;
/** Seconds the choice waits before Auto-spectate picks "Keep watching". */
export const AUTO_KEEP_WATCHING_S = 5;
/** Shorter auto delay for the autoplay pilot (soak tests). */
const AUTOPLAY_KEEP_WATCHING_S = 1.4;

/** Settings and context the decisions depend on. */
export interface WatchPrefs {
  /** Settings → Gameplay → Auto-spectate. */
  autoSpectate: boolean;
  /** The autoplay pilot drives the show (never waits on a human). */
  autoplay: boolean;
}

/**
 * Seconds until "Keep watching" is picked for the player, or null to wait for
 * them.
 *
 * @param prefs - Auto-spectate setting and autoplay flag.
 * @returns Delay in flow seconds, or null.
 */
export function autoKeepWatchingAfter(prefs: WatchPrefs): number | null {
  if (prefs.autoplay) return AUTOPLAY_KEEP_WATCHING_S;
  return prefs.autoSpectate ? AUTO_KEEP_WATCHING_S : null;
}

/** What happens right after the local Tumbler is knocked out of a round. */
export type EliminatedPlan =
  /** The player already chose to watch the show: spectate without asking. */
  | { kind: 'spectate'; afterS: number }
  /** Ask "Keep watching / Leave show"; `autoAfterS` picks Keep watching (null = wait). */
  | { kind: 'sheet'; afterS: number; autoAfterS: number | null };

/**
 * Decides the in-round elimination flow.
 *
 * @param decision - Earlier choice in this show.
 * @param prefs - Auto-spectate setting and autoplay flag.
 * @returns The plan.
 *
 * @example
 * planAfterEliminated('undecided', { autoSpectate: true, autoplay: false });
 * // → { kind: 'sheet', afterS: 1.6, autoAfterS: 5 }
 */
export function planAfterEliminated(decision: WatchDecision, prefs: WatchPrefs): EliminatedPlan {
  if (decision === 'watching') return { kind: 'spectate', afterS: ELIMINATED_SHEET_DELAY_S };
  return { kind: 'sheet', afterS: ELIMINATED_SHEET_DELAY_S, autoAfterS: autoKeepWatchingAfter(prefs) };
}

/** The local player's part in a finished round. */
export interface RoundSeat {
  /** The local player was an entrant of the round. */
  inRound: boolean;
  /** The local player qualified (or won the final). */
  qualified: boolean;
  /** The round was the show's final. */
  isFinal: boolean;
}

/** What the show does for the local player once a results wall is up. */
export type AfterResults =
  /** Still in the show: carry on to the next round as a player. */
  | { kind: 'stillIn' }
  /** The show ends after this wall (final): victory / winner cam, wall, rewards follow for everyone. */
  | { kind: 'showOver' }
  /** Out of the show and already watching: carry on as a spectator. */
  | { kind: 'spectate' }
  /** Just knocked out of the show: ask "Keep watching / Leave show". */
  | { kind: 'ask'; autoAfterS: number | null };

/**
 * Decides what the local player sees after a round's results.
 *
 * @param seat - The local player's part in the round.
 * @param decision - Earlier choice in this show.
 * @param prefs - Auto-spectate setting and autoplay flag.
 * @returns The next step.
 *
 * @example
 * afterRoundResults({ inRound: true, qualified: false, isFinal: false }, 'undecided', prefs);
 * // → { kind: 'ask', autoAfterS: 5 }
 */
export function afterRoundResults(seat: RoundSeat, decision: WatchDecision, prefs: WatchPrefs): AfterResults {
  if (seat.isFinal) return { kind: 'showOver' };
  if (seat.inRound && seat.qualified) return { kind: 'stillIn' };
  if (decision === 'watching' || !seat.inRound) return { kind: 'spectate' };
  return { kind: 'ask', autoAfterS: autoKeepWatchingAfter(prefs) };
}

/**
 * True when the local player has been knocked out of the show: they entered
 * a round and did not qualify, or a round started without them.
 *
 * @param seat - The latest round seat (null before the first round).
 */
export function isOutOfShow(seat: Pick<RoundSeat, 'inRound' | 'qualified'> | null): boolean {
  return !!seat && (!seat.inRound || !seat.qualified);
}

/** A round participant's live state for spectating. */
export type SpectateStatus = 'playing' | 'qualified' | 'eliminated';

/**
 * Who can be spectated: everyone but the local player, still-playing Tumblers
 * first in standings order; falls back to the whole field when nobody is
 * still playing (round over, everyone qualified).
 *
 * @param order - Standings (best first) or entrant order.
 * @param localId - Local player id (excluded).
 * @param statusOf - Live status per id (undefined = unknown, treated as playing).
 * @returns Spectate targets in cycle order.
 */
export function spectateCandidates(
  order: readonly number[],
  localId: number,
  statusOf: (id: number) => SpectateStatus | undefined,
): number[] {
  const others = order.filter((id) => id !== localId);
  const live = others.filter((id) => {
    const s = statusOf(id);
    return s === undefined || s === 'playing';
  });
  return live.length > 0 ? live : others;
}

/**
 * Next spectate target index when cycling.
 *
 * @param list - Targets.
 * @param currentId - Currently watched id (-1 or missing = start from the top).
 * @param dir - +1 next, -1 previous.
 * @returns Index into `list`, or -1 when the list is empty.
 */
export function cycleSpectateIndex(list: readonly number[], currentId: number, dir: 1 | -1): number {
  if (list.length === 0) return -1;
  const i = list.indexOf(currentId);
  if (i < 0) return dir > 0 ? 0 : list.length - 1;
  return (i + dir + list.length) % list.length;
}

/** How long the banner stays on a watched player who has finished the round before moving on (s). */
export const SPECTATE_MOVE_ON_S = 2.5;

/** What the spectate banner does on a refresh. */
export type SpectateFollowUp =
  /** Still a target: refresh the banner at this place. */
  | { kind: 'refresh'; index: number }
  /** Finished the round (qualified or out): show it and stay a moment longer. */
  | { kind: 'finished' }
  /** Watched long enough after finishing: move on to the next player still running. */
  | { kind: 'moveOn'; id: number; index: number };

/**
 * Decides the spectate banner's next step when it refreshes.
 *
 * @param list - Current targets ({@link spectateCandidates}).
 * @param watchedId - The player being watched.
 * @param finishedFor - Seconds since the watched player dropped out of the targets.
 * @returns The step.
 */
export function spectateFollowUp(list: readonly number[], watchedId: number, finishedFor: number): SpectateFollowUp {
  const i = list.indexOf(watchedId);
  if (i >= 0) return { kind: 'refresh', index: i };
  if (finishedFor < SPECTATE_MOVE_ON_S || list.length === 0) return { kind: 'finished' };
  return { kind: 'moveOn', id: list[0] as number, index: 0 };
}

/**
 * Caption under the spectated name.
 *
 * @param index - Position in the standings-ordered target list.
 * @param qualified - The target already qualified.
 */
export function spectateDetail(index: number, qualified: boolean): string {
  if (qualified) return 'Qualified!';
  if (index === 0) return 'In the lead';
  const n = index + 1;
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix} place`;
}

/** Standard-mapping shoulder buttons used to cycle spectate targets. */
export const PAD_SPECTATE_PREV = 4;
/** Right shoulder: next target. */
export const PAD_SPECTATE_NEXT = 5;

/**
 * Edge detector for the gamepad shoulder buttons while spectating (the
 * input system maps them to gameplay actions, which a spectator doesn't use).
 *
 * @example
 * const pad = new SpectatePadCycler();
 * const dir = pad.update(lbDown, rbDown); // 1, -1 or 0
 */
export class SpectatePadCycler {
  private prev = false;
  private next = false;

  /**
   * Feeds the current button state.
   *
   * @param prevDown - Left shoulder held.
   * @param nextDown - Right shoulder held.
   * @returns -1 / +1 on a fresh press, else 0.
   */
  update(prevDown: boolean, nextDown: boolean): -1 | 0 | 1 {
    const p = prevDown && !this.prev;
    const n = nextDown && !this.next;
    this.prev = prevDown;
    this.next = nextDown;
    if (n) return 1;
    if (p) return -1;
    return 0;
  }

  /** Forgets held buttons (e.g. when spectating starts with one held). */
  reset(prevDown = false, nextDown = false): void {
    this.prev = prevDown;
    this.next = nextDown;
  }
}
