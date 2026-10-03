import { Group, Vector3, type Object3D } from 'three/webgpu';
import type { TumblerLoadout } from '../character/types.ts';
import { DecorRandom } from '../level/toolkit.ts';
import { PropBuilder, type PropBatch } from '../environment/propKit.ts';
import { NameplateSet } from './nameplates.ts';
import { createFloatingPlatform, createTextBanner, type FloatingPlatform, type TextBanner } from './props.ts';
import {
  SceneState,
  TumblerActor,
  createSceneStage,
  tumblerFactory,
  type MenuScene,
  type SceneCommonOptions,
} from './common.ts';

/**
 * Pre-show waiting platform: up to 40 Tumblers milling about a huge floating
 * candy platform under a "show starting" arch, with nameplates (one instanced
 * draw) and an orbiting crane camera. Bots wander/emote on their own; the
 * integrator can take over any actor via `getActorObject`.
 */

/** A player on the platform. */
export interface ArenaPlayer {
  id: string;
  name: string;
  loadout: TumblerLoadout;
}

/** Options for {@link createPreShowArena}. */
export interface PreShowArenaOptions extends SceneCommonOptions {
  players: readonly ArenaPlayer[];
  /** Highlighted local player id (not auto-wandered when `driveLocal` is true). */
  localPlayerId?: string;
  /** When true the integrator moves the local player; otherwise it wanders too. */
  driveLocal?: boolean;
  seed?: number;
}

/** Pre-show arena handle. */
export interface PreShowArena extends MenuScene {
  readonly platformRadius: number;
  /** Root object for a player (null if unknown). */
  getActorObject(id: string): Object3D | null;
  /** Updates the arch banner (e.g. show name + "starting in 12"). */
  setBanner(title: string, subtitle?: string): void;
  /** Everyone emotes at once (countdown hype). */
  hype(): void;
}

interface Wanderer {
  actor: TumblerActor;
  holder: Group;
  target: Vector3;
  wait: number;
  speed: number;
  local: boolean;
  plate: number;
}

const MAX_PLAYERS = 60;

/**
 * Builds the pre-show arena.
 *
 * @param opts - Players, theme and optional Tumbler factory.
 */
