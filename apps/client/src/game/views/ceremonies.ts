/**
 * Show ceremony views built on `@tumble/render/scenes`: the pre-show waiting
 * platform, the results backdrop, the victory podium and the PLAYER WALL.
 *
 * The wall is the interesting one: the UI owns the authoritative wall
 * timeline (`playerWallTimeline`) and emits each beat as a `playerWallEvent`;
 * the 3D wall has its own internal choreography. {@link WallView} time-warps
 * the 3D recap so its round banners, crown drop and finale land on the UI's
 * beats (piecewise-linear map between the two schedules).
 */
import type { ThemeDefinition } from '@tumble/content/themes';
import type { PostPipeline } from '@tumble/render/post';
import type { QualityPreset } from '@tumble/render/quality';
import {
  createPlayerWallScene,
  createPreShowArena,
  createResultsBackdrop,
  createVictoryPodium,
  type ArenaPlayer,
  type CreateTumblerVisual,
  type PlayerWallScene,
  type PlayerWallSummary,
  type PodiumPlayer,
  type PreShowArena,
  type ResultsMood,
  type TumblerLoadout,
  type VictoryPodium,
} from '@tumble/render/scenes';
import { playerWallTimeline, type PlayerWallEvent, type ShowSummary as UiShowSummary } from '@tumble/ui';
import { sceneOptions, wrapScene } from './common.ts';
import type { GameView } from './types.ts';

/** Post effects the ceremony scenes may trigger (accessibility-filtered by the app). */
export type CeremonyPost = Pick<PostPipeline, 'punch' | 'flash' | 'setFocusVignette'>;

// -----------------------------------------------------------------------------
// Pre-show
// -----------------------------------------------------------------------------

/** Pre-show platform with every participant milling about. */
export interface PreShowView extends GameView {
  readonly arena: PreShowArena;
}

/**
 * Builds the pre-show arena view.
 *
 * @param theme - Theme.
 * @param preset - Quality preset.
 * @param createTumbler - Tumbler factory.
 * @param players - Participants with loadouts.
 * @param localId - Local player id (string form), highlighted.
 */
export function createPreShowView(
  theme: ThemeDefinition,
  preset: QualityPreset,
  createTumbler: CreateTumblerVisual,
  players: readonly ArenaPlayer[],
  localId: string | undefined,
): PreShowView {
  const arena = createPreShowArena({
    ...sceneOptions(theme, preset, createTumbler),
    players,
    ...(localId !== undefined ? { localPlayerId: localId } : {}),
    seed: players.length * 31 + 7,
  });
  return Object.assign(wrapScene('preShow', arena), { arena });
}

// -----------------------------------------------------------------------------
// Results backdrop
// -----------------------------------------------------------------------------

/**
 * Results screen backdrop (bouncing Tumblers under a sunburst).
 *
 * @param theme - Theme of the round just played.
 * @param preset - Quality preset.
 * @param createTumbler - Tumbler factory.
 * @param bouncers - Up to five loadouts (qualifiers).
 * @param mood - Qualified / eliminated / neutral lighting.
 */
export function createResultsView(
  theme: ThemeDefinition,
  preset: QualityPreset,
  createTumbler: CreateTumblerVisual,
  bouncers: readonly TumblerLoadout[],
  mood: ResultsMood,
): GameView {
  const scene = createResultsBackdrop({ ...sceneOptions(theme, preset, createTumbler), bouncers: bouncers.slice(0, 5), mood });
  return wrapScene('results', scene);
}

// -----------------------------------------------------------------------------
// Victory podium / winner cam
// -----------------------------------------------------------------------------

/** Victory podium view. */
export interface PodiumView extends GameView {
  readonly podium: VictoryPodium;
}

/**
 * The crowned winner on the podium (also the "winner cam" for everyone else).
 *
 * @param theme - Theme of the final.
 * @param preset - Quality preset.
 * @param createTumbler - Tumbler factory.
 * @param winner - Winner name + loadout.
 * @param runnersUp - 2nd/3rd place.
 * @param post - Post effects (punch/flash).
 */
export function createPodiumView(
  theme: ThemeDefinition,
  preset: QualityPreset,
  createTumbler: CreateTumblerVisual,
  winner: PodiumPlayer,
  runnersUp: readonly PodiumPlayer[],
  post: CeremonyPost,
): PodiumView {
  const podium = createVictoryPodium({ ...sceneOptions(theme, preset, createTumbler), winner, runnersUp: runnersUp.slice(0, 2) });
  podium.attachPost(post);
  let burst = 1.2;
  const view = wrapScene('podium', podium, {
    update(_dt, realDt) {
      burst -= realDt;
      if (burst <= 0) {
        podium.celebrate();
        burst = 3.5;
      }
    },
    dispose: () => podium.attachPost(null),
  });
  return Object.assign(view, { podium });
}

// -----------------------------------------------------------------------------
// Player wall
// -----------------------------------------------------------------------------

/** 3D recap timings (mirrors `createPlayerWallScene`'s internal schedule). */
const W3 = {
  intro: 2.6,
  banner: 1.3,
  emptyRound: 0.8,
  flash: 1.4,
  firstGap: 0.42,
  gapDecay: 0.78,
  minGap: 0.07,
  afterDrops: 1.6,
  roundTail: 0.4,
  sweepWinner: 1.2,
  sweepNoWinner: 0.4,
  focusToCrown: 1.2,
  crownToReveal: 1.7,
  revealToEnd: 3.2 + 2.5,
} as const;

