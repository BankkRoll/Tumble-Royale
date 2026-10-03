/**
 * Tumbler playground entry (`playground.html`).
 *
 * Responsibilities: boot Rapier + renderer, build the test course, run the
 * fixed-step sim (player + wandering bots) with render interpolation, drive
 * the camera rig and input system, and expose a live tuning/debug panel.
 */
import GUI from 'lil-gui';
import {
  CircleGeometry,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
} from 'three/webgpu';
import { float, smoothstep, uniform, uv } from 'three/tsl';
import { createRenderer, createSkyDome, type BackendPreference } from '@tumble/render';
import { ThirdPersonCamera, type CameraMode } from '@tumble/render/camera';
import { CollisionGroup, InteractionGroups, SIM_DT, groups, type Vec3 } from '@tumble/shared';
import { EventSink, FixedStepper, SurfaceRegistry, createWorld, loadRapier, type SimEvent } from '@tumble/sim';
import {
  CharacterFlag,
  CharacterState,
  TumblerController,
  emptyInput,
  type CharacterInput,
  type CharacterStepContext,
  type CharacterTuning,
} from '@tumble/sim/character';
import { InputSystem } from '../input/index.ts';
import { WanderBot } from './bots.ts';
import { PlaygroundCourse } from './course.ts';
import { PhysicsDebugDraw } from './debugDraw.ts';
import { PlaceholderTumbler, type CharacterVisual } from './placeholderVisual.ts';

const STATE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(CharacterState).map(([name, id]) => [id, name]),
);
const PLAYER_COLOR = '#ff6fb5';
const BOT_COLORS = ['#5ce1e6', '#ffd23f', '#7c5cff'];
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const EXCLUDE_SENSORS = 8;

/** One simulated Tumbler with its visual and interpolation buffers. */
interface Actor {
  ctrl: TumblerController;
  visual: CharacterVisual;
  shadow: Mesh;
  /** Opacity uniform of the blob shadow material. */
  shadowOpacity: { value: number };
  input: CharacterInput;
  bot: WanderBot | null;
  prevPos: Vector3;
  currPos: Vector3;
  prevRot: Quaternion;
  currRot: Quaternion;
  /** Squash/stretch kick accumulated from events since the last frame. */
  impulse: number;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const R = await loadRapier();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const { renderer, backend } = await createRenderer(canvas, (params.get('backend') ?? 'auto') as BackendPreference);