export function createPreShowArena(opts: PreShowArenaOptions): PreShowArena {
  const radius = 18;
  const stage = createSceneStage(opts, { min: { x: -radius, y: -2, z: -radius }, max: { x: radius, y: 4, z: radius } }, { crowd: false, fov: 45 });
  const { scene, camera } = stage;
  const factory = tumblerFactory(opts.createTumbler);
  const rng = new DecorRandom(opts.seed ?? 9);

  const platform: FloatingPlatform = createFloatingPlatform(opts.theme, radius, 12);
  scene.add(platform.object);

  const decor = new PropBuilder();
  const pal = opts.theme.palette;
  for (const sx of [-1, 1]) {
    decor.add('cyl', sx * 6, 3, -radius + 3, 0.7, 6, 0.7, pal.primary);
    decor.add('sphere', sx * 6, 6.4, -radius + 3, 0.9, 0.9, 0.9, pal.interact, undefined, 0.6);
  }
  decor.add('box', 0, 6.1, -radius + 3, 13, 0.6, 0.8, pal.secondary);
  const decorBatch: PropBatch = decor.build(true);
  for (const m of decorBatch.meshes) scene.add(m);

  const banner: TextBanner = createTextBanner(10, 2.4, {
    fill: pal.neutral,
    stripe: pal.primary,
    text: pal.ink,
    outline: '#ffffff',
  });
  banner.mesh.position.set(0, 7.9, -radius + 3);
  banner.draw('THE SHOW', 'starting soon');
  scene.add(banner.mesh);

  const plates = new NameplateSet({ capacity: Math.min(opts.players.length, MAX_PLAYERS), width: 1.5 });
  scene.add(plates.object);

  const wanderers: Wanderer[] = [];
  const byId = new Map<string, Wanderer>();
  opts.players.slice(0, MAX_PLAYERS).forEach((p, i) => {
    const actor = new TumblerActor(factory, p.loadout);
    const holder = new Group();
    holder.add(actor.object);
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * (radius - 2);
    holder.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    scene.add(holder);
    plates.setName(i, p.name, p.loadout.colors[0]);
    const w: Wanderer = {
      actor,
      holder,
      target: holder.position.clone(),
      wait: rng.range(0, 3),
      speed: rng.range(2.2, 4.2),
      local: p.id === opts.localPlayerId,
      plate: i,
    };
    wanderers.push(w);
    byId.set(p.id, w);
  });

  const pickTarget = (w: Wanderer): void => {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * (radius - 2.2);
    w.target.set(Math.cos(a) * d, 0, Math.sin(a) * d);
  };

  const emotes = ['wave', 'dance', 'cheer', 'shrug'];
  const toTarget = new Vector3();
  const push = new Vector3();
  let t = 0;

  return {
    scene,
    camera,
    grade: stage.grade,
    platformRadius: radius - 0.8,
    getActorObject(id: string): Object3D | null {
      return byId.get(id)?.holder ?? null;
    },
    setBanner(title: string, subtitle?: string): void {
      banner.draw(title, subtitle);
    },
    hype(): void {
      for (const w of wanderers) {
        w.actor.playEmote(emotes[Math.floor(rng.next() * emotes.length)] ?? 'cheer', 2.5);
        w.wait = 2.5;
      }
    },
    update(dt: number): void {
      t += dt;
      platform.update(dt);
      decorBatch.update(dt);
      for (const w of wanderers) {
        const driven = w.local && opts.driveLocal === true;
        if (!driven) {
          if (w.wait > 0) {
            w.wait -= dt;
            if (w.actor.anim.state === SceneState.Run) w.actor.setState(SceneState.Idle);
            w.actor.anim.speed = 0;
            if (w.wait <= 0) pickTarget(w);
          } else {
            toTarget.subVectors(w.target, w.holder.position);
            toTarget.y = 0;
            const d = toTarget.length();
            if (d < 0.4) {
              w.wait = rng.range(1, 4);
              if (rng.next() < 0.3) w.actor.playEmote(emotes[Math.floor(rng.next() * emotes.length)] ?? 'wave', 2.4);
              else if (rng.next() < 0.3) w.actor.kick(0.6);
            } else {
              toTarget.multiplyScalar(1 / d);
              w.holder.position.addScaledVector(toTarget, Math.min(d, w.speed * dt));
              w.actor.setState(SceneState.Run);
              w.actor.anim.speed = w.speed;
              const want = Math.atan2(toTarget.x, toTarget.z);
              let diff = want - w.actor.anim.facing;
              diff = Math.atan2(Math.sin(diff), Math.cos(diff));
              w.actor.anim.facing += diff * Math.min(1, dt * 8);
            }
          }
          // Soft separation keeps the crowd from interpenetrating.
          for (const o of wanderers) {
            if (o === w) continue;
            push.subVectors(w.holder.position, o.holder.position);
            push.y = 0;
            const d2 = push.lengthSq();
            if (d2 > 0.0001 && d2 < 0.9) w.holder.position.addScaledVector(push, (0.9 - d2) * dt * 2);
          }
          const len = Math.hypot(w.holder.position.x, w.holder.position.z);
          if (len > radius - 1) w.holder.position.multiplyScalar((radius - 1) / len);
        }
        w.actor.update(dt);
        const p = w.holder.position;
        plates.setPosition(w.plate, p.x, p.y + 2.05, p.z);
      }

      const a = t * 0.06;
      camera.position.set(Math.sin(a) * 30, 15 + Math.sin(t * 0.17) * 1.2, Math.cos(a) * 30);
      camera.lookAt(0, 0.5, 0);
      stage.update(dt);
    },
    resize: stage.resize,
    dispose(): void {
      for (const w of wanderers) w.actor.dispose();
      plates.dispose();
      banner.dispose();
      decorBatch.dispose();
      platform.dispose();
      stage.dispose();
    },
  };
}
