import { Group } from 'three/webgpu';
import type { TumblerLoadout } from '../character/types.ts';
import { PropBuilder, type PropBatch } from '../environment/propKit.ts';
import { addIsland } from '../environment/islands.ts';
import { DecorRandom } from '../level/toolkit.ts';
import { createFloatingPlatform, createSunburst, type FloatingPlatform, type Sunburst } from './props.ts';
import {
  TumblerActor,
  createSceneStage,
  tumblerFactory,
  type MenuScene,
  type SceneCommonOptions,
} from './common.ts';
import { defaultLoadout } from './placeholderTumbler.ts';

/**
 * Cheerful animated backdrop behind the between-round results grid: a slowly
 * turning sunburst, drifting islands and balloons, and a few Tumblers bouncing
 * on jelly drums. The UI sits on top; this only sets the mood.
 */

/** Backdrop moods. */
export type ResultsMood = 'neutral' | 'qualified' | 'eliminated';

/** Options for {@link createResultsBackdrop}. */
export interface ResultsBackdropOptions extends SceneCommonOptions {
  /** Loadouts for the bouncing Tumblers (up to 5). */
  bouncers?: readonly TumblerLoadout[];
  mood?: ResultsMood;
}

/** Results backdrop handle. */
export interface ResultsBackdrop extends MenuScene {
  setMood(mood: ResultsMood): void;
}

const BOUNCER_COLORS = ['#ff6fb5', '#5ce1e6', '#ffd23f', '#7c5cff', '#6ee7a8'];

/**
 * Builds the results backdrop.
 *
 * @param opts - Theme, mood and optional Tumbler factory.
 */
export function createResultsBackdrop(opts: ResultsBackdropOptions): ResultsBackdrop {
  const stage = createSceneStage(
    opts,
    { min: { x: -14, y: -6, z: -30 }, max: { x: 14, y: 6, z: 4 } },
    { crowd: false, fov: 42 },
  );
  const { scene, camera } = stage;
  const factory = tumblerFactory(opts.createTumbler);
  const pal = opts.theme.palette;

  const burst: Sunburst = createSunburst(pal.primary, pal.trim, 70, 20);
  burst.mesh.position.set(0, 6, -60);
  scene.add(burst.mesh);

  const rng = new DecorRandom(77);
  const builder = new PropBuilder();
  builder.group(1.7, 0.9);
  addIsland(builder, opts.theme.decor.set, opts.theme.decor.colors, -16, 2, -26, 6, rng);
  builder.group(3.1, 0.8);
  addIsland(builder, opts.theme.decor.set, opts.theme.decor.colors, 17, 0, -24, 7, rng);
  const drums: { x: number; z: number }[] = [];
  builder.group(0, 0);
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 3.1;
    const z = -11 + Math.abs(i - 2) * 0.8;
    drums.push({ x, z });
    builder.add('cyl', x, -0.95, z, 1.1, 0.7, 1.1, i % 2 === 0 ? pal.accent : pal.secondary, undefined, 0);
  }
  const props: PropBatch = builder.build(true);
  const stagePlatform: FloatingPlatform = createFloatingPlatform(opts.theme, 9, 31);
  stagePlatform.object.position.set(0, -1.3, -12);
  scene.add(stagePlatform.object);
  for (const m of props.meshes) scene.add(m);

  const bouncers: { actor: TumblerActor; holder: Group; phase: number; x: number; z: number }[] = [];
  const looks = opts.bouncers ?? BOUNCER_COLORS.map((c, i) => defaultLoadout(c, BOUNCER_COLORS[(i + 2) % 5]));
  looks.slice(0, 5).forEach((l, i) => {
    const actor = new TumblerActor(factory, l);
    const holder = new Group();
    holder.add(actor.object);
    scene.add(holder);
    const d = drums[i]!;
    bouncers.push({ actor, holder, phase: i * 0.37, x: d.x, z: d.z });
  });

  let mood: ResultsMood = opts.mood ?? 'neutral';
  const applyMood = (m: ResultsMood): void => {
    mood = m;
    if (m === 'qualified') burst.setColors('#ffd23f', '#fff3c4');
    else if (m === 'eliminated') burst.setColors('#8a8fc8', '#b9bde6');
    else burst.setColors(pal.primary, pal.trim);
  };
  applyMood(mood);

  let t = 0;
  const drumTop = -0.6;
  return {
    scene,
    camera,
    grade: stage.grade,
    setMood: applyMood,
    update(dt: number): void {
      t += dt;
      burst.update(dt * (mood === 'eliminated' ? 0.3 : 1));
      props.update(dt);
      stagePlatform.update(dt);
      for (const b of bouncers) {
        const period = 1.05;
        const ph = ((t + b.phase) % period) / period;
        const h = 4 * ph * (1 - ph) * (mood === 'eliminated' ? 1.2 : 2.6);
        b.holder.position.set(b.x, drumTop + h, b.z);
        if (ph < 0.04) b.actor.kick(0.8);
        b.actor.anim.facing = Math.sin(t * 0.7 + b.phase * 5) * 0.4;
        b.actor.anim.grounded = ph < 0.05 || ph > 0.95;
        b.actor.anim.verticalSpeed = (0.5 - ph) * 10;
        b.actor.update(dt);
      }
      camera.position.set(Math.sin(t * 0.08) * 1.5, 3.2 + Math.sin(t * 0.13) * 0.3, 9);
      camera.lookAt(0, 1.2, -12);
      stage.update(dt);
    },
    resize: stage.resize,
    dispose(): void {
      for (const b of bouncers) b.actor.dispose();
      burst.dispose();
      props.dispose();
      stagePlatform.dispose();
      stage.dispose();
    },
  };
}
