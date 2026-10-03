/**
 * The online pre-show platform: every Tumbler on it is posed from the
 * network (the local one from prediction, everyone else from interpolated
 * snapshots), so movement, jumps, dives, grabs, bumps and emotes look the
 * same on every client. Joiners pop in with a squash + puff, leavers shrink
 * away with a puff while their nameplate fades. Allocation-free per frame
 * (spawns allocate once per joiner).
 */
import type { ThemeDefinition } from '@tumble/content/themes';
import { MAX_ENTITIES } from '@tumble/netcode';
import type { QualityPreset } from '@tumble/render/quality';
import {
  createPreShowArena,
  type ArenaPlayer,
  type CreateTumblerVisual,
  type TumblerLoadout,
} from '@tumble/render/scenes';
import { CharacterState } from '@tumble/sim/character';
import { Vector3, type Object3D } from 'three/webgpu';
import { FOOT_OFFSET, createPlayerSample, isRespawnGhost, type PlayerSample } from '../round/source.ts';
import type { PreShowView } from './ceremonies.ts';
import { sceneOptions, wrapScene } from './common.ts';

/** What the live lobby view reads every frame. */
export interface LiveLobbySource {
  /** Local player id, or -1. */
  readonly localId: number;
  /** False once the show moved on to round 1: the view freezes its roster. */
  readonly live: boolean;
  /** Fills `out` for a player on the platform; false when absent. */
  sample(id: number, out: PlayerSample): boolean;
  /** True when the server removed `id` for good (despawn now rather than after a grace). */
  hasLeft(id: number): boolean;
  /** Name and loadout for a newly seen player (called once per spawn). */
  player(id: number): ArenaPlayer | null;
}

/** The live pre-show view. */
export interface LiveLobbyView extends PreShowView {
  /** Camera yaw for camera-relative input (radians). */
  readonly yaw: number;
  /** Quick-ping hook: a little hop/squash on a player (wired once pings exist). */
  ping(playerId: number): void;
}

/** A player missing this long without an explicit leave (a reconnect rebuild) is despawned anyway. */
const ABSENT_GRACE_S = 1.5;
const ID_STR = Array.from({ length: MAX_ENTITIES }, (_, i) => String(i));

/**
 * Builds the live lobby view.
 *
 * @param theme - Theme (candy).
 * @param preset - Quality preset.
 * @param createTumbler - Tumbler factory.
 * @param source - Network-driven roster and poses.
 * @returns The view; `arena` exposes the banner and hype like the offline pre-show.
 * @example
 * director.show(createLiveLobbyView(getTheme('candy'), preset, tumblers.create, lobbySource));
 */
export function createLiveLobbyView(
  theme: ThemeDefinition,
  preset: QualityPreset,
  createTumbler: CreateTumblerVisual,
  source: LiveLobbySource,
): LiveLobbyView {
  const arena = createPreShowArena({
    ...sceneOptions(theme, preset, createTumbler),
    players: [],
    live: true,
    ...(source.localId >= 0 ? { localPlayerId: ID_STR[source.localId]! } : {}),
    seed: 17,
  });
  const shown = new Uint8Array(MAX_ENTITIES);
  const absent = new Float32Array(MAX_ENTITIES);
  const holders: (Object3D | null)[] = new Array<Object3D | null>(MAX_ENTITIES).fill(null);
  const loadouts: (TumblerLoadout | null)[] = new Array<TumblerLoadout | null>(MAX_ENTITIES).fill(null);
  const lastState = new Int16Array(MAX_ENTITIES).fill(-1);
  const sample = createPlayerSample();
  const camDir = new Vector3();
  const camPos = new Vector3();
  const look = new Vector3();
  const want = new Vector3();
  let first = true;
  let camInit = false;
  let t = 0;
  let yaw = Math.PI;

  const spawn = (id: number, animate: boolean): void => {
    const p = source.player(id);
    if (!p || !arena.spawnActor(p, id, animate)) return;
    shown[id] = 1;
    holders[id] = arena.getActorObject(p.id);
    loadouts[id] = p.loadout;
    lastState[id] = -1;
  };
  const despawn = (id: number): void => {
    shown[id] = 0;
    holders[id] = null;
    loadouts[id] = null;
    arena.despawnActor(ID_STR[id]!);
  };

  const view = wrapScene('preShow', arena, {
    update(_dt, realDt) {
      t += realDt;
      let localSeen = false;
      for (let id = 0; id < MAX_ENTITIES; id++) {
        const present = source.sample(id, sample);
        if (!present) {
          if (!shown[id] || !source.live) continue;
          const gone = absent[id]! + realDt;
          absent[id] = gone;
          if (source.hasLeft(id) || gone > ABSENT_GRACE_S) despawn(id);
          continue;
        }
        absent[id] = 0;
        if (!shown[id]) {
          if (!source.live) continue;
          // Everyone already on the platform when the view opens is simply there.
          spawn(id, !first);
          if (!shown[id]) continue;
        }
        const holder = holders[id];
        const anim = arena.getActorAnim(ID_STR[id]!);
        if (!holder || !anim) continue;
        const fy = sample.y - FOOT_OFFSET;
        holder.position.set(sample.x, fy, sample.z);
        if (lastState[id] !== sample.state) {
          // Landing from the drop-in (or any fall) gets the squash.
          if (lastState[id] === CharacterState.Fall && sample.grounded) anim.impulse = 0.7;
          lastState[id] = sample.state;
        }
        anim.state = sample.state;
        anim.stateTime = sample.stateTime;
        anim.speed = Math.hypot(sample.vx, sample.vz);
        anim.verticalSpeed = sample.vy;
        anim.facing = sample.facing;
        anim.grounded = sample.grounded;
        anim.ghost = isRespawnGhost(sample);
        const lo = loadouts[id];
        anim.emote =
          sample.state === CharacterState.Emote && sample.emote > 0 && lo
            ? (lo.emotes[sample.emote - 1] ?? null)
            : null;
        if (id === source.localId) {
          localSeen = true;
          look.set(sample.x, fy + 1, sample.z);
        }
      }
      first = false;

      // Slow orbit centred on the local Tumbler (or the platform before it lands).
      const cam = arena.camera;
      if (!localSeen) look.set(0, 1, 0);
      const a = t * 0.05 + 0.6;
      want.set(look.x + Math.sin(a) * 13, look.y + 6.5, look.z + Math.cos(a) * 13);
      if (!camInit) {
        camPos.copy(want);
        camInit = true;
      }
      camPos.lerp(want, 1 - Math.exp(-realDt * 3));
      cam.position.copy(camPos);
      cam.lookAt(look);
      cam.getWorldDirection(camDir);
      yaw = Math.atan2(camDir.x, camDir.z);
    },
  });
  return Object.assign(view, {
    arena,
    get yaw() {
      return yaw;
    },
    ping(playerId: number) {
      const anim = playerId >= 0 && playerId < MAX_ENTITIES ? arena.getActorAnim(ID_STR[playerId]!) : null;
      if (anim) anim.impulse = 1;
    },
  });
}