  // ---------------------------------------------------------------------------
  // Scene
  // ---------------------------------------------------------------------------
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 700);
  scene.add(createSkyDome(undefined, 500));
  scene.fog = new Fog(new Color('#ffd6f2'), 90, 320);
  scene.add(new HemisphereLight('#dff1ff', '#ffc9e6', 1.35));
  const sun = new DirectionalLight('#fff3dc', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -28;
  sc.right = 28;
  sc.top = 28;
  sc.bottom = -28;
  sc.near = 1;
  sc.far = 120;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------
  const world = createWorld(R);
  const surfaces = new SurfaceRegistry();
  const events = new EventSink();
  const course = new PlaygroundCourse(R, world, surfaces);
  scene.add(course.group);

  const byCollider = new Map<number, TumblerController>();
  const ctx: CharacterStepContext = {
    R,
    world,
    dt: SIM_DT,
    tick: 0,
    time: 0,
    surfaces,
    events,
    controllerByCollider: (h) => byCollider.get(h),
    propIdByCollider: (h) => course.propIdByCollider(h),
  };

  const shadowGeo = new CircleGeometry(0.55, 32);
  const actors: Actor[] = [];
  const addActor = (feet: Vec3, yaw: number, color: string, bot: WanderBot | null): Actor => {
    const ctrl = new TumblerController({ R, world, id: actors.length, position: feet, yaw });
    byCollider.set(ctrl.collider.handle, ctrl);
    const visual = new PlaceholderTumbler(color);
    scene.add(visual.object);
    const shadowOpacity = uniform(0.4);
    const sm = new MeshBasicNodeMaterial({ color: new Color('#2b1d3a'), transparent: true, depthWrite: false });
    sm.opacityNode = shadowOpacity.mul(float(1).sub(smoothstep(0.18, 0.5, uv().sub(0.5).length())));
    const shadow = new Mesh(shadowGeo, sm);
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 5;
    scene.add(shadow);
    const p = ctrl.body.translation();
    const a: Actor = {
      ctrl,
      visual,
      shadow,
      shadowOpacity,
      input: emptyInput(),
      bot,
      prevPos: new Vector3(p.x, p.y, p.z),
      currPos: new Vector3(p.x, p.y, p.z),
      prevRot: new Quaternion(),
      currRot: new Quaternion(),
      impulse: 0,
    };
    actors.push(a);
    return a;
  };

  const player = addActor(course.spawn, course.spawnYaw, PLAYER_COLOR, null);
  const botHome = { x: 0, y: 0, z: -6 };
  BOT_COLORS.forEach((c, i) => {
    addActor({ x: -3 + i * 3, y: 0, z: -9 }, Math.PI, c, new WanderBot(1234 + i * 77, botHome, 6));
  });

  // Live tuning shared by every Tumbler: the panel edits the player's copy and mirrors it to bots.
  const tuning: CharacterTuning = player.ctrl.tuning;
  const syncTuning = (): void => {
    for (const a of actors) {
      if (a === player) continue;
      const t = a.ctrl.tuning;
      Object.assign(t, { ...tuning, surfaces: t.surfaces });
      for (const k of Object.keys(tuning.surfaces) as (keyof CharacterTuning['surfaces'])[]) {
        Object.assign(t.surfaces[k], tuning.surfaces[k]);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Camera & input
  // ---------------------------------------------------------------------------
  const camBall = new R.Ball(0.2);
  const camGroups = groups(0xffff, CollisionGroup.Static | CollisionGroup.KinematicObstacle);
  const rig = new ThirdPersonCamera(camera, {
    yaw: course.spawnYaw,
    collide: (o, d, max) => {
      const hit = world.castShape(o, IDENTITY, d, camBall, 0, max, false, EXCLUDE_SENSORS, camGroups);
      return hit ? hit.time_of_impact : max;
    },
  });
  const input = new InputSystem({ element: canvas });
  canvas.addEventListener('click', () => {
    const hint = document.getElementById('hint');
    if (hint) hint.style.opacity = '0';
  });

  // ---------------------------------------------------------------------------
  // Fixed step
  // ---------------------------------------------------------------------------
  const debugDraw = new PhysicsDebugDraw();
  scene.add(debugDraw.object);
  const feet = { x: 0, y: 0, z: 0 };

  const respawn = (a: Actor): void => {
    const i = actors.indexOf(a);
    const offset = a === player ? 0 : (i - 2) * 1.5;
    a.ctrl.teleport({ x: course.spawn.x + offset, y: course.spawn.y + 0.05, z: course.spawn.z }, course.spawnYaw);
    a.ctrl.setGhost(true, 1);
    snapActor(a);
    events.push({ type: 'respawn', player: a.ctrl.id, pos: { ...course.spawn } });
    if (a === player) {
      rig.yaw = course.spawnYaw;
      a.ctrl.getFeet(feet);
      rig.snapTo({ position: feet, velocity: { x: 0, y: 0, z: 0 }, grounded: false });
    }
  };

  const snapActor = (a: Actor): void => {
    const p = a.ctrl.body.translation();
    const r = a.ctrl.body.rotation();
    a.currPos.set(p.x, p.y, p.z);
    a.prevPos.copy(a.currPos);
    a.currRot.set(r.x, r.y, r.z, r.w);
    a.prevRot.copy(a.currRot);
  };

  const onEvent = (e: SimEvent): void => {
    if (!('player' in e)) return;
    const a = actors[e.player];
    if (!a) return;
    const isPlayer = a === player;
    switch (e.type) {
      case 'jump':
        a.impulse += 0.32;
        break;
      case 'land':
        a.impulse -= Math.min(0.45, e.impact * 0.028);
        if (isPlayer && e.impact > 16) rig.addTrauma(0.18);
        break;
      case 'dive':
        a.impulse += 0.15;
        if (isPlayer) rig.kickFov(7);
        break;
      case 'bounce':
        a.impulse += 0.5;
        if (isPlayer) rig.kickFov(5);
        break;
      case 'stun':
        if (isPlayer) rig.addTrauma(0.45 + Math.min(0.3, e.strength * 0.015));
        break;
      default:
        break;
    }
  };

  const fixedStep = (tick: number): void => {
    ctx.tick = tick;
    ctx.time = tick * SIM_DT;
    course.setNextPoses((tick + 1) * SIM_DT);
    input.sample(rig.yaw, player.input);
    for (const a of actors) {
      if (a.bot) a.bot.think(SIM_DT, a.ctrl.getFeet(feet), a.input);
      a.prevPos.copy(a.currPos);
      a.prevRot.copy(a.currRot);
    }
    for (const a of actors) a.ctrl.step(a.input, ctx);
    world.step();
    for (const a of actors) a.ctrl.postStep(ctx);
    for (const a of actors) {
      const p = a.ctrl.body.translation();
      const r = a.ctrl.body.rotation();
      a.currPos.set(p.x, p.y, p.z);
      a.currRot.set(r.x, r.y, r.z, r.w);
      if (p.y < course.killY) respawn(a);
    }
    for (const e of events.drain()) onEvent(e);
  };
  const stepper = new FixedStepper(fixedStep);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) respawn(player);
  });

  // ---------------------------------------------------------------------------
  // Debug panel
  // ---------------------------------------------------------------------------
  const settings = {
    timeScale: 1,
    physicsWireframe: false,
    readout: true,
    cameraMode: 'orbit' as Exclude<CameraMode, 'flyover'>,
    frozen: false,
    respawn: (): void => respawn(player),
    knockMe: (): void => player.ctrl.knock({ x: Math.sin(player.ctrl.facing) * -8, y: 6, z: Math.cos(player.ctrl.facing) * -8 }, true),
    ghost: (): void => player.ctrl.setGhost(true, 3),
    flyover: (): void =>
      rig.playFlyover({
        points: [
          { x: -40, y: 22, z: -30 },
          { x: -10, y: 14, z: 5 },
          { x: 30, y: 16, z: 30 },
          { x: 10, y: 25, z: 75 },
          { x: 0, y: 10, z: -24 },
        ],
        lookAts: [
          { x: 0, y: 0, z: 0 },
          { x: -20, y: 2, z: 10 },
          { x: 16, y: 3, z: 22 },
          { x: 0, y: 2, z: 60 },
          { x: 0, y: 1, z: -13 },
        ],
        duration: 9,
      }),
    backend: params.get('backend') ?? 'auto',
  };
  const gui = new GUI({ title: 'Tumbler playground' });
  const dbg = gui.addFolder('Debug');
  dbg.add(settings, 'timeScale', 0.05, 2, 0.05).name('Time scale');
  dbg.add(settings, 'physicsWireframe').name('Physics wireframe').onChange((v: boolean) => (debugDraw.enabled = v));
  dbg.add(settings, 'readout').name('State readout');
  dbg.add(settings, 'frozen').name('Frozen (start gate)').onChange((v: boolean) => player.ctrl.setFrozen(v));
  dbg.add(settings, 'respawn').name('Respawn (R)');
  dbg.add(settings, 'knockMe').name('Knock me (stun)');
  dbg.add(settings, 'ghost').name('Ghost 3 s');
  dbg
    .add(settings, 'backend', ['auto', 'webgpu', 'webgl'])
    .name('GPU backend')
    .onChange((v: string) => {
      params.set('backend', v);
      location.search = params.toString();
    });

  const cam = gui.addFolder('Camera');
  cam
    .add(settings, 'cameraMode', ['orbit', 'sideFixed', 'topDownTilt', 'spectate', 'orbitAround'])
    .name('Mode')
    .onChange((m: Exclude<CameraMode, 'flyover'>) => rig.setMode(m));
  cam.add(settings, 'flyover').name('Play flyover');
  const cs = rig.settings;
  cam.add(cs, 'distance', 3, 16, 0.1);
  cam.add(cs, 'pivotHeight', 0.5, 3, 0.05);
  cam.add(cs, 'followHalfLife', 0, 0.3, 0.005);
  cam.add(cs, 'verticalHalfLife', 0, 0.5, 0.01);
  cam.add(cs, 'jumpAllowance', 0, 5, 0.1);
  cam.add(cs, 'lookAheadTime', 0, 0.6, 0.01);
  cam.add(cs, 'autoRecenter');
  cam.add(cs, 'recenterDelay', 0, 5, 0.1);
  cam.add(cs, 'recenterSpeed', 0, 5, 0.1);
  cam.add(cs, 'fov', 40, 90, 1);
  cam.add(cs, 'fovSpeedKick', 0, 20, 0.5);
  cam.add(cs, 'shakeScale', 0, 1, 0.05).name('shake (accessibility)');
  cam.close();

  const inp = gui.addFolder('Input');
  inp.add(input.settings, 'sensitivity', 0.1, 3, 0.05);
  inp.add(input.settings, 'invertY');
  inp.add(input.settings, 'mouseRadPerPixel', 0.0005, 0.006, 0.0001);
  inp.add(input.settings, 'gamepadLookSpeed', 0.5, 6, 0.1);
  inp.add(input.settings, 'stickDeadzone', 0, 0.5, 0.01);
  inp.close();

  buildTuningPanel(gui.addFolder('Tumbler tuning (live)'), tuning, syncTuning);
  if (params.get('gui') === '0') gui.hide();

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------
  const readout = document.getElementById('readout') as HTMLDivElement;
  let readoutTimer = 0;
  let fps = 60;
  const vel = { x: 0, y: 0, z: 0 };
  const lerpPos = new Vector3();
  const lerpRot = new Quaternion();
  const followPos = { x: 0, y: 0, z: 0 };
  const shadowRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  const spectateTarget = actors[1]!;

  const resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  let last = performance.now();
  let elapsed = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;
    const scaled = dt * settings.timeScale;
    elapsed += scaled;

    stepper.advance(scaled);
    const alpha = stepper.alpha;
    const renderTime = (stepper.tick - 1 + alpha) * SIM_DT;
    course.syncVisuals(Math.max(0, renderTime), elapsed);

    const look = input.readLook(dt);
    rig.addLook(look.yaw, look.pitch);

    for (const a of actors) {
      lerpPos.lerpVectors(a.prevPos, a.currPos, alpha);
      lerpRot.slerpQuaternions(a.prevRot, a.currRot, alpha);
      const t = a.ctrl.tuning;
      const foot = t.halfHeight + t.radius;
      a.visual.object.position.set(lerpPos.x, lerpPos.y - foot, lerpPos.z);
      a.ctrl.getVelocity(vel);
      const ghost = (a.ctrl.characterFlags & CharacterFlag.Ghost) !== 0;
      a.visual.object.visible = !ghost || Math.floor(elapsed * 12) % 2 === 0;
      a.visual.update(dt, {
        state: a.ctrl.state,
        stateTime: a.ctrl.stateTime,
        speed: Math.hypot(vel.x, vel.z),
        verticalSpeed: vel.y,
        facing: a.ctrl.facing,
        grounded: a.ctrl.grounded,
        emote: a.ctrl.emote ? String(a.ctrl.emote) : null,
        impulse: a.impulse,
        tumble: lerpRot,
      });
      a.impulse = 0;
      updateBlobShadow(a, lerpPos, foot);
    }

    const followed = settings.cameraMode === 'spectate' ? spectateTarget : player;
    followed.ctrl.getVelocity(vel);
    const fp = followed === player ? player : followed;
    lerpPos.lerpVectors(fp.prevPos, fp.currPos, alpha);
    const ft = fp.ctrl.tuning;
    followPos.x = lerpPos.x;
    followPos.y = lerpPos.y - ft.halfHeight - ft.radius;
    followPos.z = lerpPos.z;
    rig.update(dt, { position: followPos, velocity: vel, grounded: fp.ctrl.grounded });

    sun.position.set(followPos.x + 18, followPos.y + 30, followPos.z + 12);
    sun.target.position.set(followPos.x, followPos.y, followPos.z);

    debugDraw.update(world);

    readoutTimer -= dt;
    if (readoutTimer <= 0) {
      readoutTimer = 0.1;
      readout.style.display = settings.readout ? 'block' : 'none';
      if (settings.readout) readout.textContent = describe(player.ctrl, fps, backend, input.lastDevice);
    }
    renderer.render(scene, camera);
  });

  function updateBlobShadow(a: Actor, center: Vector3, foot: number): void {
    shadowRay.origin.x = center.x;
    shadowRay.origin.y = center.y - foot + 0.1;
    shadowRay.origin.z = center.z;
    const hit = world.castRay(shadowRay, 40, true, EXCLUDE_SENSORS, InteractionGroups.groundQuery, a.ctrl.collider);
    if (!hit) {
      a.shadow.visible = false;
      return;
    }
    const h = hit.timeOfImpact - 0.1;
    a.shadow.visible = true;
    a.shadow.position.set(center.x, shadowRay.origin.y - hit.timeOfImpact + 0.025, center.z);
    const k = Math.min(1, Math.max(0, h) / 8);
    a.shadow.scale.setScalar(1 - k * 0.5);
    a.shadowOpacity.value = 0.42 * (1 - k * 0.7);
  }

  // Console / automation hook; not part of any public API.
  (window as unknown as { __playground?: unknown }).__playground = {
    player: player.ctrl,
    actors: actors.map((a) => a.ctrl),
    world,
    rig,
    input,
    stepper,
    course,
    respawn: () => respawn(player),
  };

  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.style.opacity = '0';
    setTimeout(() => bootEl.remove(), 450);
  }
}

