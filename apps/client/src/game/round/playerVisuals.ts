/**
 * Player visuals for a round: one Tumbler per entrant (pooled across the
 * show), placed from the {@link RoundSource} every frame with animation input,
 * LOD by camera distance, nameplates, blob shadows, trails, squash/stretch
 * impulses from sim events, and footstep audio for nearby players.
 *
 * Hot loop is allocation-free: samples, anim inputs and vectors are reused.
 */
import { Vector3, type Camera, type Object3D } from 'three/webgpu';
import type { GameAudio } from '@tumble/audio';
import { getCosmetic } from '@tumble/content/cosmetics';
import { NameplateLayer, Tumbler, TumblerCrowd, type Nameplate } from '@tumble/render/character';
import type { QualityPreset } from '@tumble/render/quality';
import type {
  CreateTumblerVisual,
  TumblerAnimInput,
  TumblerLoadout,
  TumblerVisual,
} from '@tumble/render/scenes';
import type { TrailHandle, TrailStyle, VfxSystem } from '@tumble/render/vfx';
import { TEAM_COLORS } from '@tumble/shared';
import { CharacterFlag, CharacterState } from '@tumble/sim';
import type { MatchPlayerInfo } from '@tumble/sim/match';
import {
  FOOT_OFFSET,
  createPlayerSample,
  isRespawnGhost,
  type PlayerSample,
  type RoundSource,
} from './source.ts';

/** Players within this distance of the camera get footstep sounds. */
const FOOTSTEP_RANGE = 28;
const SHADOW_RADIUS = 0.55;
/** Only the nearest few names are drawn: a 40-player crowd of plates hides the course. */
const MAX_PLATES = 8;
/** Names closer than this would fill the screen. */
const PLATE_MIN_DIST = 5;
/** Moving closer must cross this fraction of a LOD distance, so Tumblers near a boundary don't flip every frame. */
const LOD_HYSTERESIS = 0.9;

/**
 * Keeps one Tumbler visual per show participant alive for the whole show, so
 * rounds reuse them instead of rebuilding 40 rigs behind every wipe. Real
 * Tumblers are drawn through one shared {@link TumblerCrowd} (a few draw calls
 * for the whole field instead of 2–3 per Tumbler).
 */
export class TumblerPool {
  private readonly visuals = new Map<number, TumblerVisual>();
  private crowd: TumblerCrowd | null = null;

  constructor(private readonly factory: CreateTumblerVisual) {}

  /**
   * Routes a round's Tumblers through the crowd renderer and drops everyone
   * else from it, so eliminated players cost nothing.
   *
   * @param active - Visuals on screen this round.
   * @returns The crowd's root (add it to the round scene), or null when no visual can be batched.
   */
  batch(active: readonly TumblerVisual[]): TumblerCrowd | null {
    const tumblers = active.filter((v): v is Tumbler => v instanceof Tumbler);
    if (tumblers.length === 0) return null;
    this.crowd ??= new TumblerCrowd();
    const keep = new Set(tumblers);
    for (const v of this.visuals.values())
      if (v instanceof Tumbler && !keep.has(v) && this.crowd.has(v)) this.crowd.remove(v);
    for (const t of tumblers) this.crowd.add(t);
    return this.crowd;
  }

  /**
   * Gets (or builds) the visual for a player.
   *
   * @param id - Player id.
   * @param loadout - Look to apply when first built.
   */
  get(id: number, loadout: TumblerLoadout): TumblerVisual {
    let v = this.visuals.get(id);
    if (!v) {
      v = this.factory(loadout);
      this.visuals.set(id, v);
    }
    return v;
  }

  /** Detaches every visual from its scene (between rounds). */
  detachAll(): void {
    for (const v of this.visuals.values()) v.object.removeFromParent();
  }

  /** Disposes everything (show end). */
  dispose(): void {
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    this.crowd?.dispose();
    this.crowd = null;
  }
}

