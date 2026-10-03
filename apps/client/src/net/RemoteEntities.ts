/**
 * Remote players: buffers their snapshot samples, renders them ~100 ms in the
 * past (adaptive to jitter) with Hermite interpolation, briefly extrapolates
 * through gaps, and positions their kinematic proxies in the predict sim so
 * the local player collides with what it sees.
 */
import {
  InterpolationClock,
  MAX_ENTITIES,
  SnapshotInterpolator,
  createRenderEntityState,
  type DecodedSnapshot,
  type InterpolationClockOptions,
  type MatchSim,
  type RenderEntityState,
} from '@tumble/netcode';

/**
 * Interpolated remote entities, ready for rendering.
 *
 * @example
 * net.on('snapshot', (s) => remotes.onSnapshot(s, performance.now(), s.serverTick * net.tickMs));
 * // every frame:
 * remotes.update(performance.now(), predictSim);
 * remotes.forEach((e) => visuals.get(e.id)?.setTransform(e.pos, e.rot));
 */
export class RemoteEntities {
  readonly clock: InterpolationClock;
  private readonly interps: (SnapshotInterpolator | null)[] = new Array<SnapshotInterpolator | null>(MAX_ENTITIES).fill(null);
  private readonly states: RenderEntityState[] = Array.from({ length: MAX_ENTITIES }, createRenderEntityState);
  private readonly visible = new Uint8Array(MAX_ENTITIES);
  /** Render time on the snapshot timeline used by the last {@link update} (ms). */
  renderTimeMs = 0;

  /**
   * @param localPlayerId - Excluded (predicted, not interpolated); -1 for spectators.
   * @param clockOpts - Interpolation delay tuning.
   */
  constructor(
    public localPlayerId: number,
    clockOpts: InterpolationClockOptions = {},
  ) {
    this.clock = new InterpolationClock(clockOpts);
  }

  /**
   * Feeds a decoded snapshot.
   *
   * @param localNowMs - Local arrival time.
   * @param snapshotTimeMs - `serverTick × tickMs`.
   */
  onSnapshot(snap: DecodedSnapshot, localNowMs: number, snapshotTimeMs: number): void {
    this.clock.onSnapshot(localNowMs, snapshotTimeMs);
    for (let i = 0; i < snap.removedCount; i++) {
      const id = snap.removed[i]!;
      this.interps[id]?.clear();
      this.visible[id] = 0;
    }
    for (let i = 0; i < snap.entityCount; i++) {
      const e = snap.entities[i]!;
      if (e.id === this.localPlayerId) continue;
      let interp = this.interps[e.id];
      if (!interp) interp = this.interps[e.id] = new SnapshotInterpolator();
      interp.push(snapshotTimeMs, e);
      this.visible[e.id] = 1;
    }
  }

  /**
   * Samples every remote at the current render time and (optionally) moves
   * their proxies in the predict sim.
   */
  update(localNowMs: number, sim?: MatchSim | null): void {
    const t = this.clock.renderTime(localNowMs);
    this.renderTimeMs = t;
    for (let id = 0; id < MAX_ENTITIES; id++) {
      const interp = this.interps[id];
      if (!interp || !this.visible[id]) continue;
      const out = this.states[id]!;
      if (!interp.sample(t, out)) continue;
      sim?.setRemoteProxy(id, out.pos, out.rot, out.vel, out.state);
    }
  }

  /** @returns The render state of remote `id`, or undefined when unknown. */
  get(id: number): RenderEntityState | undefined {
    return id >= 0 && id < MAX_ENTITIES && this.visible[id] ? this.states[id] : undefined;
  }

  /** Calls `fn` for every visible remote. */
  forEach(fn: (state: RenderEntityState) => void): void {
    for (let id = 0; id < MAX_ENTITIES; id++) if (this.visible[id] && this.interps[id]?.size) fn(this.states[id]!);
  }

  /** Forgets every entity (new round). */
  reset(): void {
    for (const i of this.interps) i?.clear();
    this.visible.fill(0);
    this.clock.reset();
  }
}
