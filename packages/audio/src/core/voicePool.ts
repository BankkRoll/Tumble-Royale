/**
 * Fixed-size SFX voice pool and the stealing policy behind the 32-voice limit.
 * Pure bookkeeping (no Web Audio) so the policy is unit-testable; the engine
 * attaches a `stop` callback to each slot.
 */

/** Suggested priorities. Higher survives longer under voice pressure. */
export const VoicePriority = {
  Ambient: 0,
  Footstep: 1,
  Normal: 3,
  Important: 5,
  Critical: 8,
} as const;

/** Bonus applied to sounds made by the local player so your own jump is never stolen by a stranger's. */
export const LOCAL_PLAYER_PRIORITY_BONUS = 2;

/**
 * How much a fully audible voice outweighs a silent one, in priority units.
 * Kept below 2 together with the age penalty so a priority gap of 2+ is never
 * overturned by loudness or age (critical sounds stay protected).
 */
const AUDIBILITY_WEIGHT = 1.2;
/** Older voices are mostly in their tail, so they are cheaper to cut. Units per second, capped. */
const AGE_WEIGHT = 0.4;
const MAX_AGE_PENALTY = 0.6;

/** One slot in the pool. Slots are preallocated and reused. */
export interface VoiceSlot {
  /** Monotonic id of the sound currently in the slot (0 when free). */
  id: number;
  active: boolean;
  priority: number;
  /** Estimated loudness at the listener, 0..1 (volume × distance attenuation). */
  audibility: number;
  /** Audio-clock start time. */
  startedAt: number;
  /** Stops the underlying nodes; set by the engine. */
  stop: (() => void) | null;
}

/**
 * Score of a voice for keeping it alive; lower is stolen first.
 *
 * @param priority - Voice priority.
 * @param audibility - 0..1 loudness at the listener.
 * @param age - Seconds since it started (0 for an incoming sound).
 * @returns Keep score.
 */
export function voiceKeepScore(priority: number, audibility: number, age: number): number {
  return priority + audibility * AUDIBILITY_WEIGHT - Math.min(MAX_AGE_PENALTY, Math.max(0, age) * AGE_WEIGHT);
}

/**
 * Chooses which active voice to steal for an incoming sound.
 *
 * @param slots - Pool slots (all assumed active).
 * @param priority - Incoming priority.
 * @param audibility - Incoming audibility.
 * @param now - Current audio time.
 * @returns Slot index to steal, or -1 if the incoming sound is the least important and should be dropped.
 */
export function pickVoiceToSteal(slots: readonly VoiceSlot[], priority: number, audibility: number, now: number): number {
  let victim = -1;
  let victimScore = Infinity;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as VoiceSlot;
    const score = voiceKeepScore(s.priority, s.audibility, now - s.startedAt);
    // Ties go to the older voice: it has already been heard.
    if (score < victimScore || (score === victimScore && victim >= 0 && s.startedAt < (slots[victim] as VoiceSlot).startedAt)) {
      victim = i;
      victimScore = score;
    }
  }
  return voiceKeepScore(priority, audibility, 0) > victimScore ? victim : -1;
}

/** Result of {@link VoicePool.acquire}. */
export interface VoiceAcquire {
  /** Slot index, or -1 when the sound was rejected. */
  slot: number;
  /** Id the caller must pass back to {@link VoicePool.release}. */
  id: number;
}

/**
 * Fixed-capacity voice pool. `acquire` never allocates; when full it steals
 * according to {@link pickVoiceToSteal} and calls the victim's `stop`.
 *
 * @example
 * const pool = new VoicePool(32);
 * const v = pool.acquire(VoicePriority.Normal, 0.8, ctx.currentTime);
 * if (v.slot >= 0) pool.slots[v.slot].stop = () => src.stop();
 */
export class VoicePool {
  /** Preallocated slots; inspect but do not reassign. */
  readonly slots: VoiceSlot[];
  private nextId = 1;
  private activeCount = 0;
  private readonly result: VoiceAcquire = { slot: -1, id: 0 };

  /**
   * @param capacity - Maximum simultaneous voices.
   */
  constructor(readonly capacity: number) {
    this.slots = [];
    for (let i = 0; i < capacity; i++) {
      this.slots.push({ id: 0, active: false, priority: 0, audibility: 0, startedAt: 0, stop: null });
    }
  }

  /** Number of voices currently playing. */
  get active(): number {
    return this.activeCount;
  }

  /**
   * Reserves a slot for a new voice, stealing if necessary.
   * The returned object is reused between calls; copy fields if you keep it.
   *
   * @param priority - Voice priority (see {@link VoicePriority}).
   * @param audibility - Estimated loudness 0..1 at the listener.
   * @param now - Current audio time.
   * @returns The slot and id; `slot === -1` means dropped.
   */
  acquire(priority: number, audibility: number, now: number): VoiceAcquire {
    let slot = -1;
    if (this.activeCount < this.capacity) {
      for (let i = 0; i < this.slots.length; i++) {
        if (!(this.slots[i] as VoiceSlot).active) {
          slot = i;
          break;
        }
      }
    } else {
      slot = pickVoiceToSteal(this.slots, priority, audibility, now);
      if (slot >= 0) {
        const victim = this.slots[slot] as VoiceSlot;
        const stop = victim.stop;
        victim.active = false;
        victim.stop = null;
        this.activeCount--;
        stop?.();
      }
    }
    if (slot < 0) {
      this.result.slot = -1;
      this.result.id = 0;
      return this.result;
    }
    const s = this.slots[slot] as VoiceSlot;
    s.id = this.nextId++;
    s.active = true;
    s.priority = priority;
    s.audibility = audibility;
    s.startedAt = now;
    s.stop = null;
    this.activeCount++;
    this.result.slot = slot;
    this.result.id = s.id;
    return this.result;
  }

  /**
   * Frees a slot when its sound ends. Ignored if the slot was already stolen
   * and reused (id mismatch), which happens because `ended` fires after a steal.
   *
   * @param slot - Slot index from {@link acquire}.
   * @param id - Id from {@link acquire}.
   */
  release(slot: number, id: number): void {
    const s = this.slots[slot];
    if (!s || !s.active || s.id !== id) return;
    s.active = false;
    s.stop = null;
    this.activeCount--;
  }

  /** Stops and frees every voice. */
  stopAll(): void {
    for (const s of this.slots) {
      if (!s.active) continue;
      const stop = s.stop;
      s.active = false;
      s.stop = null;
      stop?.();
    }
    this.activeCount = 0;
  }
}

/**
 * Inverse-distance gain matching PannerNode's `'inverse'` model, used to
 * estimate audibility before creating nodes (and to cull inaudible sounds).
 *
 * @param distance - Metres from the listener.
 * @param refDistance - Distance at which gain is 1.
 * @param rolloff - Rolloff factor.
 * @returns Gain 0..1.
 */
export function inverseDistanceGain(distance: number, refDistance: number, rolloff: number): number {
  const d = Math.max(distance, refDistance);
  return refDistance / (refDistance + rolloff * (d - refDistance));
}