/** Nameplate chip that marks computer-controlled players. */
const BOT_TAG = 'BOT';

const TRAIL_STYLE: Readonly<Record<string, TrailStyle>> = {
  sparkle: 'sparkle',
  bubbles: 'bubbles',
  rainbow: 'rainbow',
  hearts: 'candy',
  confetti: 'candy',
  stars: 'sparkle',
};

interface Entry {
  info: MatchPlayerInfo;
  loadout: TumblerLoadout;
  visual: TumblerVisual;
  anim: TumblerAnimInput;
  plate: Nameplate | null;
  trail: TrailHandle | null;
  impulse: number;
  visible: boolean;
  lod: 0 | 1 | 2;
  /** Last sampled feet position (camera follow, spectate, VFX). */
  feet: Vector3;
  centre: Vector3;
  vel: Vector3;
  grounded: boolean;
  speed: number;
  sliding: boolean;
  dist: number;
}

/** Options for {@link PlayerVisuals}. */
export interface PlayerVisualsOptions {
  parent: Object3D;
  pool: TumblerPool;
  loadouts: ReadonlyMap<number, TumblerLoadout>;
  vfx: VfxSystem;
  preset: QualityPreset;
  audio: GameAudio | null;
  nameplates: boolean;
  streamerMode: boolean;
  /** Tag bots' nameplates with a small BOT chip (Settings → Gameplay → Show bot tags). */
  botTags?: boolean;
}

/** All entrants' visuals for one round. */
export class PlayerVisuals {
  readonly plates: NameplateLayer;
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<number, Entry>();
  private readonly sample: PlayerSample = createPlayerSample();
  private readonly camPos = new Vector3();
  private readonly tmp = new Vector3();
  private readonly footPos = { x: 0, y: 0, z: 0 };
  private lod1: number;
  private lod2: number;
  private showPlates: boolean;
  private readonly dists = new Float32Array(64);
  private readonly crowd: TumblerCrowd | null;

  constructor(
    private readonly source: RoundSource,
    private readonly opts: PlayerVisualsOptions,
  ) {
    this.plates = new NameplateLayer();
    this.plates.setStreamerMode(opts.streamerMode);
    opts.parent.add(this.plates.mesh);
    this.lod1 = opts.preset.lodDistances[0];
    this.lod2 = opts.preset.lodDistances[1];
    this.showPlates = opts.nameplates;
    let trails = opts.preset.vfx.trails;
    const visuals: TumblerVisual[] = [];
    const order = [...source.players].sort((a, b) =>
      a.id === source.localId ? -1 : b.id === source.localId ? 1 : 0,
    );
    for (const info of order) {
      const loadout = opts.loadouts.get(info.id);
      if (!loadout) continue;
      const visual = opts.pool.get(info.id, loadout);
      visual.setLoadout(loadout);
      visual.setLod(info.id === source.localId ? 0 : 1);
      opts.parent.add(visual.object);
      visuals.push(visual);
      const isLocal = info.id === source.localId;
      const plate = isLocal
        ? null
        : this.plates.create(info.name, {
            style: loadout.nameplate,
            teamColor: info.team >= 0 ? (TEAM_COLORS[info.team % TEAM_COLORS.length] ?? null) : null,
            tag: info.isBot && (opts.botTags ?? true) ? BOT_TAG : null,
          });
      if (plate) plate.target = visual.object;
      let trail: TrailHandle | null = null;
      if (loadout.trail && trails > 0) {
        const item = getCosmetic(loadout.trail);
        if (item && item.slot === 'trail') {
          trail = opts.vfx.acquireTrail(TRAIL_STYLE[item.trail.kind] ?? 'sparkle', item.trail.colors[0]);
          if (trail) trails--;
        }
      }
      const e: Entry = {
        info,
        loadout,
        visual,
        anim: {
          state: 0,
          stateTime: 0,
          speed: 0,
          verticalSpeed: 0,
          facing: 0,
          grounded: true,
          emote: null,
          impulse: 0,
          ghost: false,
        },
        plate,
        trail,
        impulse: 0,
        visible: true,
        lod: isLocal ? 0 : 1,
        feet: new Vector3(),
        centre: new Vector3(),
        vel: new Vector3(),
        grounded: true,
        speed: 0,
        sliding: false,
        dist: 0,
      };
      this.entries.push(e);
      this.byId.set(info.id, e);
    }
    this.crowd = opts.pool.batch(visuals);
    if (this.crowd) opts.parent.add(this.crowd.object);
  }

