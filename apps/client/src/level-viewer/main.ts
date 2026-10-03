/**
 * Level viewer: loads any registered round (`?round=<id>`), runs it in an
 * offline match sim with bots following the round's waypoint graph, and
 * renders it with the real level, environment and obstacle visuals.
 *
 * URL params: `round`, `bots` (default 20), `seed`, `stage`, `variation`,
 * `mutator`, `intro=1` (hold the round in its intro like a show does, so the
 * pre-roll obstacle clock is visible), `cam=orbit|flyover|follow`, `backend`,
 * `ts` (time scale).
 * Keys: O orbit · F flyover · L follow leader · N next bot · R restart.
 */
import { Clock, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getRound, ROUNDS } from '@tumble/content/rounds';
import { getTheme } from '@tumble/content/themes';
import { createRenderer, type BackendPreference } from '@tumble/render';
import { MeshBatcher } from '@tumble/render/batching';
import { createEnvironment, roundDressing, type Environment } from '@tumble/render/environment';
import { buildLevelVisuals, type LevelVisuals } from '@tumble/render/level';
import { getObstacleVisual, type ObstacleVisual } from '@tumble/render/obstacles';
import { createPlaceholderTumbler, defaultLoadout, type TumblerVisual } from '@tumble/render/scenes';
import { RoundPhase, Rng, SIM_DT, type RoundDefinition } from '@tumble/shared';
import {
  FixedStepper,
  loadRapier,
  type CharacterFullState,
  type CreateTumblerController,
  type ObstacleRuntime,
  type Rapier,
} from '@tumble/sim';
import {
  createMatchSim,
  createSimpleController,
  measureCourse,
  type MatchSimHandle,
} from '@tumble/sim/match';
import { OBSTACLE_REGISTRY } from '@tumble/sim/obstacles';
import { generateBotNames } from '@tumble/sim/bots';
import { StatsOverlay } from '../debug/stats.ts';
import { ObstacleClock, introPreRollSeconds } from '../game/round/obstacleClock.ts';

const COLORS = ['#ff6fb5', '#5ce1e6', '#ffd23f', '#7c5cff', '#6ee7a8', '#ff8a3d', '#ff4f8b', '#3fa9ff'];
const COUNTDOWN = 3;

/** Debug hooks for Playwright screenshots and level validation. */
interface LevelDebug {
  ready: boolean;
  roundId: string;
  warnings: readonly string[];
  setCamera(mode: CamMode, t?: number): void;
  status(): { time: number; qualified: number; target: number; eliminated: number; finished: boolean };
  /**
   * Per obstacle: a checksum of its visual's world matrices and of its colliders' poses.
   * Sampled twice, a moving collider whose visual checksum never changes is a frozen visual.
   */
  obstacleSignatures(): { id: string; type: string; visual: number; sim: number }[];
  /** Max progress along +Z reached by any bot, as a rough reachability signal. */
  furthestZ(): number;
}

type CamMode = 'orbit' | 'flyover' | 'follow';

declare global {
  interface Window {
    __level?: LevelDebug;
  }
}

/**
 * Picks the real controller once `@tumble/sim/character` exists; the simple
 * test controller keeps the viewer usable while that package is in progress.
 */
async function resolveController(): Promise<{ create: CreateTumblerController; name: string }> {
  const mods = import.meta.glob<{ createTumblerController?: CreateTumblerController }>(
    '../../../../packages/sim/src/character/index.ts',
  );
  const loader = Object.values(mods)[0];
  if (loader) {
    try {
      const m = await loader();
      if (m.createTumblerController) return { create: m.createTumblerController, name: 'tumbler' };
    } catch (err) {
      console.warn('[level] character controller failed to load, using simple controller', err);
    }
  }
  return { create: createSimpleController, name: 'simple (fallback)' };
}

