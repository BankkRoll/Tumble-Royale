/**
 * Whether Play Online works right now, for the Play tab's mode tiles.
 * Checks overlap (boot, sign-in, Retry, the network coming and going) and a
 * probe can take seconds, so only the newest check publishes, and a probe
 * that answers after the device went offline or maintenance began never
 * flips the tile back to online.
 */
import type { OnlineStatus } from '@tumble/ui';

/** What a check reads and where it publishes. */
export interface OnlineStatusDeps {
  /** Online play is off for this session (no API, no direct game server). */
  disabled(): boolean;
  /** `navigator.onLine`: false is reliable, true only means "maybe". */
  networkUp(): boolean;
  /** The maintenance message while a window is active, else null. */
  maintenance(): string | null;
  /** Probes the servers; `counts` are the Play tile's player counts. */
  probe(): Promise<{ up: boolean; counts?: Pick<OnlineStatus, 'playersOnline' | 'inQueue'> }>;
  publish(status: OnlineStatus): void;
}

/**
 * Publishes the online state, newest check wins.
 *
 * @example
 * const status = new OnlineStatusCheck(deps);
 * window.addEventListener('offline', () => void status.refresh());
 */
export class OnlineStatusCheck {
  private gen = 0;

  constructor(private readonly deps: OnlineStatusDeps) {}

  /** The state without probing, or null when a probe is needed. */
  private settled(): OnlineStatus | null {
    const d = this.deps;
    if (d.disabled()) return { state: 'disabled', message: 'Online play is turned off for this session.' };
    if (!d.networkUp())
      return { state: 'offline', noNetwork: true, message: "You're offline. Shows against bots still work." };
    const maintenance = d.maintenance();
    return maintenance !== null ? { state: 'offline', message: maintenance } : null;
  }

  /**
   * Checks and publishes.
   *
   * @returns The published state, or null when a newer check took over.
   */
  async refresh(): Promise<OnlineStatus | null> {
    const gen = ++this.gen;
    const now = this.settled();
    if (now) {
      this.deps.publish(now);
      return now;
    }
    this.deps.publish({ state: 'checking' });
    let result: Awaited<ReturnType<OnlineStatusDeps['probe']>>;
    try {
      result = await this.deps.probe();
    } catch {
      result = { up: false };
    }
    if (gen !== this.gen) return null;
    const status: OnlineStatus = this.settled() ??
      (result.up
        ? { state: 'online', ...result.counts }
        : { state: 'offline', message: 'The game servers are offline right now.' });
    this.deps.publish(status);
    return status;
  }
}
