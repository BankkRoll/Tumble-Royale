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
import { ReplayRecorder, type RecordableCamera, type RecordablePlayer } from './recorder.ts';

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

  /**
   * @param library - Where finished rounds go.
   * @param onChange - Library or live availability changed (publish to the UI).
   */
  constructor(
    private readonly library: ReplayLibrary,
    private readonly onChange: () => void,
  ) {}

  /** True while a round with at least one frame is being recorded. */
  get recording(): boolean {
    return !!this.rec && this.rec.recordedFrames > 0;
  }

  /** The round in progress so far, or null. */
  snapshot(): ReplayData | null {
    return this.rec?.snapshot() ?? null;
  }

  showStarted(): void {
    this.rec = null;
    this.source = null;
    this.view = null;
    this.library.beginShow();
    this.onChange();
  }

  roundStarted(info: LiveRoundInfo, source: RoundSource, view: RecordableView | null): void {
    if (this.rec) this.roundEnded(null);
    const r = info.round;
    this.rec = new ReplayRecorder({
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
      qualifyTarget: info.qualifyTarget,
      localId: info.localId,
      players: info.players,
    });
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
    let cam: RecordableCamera | null = null;
    if (v) {
      cam = this.cam;
      cam.mode = CAMERA_CODE[v.cameraMode];
      cam.target = v.cameraTarget;
      cam.yaw = v.rig.yaw;
      cam.pitch = v.rig.pitch;
    }
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
    if (data && data.header.frameCount > 1) this.library.add(data);
    this.onChange();
  }
}