/** Catmull-Rom sample through `pts` at u ∈ [0,1]. */
function catmull(pts: readonly { x: number; y: number; z: number }[], u: number, out: Vector3): Vector3 {
  const n = pts.length;
  if (n === 1) return out.set(pts[0]!.x, pts[0]!.y, pts[0]!.z);
  const f = Math.min(Math.max(u, 0), 1) * (n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  const t = f - i;
  const p0 = pts[Math.max(i - 1, 0)]!;
  const p1 = pts[i]!;
  const p2 = pts[i + 1]!;
  const p3 = pts[Math.min(i + 2, n - 1)]!;
  const t2 = t * t;
  const t3 = t2 * t;
  const c = (a: number, b: number, cc: number, d: number): number =>
    0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
  return out.set(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y), c(p0.z, p1.z, p2.z, p3.z));
}

class LevelSession {
  readonly scene = new Scene();
  readonly sim: MatchSimHandle;
  readonly level: LevelVisuals;
  readonly env: Environment;
  readonly obstacles: { visual: ObstacleVisual; runtime: ObstacleRuntime }[] = [];
  /** Same automatic instancing as the game's round view, so batched parts are checked here too. */
  readonly batcher = new MeshBatcher();
  private readonly clock: ObstacleClock;
  private introLeft: number;
  /** Sim warnings plus visual build failures. */
  readonly warnings: string[] = [];
  readonly tumblers = new Map<number, TumblerVisual>();
  readonly stepper: FixedStepper;
  private readonly st: CharacterFullState = {
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    angVel: { x: 0, y: 0, z: 0 },
    state: 0,
    stateTime: 0,
    facing: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
    prevButtons: 0,
    grabStamina: 0,
    grabTarget: -1,
    stunTimer: 0,
    ghostTimer: 0,
    emote: 0,
    flags: 0,
  };
  private wall = 0;
  furthest = -Infinity;

  constructor(
    R: Rapier,
    readonly round: RoundDefinition,
    create: CreateTumblerController,
    opts: { bots: number; seed: number; stage: number; variation?: string; mutator?: string; intro: boolean },
  ) {
    const theme = getTheme(round.theme);
    const names = generateBotNames(opts.bots, new Rng(opts.seed), new Set());
    const players = names.map((name, id) => ({
      id,
      name,
      isBot: true,
      team: round.qualification.teams > 0 ? id % round.qualification.teams : -1,
      botSkill: (['sharp', 'average', 'clumsy'] as const)[id % 3],
    }));
    this.sim = createMatchSim(
      {
        R,
        round,
        seed: opts.seed,
        stage: opts.stage,
        players,
        mode: 'offline',
        ...(opts.variation ? { variationId: opts.variation } : {}),
        ...(opts.mutator ? { mutatorId: opts.mutator } : {}),
      },
      { createController: create, obstacles: OBSTACLE_REGISTRY },
    ) as MatchSimHandle;
    this.clock = new ObstacleClock(introPreRollSeconds(round.flyover.duration));
    this.introLeft = opts.intro ? introPreRollSeconds(round.flyover.duration) : 0;
    this.sim.setPhase(
      opts.intro ? RoundPhase.IntroFlyover : RoundPhase.Countdown,
      opts.intro ? 0 : -COUNTDOWN,
    );
    this.warnings.push(...this.sim.warnings);

    this.env = createEnvironment(theme, {
      ...roundDressing(round, measureCourse(this.sim.round, this.sim.obstacleRuntimes)),
      seed: round.decorSeed,
    });
    this.env.attach(this.scene);
    this.level = buildLevelVisuals(round, theme);
    this.scene.add(this.level.object);

    const speedScale = this.sim.speedScale;
    for (const rt of this.sim.obstacleRuntimes) {
      const factory = getObstacleVisual(rt.instance.type);
      if (!factory) continue;
      try {
        const v = factory(rt.instance, { theme: round.theme, speedScale, seed: opts.seed });
        this.obstacles.push({ visual: v, runtime: rt });
        this.scene.add(v.object);
        this.batcher.add(v.object);
      } catch (err) {
        this.warnings.push(`visual ${rt.instance.id} (${rt.instance.type}): ${String(err)}`);
      }
    }

    this.batcher.build();
    this.scene.add(this.batcher.object);

    for (const p of players) {
      const v = createPlaceholderTumbler(defaultLoadout(COLORS[p.id % COLORS.length]));
      this.tumblers.set(p.id, v);
      this.scene.add(v.object);
    }

    this.stepper = new FixedStepper(() => this.sim.step(), SIM_DT);
  }