/** Multi-line state readout for the overlay. */
function describe(c: TumblerController, fps: number, backend: string, device: string): string {
  const v = c.getVelocity({ x: 0, y: 0, z: 0 });
  const d = c.debug;
  const flags: string[] = [];
  for (const [name, bit] of Object.entries(CharacterFlag)) if (c.characterFlags & bit) flags.push(name);
  return (
    `FPS     ${fps.toFixed(0)}  (${backend}, ${device})\n` +
    `state   ${STATE_NAMES[c.state] ?? c.state}  ${c.stateTime.toFixed(2)}s\n` +
    `ground  ${c.grounded ? 'yes' : 'no '}  ${d.surface}  gap ${Number.isFinite(d.gap) ? d.gap.toFixed(3) : '—'}\n` +
    `speed   ${d.planarSpeed.toFixed(2)} m/s  vy ${v.y.toFixed(2)}\n` +
    `vel     ${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}\n` +
    `support ${d.supportVel.x.toFixed(2)}, ${d.supportVel.y.toFixed(2)}, ${d.supportVel.z.toFixed(2)}\n` +
    `normal  ${d.groundNormal.x.toFixed(2)}, ${d.groundNormal.y.toFixed(2)}, ${d.groundNormal.z.toFixed(2)}\n` +
    `stamina ${(c.stamina * 100).toFixed(0)}%  grab ${c.grabTargetId}  impact ${d.lastImpact.toFixed(1)}\n` +
    `flags   ${flags.join(' ') || '—'}`
  );
}