  /** Applies quality changes (LOD distances). */
  setPreset(p: QualityPreset): void {
    this.lod1 = p.lodDistances[0];
    this.lod2 = p.lodDistances[1];
  }

  /** Nameplate settings. */
  setNameplates(on: boolean, streamer: boolean): void {
    this.showPlates = on;
    this.plates.setStreamerMode(streamer);
  }

  /** Shows or hides the BOT chip on bots' nameplates. */
  setBotTags(on: boolean): void {
    for (const e of this.entries) if (e.info.isBot) e.plate?.setTag(on ? BOT_TAG : null);
  }

  /** Adds a squash/stretch kick to a player's next frame. */
  kick(id: number, amount: number): void {
    const e = this.byId.get(id);
    if (e) e.impulse += amount;
  }

  /**
   * Last rendered feet position of a player.
   *
   * @returns False when the player is unknown or hidden.
   */
  feetOf(id: number, out: { x: number; y: number; z: number }): boolean {
    const e = this.byId.get(id);
    if (!e || !e.visible) return false;
    out.x = e.feet.x;
    out.y = e.feet.y;
    out.z = e.feet.z;
    return true;
  }

  /**
   * Fills a camera follow target from a player's last rendered state.
   *
   * @returns False when the player is unknown or hidden.
   */
  followTarget(
    id: number,
    out: {
      position: { x: number; y: number; z: number };
      velocity: { x: number; y: number; z: number };
      grounded: boolean;
    },
  ): boolean {
    const e = this.byId.get(id);
    if (!e || !e.visible) return false;
    out.position.x = e.feet.x;
    out.position.y = e.feet.y;
    out.position.z = e.feet.z;
    out.velocity.x = e.vel.x;
    out.velocity.y = e.vel.y;
    out.velocity.z = e.vel.z;
    out.grounded = e.grounded;
    return true;
  }

  /** Last rendered planar speed (camera FOV kick, spectate). */
  speedOf(id: number): number {
    return this.byId.get(id)?.speed ?? 0;
  }

  /** Root object of a player's Tumbler (camera look targets). */
  objectOf(id: number): Object3D | null {
    return this.byId.get(id)?.visual.object ?? null;
  }

  /** Visuals in this round (debug overlay). */
  get count(): number {
    return this.entries.length;
  }

