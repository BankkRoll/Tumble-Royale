import { Group, Mesh, MeshBasicNodeMaterial, SphereGeometry, Vector3, type Object3D } from 'three/webgpu';
import type { TumblerAnimInput, TumblerLoadout } from '../character/types.ts';
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
  /**
   * Online live lobby: nobody wanders; the integrator poses every actor from
   * the network and adds/removes them with {@link PreShowArena.spawnActor} /
   * {@link PreShowArena.despawnActor} (animated). Nameplate `i` = player id.
   */
  live?: boolean;
}

/** Pre-show arena handle. */
export interface PreShowArena extends MenuScene {
  readonly platformRadius: number;
  /** Root object for a player (null if unknown). */
  getActorObject(id: string): Object3D | null;
  /** Animation input for a player (the integrator writes it for a `driveLocal` player). */
  getActorAnim(id: string): TumblerAnimInput | null;
  /** Updates the arch banner (e.g. show name + "starting in 12"). */
  setBanner(title: string, subtitle?: string): void;
  /** Everyone emotes at once (countdown hype). */
  hype(): void;
  /**
   * Live mode: adds a player. With `animate` the Tumbler pops in (scale
   * overshoot + puff) and its nameplate fades in; without, it is just there
   * (players already on the platform when the view opens).
   *
   * @param plate - Nameplate slot (player id, < 64).
   * @returns False when the id is already present.
   */
  spawnActor(player: ArenaPlayer, plate: number, animate: boolean): boolean;
  /** Live mode: shrinks the player away with a puff, fades the nameplate, then frees it. */
  despawnActor(id: string): void;
  /** Live mode: true while `id` is on the platform (not despawning). */
  hasActor(id: string): boolean;
}

interface Wanderer {
  id: string;
  actor: TumblerActor;
  holder: Group;
  target: Vector3;
  wait: number;
  speed: number;
  local: boolean;
  plate: number;
  /** Seconds into the spawn pop (≥ SPAWN_TIME when done). */
  spawnT: number;
  /** Seconds into the despawn shrink, or -1 while alive. */
  despawnT: number;
}

const MAX_PLAYERS = 60;
/** Nameplate slots in live mode (one per wire player id). */
const LIVE_PLATES = 64;
const SPAWN_TIME = 0.45;
const DESPAWN_TIME = 0.4;
const PUFF_POOL = 8;
const PUFF_TIME = 0.5;

/** Elastic pop 0 → 1 with a small overshoot. */
function popScale(t: number): number {
  if (t >= 1) return 1;
  const c = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c) + 1;
}

/**
 * Builds the pre-show arena.
 *
 * @param opts - Players, theme and optional Tumbler factory.
 */