/** Ranges for tuning sliders, keyed by field name; anything else gets [0, 3×default]. */
const RANGES: Partial<Record<keyof CharacterTuning, [number, number, number]>> = {
  maxSlopeDeg: [10, 80, 1],
  jumpCutMultiplier: [0, 1, 0.01],
  knockControlMul: [0, 1, 0.01],
  reachSpeedMul: [0, 1, 0.01],
  grabberSpeedMul: [0, 1, 0.01],
  grabbedSpeedMul: [0, 1, 0.01],
  carrySpeedMul: [0, 1, 0.01],
  ledgeReachMin: [-1.5, 1, 0.01],
  stunFriction: [0, 2, 0.01],
};

const GROUPS: [string, (keyof CharacterTuning)[]][] = [
  ['Locomotion', ['maxSpeed', 'groundAccel', 'groundDecel', 'turnAccel', 'airAccel', 'airDecel', 'airOverspeedDrag', 'turnSpeed', 'airTurnSpeed', 'runThreshold', 'carryHalfLife', 'pushHalfLife']],
  ['Ground', ['maxSlopeDeg', 'groundEpsilon', 'snapDistance', 'stepHeight']],
  ['Jump', ['jumpSpeed', 'coyoteTime', 'jumpBufferTime', 'jumpCutMultiplier', 'riseGravityScale', 'fallGravityScale', 'apexGravityScale', 'apexThreshold', 'maxFallSpeed']],
  ['Dive', ['diveSpeed', 'diveBoost', 'diveMaxSpeed', 'diveUpSpeed', 'diveAirUpSpeed', 'diveGravityScale', 'diveSteer', 'slideFriction', 'slideSteer', 'slideMinTime', 'slideMaxTime', 'slideStopSpeed', 'getUpTime']],
  ['Stun', ['stunImpactThreshold', 'knockStunThreshold', 'stunMinTime', 'stunMaxTime', 'stunMaxStrength', 'stunSpin', 'stunFriction', 'stunRecoverTime', 'knockControlTime', 'knockControlMul', 'diveHitThreshold', 'hazardStunStrength']],
  ['Grab', ['grabRange', 'grabRadius', 'grabHoldDistance', 'grabPull', 'grabMaxPull', 'grabStaminaTime', 'grabStaminaRegen', 'grabCooldown', 'reachSpeedMul', 'grabberSpeedMul', 'grabbedSpeedMul', 'breakFreeMashes', 'breakFreeDecay', 'carrySpeedMul', 'carryDistance', 'carryHeight']],
  ['Ledges', ['ledgeReachMin', 'ledgeReachMax', 'ledgeProbe', 'ledgeHangOffset', 'ledgeClimbTime', 'autoLedgeGrab', 'ledgeMaxRiseSpeed']],
  ['Bounce & emote', ['bounceSpeed', 'bounceCooldown', 'emoteTime', 'emoteCancelInput', 'slideSurfaceMaxSpeed']],
];

/** Builds lil-gui controls for every tuning field, editing `tuning` in place. */
function buildTuningPanel(folder: GUI, tuning: CharacterTuning, onChange: () => void): void {
  const t = tuning as unknown as Record<string, number | boolean>;
  for (const [title, keys] of GROUPS) {
    const f = folder.addFolder(title);
    for (const key of keys) {
      const value = t[key];
      if (typeof value === 'boolean') {
        f.add(t, key).onChange(onChange);
      } else if (typeof value === 'number') {
        const [min, max, step] = RANGES[key] ?? [0, Math.max(1, Math.abs(value) * 3), Math.abs(value) >= 10 ? 0.5 : 0.01];
        f.add(t, key, min, max, step).onChange(onChange);
      }
    }
    f.close();
  }
  const sf = folder.addFolder('Surfaces');
  for (const [kind, s] of Object.entries(tuning.surfaces)) {
    const k = sf.addFolder(kind);
    for (const field of Object.keys(s) as (keyof typeof s)[]) k.add(s, field, 0, 2, 0.01).onChange(onChange);
    k.close();
  }
  sf.close();
  folder.close();
}

boot().catch((err: unknown) => {
  console.error(err);
  const el = document.getElementById('boot');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