  /**
   * Places and animates every Tumbler, then feeds VFX anchors, shadows,
   * trails, nameplates and footsteps.
   *
   * @param dt - Scaled frame delta.
   * @param camera - Active camera.
   */
  update(dt: number, camera: Camera): void {
    camera.getWorldPosition(this.camPos);
    const vfx = this.opts.vfx;
    const s = this.sample;
    let shadows = 0;
    // Slots must be opened before writing; the final count is trimmed after the loop.
    vfx.setShadowCount(Math.min(this.entries.length, this.opts.preset.vfx.shadows));
    for (const e of this.entries) {
      const ok = this.source.sample(e.info.id, s);
      const hidden = !ok || s.state === CharacterState.Eliminated || s.state === CharacterState.Spectating;
      if (hidden) {
        if (e.visible) {
          e.visual.object.visible = false;
          e.visible = false;
          if (e.plate) e.plate.visible = false;
        }
        continue;
      }
      if (!e.visible) {
        e.visual.object.visible = true;
        e.visible = true;
      }
      const fy = s.y - FOOT_OFFSET;
      e.feet.set(s.x, fy, s.z);
      e.centre.set(s.x, s.y, s.z);
      e.visual.object.position.copy(e.feet);
      e.vel.set(s.vx, s.vy, s.vz);
      e.grounded = s.grounded;
      e.speed = Math.hypot(s.vx, s.vz);

      const dist = this.tmp.copy(e.centre).distanceTo(this.camPos);
      e.dist = dist;
      const far: 0 | 1 | 2 = dist > this.lod2 ? 2 : dist > this.lod1 ? 1 : 0;
      const near: 0 | 1 | 2 =
        dist > this.lod2 * LOD_HYSTERESIS ? 2 : dist > this.lod1 * LOD_HYSTERESIS ? 1 : 0;
      const lod: 0 | 1 | 2 =
        e.info.id === this.source.localId ? 0 : far > e.lod ? far : near < e.lod ? near : e.lod;
      if (lod !== e.lod) {
        e.lod = lod;
        e.visual.setLod(lod);
      }

      const a = e.anim;
      if (a.state !== s.state) a.stateTime = 0;
      a.state = s.state;
      a.stateTime = s.stateTime;
      a.speed = e.speed;
      a.verticalSpeed = s.vy;
      a.facing = s.facing;
      a.grounded = s.grounded;
      a.emote =
        s.state === CharacterState.Emote && s.emote > 0 ? (e.loadout.emotes[s.emote - 1] ?? null) : null;
      a.ghost = isRespawnGhost(s);
      a.impulse = e.impulse;
      e.impulse = 0;
      e.visual.update(dt, a);

      vfx.setPlayerPosition(e.info.id, s.x, s.y, s.z);
      if (shadows < this.opts.preset.vfx.shadows && s.state !== CharacterState.Respawning) {
        vfx.setShadow(shadows++, s.x, fy, s.z, SHADOW_RADIUS);
      }
      e.trail?.update(s.x, fy + 0.5, s.z, dt);

      const audio = this.opts.audio;
      if (audio && (dist < FOOTSTEP_RANGE || e.info.id === this.source.localId)) {
        this.footPos.x = s.x;
        this.footPos.y = fy;
        this.footPos.z = s.z;
        const surface =
          s.flags & CharacterFlag.OnIce ? 'ice' : s.flags & CharacterFlag.InSlime ? 'slime' : 'normal';
        audio.stepFootstep(e.info.id, e.speed, s.grounded, surface, this.footPos, dt);
        const sliding = s.state === CharacterState.DiveSlide;
        if (sliding !== e.sliding && e.info.id === this.source.localId) {
          e.sliding = sliding;
          audio.setSliding(e.info.id, sliding, this.footPos);
        }
      }
    }
    vfx.setShadowCount(shadows);
    this.cullPlates();
    this.plates.update(camera);
  }

  private cullPlates(): void {
    let n = 0;
    for (const e of this.entries)
      if (e.plate && e.visible && e.dist >= PLATE_MIN_DIST && n < this.dists.length) this.dists[n++] = e.dist;
    const list = this.dists.subarray(0, n).sort();
    const limit = n > MAX_PLATES ? (list[MAX_PLATES - 1] as number) : Infinity;
    for (const e of this.entries) {
      if (e.plate)
        e.plate.visible = this.showPlates && e.visible && e.dist >= PLATE_MIN_DIST && e.dist <= limit;
    }
  }

  /** Releases trails and detaches visuals (they return to the pool). */
  dispose(): void {
    for (const e of this.entries) {
      e.trail?.release();
      e.plate?.dispose();
      if (e.sliding) this.opts.audio?.setSliding(e.info.id, false);
      e.visual.object.visible = true;
      e.visual.object.removeFromParent();
    }
    this.entries.length = 0;
    this.byId.clear();
    this.plates.dispose();
    this.crowd?.object.removeFromParent();
  }
}
