import {
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  RingGeometry,
  Vector3,
  type Object3D,
} from 'three/webgpu';
import { float, sin, smoothstep, uniform, uv } from 'three/tsl';
import type { TumblerAnimInput, TumblerLoadout } from '../character/types.ts';
import { createFloatingPlatform, type FloatingPlatform } from './props.ts';
import {
  SceneState,
  TumblerActor,
  createSceneStage,
  tumblerFactory,
  type MenuScene,
  type SceneCommonOptions,
} from './common.ts';
import { defaultLoadout } from './placeholderTumbler.ts';

/**
 * Main menu stage: the player's Tumbler front and centre on a floating candy
 * platform, up to three party members beside it emoting, the themed sky,
 * clouds and islands drifting behind, and a slow cinematic camera drift.
 */

/** Options for {@link createMainMenuStage}. */
export interface MainMenuStageOptions extends SceneCommonOptions {
  player: TumblerLoadout;
  /** Party members (max 3; `null` = empty slot). */
  party?: readonly (TumblerLoadout | null)[];
  /** Emotes party members cycle through when idle. */
  idleEmotes?: readonly string[];
}

/** Main menu stage handle. */
export interface MainMenuStage extends MenuScene {
  /** The local player's root object (integrator drives it in idle-play mode). */
  readonly playerObject: Object3D;
  /**
   * The player Tumbler's animation input. In idle play the integrator writes
   * state/speed/facing/emote from its physics each frame; the stage keeps
   * advancing and rendering the same Tumbler.
   */
  readonly playerAnim: TumblerAnimInput;
  setPlayerLoadout(loadout: TumblerLoadout): void;
  /** Replace party slots 0–2 (`null` empties a slot). */
  setParty(party: readonly (TumblerLoadout | null)[]): void;
  /**
   * Plays an emote.
   *
   * @param slot - 0 = player, 1–3 = party members.
   */
  playEmote(slot: number, emote: string, duration?: number): void;
  /**
   * Idle-play hint: widens the camera and shows the "move me" ring under the
   * player. Movement itself is wired by the integrator via `playerObject`.
   */
  setPlayable(playable: boolean): void;
  /** Platform radius for the integrator's movement clamp. */
  readonly platformRadius: number;
}

const PARTY_SLOTS = [new Vector3(-1.9, 0, -0.8), new Vector3(1.9, 0, -0.8), new Vector3(-3.6, 0, -2.1)];

/**
 * Builds the main menu stage.
 *
 * @param opts - Theme, player and party loadouts, optional Tumbler factory.
 * @example
 * const stage = createMainMenuStage({ theme: getTheme('candy'), player: myLoadout, createTumbler });
 * post.setView(stage.scene, stage.camera); post.setGrade(stage.grade);
 */
export function createMainMenuStage(opts: MainMenuStageOptions): MainMenuStage {
  const radius = 6;
  const stage = createSceneStage(
    opts,
    { min: { x: -radius, y: -2, z: -radius }, max: { x: radius, y: 2, z: radius } },
    { crowd: false, fov: 35 },
  );
  const { scene, camera } = stage;
  const factory = tumblerFactory(opts.createTumbler);
  const idleEmotes = opts.idleEmotes ?? ['wave', 'dance', 'cheer'];

  const platform: FloatingPlatform = createFloatingPlatform(opts.theme, radius, 4);
  scene.add(platform.object);

  const player = new TumblerActor(factory, opts.player);
  const playerHolder = new Group();
  playerHolder.add(player.object);
  scene.add(playerHolder);

  const party: (TumblerActor | null)[] = [null, null, null];
  const partyHolders = PARTY_SLOTS.map((p) => {
    const g = new Group();
    g.position.copy(p);
    g.rotation.y = -p.x * 0.12;
    scene.add(g);
    return g;
  });
  const partyTimers = [2.5, 4.2, 5.8];

  const ringTime = uniform(0);
  const ringMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const r = uv().sub(0.5).length().mul(2);
  ringMat.colorNode = uniform(new Color(opts.theme.palette.interact));
  ringMat.opacityNode = smoothstep(0.7, 0.85, r)
    .mul(smoothstep(1.0, 0.9, r))
    .mul(sin(ringTime.mul(4)).mul(0.25).add(0.75))
    .mul(float(0.9));
  const ring = new Mesh(new RingGeometry(0.55, 1.0, 48), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  ring.visible = false;
  playerHolder.add(ring);

  let playable = false;
  let camInit = false;
  let t = 0;
  const camTarget = new Vector3();
  const camPos = new Vector3();
  const lookAt = new Vector3(0, 1.05, 0);

  const setParty = (list: readonly (TumblerLoadout | null)[]): void => {
    for (let i = 0; i < 3; i++) {
      const l = list[i] ?? null;
      const existing = party[i];
      if (!l) {
        existing?.dispose();
        party[i] = null;
        continue;
      }
      if (existing) existing.visual.setLoadout(l);
      else {
        const a = new TumblerActor(factory, l);
        partyHolders[i]!.add(a.object);
        party[i] = a;
      }
    }
  };
  setParty(opts.party ?? [defaultLoadout('#5ce1e6', '#ff6fb5'), null, defaultLoadout('#7c5cff', '#ffd23f')]);

  const resize = (w: number, h: number): void => stage.resize(w, h);
  resize(16, 9);

  return {
    scene,
    camera,
    grade: stage.grade,
    playerObject: playerHolder,
    playerAnim: player.anim,
    platformRadius: radius - 0.6,
    setPlayerLoadout(l: TumblerLoadout): void {
      player.visual.setLoadout(l);
    },
    setParty,
    playEmote(slot: number, emote: string, duration = 3): void {
      const a = slot === 0 ? player : party[slot - 1];
      a?.playEmote(emote, duration);
    },
    setPlayable(on: boolean): void {
      playable = on;
      ring.visible = on;
      if (!on) playerHolder.position.set(0, 0, 0);
    },
    update(dt: number): void {
      t += dt;
      ringTime.value = t;
      platform.update(dt);
      player.update(dt);
      for (let i = 0; i < 3; i++) {
        const a = party[i];
        if (!a) continue;
        partyTimers[i]! -= dt;
        if (partyTimers[i]! <= 0) {
          a.playEmote(idleEmotes[(i + Math.floor(t)) % idleEmotes.length] ?? 'wave', 2.6);
          partyTimers[i] = 6 + ((i * 2.3 + t) % 4);
        }
        a.update(dt);
      }
      if (!playable && player.anim.state !== SceneState.Emote) player.anim.facing = Math.sin(t * 0.35) * 0.18;

      // Slow cinematic drift; idle-play pulls back so the whole platform is in frame.
      const dist = playable ? 15 : 8.2;
      const height = playable ? 7.5 : 2.4;
      const yaw = Math.sin(t * 0.11) * 0.22;
      camTarget.set(Math.sin(yaw) * dist, height + Math.sin(t * 0.23) * 0.15, Math.cos(yaw) * dist);
      if (!camInit) {
        camPos.copy(camTarget);
        camInit = true;
      }
      camPos.lerp(camTarget, 1 - Math.exp(-dt * 1.6));
      camera.position.copy(camPos);
      lookAt.set(playerHolder.position.x * 0.4, playable ? 0.4 : 1.0, playerHolder.position.z * 0.4);
      camera.lookAt(lookAt);
      stage.focus.copy(playerHolder.position);
      stage.update(dt);
    },
    resize,
    dispose(): void {
      player.dispose();
      for (const a of party) a?.dispose();
      ring.geometry.dispose();
      ringMat.dispose();
      platform.dispose();
      stage.dispose();
    },
  };
}
