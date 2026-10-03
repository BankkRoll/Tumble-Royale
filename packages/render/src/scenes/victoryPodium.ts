import {
  BufferAttribute,
  Color,
  Group,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three/webgpu';
import type { TumblerLoadout } from '../character/types.ts';
import { createBeveledCylinderGeometry } from '../level/geometry.ts';
import { createLevelMaterial, createLevelUniforms } from '../level/materials.ts';
import { createVfxSystem } from '../vfx/index.ts';
import type { VfxSystem } from '../vfx/types.ts';
import type { PostPipeline } from '../post/pipeline.ts';
import {
  createCrownMesh,
  createFloatingPlatform,
  createLightBeam,
  createTextBanner,
  type FloatingPlatform,
  type LightBeam,
  type TextBanner,
} from './props.ts';
import {
  TumblerActor,
  createSceneStage,
  measureHeadHeight,
  tumblerFactory,
  type MenuScene,
  type SceneCommonOptions,
} from './common.ts';

/**
 * Victory podium: the winner crowned on a tall striped podium (runners-up on
 * lower steps when given), light beams, periodic fireworks and a slow orbit.
 * Photo-mode friendly: auto camera can be swapped for a manual orbit, poses
 * cycle through the winner's emotes, and filters live in the post pipeline.
 */

/** A podium occupant. */
export interface PodiumPlayer {
  name: string;
  loadout: TumblerLoadout;
}

/** Options for {@link createVictoryPodium}. */
export interface VictoryPodiumOptions extends SceneCommonOptions {
  winner: PodiumPlayer;
  /** 2nd and 3rd place (optional). */
  runnersUp?: readonly PodiumPlayer[];
  /** Poses `cyclePose` steps through. Defaults to the winner's victory pose + celebration + emotes. */
  poses?: readonly string[];
  /** Crown height above the winner's feet. Default: measured from the winner's bounds. */
  crownHeight?: number;
}

/** Victory podium handle. */
export interface VictoryPodium extends MenuScene {
  readonly vfx: VfxSystem;
  /** Advances to the next pose; returns its id. */
  cyclePose(): string;
  setPose(pose: string): void;
  /** Auto orbit on/off and speed (rad/s). */
  setOrbit(enabled: boolean, speed?: number): void;
  /**
   * Photo mode: freezes the auto camera; `setCameraOrbit` positions it manually.
   * Pair with `post.setFilter(...)` for filters.
   */
  setPhotoMode(enabled: boolean): void;
  /**
   * Manual camera (photo mode).
   *
   * @param yaw - Radians around the winner.
   * @param pitch - Radians above the horizon.
   * @param distance - Metres from the winner.
   */
  setCameraOrbit(yaw: number, pitch: number, distance: number): void;
  /** Fire a celebration burst (fireworks + confetti). */
  celebrate(): void;
  attachPost(post: Pick<PostPipeline, 'punch' | 'flash'> | null): void;
}

function tint(geo: BufferGeometry, hex: string): BufferGeometry {
  const c = new Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/**
 * Builds the victory podium scene.
 *
 * @param opts - Winner, runners-up, theme and optional Tumbler factory.
 */
export function createVictoryPodium(opts: VictoryPodiumOptions): VictoryPodium {
  const stage = createSceneStage(
    opts,
    { min: { x: -8, y: -2, z: -8 }, max: { x: 8, y: 6, z: 8 } },
    { crowd: false, fov: 38 },
  );
  const { scene, camera } = stage;
  const factory = tumblerFactory(opts.createTumbler);
  const pal = opts.theme.palette;
  const vfx = createVfxSystem({ voidStyle: opts.theme.void.style });
  scene.add(vfx.object);

  const platform: FloatingPlatform = createFloatingPlatform(opts.theme, 8, 21);
  scene.add(platform.object);

  const u = createLevelUniforms(opts.theme);
  const stripeMat = createLevelMaterial(u, { surface: 'normal', pattern: 'stripes' });
  const trimMat = createLevelMaterial(u, { surface: 'slide', pattern: 'none' });
  const steps: { x: number; h: number; r: number; color: string }[] = [
    { x: 0, h: 2.4, r: 1.5, color: pal.interact },
    { x: -3.1, h: 1.5, r: 1.3, color: pal.secondary },
    { x: 3.1, h: 0.9, r: 1.3, color: pal.accent },
  ];
  const podium = new Group();
  const meshes: Mesh[] = [];
  const count = 1 + Math.min(2, opts.runnersUp?.length ?? 0);
  for (let i = 0; i < count; i++) {
    const s = steps[i]!;
    const body = new Mesh(tint(createBeveledCylinderGeometry(s.r, s.h, 0.25, 2), s.color), stripeMat);
    body.position.set(s.x, s.h / 2, 0);
    const cap = new Mesh(tint(createBeveledCylinderGeometry(s.r + 0.12, 0.25, 0.1, 2), '#ffffff'), trimMat);
    cap.position.set(s.x, s.h + 0.05, 0);
    for (const m of [body, cap]) {
      m.castShadow = true;
      m.receiveShadow = true;
      podium.add(m);
      meshes.push(m);
    }
  }
  scene.add(podium);

  const actors: TumblerActor[] = [];
  const holders: Group[] = [];
  const people = [opts.winner, ...(opts.runnersUp ?? []).slice(0, 2)];
  people.forEach((p, i) => {
    const s = steps[i]!;
    const a = new TumblerActor(factory, p.loadout);
    const g = new Group();
    g.position.set(s.x, s.h + 0.18, 0);
    g.add(a.object);
    scene.add(g);
    actors.push(a);
    holders.push(g);
  });
  const winner = actors[0]!;
  const crownHeight = opts.crownHeight ?? measureHeadHeight(holders[0]!) + 0.1;

  const crown = createCrownMesh(1.1);
  crown.position.set(0, steps[0]!.h + 0.18 + crownHeight, 0);
  scene.add(crown);

  const banner: TextBanner = createTextBanner(7, 1.6, {
    fill: pal.neutral,
    stripe: pal.interact,
    text: pal.ink,
    outline: '#ffffff',
  });
  banner.draw(opts.winner.name, 'WINS THE CROWN!');
  banner.mesh.position.set(0, steps[0]!.h + 4.1, -0.5);
  scene.add(banner.mesh);

  const beams: LightBeam[] = [];
  for (const [x, col] of [
    [-6, pal.primary],
    [6, pal.accent],
    [0, '#fff3c4'],
  ] as const) {
    const b = createLightBeam(col, 16, x === 0 ? 2.4 : 3);
    b.mesh.position.set(x, 15, x === 0 ? 1 : -3);
    beams.push(b);
    scene.add(b.mesh);
  }

  const poses = opts.poses ?? [
    opts.winner.loadout.victoryPose,
    opts.winner.loadout.celebration,
    ...opts.winner.loadout.emotes,
  ];
  let poseIndex = 0;
  let orbit = true;
  let orbitSpeed = 0.12;
  let photo = false;
  let yaw = 0;
  let pitch = 0.18;
  let distance = 11;
  let t = 0;
  let nextBurst = 0.6;
  let post: Pick<PostPipeline, 'punch' | 'flash'> | null = null;
  const look = new Vector3(0, steps[0]!.h + 1.0, 0);

  const playPose = (pose: string): void => winner.playEmote(pose, 1e6);
  playPose(poses[0] ?? 'victory');
  actors.slice(1).forEach((a) => a.playEmote('cheer', 1e6));

  const celebrate = (): void => {
    const top = steps[0]!.h;
    for (let k = 0; k < 3; k++)
      vfx.spawn('fireworks', { x: (k - 1) * 5, y: top + 6, z: -4 }, { delay: k * 0.3 });
    vfx.spawn('confetti', { x: 0, y: top + 3, z: 0 }, { intensity: 1.3 });
    vfx.spawn(
      'crownShine',
      { x: crown.position.x, y: crown.position.y + 0.2, z: crown.position.z },
      { duration: 6 },
    );
    post?.flash(0.25);
  };

  return {
    scene,
    camera,
    grade: stage.grade,
    vfx,
    cyclePose(): string {
      poseIndex = (poseIndex + 1) % Math.max(1, poses.length);
      const p = poses[poseIndex] ?? 'victory';
      playPose(p);
      return p;
    },
    setPose(pose: string): void {
      playPose(pose);
    },
    setOrbit(enabled: boolean, speed = orbitSpeed): void {
      orbit = enabled;
      orbitSpeed = speed;
    },
    setPhotoMode(enabled: boolean): void {
      photo = enabled;
    },
    setCameraOrbit(y: number, p: number, d: number): void {
      yaw = y;
      pitch = Math.max(-0.2, Math.min(1.3, p));
      distance = Math.max(3, Math.min(30, d));
    },
    celebrate,
    attachPost(p): void {
      post = p;
    },
    update(dt: number): void {
      t += dt;
      u.time.value = t;
      platform.update(dt);
      for (const a of actors) a.update(dt);
      crown.rotation.y += dt * 0.6;
      crown.position.y = steps[0]!.h + 0.18 + crownHeight + Math.sin(t * 2) * 0.05;
      for (let i = 0; i < beams.length; i++) beams[i]!.mesh.rotation.z = Math.sin(t * 0.5 + i * 2) * 0.3;
      nextBurst -= dt;
      if (nextBurst <= 0 && !photo) {
        celebrate();
        nextBurst = 5.5;
      }
      if (!photo && orbit) yaw += dt * orbitSpeed;
      const d = photo ? distance : 11 + Math.sin(t * 0.2) * 1.2;
      const p = photo ? pitch : 0.2 + Math.sin(t * 0.15) * 0.06;
      camera.position.set(
        Math.sin(yaw) * Math.cos(p) * d,
        look.y + Math.sin(p) * d,
        Math.cos(yaw) * Math.cos(p) * d,
      );
      camera.lookAt(look);
      stage.focus.set(0, steps[0]!.h, 0);
      stage.update(dt);
      vfx.update(dt, camera);
    },
    resize: stage.resize,
    dispose(): void {
      for (const a of actors) a.dispose();
      for (const m of meshes) m.geometry.dispose();
      stripeMat.dispose();
      trimMat.dispose();
      crown.geometry.dispose();
      (crown.material as Material).dispose();
      banner.dispose();
      for (const b of beams) b.dispose();
      vfx.dispose();
      platform.dispose();
      stage.dispose();
    },
  };
}
