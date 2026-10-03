/**
 * Show ceremony views built on `@tumble/render/scenes`: the pre-show waiting
 * platform, the results backdrop, the victory podium and the PLAYER WALL.
 *
 * The wall is the interesting one: the UI owns the authoritative wall
 * timeline (`playerWallTimeline`) and emits each beat as a `playerWallEvent`;
 * {@link WallView} plays each beat on the 3D wall as it arrives.
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
import type { PlayerWallEvent } from '@tumble/ui';
import { Vector3 } from 'three/webgpu';
import type { GameAudio } from '@tumble/audio';
import type { Rapier } from '@tumble/sim';
import { CharacterState } from '@tumble/sim/character';
import type { InputSystem } from '../../input/index.ts';
import { sceneOptions, wrapScene } from './common.ts';
import { IdlePlay } from './idlePlay.ts';
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
  control?: PreShowControl,
): PreShowView {
  const local = localId !== undefined ? players.find((p) => p.id === localId) : undefined;
  const drive = !!control && !!local;
  const arena = createPreShowArena({
    ...sceneOptions(theme, preset, createTumbler),
    players,
    ...(localId !== undefined ? { localPlayerId: localId, driveLocal: drive } : {}),
    seed: players.length * 31 + 7,
  });
  if (!drive || !control || !local) return Object.assign(wrapScene('preShow', arena), { arena });

  // The local Tumbler runs, jumps and emotes among the crowd with real physics; the camera follows it.
  const holder = arena.getActorObject(local.id);
  const anim = arena.getActorAnim(local.id);
  const start = holder ? { x: holder.position.x, z: holder.position.z } : { x: 0, z: 0 };
  const idle = new IdlePlay(control.R, arena.platformRadius + 0.6, control.input, control.audio, start);
  const camDir = new Vector3();
  const camPos = new Vector3();
  const look = new Vector3();
  let camInit = false;
  let t = 0;
  const view = wrapScene('preShow', arena, {
    update(_dt, realDt) {
      t += realDt;
      const cam = arena.camera;
      cam.getWorldDirection(camDir);
      idle.yaw = Math.atan2(camDir.x, camDir.z);
      idle.advance(realDt);
      const { feet, vel } = idle.sample();
      holder?.position.set(feet.x, feet.y, feet.z);
      const c = idle.ctrl;
      if (anim) {
        anim.state = c.state;
        anim.stateTime = c.stateTime;
        anim.speed = Math.hypot(vel.x, vel.z);
        anim.verticalSpeed = vel.y;
        anim.facing = c.facing;
        anim.grounded = c.grounded;
        anim.emote =
          c.state === CharacterState.Emote && c.emote > 0
            ? (local.loadout.emotes[c.emote - 1] ?? null)
            : null;
      }
      // Slow orbit like the arena's crane, but centred on the player and close enough to see them.
      const a = t * 0.05 + 0.6;
      const target = look.set(feet.x, feet.y + 1, feet.z);
      const want = camDir.set(feet.x + Math.sin(a) * 13, feet.y + 7.5, feet.z + Math.cos(a) * 13);
      if (!camInit) {
        camPos.copy(want);
        camInit = true;
      }
      camPos.lerp(want, 1 - Math.exp(-realDt * 3));
      cam.position.copy(camPos);
      cam.lookAt(target);
    },
    dispose: () => idle.dispose(),
  });
  return Object.assign(view, { arena });
}

/** What the pre-show needs to let the local player move. */
export interface PreShowControl {
  R: Rapier;
  input: InputSystem;
  audio: GameAudio | null;
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
  const scene = createResultsBackdrop({
    ...sceneOptions(theme, preset, createTumbler),
    bouncers: bouncers.slice(0, 5),
    mood,
  });
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
  const podium = createVictoryPodium({
    ...sceneOptions(theme, preset, createTumbler),
    winner,
    runnersUp: runnersUp.slice(0, 2),
  });
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

/**
 * Player wall view: the 3D wall plays each beat of the UI's wall timeline
 * (`playerWallEvent` intents) as it happens, so the overlay's banners,
 * counter and the 3D drops and crown always land together.
 */
export class WallView implements GameView {
  readonly kind = 'wall';
  readonly wall: PlayerWallScene;
  private started = false;
  private waitStart = 0;

