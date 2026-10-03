/**
 * Pure schedule for the end-of-show PLAYER WALL (docs/design/SCREENS.md §10).
 *
 * The DOM wall and the three.js wall scene both consume this so they agree on
 * every beat: which round banner shows when, which cells flash, the order and
 * spin of each falling Tumbler, and when the crown lands.
 */
import { Rng } from '@tumble/shared';
import type { PlayerWallEvent, ShowSummary } from './types.ts';

/** Tunables for `playerWallTimeline`. All in milliseconds unless noted. */
export interface PlayerWallTimingOptions {
  /** Global time multiplier (>1 = slower). Default 1. */
  timeScale?: number;
  /** Shorter beats for Reduce Motion. */
  reduceMotion?: boolean;
}

/** A computed schedule. */
export interface PlayerWallTimeline {
  /** Events sorted by `t` (ms from wall start). */
  events: PlayerWallEvent[];
  /** `t` of `wallEnd`. */
  duration: number;
  /** Remaining-player counts: [start, after round 1, …]. */
  counts: number[];
}

const INTRO = 1900;
const FLASH_AFTER_BANNER = 650;
const TRAPDOOR_AFTER_BANNER = 1450;
const DROP_LEAD = 60;
const MAX_DROP_SPREAD = 1400;
const MAX_DROP_STAGGER = 70;
const COUNTER_AFTER_LAST_DROP = 700;
const ROUND_END_AFTER_COUNTER = 600;
const ROUND_GAP = 200;
const WINNER_FOCUS_GAP = 300;
const CROWN_AFTER_FOCUS = 900;
const REVEAL_AFTER_CROWN = 700;
const END_AFTER_REVEAL = 3200;

/**
 * Builds the wall schedule for a show.
 * @param summary The show recap.
 * @param opts Timing tweaks.
 * @returns Sorted events plus total duration and per-round remaining counts.
 * @example
 * const { events, duration } = playerWallTimeline(summary);
 * for (const e of events) setTimeout(() => wall3d.handle(e), e.t);
 */
export function playerWallTimeline(
  summary: ShowSummary,
  opts: PlayerWallTimingOptions = {},
): PlayerWallTimeline {
  const k = (opts.timeScale ?? 1) * (opts.reduceMotion ? 0.7 : 1);
  const rng = new Rng(summary.seed ^ 0x5eed);
  const events: PlayerWallEvent[] = [];
  const known = new Set(summary.players.map((p) => p.id));
  let remaining = summary.players.length;
  const counts = [remaining];

  events.push({ type: 'wallStart', t: 0 }, { type: 'cellsIn', t: Math.round(300 * k) });
  let t = INTRO * k;

  summary.rounds.forEach((round, roundIndex) => {
    const ids = round.eliminatedIds.filter((id) => known.has(id) && id !== summary.winnerId);
    events.push({ type: 'roundBanner', t: Math.round(t), roundIndex });
    let lastDrop = t + TRAPDOOR_AFTER_BANNER * k;
    if (ids.length > 0) {
      events.push({
        type: 'cellFlash',
        t: Math.round(t + FLASH_AFTER_BANNER * k),
        roundIndex,
        playerIds: ids,
      });
      const open = t + TRAPDOOR_AFTER_BANNER * k;
      events.push({ type: 'trapdoorOpen', t: Math.round(open), roundIndex, playerIds: ids });
      const order = rng.shuffle([...ids]);
      const stagger = Math.min(MAX_DROP_STAGGER, MAX_DROP_SPREAD / order.length) * k;
      order.forEach((playerId, i) => {
        const dt = open + DROP_LEAD * k + i * stagger;
        const dir = rng.chance(0.5) ? 1 : -1;
        events.push({
          type: 'cellDrop',
          t: Math.round(dt),
          roundIndex,
          playerId,
          spin: dir * rng.range(200, 560),
          drift: rng.range(-0.3, 0.3),
          hang: rng.chance(0.1),
        });
        lastDrop = dt;
      });
    }
    const from = remaining;
    remaining -= ids.length;
    counts.push(remaining);
    const counterT = lastDrop + COUNTER_AFTER_LAST_DROP * k;
    events.push({ type: 'counter', t: Math.round(counterT), roundIndex, from, to: remaining });
    const endT = counterT + ROUND_END_AFTER_COUNTER * k;
    events.push({ type: 'roundEnd', t: Math.round(endT), roundIndex });
    t = endT + ROUND_GAP * k;
  });

  let end: number;
  if (summary.winnerId >= 0 && known.has(summary.winnerId)) {
    const focus = t + WINNER_FOCUS_GAP * k;
    const crown = focus + CROWN_AFTER_FOCUS * k;
    const reveal = crown + REVEAL_AFTER_CROWN * k;
    end = reveal + END_AFTER_REVEAL * k;
    events.push(
      { type: 'winnerFocus', t: Math.round(focus), playerId: summary.winnerId },
      { type: 'crownDrop', t: Math.round(crown), playerId: summary.winnerId },
      { type: 'winnerReveal', t: Math.round(reveal), playerId: summary.winnerId },
    );
  } else {
    end = t + 1500 * k;
  }
  events.push({ type: 'wallEnd', t: Math.round(end) });
  events.sort((a, b) => a.t - b.t);
  return { events, duration: Math.round(end), counts };
}
