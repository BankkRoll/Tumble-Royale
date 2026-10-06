/**
 * Live recording glue between a running show and the replay library: the show
 * session reports round start/end, frames and sim events through
 * {@link ReplayHooks}; finished rounds land in the per-show library.
 */
import { PROTOCOL_VERSION } from '@tumble/netcode';
import type { RoundDefinition } from '@tumble/shared';
import type { SimEvent } from '@tumble/sim';
import type { RoundCameraMode } from '../round/roundView.ts';
import type { PlayerSample, RoundSource } from '../round/source.ts';
import { CameraModeCode, type ReplayData, type ReplayOutcome, type ReplayPlayer } from './format.ts';
import type { ReplayLibrary } from './library.ts';
import type { ReplayEntry } from './library.ts';
import { ReplayRecorder, type RecordableCamera, type RecordablePlayer, type ReplayMeta } from './recorder.ts';

/** The camera facts the recorder reads from the live round view. */
export interface RecordableView {
  readonly cameraMode: RoundCameraMode;
  readonly cameraTarget: number;
  readonly rig: { readonly yaw: number; readonly pitch: number };
}

/** A round about to be recorded. */
export interface LiveRoundInfo {
  showName: string;
  online: boolean;
  roundIndex: number;
  isFinal: boolean;
  round: RoundDefinition;
  seed: number;
  stage: number;
  qualifyTarget: number;
  /** Local player id, or -1 when the local player only spectates this round. */
  localId: number;
  players: ReplayPlayer[];
  /** Show ids of the local player's party mates (Streamer Mode leaves their names alone). */
  partyMates?: readonly number[];
}

/** What a show session reports to the replay system (`GameContext.replays`). */
export interface ReplayHooks {
  /** A new show began: the previous show's recordings are dropped. */
  showStarted(): void;
  /** The countdown began with the round view on screen: start recording. */
  roundStarted(info: LiveRoundInfo, source: RoundSource, view: RecordableView | null): void;
  /** Once per rendered frame while a round runs. */
  frame(): void;
  /** A sim event was rendered. */
  event(e: SimEvent): void;
  /** Results are in (or the player left: null): close and store the recording. */
  roundEnded(outcome: ReplayOutcome | null): void;
}

const CAMERA_CODE: Readonly<Record<RoundCameraMode, number>> = {
  follow: CameraModeCode.Follow,
  spectate: CameraModeCode.Spectate,
  celebrate: CameraModeCode.Celebrate,
  flyover: CameraModeCode.Flyover,
};

/**
 * Fills a recordable camera from the live view.
 *
 * @param v - The round view.
 * @param out - Camera to fill.
 * @returns `out`.
 */
export function readCamera(v: RecordableView, out: RecordableCamera): RecordableCamera {
  out.mode = CAMERA_CODE[v.cameraMode];
  out.target = v.cameraTarget;
  out.yaw = v.rig.yaw;
  out.pitch = v.rig.pitch;
  return out;
}

/**
 * Recording header facts for a live round.
 *
 * @param info - The round.
 * @param source - Its render source (variation and mutator come from the sim).
 * @returns Meta for a {@link ReplayRecorder} (or a {@link ReplayTape} export).
 */
export function replayMeta(info: LiveRoundInfo, source: Pick<RoundSource, 'sim'>): ReplayMeta {
  const r = info.round;
  return {
    protocolVersion: PROTOCOL_VERSION,
    recordedAt: new Date().toISOString(),
    online: info.online,
    showName: info.showName,
    roundId: r.id,
    roundName: r.name,
    roundType: info.isFinal ? 'final' : r.type,
    roundIndex: info.roundIndex,
    isFinal: info.isFinal,
    seed: info.seed >>> 0,
    stage: info.stage,
    variationId: source.sim.variationId ?? null,
    ...(source.sim.mutatorId ? { mutatorId: source.sim.mutatorId } : {}),
    qualifyTarget: info.qualifyTarget,
    localId: info.localId,
    players: info.players,
  };
}

/**
 * Records the round on screen.
 *
 * @example
 * const live = new LiveRecording(library, () => publish());
 * ctx.replays = live;
 */
export class LiveRecording implements ReplayHooks {
  private rec: ReplayRecorder | null = null;
  private source: RoundSource | null = null;
  private view: RecordableView | null = null;
  private readonly cam: RecordableCamera = { mode: 0, target: -1, yaw: 0, pitch: 0 };
  private announced = false;
  private readonly sampler = (id: number, out: RecordablePlayer): boolean =>
    this.source?.sample(id, out as PlayerSample) ?? false;

  private roundIndex = -1;
  private party: ReadonlySet<number> = new Set();

  /** Party mates' show ids in the current show (seat ids are stable for the whole show). */
  get partyMates(): ReadonlySet<number> {
    return this.party;
  }

  /**
   * @param library - Where finished rounds go.
   * @param onChange - Library or live availability changed (publish to the UI).
   * @param onStored - A finished round went into the library (highlights).
   */
  constructor(
    private readonly library: ReplayLibrary,
    private readonly onChange: () => void,
    private readonly onStored?: (entry: ReplayEntry) => void,
  ) {}

  /** True while a round with at least one frame is being recorded. */
  get recording(): boolean {
    return !!this.rec && this.rec.recordedFrames > 0;
  }

  /** The round in progress so far, or null. */
  snapshot(): ReplayData | null {
    return this.rec?.snapshot() ?? null;
  }

  /**
   * A round of the current show: the one being recorded (so far), else the
   * stored recording.
   *
   * @param roundIndex - Round index within the show.
   * @returns The recording, or null when it wasn't recorded (or was evicted).
   */
  recordingOf(roundIndex: number): ReplayData | null {
    if (this.rec && this.roundIndex === roundIndex) return this.rec.snapshot();
    const list = this.library.list();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i] as ReplayEntry;
      if (e.data.header.roundIndex === roundIndex) return e.data;
    }
    return null;
  }

  showStarted(): void {
    this.rec = null;
    this.source = null;
    this.view = null;
    this.library.beginShow();
    this.party = new Set();
    this.onChange();
  }

  roundStarted(info: LiveRoundInfo, source: RoundSource, view: RecordableView | null): void {
    if (this.rec) this.roundEnded(null);
    this.rec = new ReplayRecorder(replayMeta(info, source));
    this.roundIndex = info.roundIndex;
    this.party = new Set(info.partyMates);
    this.source = source;
    this.view = view;
    this.announced = false;
  }

  frame(): void {
    const rec = this.rec;
    const src = this.source;
    if (!rec || !src?.alive) return;
    const t = src.renderTime();
    if (!rec.due(t)) return;
    const v = this.view;
    const cam = v ? readCamera(v, this.cam) : null;
    rec.frame(t, this.sampler, cam, src.sim.getObstacleNetStates());
    if (!this.announced) {
      this.announced = true;
      this.onChange();
    }
  }

  event(e: SimEvent): void {
    const src = this.source;
    if (!this.rec || !src?.alive) return;
    this.rec.event(src.renderTime(), e);
  }

  roundEnded(outcome: ReplayOutcome | null): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    this.source = null;
    this.view = null;
    const data = rec.finish(outcome);
    const entry = data && data.header.frameCount > 1 ? this.library.add(data) : null;
    if (entry) this.onStored?.(entry);
    this.onChange();
  }
}