  /**
   * @param theme - Wall theme.
   * @param preset - Quality preset.
   * @param createTumbler - Tumbler factory.
   * @param summary3d - Wall input (string ids, loadouts).
   * @param post - Post effects.
   */
  constructor(
    theme: ThemeDefinition,
    preset: QualityPreset,
    createTumbler: CreateTumblerVisual,
    private readonly summary3d: PlayerWallSummary,
    post: CeremonyPost,
  ) {
    this.wall = createPlayerWallScene({
      ...sceneOptions(theme, preset, createTumbler),
      capacity: Math.max(20, summary3d.players.length),
      title: 'THE TUMBLE WALL',
    });
    this.wall.attachPost(post);
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
    const w = this.wall;
    switch (e.type) {
      case 'wallStart':
        w.beat({ type: 'intro' });
        break;
      case 'roundBanner':
        w.beat({ type: 'round', roundIndex: e.roundIndex });
        break;
      case 'cellFlash':
        w.beat({ type: 'flash', roundIndex: e.roundIndex, ids: e.playerIds.map(String) });
        break;
      case 'cellDrop':
        w.beat({ type: 'drop', roundIndex: e.roundIndex, id: String(e.playerId), order: this.drops++ });
        break;
      case 'roundEnd':
        w.beat({ type: 'roundEnd', roundIndex: e.roundIndex });
        break;
      case 'winnerFocus':
        w.beat({ type: 'winnerFocus' });
        break;
      case 'crownDrop':
        w.beat({ type: 'crown' });
        break;
      case 'winnerReveal':
        w.beat({ type: 'reveal' });
        break;
      case 'wallEnd':
        w.beat({ type: 'end' });
        break;
      case 'skip':
        w.skip();
        break;
      default:
        break;
    }
  }

  private drops = 0;

  private start(): void {
    this.started = true;
    this.wall.startDrivenRecap(this.summary3d);
  }

  update(_dt: number, realDt: number): void {
    if (!this.started) {
      // The UI normally starts the timeline as the wipe reveals; never sit on an empty wall if it doesn't.
      this.waitStart += realDt;
      if (this.waitStart > 2) {
        this.start();
        this.wall.beat({ type: 'intro' });
      }
    }
    this.wall.update(realDt);
  }

  resize(width: number, height: number): void {
    this.wall.resize(width, height);
  }

  dispose(): void {
    this.wall.attachPost(null);
    this.wall.dispose();
  }
}

/**
 * Round results on the 3D wall: everyone who played the round stands in a
 * cubby and the round's eliminated players drop out one after another. It
 * schedules its own beats so the whole recap fits the results phase.
 */
export class RoundWallView implements GameView {
  readonly kind = 'roundWall';
  readonly wall: PlayerWallScene;
  private clock = 0;
  private readonly beats: { at: number; run: () => void }[] = [];
  private next = 0;

  /**
   * @param theme - Wall theme.
   * @param preset - Quality preset.
   * @param createTumbler - Tumbler factory.
   * @param roundNumber - 1-based round number for the header.
   * @param round - Players in the round and those eliminated, in drop order.
   * @param post - Post effects.
   */
  constructor(
    theme: ThemeDefinition,
    preset: QualityPreset,
    createTumbler: CreateTumblerVisual,
    roundNumber: number,
    round: { name: string; players: PlayerWallSummary['players']; eliminatedIds: readonly string[] },
    post: CeremonyPost,
  ) {
    this.wall = createPlayerWallScene({
      ...sceneOptions(theme, preset, createTumbler),
      capacity: Math.max(20, round.players.length),
      title: `ROUND ${roundNumber}`,
    });
    this.wall.attachPost(post);
    this.wall.startDrivenRecap({
      players: round.players,
      // Earlier rounds are blank placeholders so the wall banner numbers this round correctly.
      rounds: [
        ...Array.from({ length: roundNumber - 1 }, () => ({ name: '', eliminatedIds: [] as string[] })),
        { name: round.name, eliminatedIds: round.eliminatedIds },
      ],
      winnerId: null,
    });
    const out = round.eliminatedIds;
    const ri = roundNumber - 1;
    // Drops spread over at most ~2.4 s so even a 14-player cut ends inside the 6 s results phase.
    const gap = out.length > 0 ? Math.min(0.32, 2.4 / out.length) : 0;
    this.beats.push({ at: 0.3, run: () => this.wall.beat({ type: 'round', roundIndex: ri }) });
    if (out.length > 0) {
      this.beats.push({ at: 1.3, run: () => this.wall.beat({ type: 'flash', roundIndex: ri, ids: out }) });
      out.forEach((id, i) => {
        this.beats.push({
          at: 1.9 + i * gap,
          run: () => this.wall.beat({ type: 'drop', roundIndex: ri, id, order: i }),
        });
      });
    }
    this.beats.push({
      at: 2.3 + out.length * gap,
      run: () => this.wall.beat({ type: 'roundEnd', roundIndex: ri }),
    });
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

  update(_dt: number, realDt: number): void {
    this.clock += realDt;
    while (this.next < this.beats.length && this.beats[this.next]!.at <= this.clock)
      this.beats[this.next++]!.run();
    this.wall.update(realDt);
  }

  resize(width: number, height: number): void {
    this.wall.resize(width, height);
  }

  dispose(): void {
    this.wall.attachPost(null);
    this.wall.dispose();
  }
}