export function createPreShowArena(opts: PreShowArenaOptions): PreShowArena {
  const radius = 18;
  const stage = createSceneStage(
    opts,
    { min: { x: -radius, y: -2, z: -radius }, max: { x: radius, y: 4, z: radius } },
    { crowd: false, fov: 45 },
  );
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

  const live = opts.live === true;
  const plates = new NameplateSet({
    capacity: live ? LIVE_PLATES : Math.min(opts.players.length, MAX_PLAYERS),
    width: 1.5,
  });
  scene.add(plates.object);

  const wanderers: Wanderer[] = [];
  const byId = new Map<string, Wanderer>();
  const addWanderer = (p: ArenaPlayer, plate: number, spawnT: number): Wanderer => {
    const actor = new TumblerActor(factory, p.loadout);
    const holder = new Group();
    holder.add(actor.object);
    const a = rng.range(0, Math.PI * 2);
    const d = Math.sqrt(rng.next()) * (radius - 2);
    holder.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    scene.add(holder);
    plates.setName(plate, p.name, p.loadout.colors[0]);
    const w: Wanderer = {
      id: p.id,
      actor,
      holder,
      target: holder.position.clone(),
      wait: rng.range(0, 3),
      speed: rng.range(2.2, 4.2),
      local: p.id === opts.localPlayerId,
      plate,
      spawnT,
      despawnT: -1,
    };
    wanderers.push(w);
    byId.set(p.id, w);
    return w;
  };
  if (!live) opts.players.slice(0, MAX_PLAYERS).forEach((p, i) => addWanderer(p, i, SPAWN_TIME));

  // Spawn/despawn puffs: a small preallocated pool of expanding, fading spheres.
  const puffGeo = new SphereGeometry(0.5, 12, 8);
  const puffs: { mesh: Mesh; mat: MeshBasicNodeMaterial; t: number }[] = [];
  if (live) {
    for (let i = 0; i < PUFF_POOL; i++) {
      const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, color: '#ffffff' });
      const mesh = new Mesh(puffGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      puffs.push({ mesh, mat, t: PUFF_TIME });
    }
  }
  let nextPuff = 0;
  const puffAt = (p: Vector3): void => {
    if (puffs.length === 0) return;
    const puff = puffs[nextPuff]!;
    nextPuff = (nextPuff + 1) % puffs.length;
    puff.t = 0;
    puff.mesh.position.set(p.x, p.y + 0.7, p.z);
    puff.mesh.visible = true;
  };
  const freeWanderer = (w: Wanderer): void => {
    w.actor.dispose();
    w.holder.removeFromParent();
    plates.setScale(w.plate, 0);
    const i = wanderers.indexOf(w);
    if (i >= 0) wanderers.splice(i, 1);
    if (byId.get(w.id) === w) byId.delete(w.id);
  };

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
    getActorAnim(id: string): TumblerAnimInput | null {
      return byId.get(id)?.actor.anim ?? null;
    },
    setBanner(title: string, subtitle?: string): void {
      banner.draw(title, subtitle);
    },
    hype(): void {
      // Live actors are posed from the network; their emotes come from the players.
      if (live) return;
      for (const w of wanderers) {
        w.actor.playEmote(emotes[Math.floor(rng.next() * emotes.length)] ?? 'cheer', 2.5);
        w.wait = 2.5;
      }
    },
    spawnActor(player: ArenaPlayer, plate: number, animate: boolean): boolean {
      const old = byId.get(player.id);
      if (old && old.despawnT < 0) return false;
      // A leaver who rejoins mid-despawn: finish the old body at once.
      if (old) freeWanderer(old);
      const w = addWanderer(player, Math.max(0, Math.min(LIVE_PLATES - 1, plate)), animate ? 0 : SPAWN_TIME);
      w.actor.object.scale.setScalar(animate ? 0.001 : 1);
      plates.setScale(w.plate, animate ? 0.001 : 1);
      return true;
    },
    despawnActor(id: string): void {
      const w = byId.get(id);
      if (!w || w.despawnT >= 0) return;
      w.despawnT = 0;
      puffAt(w.holder.position);
    },
    hasActor(id: string): boolean {
      const w = byId.get(id);
      return !!w && w.despawnT < 0;
    },
    update(dt: number): void {
      t += dt;
      platform.update(dt);
      decorBatch.update(dt);
      for (const p of puffs) {
        if (p.t >= PUFF_TIME) continue;
        p.t += dt;
        const k = Math.min(1, p.t / PUFF_TIME);
        p.mesh.scale.setScalar(0.4 + k * 2.2);
        p.mat.opacity = 0.75 * (1 - k);
        if (k >= 1) p.mesh.visible = false;
      }
      for (let i = wanderers.length - 1; i >= 0; i--) {
        const w = wanderers[i]!;
        if (w.despawnT >= 0) {
          w.despawnT += dt;
          const k = Math.min(1, w.despawnT / DESPAWN_TIME);
          // Brief swell, then shrink to nothing while spinning.
          const s = k < 0.2 ? 1 + k * 0.6 : Math.max(0.001, 1.12 * (1 - (k - 0.2) / 0.8));
          w.actor.object.scale.setScalar(s);
          w.actor.object.rotation.y += dt * 14 * k;
          plates.setScale(w.plate, Math.max(0.001, 1 - k));
          if (k >= 1) freeWanderer(w);
        } else if (w.spawnT < SPAWN_TIME) {
          w.spawnT += dt;
          const k = Math.min(1, w.spawnT / SPAWN_TIME);
          w.actor.object.scale.setScalar(Math.max(0.001, popScale(k)));
          plates.setScale(w.plate, Math.max(0.001, k));
          if (k >= 1 && live) {
            w.actor.kick(0.8);
            puffAt(w.holder.position);
          }
        }
      }
      for (const w of wanderers) {
        const driven = live || (w.local && opts.driveLocal === true);
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
              // One roll split 30% emote / 21% kick (the old pair of rolls gave the same odds).
              const roll = rng.next();
              if (roll < 0.3)
                w.actor.playEmote(emotes[Math.floor(rng.next() * emotes.length)] ?? 'wave', 2.4);
              else if (roll < 0.51) w.actor.kick(0.6);
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
      for (const p of puffs) p.mat.dispose();
      puffGeo.dispose();
      plates.dispose();
      banner.dispose();
      decorBatch.dispose();
      platform.dispose();
      stage.dispose();
    },
  };
}
