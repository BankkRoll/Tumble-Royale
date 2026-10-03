/**
 * Controller vibration and phone haptics (Settings → Controller vibration).
 *
 * Responsibilities:
 * - map the local player's sim events to rumble patterns ({@link HapticMapper});
 * - throttle them so a pinball bumper chain does not buzz continuously
 *   ({@link HapticThrottle});
 * - play them on the last-used device: `vibrationActuator.playEffect('dual-rumble')`
 *   on a standard gamepad, `navigator.vibrate` on touch devices ({@link playHaptic}).
 */
import type { SimEvent } from '@tumble/sim';

/** What happened to the local Tumbler. */
export type HapticKind =
  'diveImpact' | 'hardLanding' | 'stunned' | 'grabbed' | 'bounce' | 'eliminated' | 'qualified';

/** A dual-rumble effect. */
export interface RumblePattern {
  /** Effect length (ms). */
  durationMs: number;
  /** Low-frequency (heavy) motor, 0–1. */
  strong: number;
  /** High-frequency (buzz) motor, 0–1. */
  weak: number;
}

/** A pattern with the reason it fired (throttling is per kind). */
export interface HapticCue {
  kind: HapticKind;
  pattern: RumblePattern;
}

/** Base patterns; event strength scales the motors of impacts and stuns. */
export const HAPTIC_PATTERNS: Readonly<Record<HapticKind, RumblePattern>> = Object.freeze({
  diveImpact: { durationMs: 110, strong: 0.55, weak: 0.25 },
  hardLanding: { durationMs: 70, strong: 0.35, weak: 0.1 },
  stunned: { durationMs: 220, strong: 0.85, weak: 0.5 },
  grabbed: { durationMs: 140, strong: 0.25, weak: 0.65 },
  bounce: { durationMs: 60, strong: 0.15, weak: 0.55 },
  eliminated: { durationMs: 520, strong: 1, weak: 0.6 },
  qualified: { durationMs: 260, strong: 0.35, weak: 0.9 },
});

/** Landing speed (m/s) from which a plain landing rumbles. */
const HARD_LANDING = 9;
/** Stun strength that maps to full motors (sim tuning `stunMaxStrength`). */
const STUN_FULL = 20;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function scaled(kind: HapticKind, k: number): HapticCue {
  const p = HAPTIC_PATTERNS[kind];
  return { kind, pattern: { durationMs: p.durationMs, strong: p.strong * k, weak: p.weak * k } };
}

/**
 * Maps sim events to haptic cues for one local player. Stateful only to tell
 * a dive's belly-flop landing from an ordinary one.
 *
 * @example
 * const map = new HapticMapper();
 * for (const e of events) { const cue = map.map(e, localId); if (cue) haptics.play(cue); }
 */
export class HapticMapper {
  private diving = false;

  /**
   * @param e - A sim event.
   * @param localId - The local player's id (-1 when spectating only).
   * @returns The cue to play, or null when the event is not about the local player or too small.
   */
  map(e: SimEvent, localId: number): HapticCue | null {
    if (localId < 0) return null;
    switch (e.type) {
      case 'dive':
        if (e.player === localId) this.diving = true;
        return null;
      case 'getUp':
      case 'respawn':
        if (e.player === localId) this.diving = false;
        return null;
      case 'land': {
        if (e.player !== localId) return null;
        const wasDiving = this.diving;
        this.diving = false;
        if (wasDiving) return scaled('diveImpact', 0.6 + 0.4 * clamp01(e.impact / 12));
        return e.impact >= HARD_LANDING ? scaled('hardLanding', clamp01(e.impact / 16)) : null;
      }
      case 'stun':
        if (e.player !== localId) return null;
        this.diving = false;
        return scaled('stunned', 0.45 + 0.55 * clamp01(e.strength / STUN_FULL));
      case 'grabStart':
        return e.target === localId && e.player !== localId && e.targetKind === 'player'
          ? scaled('grabbed', 1)
          : null;
      case 'bounce':
        return e.player === localId ? scaled('bounce', 1) : null;
      case 'eliminated':
        return e.player === localId ? scaled('eliminated', 1) : null;
      case 'qualified':
        return e.player === localId ? scaled('qualified', 1) : null;
      default:
        return null;
    }
  }

  /** Forgets dive state (new round). */
  reset(): void {
    this.diving = false;
  }
}

/** Minimum gaps between effects. */
export interface HapticThrottleOptions {
  /** Between any two effects (ms). */
  globalMs: number;
  /** Between two effects of the same kind (ms). */
  perKindMs: number;
}

/** Big moments that always cut through the global gap. */
const PRIORITY: ReadonlySet<HapticKind> = new Set<HapticKind>(['eliminated', 'qualified', 'stunned']);

/**
 * Rate limiter: a short global gap so overlapping events do not stack into a
 * blur, a longer per-kind gap so repeats (bumper chains, mash-grabs) do not
 * buzz continuously. Eliminated / qualified / stunned skip the global gap.
 */
export class HapticThrottle {
  private readonly opts: HapticThrottleOptions;
  private lastAny = -Infinity;
  private readonly lastKind = new Map<HapticKind, number>();

  constructor(opts: Partial<HapticThrottleOptions> = {}) {
    this.opts = { globalMs: 90, perKindMs: 280, ...opts };
  }

  /**
   * @param kind - Cue kind.
   * @param now - Timestamp (ms).
   * @returns True (and records it) when the cue may play now.
   */
  allow(kind: HapticKind, now: number): boolean {
    if (now - (this.lastKind.get(kind) ?? -Infinity) < this.opts.perKindMs) return false;
    if (!PRIORITY.has(kind) && now - this.lastAny < this.opts.globalMs) return false;
    this.lastAny = now;
    this.lastKind.set(kind, now);
    return true;
  }
}

/** The parts of `Gamepad` / `Navigator` haptics uses (feature-detected at runtime). */
interface RumblePad {
  vibrationActuator?: {
    playEffect?: (type: 'dual-rumble', params: Record<string, number>) => Promise<unknown>;
  } | null;
}

/**
 * Plays a pattern on the device the player is using.
 *
 * @param pattern - Effect.
 * @param target - The active standard gamepad, or `'touch'` for the phone's vibration motor.
 * @returns True when an effect was started.
 */
export function playHaptic(pattern: RumblePattern, target: RumblePad | 'touch' | null): boolean {
  if (!target) return false;
  if (target === 'touch') {
    // Phones have one motor: map strength to a slightly shorter or longer pulse.
    const ms = Math.round(pattern.durationMs * (0.5 + 0.5 * clamp01(Math.max(pattern.strong, pattern.weak))));
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
      ? navigator.vibrate(ms)
      : false;
  }
  const play = target.vibrationActuator?.playEffect;
  if (typeof play !== 'function') return false;
  play
    .call(target.vibrationActuator, 'dual-rumble', {
      startDelay: 0,
      duration: pattern.durationMs,
      strongMagnitude: clamp01(pattern.strong),
      weakMagnitude: clamp01(pattern.weak),
    })
    // NOTE: a newer effect preempts the running one, which rejects; that is expected.
    .catch(() => undefined);
  return true;
}