  update(dt: number): void {
    this.wall += dt;
    if (this.introLeft > 0) {
      this.introLeft -= dt;
      if (this.introLeft <= 0) this.sim.setPhase(RoundPhase.Countdown, -COUNTDOWN);
    }
    if (this.sim.phase === RoundPhase.Countdown && this.sim.time >= 0)
      this.sim.setPhase(RoundPhase.Playing, 0);
    this.stepper.advance(dt);
    this.sim.events.drain();

    for (const [id, v] of this.tumblers) {
      if (!this.sim.getPlayerState(id, this.st)) {
        v.object.visible = false;
        continue;
      }
      const s = this.st;
      v.object.visible = s.state !== 19 && s.state !== 15;
      v.object.position.set(s.pos.x, s.pos.y - 0.9, s.pos.z);
      v.object.rotation.set(0, s.facing, 0);
      v.update(dt, {
        state: s.state,
        stateTime: s.stateTime,
        speed: Math.hypot(s.vel.x, s.vel.z),
        verticalSpeed: s.vel.y,
        facing: s.facing,
        grounded: s.grounded,
        emote: null,
      });
      if (s.pos.y > this.round.killY + 1) this.furthest = Math.max(this.furthest, s.pos.z);
    }
    this.level.update(this.sim.time, dt);
  }

  /** Poses every obstacle visual on the same clock the game's round view uses. */
  updateObstacles(dt: number): void {
    const t = this.clock.time(this.sim.phase, this.sim.time, dt);
    for (const o of this.obstacles) o.visual.update(t, dt, o.runtime);
  }

  signatures(): { id: string; type: string; visual: number; sim: number }[] {
    return this.obstacles.map(({ visual, runtime }) => {
      let v = 0;
      visual.object.updateMatrixWorld(true);
      visual.object.traverse((o) => {
        const e = o.matrixWorld.elements;
        for (let i = 0; i < 16; i++) v += e[i]! * (i + 1);
      });
      let sum = 0;
      for (const c of runtime.colliders) {
        const t = c.translation();
        const r = c.rotation();
        sum += t.x + t.y * 3 + t.z * 7 + r.x * 11 + r.y * 13 + r.z * 17 + r.w * 19;
      }
      return { id: runtime.instance.id, type: runtime.instance.type, visual: v, sim: sum };
    });
  }

  leaderPosition(out: Vector3): Vector3 {
    const ids = this.sim.getStandings();
    for (const id of ids) {
      if (this.sim.getPlayerState(id, this.st)) return out.set(this.st.pos.x, this.st.pos.y, this.st.pos.z);
    }
    return out.set(0, 0, 0);
  }

  dispose(): void {
    this.batcher.dispose();
    for (const o of this.obstacles) o.visual.dispose();
    for (const v of this.tumblers.values()) v.dispose();
    this.level.dispose();
    this.env.dispose();
    this.sim.dispose();
  }
}

