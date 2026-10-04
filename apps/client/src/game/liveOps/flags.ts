/**
 * Feature flags on the client.
 *
 * Responsibilities:
 * - Hold the evaluated flags from `GET /flags` (per account when signed in,
 *   so percentage rollouts are sticky), cached on the device so an offline
 *   boot still honours the last switches an operator made.
 * - Answer {@link flag} synchronously with the shared defaults (everything on)
 *   for keys the API never sent, so a fresh or offline client is never
 *   missing a feature.
 * - Notify subscribers (the UI store, the social controller) when a flag
 *   actually changes.
 * - Gate replay recording per show on `replays.enabled`.
 */
import {
  analyticsSampleRate,
  flagEnabled,
  type FlagKey,
  type FlagMap,
  type FlagValue,
} from '@tumble/shared/liveops';
import type { ReplayHooks } from '../replay/live.ts';
import { loadJson, saveJson } from '../storage.ts';

/** Storage seam for {@link FlagStore}. */
export interface FlagStorage {
  load(): unknown;
  save(flags: FlagMap): void;
}

/**
 * Validates a `{ flags }` answer (or a cached copy). Malformed entries are
 * dropped one by one so a single bad row cannot disable the rest.
 *
 * @param raw - Untrusted JSON: the flags object.
 * @returns The valid flags.
 */
export function parseFlags(raw: unknown): Record<string, FlagValue> {
  const out: Record<string, FlagValue> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > 64 || !v || typeof v !== 'object') continue;
    const f = v as { enabled?: unknown; payload?: unknown };
    if (typeof f.enabled !== 'boolean') continue;
    out[key] = { enabled: f.enabled, payload: f.payload ?? null };
  }
  return out;
}

/**
 * Evaluated flags with change notifications.
 *
 * @example
 * const flags = new FlagStore();
 * await flags.refresh(() => api.flags());
 * if (flags.flag('store.enabled')) openStore();
 */
export class FlagStore {
  private map: Record<string, FlagValue>;
  private readonly listeners = new Set<(flags: FlagMap) => void>();

  constructor(private readonly storage: FlagStorage | null = null) {
    this.map = parseFlags(storage?.load());
  }

  /** Every flag the API sent (no defaults filled in). */
  get flags(): FlagMap {
    return this.map;
  }

  /** Whether a flag is on (its default when unknown). */
  flag(key: FlagKey): boolean {
    return flagEnabled(this.map, key);
  }

  /** `analytics.sample` as a 0..1 rate. */
  sampleRate(): number {
    return analyticsSampleRate(this.map);
  }

  /**
   * Calls `fn` whenever a flag changes.
   *
   * @returns Unsubscribe.
   */
  subscribe(fn: (flags: FlagMap) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /**
   * Replaces the flags with a fresh answer, caching and notifying when
   * anything changed.
   *
   * @param raw - The `flags` object from the API.
   * @returns True when something changed.
   */
  apply(raw: unknown): boolean {
    const next = parseFlags(raw);
    if (JSON.stringify(next) === JSON.stringify(this.map)) return false;
    this.map = next;
    this.storage?.save(next);
    for (const fn of this.listeners) fn(next);
    return true;
  }

  /**
   * Fetches the flags. Never throws: on failure the current (cached or
   * default) flags stay in force.
   *
   * @param fetchFlags - `ApiClient.flags`.
   * @returns True when a fresh answer arrived.
   */
  async refresh(fetchFlags: () => Promise<{ flags: unknown }>): Promise<boolean> {
    try {
      const r = await fetchFlags();
      this.apply(r.flags);
      return true;
    } catch {
      return false;
    }
  }
}

/** The game's flags, cached in `localStorage`. */
export const liveFlags = new FlagStore({
  load: () => loadJson('flags'),
  save: (m) => void saveJson('flags', m),
});

/**
 * Whether a feature is on right now.
 *
 * @param key - Flag key.
 * @example
 * if (!flag('chat.global')) hideGlobalChat();
 */
export function flag(key: FlagKey): boolean {
  return liveFlags.flag(key);
}

/**
 * Replay hooks that record only while `enabled()` was true when the show
 * started. Read once per show so flipping the flag mid-show never leaves a
 * half-recorded round.
 *
 * @param inner - The real recorder.
 * @param enabled - Usually `() => flag('replays.enabled')`.
 */
export function gatedReplays(inner: ReplayHooks, enabled: () => boolean): ReplayHooks {
  let on = enabled();
  return {
    showStarted: () => {
      // Always forwarded: it drops the previous show's recordings either way.
      inner.showStarted();
      on = enabled();
    },
    roundStarted: (info, source, view) => {
      if (on) inner.roundStarted(info, source, view);
    },
    frame: () => {
      if (on) inner.frame();
    },
    event: (e) => {
      if (on) inner.event(e);
    },
    roundEnded: (outcome) => {
      if (on) inner.roundEnded(outcome);
    },
  };
}
