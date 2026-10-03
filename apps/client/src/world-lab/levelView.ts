import {
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
  type Mesh,
  type Object3D,
  type WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RoundDefinition } from '@tumble/shared';
import { getTheme, type Weather } from '@tumble/content/themes';
import type { ThemeId } from '@tumble/shared';
import { buildLevelVisuals, type LevelVisuals } from '@tumble/render/level';
import { createEnvironment, type Environment } from '@tumble/render/environment';
import { gradeFromTheme, type GradeParams } from '@tumble/render/post';
import type { QualityPreset } from '@tumble/render/quality';
import { TumblerActor, defaultLoadout, createPlaceholderTumbler, SceneState } from '@tumble/render/scenes';
import type { CreateTumblerVisual } from '@tumble/render/scenes';
import { createVfxSystem, type TrailHandle, type VfxSystem } from '@tumble/render/vfx';

/**
 * Lab view of a round: level visuals + environment + a few wandering
 * placeholder Tumblers (blob shadows and VFX anchors), orbit camera.
 */

const RUNNER_COLORS = ['#ff6fb5', '#5ce1e6', '#ffd23f', '#7c5cff', '#6ee7a8', '#ff8a3d'];

interface Runner {
  actor: TumblerActor;
  holder: Object3D;
  t: number;
  speed: number;
  lane: number;
  trail: TrailHandle | null;
}

export class LevelView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(55, 1, 0.1, 1500);
  readonly controls: OrbitControls;
  level: LevelVisuals | null = null;
  env: Environment | null = null;
  grade: GradeParams;
  readonly vfx: VfxSystem;
  readonly runners: Runner[] = [];
  private time = 0;
  private readonly ray = new Raycaster();
  private readonly down = new Vector3(0, -1, 0);
  private readonly probeOrigin = new Vector3();
  private solids: Mesh[] = [];
  private readonly ground = { y: 0, nx: 0, ny: 1, nz: 0 };

  constructor(
    private readonly round: RoundDefinition,
    renderer: WebGPURenderer,
    private readonly createTumbler: CreateTumblerVisual = createPlaceholderTumbler,
  ) {
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.camera.position.set(22, 18, -18);
    this.controls.target.set(0, 2, 24);
    this.grade = gradeFromTheme(getTheme('candy'));
    this.vfx = createVfxSystem({ groundProbe: (x, y, z, out) => this.probe(x, y, z, out) });
    this.scene.add(this.vfx.object);
  }

  /** Rebuilds level + environment for a theme/weather/preset. */
  build(themeId: ThemeId, weather: Weather, preset: QualityPreset): void {
    this.disposeWorld();
    const theme = getTheme(themeId);
    this.level = buildLevelVisuals(this.round, theme, { detail: preset.geometryDetail });
    this.scene.add(this.level.object);
    const b = this.level.bounds;
    this.env = createEnvironment(theme, {
      weather,
      courseBounds: { min: b.min, max: b.max },
      seed: this.round.decorSeed,
      detail: preset.environment,
      lighting: {
        shadows: preset.shadows,
        mapSize: preset.shadowMapSize,
        cascades: preset.cascades,
        shadowDistance: preset.shadowDistance,
      },
    });
    this.env.attach(this.scene);
    const level = this.level;
    this.env.onAtmosphere = (a): void => level.setNight(a.night);
    level.setNight(this.env.atmosphere.night);
    this.grade = gradeFromTheme(theme);
    this.vfx.setBudget(preset.vfx);
    this.solids = [];
    this.level.object.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.name.startsWith('level:')) this.solids.push(m);
    });

    if (this.runners.length === 0) {
      for (let i = 0; i < 6; i++) {
        const actor = new TumblerActor(
          this.createTumbler,
          defaultLoadout(RUNNER_COLORS[i % RUNNER_COLORS.length]),
        );
        actor.setState(SceneState.Run);
        actor.anim.speed = 5;
        const holder = actor.object;
        this.runners.push({
          actor,
          holder,
          t: i * 0.17,
          speed: 0.012 + i * 0.0015,
          lane: (i - 2.5) * 1.3,
          trail: i < 2 ? this.vfx.acquireTrail(i === 0 ? 'rainbow' : 'sparkle') : null,
        });
      }
    }
    for (const r of this.runners) this.scene.add(r.holder);
  }

  /** Ground height under (x, z) from the level meshes, or null over the void. */
  probe(x: number, y: number, z: number, out: { y: number; nx: number; ny: number; nz: number }): boolean {
    this.probeOrigin.set(x, y + 0.5, z);
    this.ray.set(this.probeOrigin, this.down);
    this.ray.far = 60;
    const hit = this.ray.intersectObjects(this.solids, false)[0];
    if (!hit) return false;
    out.y = hit.point.y;
    const n = hit.face?.normal;
    out.nx = n?.x ?? 0;
    out.ny = n?.y ?? 1;
    out.nz = n?.z ?? 0;
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    this.controls.update(dt);
    this.level?.update(this.time, dt);
    this.vfx.setShadowCount(this.runners.length);
    let i = 0;
    for (const r of this.runners) {
      r.t = (r.t + dt * r.speed) % 1;
      const z = -2 + r.t * 140;
      const x = r.lane + Math.sin(this.time * 0.8 + r.lane) * 1.2;
      const y = this.probe(x, 12, z, this.ground) ? this.ground.y : -20;
      r.holder.position.set(x, y, z);
      r.actor.anim.facing = 0;
      r.actor.update(dt);
      this.vfx.setPlayerPosition(i, x, y, z);
      this.vfx.setShadow(i, x, y, z, 0.55);
      r.trail?.update(x, y + 0.5, z, dt);
      i++;
    }
    this.vfx.update(dt, this.camera);
    this.env?.update(dt, this.camera, this.controls.target);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private disposeWorld(): void {
    this.level?.dispose();
    this.env?.dispose();
    this.level = null;
    this.env = null;
  }

  dispose(): void {
    this.disposeWorld();
    for (const r of this.runners) r.actor.dispose();
    this.vfx.dispose();
    this.runners.length = 0;
    this.controls.dispose();
  }
}
