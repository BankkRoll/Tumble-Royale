/**
 * Live ops on the client: keeps flags, the maintenance window and playlist
 * schedules fresh and mirrors them into the UI.
 *
 * Responsibilities:
 * - Fetch everything at boot and on reconnect (the browser coming back
 *   online, a sign-in), then poll: the maintenance status every minute (it
 *   is public and cached briefly by the API), flags and schedules every five.
 * - Re-evaluate windows locally every few seconds on the server's clock, so a
 *   scheduled maintenance flips to active, and a limited-time playlist opens
 *   or closes, without waiting for the next poll.
 * - Publish to the UI store (`liveOps.maintenance`, `liveOps.flags`) and tell
 *   the game when the maintenance phase or the offered playlists change.
 *
 * Offline (no API, or unreachable) nothing is ever blocked: flags keep their
 * cached or default values, schedules fall back to the cache or the bundled
 * ones, and maintenance is unknown, which is treated as off.
 */
import {
  clockOffset,
  maintenancePhase,
  parseMaintenance,
  type FlagMap,
  type MaintenancePhase,
  type MaintenanceWindow,
} from '@tumble/shared/liveops';
import { ui, type MaintenanceNotice } from '@tumble/ui';
import { liveFlags, type FlagStore } from './flags.ts';
import { refreshSchedule, setActiveSchedule } from './schedule.ts';

/** The API calls the controller needs (`ApiClient` satisfies it). */
export interface LiveOpsApi {
  flags(): Promise<{ flags: unknown }>;
  status(): Promise<{ maintenance: unknown; serverTime: unknown }>;
  playlistSchedule(): Promise<{ playlists: unknown; serverTime: unknown }>;
}

/** Options for {@link LiveOpsController}. */
export interface LiveOpsControllerOptions {
  /** Null when the game runs without an API (`?api=0`). */
  api: LiveOpsApi | null;
  /** The offered playlists may have changed (schedule fetched, or a window opened or closed). */
  onPlaylists?: () => void;
  /** The maintenance phase changed. */
  onMaintenance?: (phase: MaintenancePhase) => void;
  flags?: FlagStore;
  /** Publishes to the UI (defaults to the `@tumble/ui` store). */
  publish?: (patch: { maintenance?: MaintenanceNotice | null; flags?: Record<string, boolean> }) => void;
  now?: () => number;
  /** Status poll (default 60 s). */
  statusMs?: number;
  /** Flags and schedule poll (default 5 min). */
  slowMs?: number;
  /** Local re-evaluation (default 5 s). */
  tickMs?: number;
}

/** Flags as the UI wants them: key → on/off. */
export function flagBooleans(flags: FlagMap): Record<string, boolean> {
  return Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, v.enabled]));
}

/**
 * Keeps live-ops state fresh.
 *
 * @example
 * const liveOps = new LiveOpsController({ api, onMaintenance: () => app.refreshOnlineStatus() });
 * liveOps.start(window);
 */
export class LiveOpsController {
  private window: MaintenanceWindow | null = null;
  private offsetMs = 0;
  private phase: MaintenancePhase = 'off';
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly now: () => number;
  private readonly flags: FlagStore;
  private readonly publish: NonNullable<LiveOpsControllerOptions['publish']>;
  private lastNotice = 'null';

  constructor(private readonly opts: LiveOpsControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.flags = opts.flags ?? liveFlags;
    this.publish = opts.publish ?? ((patch) => ui.getState().setLiveOps(patch));
  }

  /** The maintenance window with its phase now (off when unknown). */
  maintenance(): MaintenanceWindow & { phase: MaintenancePhase } {
    const w = this.window ?? parseMaintenance(null);
    return { ...w, phase: maintenancePhase(w, this.now() + this.offsetMs) };
  }

  /** True while online play is closed for maintenance. */
  maintenanceActive(): boolean {
    return this.maintenance().phase === 'active';
  }

  /**
   * Publishes the cached flags, fetches everything and starts polling.
   *
   * @param target - Listens for `online` to refresh on reconnect (usually `window`).
   */
  start(target?: Pick<Window, 'addEventListener' | 'removeEventListener'>): void {
    this.publish({ flags: flagBooleans(this.flags.flags) });
    this.unsubscribe = this.flags.subscribe((f) => this.publish({ flags: flagBooleans(f) }));
    if (!this.opts.api) return;
    void this.refresh();
    this.timers.push(setInterval(() => void this.refreshStatus(), this.opts.statusMs ?? 60_000));
    this.timers.push(
      setInterval(() => {
        void this.refreshFlags();
        void this.refreshPlaylists();
      }, this.opts.slowMs ?? 300_000),
    );
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs ?? 5000));
    const onOnline = (): void => void this.refresh();
    target?.addEventListener('online', onOnline);
    const prevStop = this.stopListening;
    this.stopListening = () => {
      prevStop();
      target?.removeEventListener('online', onOnline);
    };
  }

  private stopListening: () => void = () => undefined;

  /** Stops polling. */
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopListening();
  }

  /** Fetches flags, maintenance and schedules (boot, reconnect, sign-in). Never throws. */
  async refresh(): Promise<void> {
    await Promise.all([this.refreshFlags(), this.refreshStatus(), this.refreshPlaylists()]);
  }

  /** Fetches the flags (per account when signed in). */
  async refreshFlags(): Promise<void> {
    const api = this.opts.api;
    if (api) await this.flags.refresh(() => api.flags());
  }

  /** Fetches the maintenance window and measures the clock offset. */
  async refreshStatus(): Promise<void> {
    const api = this.opts.api;
    if (!api) return;
    const sent = this.now();
    try {
      const r = await api.status();
      if (typeof r.serverTime === 'number') this.offsetMs = clockOffset(r.serverTime, sent, this.now());
      this.window = parseMaintenance(r.maintenance);
    } catch {
      // Unreachable: keep what we knew; an API that is down cannot be queued through anyway.
      return;
    }
    this.tick();
  }

  /** Fetches the playlist schedules. */
  async refreshPlaylists(): Promise<void> {
    const api = this.opts.api;
    if (!api) return;
    const cache = await refreshSchedule(() => api.playlistSchedule(), this.now);
    if (!cache) return;
    setActiveSchedule(cache);
    this.opts.onPlaylists?.();
  }

  /** Re-evaluates windows on the server clock and publishes what changed. */
  tick(): void {
    const m = this.maintenance();
    const t = (iso: string | null) => (iso ? Date.parse(iso) - this.offsetMs : null);
    const notice: MaintenanceNotice | null =
      m.phase === 'off'
        ? null
        : { phase: m.phase, message: m.message, startsAt: t(m.startsAt), endsAt: t(m.endsAt) };
    const key = JSON.stringify(notice);
    if (key !== this.lastNotice) {
      this.lastNotice = key;
      this.publish({ maintenance: notice });
    }
    if (m.phase !== this.phase) {
      this.phase = m.phase;
      this.opts.onMaintenance?.(m.phase);
    }
    // The receiver only re-renders when the offered cards differ, so a window that just
    // opened or closed shows within one tick at no cost otherwise.
    this.opts.onPlaylists?.();
  }
}