async function main(): Promise<void> {
  const hud = document.getElementById('hud')!;
  const params = new URLSearchParams(location.search);
  const roundId = params.get('round') ?? ROUNDS.find((r) => r.id !== 'test-arena')?.id ?? 'test-arena';
  const round = getRound(roundId);
  if (!round) {
    hud.textContent = `Unknown round "${roundId}". Registered: ${ROUNDS.map((r) => r.id).join(', ')}`;
    return;
  }

  const R = await loadRapier();
  const controller = await resolveController();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const { renderer, backend } = await createRenderer(
    canvas,
    (params.get('backend') ?? 'auto') as BackendPreference,
  );
  const stats = new StatsOverlay(document.body);
  stats.set('gpu', backend);
  stats.set('ctrl', controller.name);

  const opts = {
    bots: Number(params.get('bots') ?? 20),
    seed: Number(params.get('seed') ?? 7),
    stage: Number(params.get('stage') ?? 0),
    ...(params.get('variation') ? { variation: params.get('variation')! } : {}),
    ...(params.get('mutator') ? { mutator: params.get('mutator')! } : {}),
    intro: params.get('intro') === '1',
  };
  let session = new LevelSession(R, round, controller.create, opts);

  const camera = new PerspectiveCamera(55, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, canvas);
  const fly = round.flyover;
  const startPt = fly.path[0]!;
  camera.position.set(startPt.x, startPt.y, startPt.z);
  const look0 = fly.lookAt[0]!;
  controls.target.set(look0.x, look0.y, look0.z);

  let mode: CamMode = (params.get('cam') as CamMode) ?? 'orbit';
  let flyT = 0;
  const tmp = new Vector3();
  const tmp2 = new Vector3();

  const resize = (): void => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener('resize', resize);
  addEventListener('keydown', (e) => {
    if (e.key === 'o') mode = 'orbit';
    if (e.key === 'f') {
      mode = 'flyover';
      flyT = 0;
    }
    if (e.key === 'l') mode = 'follow';
    if (e.key === 'r') {
      session.dispose();
      session = new LevelSession(R, round, controller.create, opts);
    }
  });

  const timeScale = Number(params.get('ts') ?? 1);
  const clock = new Clock();
  const debug: LevelDebug = {
    ready: false,
    roundId,
    warnings: session.warnings,
    setCamera(m, t = 0) {
      mode = m;
      flyT = t;
    },
    status() {
      const s = session.sim.getStatus();
      return {
        time: s.time,
        qualified: s.qualifiedCount,
        target: s.qualifyTarget,
        eliminated: s.eliminatedCount,
        finished: s.finished,
      };
    },
    furthestZ: () => session.furthest,
    obstacleSignatures: () => session.signatures(),
  };
  window.__level = debug;

  let hudTimer = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1) * timeScale;
    session.update(dt);
    session.updateObstacles(dt);

    if (mode === 'flyover') {
      flyT += dt / fly.duration;
      if (flyT > 1) flyT = 0;
      catmull(fly.path, flyT, camera.position);
      const target =
        fly.lookAt.length > 1 ? catmull(fly.lookAt, flyT, tmp) : tmp.set(look0.x, look0.y, look0.z);
      camera.lookAt(target);
      controls.target.copy(target);
    } else if (mode === 'follow') {
      session.leaderPosition(tmp);
      tmp2.set(tmp.x, tmp.y + 7, tmp.z - 13);
      camera.position.lerp(tmp2, 1 - Math.pow(0.02, dt));
      controls.target.lerp(tmp, 1 - Math.pow(0.02, dt));
      camera.lookAt(controls.target);
    } else {
      controls.update();
    }

    session.env.update(dt, camera, controls.target);
    renderer.render(session.scene, camera);
    stats.update(dt, renderer);

    hudTimer -= dt;
    if (hudTimer <= 0) {
      hudTimer = 0.25;
      const s = session.sim.getStatus();
      const w = session.warnings;
      hud.textContent =
        `${round.name}  [${round.id}]  ${round.type} · ${round.theme}\n` +
        `phase ${s.phase}  t=${s.time.toFixed(1)}s  left ${s.timeLeft.toFixed(0)}s\n` +
        `qualified ${s.qualifiedCount}/${s.qualifyTarget}  eliminated ${s.eliminatedCount}  furthest z ${session.furthest.toFixed(1)}\n` +
        `variation ${session.sim.variationId ?? '—'}  cam ${mode} (O/F/L, R restart)\n` +
        (w.length ? `⚠ ${w.length} warnings:\n  ${w.slice(0, 8).join('\n  ')}` : 'no warnings');
    }
  });
  debug.ready = true;
}

main().catch((err: unknown) => {
  console.error(err);
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `Failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
});