/** Anchor beats of the 3D schedule (seconds). */
function wall3dAnchors(summary: PlayerWallSummary): { rounds: number[]; focus: number; crown: number; reveal: number; end: number } {
  const known = new Set(summary.players.map((p) => p.id));
  const rounds: number[] = [];
  let at = W3.intro;
  for (const r of summary.rounds) {
    rounds.push(at);
    at += W3.banner;
    const victims = r.eliminatedIds.filter((id) => known.has(id) && id !== summary.winnerId);
    if (victims.length === 0) {
      at += W3.emptyRound;
      continue;
    }
    at += W3.flash;
    let gap: number = W3.firstGap;
    for (let i = 0; i < victims.length; i++) {
      at += gap;
      gap = Math.max(W3.minGap, gap * W3.gapDecay);
    }
    at += W3.afterDrops + W3.roundTail;
  }
  const hasWinner = summary.winnerId !== null && known.has(summary.winnerId);
  at += hasWinner ? W3.sweepWinner : W3.sweepNoWinner;
  const focus = at;
  const crown = focus + W3.focusToCrown;
  const reveal = crown + W3.crownToReveal;
  const end = hasWinner ? reveal + W3.revealToEnd : at;
  return { rounds, focus, crown, reveal, end };
}

/** Player wall view synced to the UI wall timeline. */
export class WallView implements GameView {
  readonly kind = 'wall';
  readonly wall: PlayerWallScene;
  /** Pairs of (UI seconds, 3D seconds), ascending. */
  private readonly map: [number, number][] = [];
  private started = false;
  private uiClock = 0;
  private clock3d = 0;
  private waitStart = 0;

  /**
   * @param theme - Wall theme.
   * @param preset - Quality preset.
   * @param createTumbler - Tumbler factory.
   * @param summary3d - Wall input (string ids, loadouts).
   * @param uiSummary - The same show as the UI sees it (drives the UI timeline).
   * @param post - Post effects.
   * @param reduceMotion - Mirrors the UI timeline's reduce-motion timing.
   */
  constructor(
    theme: ThemeDefinition,
    preset: QualityPreset,
    createTumbler: CreateTumblerVisual,
    private readonly summary3d: PlayerWallSummary,
    uiSummary: UiShowSummary,
    post: CeremonyPost,
    reduceMotion: boolean,
  ) {
    this.wall = createPlayerWallScene({
      ...sceneOptions(theme, preset, createTumbler),
      capacity: Math.max(20, summary3d.players.length),
      title: 'THE TUMBLE WALL',
    });
    this.wall.attachPost(post);

    const ui = playerWallTimeline(uiSummary, { reduceMotion });
    const w = wall3dAnchors(summary3d);
    this.map.push([0, 0]);
    const banners = ui.events.filter((e) => e.type === 'roundBanner');
    banners.forEach((e, i) => {
      const t3 = w.rounds[i];
      if (t3 !== undefined) this.map.push([e.t / 1000, t3]);
    });
    const at = (type: PlayerWallEvent['type']): number | undefined => ui.events.find((e) => e.type === type)?.t;
    const pairs: [number | undefined, number][] = [
      [at('winnerFocus'), w.focus],
      [at('crownDrop'), w.crown],
      [at('winnerReveal'), w.reveal],
      [ui.duration, w.end],
    ];
    for (const [u, t3] of pairs) if (u !== undefined) this.map.push([u / 1000, t3]);
    // Both schedules are monotonic, but guard against a zero-length UI segment.
    this.map.sort((a, b) => a[0] - b[0]);
  }

  get scene(): GameView['scene'] {
    return this.wall.scene;
  }

  get camera(): GameView['camera'] {
    return this.wall.camera;
  }

  get grade(): GameView['grade'] {
    return this.wall.grade;
  }

  /**
   * Feeds a UI wall beat.
   *
   * @param e - Event from the `playerWallEvent` intent.
   */
  handle(e: PlayerWallEvent): void {
    if (!this.started) this.start();
    if (e.type === 'skip') this.wall.skip();
  }

  private start(): void {
    this.started = true;
    this.uiClock = 0;
    this.clock3d = 0;
    this.wall.playRecap(this.summary3d);
  }

  /** 3D time for a UI time (piecewise linear between anchors, clamped). */
  private to3d(u: number): number {
    const m = this.map;
    for (let i = 1; i < m.length; i++) {
      const a = m[i - 1] as [number, number];
      const b = m[i] as [number, number];
      if (u <= b[0]) {
        const span = b[0] - a[0];
        return span <= 1e-6 ? b[1] : a[1] + ((u - a[0]) / span) * (b[1] - a[1]);
      }
    }
    const last = m[m.length - 1] as [number, number];
    return last[1] + (u - last[0]);
  }

  update(_dt: number, realDt: number): void {
    if (!this.started) {
      // The UI normally starts the timeline as the wipe reveals; never sit idle if it doesn't.
      this.waitStart += realDt;
      if (this.waitStart > 2) this.start();
      this.wall.update(realDt);
      return;
    }
    this.uiClock += realDt;
    const target = this.to3d(this.uiClock);
    const step = Math.max(0, Math.min(0.25, target - this.clock3d));
    this.clock3d += step;
    this.wall.update(step);
  }

  resize(width: number, height: number): void {
    this.wall.resize(width, height);
  }

  dispose(): void {
    this.wall.attachPost(null);
    this.wall.dispose();
  }
}
