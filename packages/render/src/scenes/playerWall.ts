import type { BufferGeometry } from 'three/webgpu';
import {
  BufferAttribute,
  Color,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SpotLight,
  Vector3,
  type Material,
  type Node,
} from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { float, fract, instanceIndex, smoothstep, uniform, vec3 } from 'three/tsl';
import type { TumblerLoadout } from '../character/types.ts';
import { createLevelMaterial, createLevelUniforms } from '../level/materials.ts';
import { createVfxSystem } from '../vfx/index.ts';
import type { VfxSystem } from '../vfx/types.ts';
import type { PostPipeline } from '../post/pipeline.ts';
import { NameplateSet } from './nameplates.ts';
import { CameraShake, createCrownMesh, createLightBeam, createTextBanner, type LightBeam } from './props.ts';
import {
  SceneState,
  TumblerActor,
  createSceneStage,
  measureHeadHeight,
  tumblerFactory,
  type MenuScene,
  type SceneCommonOptions,
} from './common.ts';

/**
 * THE PLAYER WALL — the end-of-show signature moment.
 *
 * A giant candy-striped stadium wall floating in the sky, one cubby per player
 * of the show. The recap plays round by round: the round title flips onto the
 * header banner, the eliminated cubbies blink red, then their floors kick open
 * and those Tumblers are flung out in staggered, spinning ballistic arcs and
 * vanish into poof balloons below. When only the winner remains: lights dim,
 * a spotlight and gold glow find them, the wall shakes, the Crown descends onto
 * their head, fireworks and confetti fire and the camera pushes in.
 *
 * Choreography is a precomputed timeline of actions (built once per recap), so
 * `skip()` can jump to the end deterministically and the hot loop never allocates.
 */

/** A player shown on the wall. */
export interface PlayerWallPlayer {
  id: string;
  name: string;
  loadout: TumblerLoadout;
}

/** One round of the recap. */
export interface PlayerWallRound {
  /** Round display name ("Gumdrop Gauntlet"). */
  name: string;
  /** Players eliminated in this round, in drop order. */
  eliminatedIds: readonly string[];
}

/** Recap input. */
export interface PlayerWallSummary {
  players: readonly PlayerWallPlayer[];
  rounds: readonly PlayerWallRound[];
  /** Winner, or null for a show with no single winner (everyone left over is crowned together). */
  winnerId: string | null;
}

/** Timing hooks for UI overlays and audio. */
export interface PlayerWallCallbacks {
  /** Round title moment begins (show your overlay / play the sting). */
  onRoundStart?(index: number, round: PlayerWallRound): void;
  /** A Tumbler's floor just dropped. */
  onEliminate?(id: string, roundIndex: number): void;
  /** The Crown lands. */
  onWinner?(id: string): void;
  /** Recap finished (or skipped). */
  onDone?(): void;
}

/**
 * One beat of an externally scheduled recap (see {@link PlayerWallScene.beat}).
 * The UI's `playerWallTimeline` maps onto these one to one, so the 3D wall
 * lands every banner, drop and crown exactly when the overlay does.
 */
export type PlayerWallBeat =
  | { type: 'intro' }
  | { type: 'round'; roundIndex: number }
  | { type: 'flash'; roundIndex: number; ids: readonly string[] }
  | { type: 'drop'; roundIndex: number; id: string; order: number }
  | { type: 'roundEnd'; roundIndex: number }
  | { type: 'winnerFocus' }
  | { type: 'crown' }
  | { type: 'reveal' }
  | { type: 'end' };

/** Options for {@link createPlayerWallScene}. */
export interface PlayerWallOptions extends SceneCommonOptions {
  /** Cubby capacity; the grid is sized for it. Default 40 (8 × 5). */
  capacity?: number;
  /** Crown resting height above a Tumbler's feet. Default: measured from the winner's bounds. */
  crownHeight?: number;
  /** Header title shown before the first round. Default "SHOW RECAP". */
  title?: string;
}

/** Player wall handle. */
export interface PlayerWallScene extends MenuScene {
  /**
   * Populates the wall and plays the recap.
   *
   * @param summary - Players, rounds and the winner.
   * @param callbacks - Timing hooks.
   */
  playRecap(summary: PlayerWallSummary, callbacks?: PlayerWallCallbacks): void;
  /**
   * Populates the wall without its built-in schedule; the integrator drives
   * the recap with {@link beat} (e.g. from the UI's wall timeline).
   */
  startDrivenRecap(summary: PlayerWallSummary, callbacks?: PlayerWallCallbacks): void;
  /** Plays one beat of a driven recap. */
  beat(b: PlayerWallBeat): void;
  /** Jumps to the final crowned state (fires any pending `onWinner`, then `onDone`). */
  skip(): void;
  /** True while a recap is running. */
  readonly playing: boolean;
  /** Lets the scene punch/flash/vignette through the post pipeline. */
  attachPost(post: Pick<PostPipeline, 'punch' | 'flash' | 'setFocusVignette'> | null): void;
  /** The VFX system living in this scene. */
  readonly vfx: VfxSystem;
}

const CW = 2.3;
const CH = 2.7;
const CD = 1.9;
const FLOOR_T = 0.24;
const FRAME = 0.9;
const BASE_Y = 0;
const GRAVITY = -22;
const TILT = 0.55;

type CubbyState = 'empty' | 'idle' | 'blink' | 'falling' | 'gone' | 'winner';

interface Cubby {
  index: number;
  center: Vector3;
  floorY: number;
  holder: Group;
  actor: TumblerActor | null;
  state: CubbyState;
  doorAngle: number;
  doorTarget: number;
  blinkTime: number;
  vel: Vector3;
  spin: Vector3;
  fallTime: number;
  poofed: boolean;
  playerId: string;
}

interface TimelineAction {
  at: number;
  run: () => void;
  /** Whether `skip()` must still execute this action (state changes, callbacks). */
  essential: boolean;
}

function painted(geo: BufferGeometry, hex: string): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes))
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(arr, 3));
  return g;
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  hex: string,
  r = 0.08,
): BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, Math.min(w, h, d) * 0.45));
  g.translate(x, y, z);
  return painted(g, hex);
}

/**
 * Builds the player wall scene.
 *
 * @param opts - Theme, capacity and optional Tumbler factory.
 * @example
 * const wall = createPlayerWallScene({ theme: getTheme('candy'), createTumbler });
 * wall.attachPost(post);
 * wall.playRecap(summary, { onRoundStart: (i, r) => ui.showRound(r.name), onDone: () => ui.next() });
 */
export function createPlayerWallScene(opts: PlayerWallOptions): PlayerWallScene {
  const capacity = Math.max(1, opts.capacity ?? 40);
  const cols = capacity <= 40 ? 8 : 10;
  const rows = Math.ceil(capacity / cols);
  const innerW = cols * CW;
  const innerH = rows * CH;
  const wallW = innerW + FRAME * 2;
  const wallH = innerH + FRAME * 2;
  let crownHeight = opts.crownHeight ?? 1.45;
  const pal = opts.theme.palette;

  const stage = createSceneStage(
    opts,
    { min: { x: -wallW / 2 - 6, y: -4, z: -CD - 4 }, max: { x: wallW / 2 + 6, y: wallH + 6, z: 10 } },
    { crowd: false, fov: 38 },
  );
  const { scene, camera } = stage;
  const factory = tumblerFactory(opts.createTumbler);
  const vfx = createVfxSystem({ voidStyle: opts.theme.void.style });
  scene.add(vfx.object);

  // ---------------------------------------------------------------------------
  // Static wall geometry (2 draws: plain + candy-striped frame)
  // ---------------------------------------------------------------------------
  const levelU = createLevelUniforms(opts.theme);
  const plainParts: BufferGeometry[] = [];
  const stripeParts: BufferGeometry[] = [];
  const x0 = -innerW / 2;
  const y0 = BASE_Y + FRAME;

  plainParts.push(box(wallW, wallH, 0.5, 0, BASE_Y + wallH / 2, -CD - 0.25, pal.structure, 0.2));
  for (let c = 0; c <= cols; c++) {
    plainParts.push(box(0.24, innerH, CD, x0 + c * CW, y0 + innerH / 2, -CD / 2, pal.trim, 0.06));
  }
  for (let r = 0; r <= rows; r++) {
    // Sits 2 cm under the floor line so it never z-fights the trapdoor tops.
    plainParts.push(box(innerW, 0.3, 0.32, 0, y0 + r * CH - 0.17, -0.1, pal.neutral, 0.1));
  }
  stripeParts.push(box(wallW, FRAME, 1.1, 0, BASE_Y + FRAME / 2, 0, pal.primary, 0.3));
  stripeParts.push(box(wallW, FRAME, 1.1, 0, BASE_Y + wallH - FRAME / 2, 0, pal.primary, 0.3));
  stripeParts.push(box(FRAME, wallH, 1.1, -wallW / 2 + FRAME / 2, BASE_Y + wallH / 2, 0, pal.primary, 0.3));
  stripeParts.push(box(FRAME, wallH, 1.1, wallW / 2 - FRAME / 2, BASE_Y + wallH / 2, 0, pal.primary, 0.3));
  plainParts.push(box(wallW + 3, 1.6, CD + 3.4, 0, BASE_Y - 0.8, -CD / 2 + 0.6, pal.secondary, 0.4));
  plainParts.push(box(wallW + 1.6, 1.4, CD + 2, 0, BASE_Y - 2.2, -CD / 2 + 0.3, pal.structure, 0.4));
  for (const sx of [-1, 1]) {
    stripeParts.push(
      box(1.4, wallH + 3, 1.4, sx * (wallW / 2 + 0.9), BASE_Y + (wallH + 3) / 2, 0.1, pal.secondary, 0.5),
    );
  }

  const plainMat = createLevelMaterial(levelU, { surface: 'normal', pattern: 'none' });
  const stripeMat = createLevelMaterial(levelU, { surface: 'normal', pattern: 'stripes' });
  const plainGeo = mergeGeometries(plainParts)!;
  const stripeGeo = mergeGeometries(stripeParts)!;
  for (const g of [...plainParts, ...stripeParts]) g.dispose();
  const wallPlain = new Mesh(plainGeo, plainMat);
  const wallStripe = new Mesh(stripeGeo, stripeMat);
  const wall = new Group();
  wall.name = 'player-wall';
  for (const m of [wallPlain, wallStripe]) {
    m.castShadow = true;
    m.receiveShadow = true;
    wall.add(m);
  }
  scene.add(wall);

  // ---------------------------------------------------------------------------
  // Cubby lights, trapdoors, marquee bulbs (1 draw each)
  // ---------------------------------------------------------------------------
  const lightGeo = new PlaneGeometry(CW - 0.3, CH - 0.35);
  const lightMat = new MeshBasicNodeMaterial();
  const lights = new InstancedMesh(lightGeo, lightMat, capacity);
  lights.name = 'wall-cubby-lights';
  wall.add(lights);
  const doorGeo = new RoundedBoxGeometry(CW - 0.26, FLOOR_T, CD - 0.1, 2, 0.06);
  // Hinge on the back edge: shift so the pivot sits at local z = 0.
  doorGeo.translate(0, -FLOOR_T / 2, (CD - 0.1) / 2);
  const doorMat = createLevelMaterial(levelU, { surface: 'normal', pattern: 'checker' });
  const doorColor = painted(doorGeo, pal.neutral);
  const doors = new InstancedMesh(doorColor, doorMat, capacity);
  doors.castShadow = true;
  doors.receiveShadow = true;
  doors.name = 'wall-trapdoors';
  wall.add(doors);

  const bulbPositions: Vector3[] = [];
  const perimeter = 2 * (wallW + wallH);
  const bulbCount = Math.round(perimeter / 0.75);
  for (let i = 0; i < bulbCount; i++) {
    let d = (i / bulbCount) * perimeter;
    const p = new Vector3(0, 0, 0.6);
    if (d < wallW) p.set(-wallW / 2 + d, BASE_Y + wallH - FRAME / 2, 0.58);
    else if ((d -= wallW) < wallH) p.set(wallW / 2 - FRAME / 2, BASE_Y + wallH - d, 0.58);
    else if ((d -= wallH) < wallW) p.set(wallW / 2 - d, BASE_Y + FRAME / 2, 0.58);
    else p.set(-wallW / 2 + FRAME / 2, BASE_Y + (d - wallW), 0.58);
    bulbPositions.push(p);
  }
  const bulbTime = uniform(0);
  const bulbBoost = uniform(1);
  const bulbMat = new MeshBasicNodeMaterial();
  const chase = smoothstep(0.35, 0.5, fract(float(instanceIndex).div(4).sub(bulbTime.mul(2.5))));
  bulbMat.colorNode = vec3(1.0, 0.86, 0.45).mul(chase.mul(2.2).add(0.35).mul(bulbBoost));
  (bulbMat as MeshBasicNodeMaterial & { emissiveNode: Node | null }).emissiveNode = vec3(1.0, 0.8, 0.35).mul(
    chase.mul(1.2).mul(bulbBoost),
  );
  const bulbs = new InstancedMesh(new IcosahedronGeometry(0.17, 1), bulbMat, bulbPositions.length);
  {
    const m = new Matrix4();
    bulbPositions.forEach((p, i) => bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  }
  bulbs.name = 'wall-bulbs';
  wall.add(bulbs);

  const header = createTextBanner(Math.min(wallW * 0.8, 16), 2.6, {
    fill: pal.neutral,
    stripe: pal.primary,
    text: pal.ink,
    outline: '#ffffff',
  });
  header.mesh.position.set(0, BASE_Y + wallH + 1.9, 0.4);
  header.draw(opts.title ?? 'SHOW RECAP');
  wall.add(header.mesh);
  const headerBack = new Mesh(
    painted(new RoundedBoxGeometry(Math.min(wallW * 0.8, 16) + 0.8, 3.2, 0.6, 2, 0.3), pal.secondary),
    plainMat,
  );
  headerBack.position.set(0, BASE_Y + wallH + 1.9, 0.0);
  wall.add(headerBack);

  const plates = new NameplateSet({ capacity, width: 1.9 });
  scene.add(plates.object);

  const beams: LightBeam[] = [];
  for (const sx of [-1, 1]) {
    const beam = createLightBeam(pal.interact, wallH + 10, 3.2);
    beam.mesh.position.set(sx * (wallW / 2 + 0.9), BASE_Y + wallH + 3, 1);
    beams.push(beam);
    scene.add(beam.mesh);
  }
  const winnerBeam = createLightBeam('#fff1b8', 14, 2.1);
  winnerBeam.setIntensity(0);
  scene.add(winnerBeam.mesh);
  const spot = new SpotLight('#fff3c4', 0, 30, 0.38, 0.6, 1.2);
  spot.castShadow = false;
  scene.add(spot, spot.target);

  const crown = createCrownMesh(1.1);
  crown.visible = false;
  scene.add(crown);

  // ---------------------------------------------------------------------------
  // Cubbies
  // ---------------------------------------------------------------------------
  const cubbies: Cubby[] = [];
  for (let i = 0; i < capacity; i++) {
    const col = i % cols;
    const row = rows - 1 - Math.floor(i / cols);
    const cx = x0 + (col + 0.5) * CW;
    const floorY = y0 + row * CH;
    const holder = new Group();
    holder.position.set(cx, floorY, -CD / 2 + 0.1);
    scene.add(holder);
    cubbies.push({
      index: i,
      center: new Vector3(cx, floorY + CH / 2, -CD / 2),
      floorY,
      holder,
      actor: null,
      state: 'empty',
      doorAngle: 0,
      doorTarget: 0,
      blinkTime: 0,
      vel: new Vector3(),
      spin: new Vector3(),
      fallTime: 0,
      poofed: false,
      playerId: '',
    });
  }
  const byPlayer = new Map<string, Cubby>();

  const m4 = new Matrix4();
  const q = new Quaternion();
  const pv = new Vector3();
  const one = new Vector3(1, 1, 1);
  const xAxis = new Vector3(1, 0, 0);
  const lightColor = new Color();
  const baseLight = new Color(pal.trim).multiplyScalar(0.55);
  const emptyLight = new Color(pal.structure).multiplyScalar(0.3);
  const redLight = new Color(2.6, 0.18, 0.32);
  const goldLight = new Color(2.4, 1.7, 0.45);

  const writeDoor = (c: Cubby): void => {
    pv.set(c.center.x, c.floorY, -CD + 0.05);
    q.setFromAxisAngle(xAxis, c.doorAngle);
    m4.compose(pv, q, one);
    doors.setMatrixAt(c.index, m4);
  };
  const writeLight = (c: Cubby, col: Color): void => {
    pv.set(c.center.x, c.center.y - FLOOR_T / 2, -CD + 0.03);
    m4.compose(pv, q.identity(), one);
    lights.setMatrixAt(c.index, m4);
    lights.setColorAt(c.index, col);
  };
  for (const c of cubbies) {
    writeDoor(c);
    writeLight(c, emptyLight);
    plates.setScale(c.index, 0);
  }
  doors.instanceMatrix.needsUpdate = true;
  lights.instanceMatrix.needsUpdate = true;
  if (lights.instanceColor) lights.instanceColor.needsUpdate = true;

  // ---------------------------------------------------------------------------
  // Recap timeline
  // ---------------------------------------------------------------------------
  let post: Pick<PostPipeline, 'punch' | 'flash' | 'setFocusVignette'> | null = null;
  let timeline: TimelineAction[] = [];
  /** Set while `startDrivenRecap` populates the wall; the recap then advances only on `beat()`. */
  let driving = false;
  let drivenSummary: PlayerWallSummary | null = null;
  let cursor = 0;
  let clock = 0;
  let playing = false;
  let callbacks: PlayerWallCallbacks = {};
  let winner: Cubby | null = null;
  let winnerFired = false;
  let crownT = -1;
  let dim = 0;
  let dimTarget = 0;
  const shake = new CameraShake();
  const shakeOffset = { x: 0, y: 0, z: 0 };

  type Shot = 'intro' | 'wide' | 'focus' | 'winner';
  let shot: Shot = 'wide';
  const focusPoint = new Vector3();
  const camPos = new Vector3();
  const camLook = new Vector3();
  const wantPos = new Vector3();
  const wantLook = new Vector3();
  let camInit = false;
  let t = 0;

  const wideDistance = (): number => {
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const totalH = wallH + 4.5;
    return Math.max(wallW / 2 / Math.tan(hfov / 2), totalH / 2 / Math.tan(vfov / 2)) * 1.08;
  };

  const clearActors = (): void => {
    for (const c of cubbies) {
      c.actor?.dispose();
      c.actor = null;
      c.state = 'empty';
      c.doorAngle = 0;
      c.doorTarget = 0;
      c.holder.position.set(c.center.x, c.floorY, -CD / 2 + 0.1);
      c.holder.rotation.set(0, 0, 0);
      c.holder.visible = true;
      c.poofed = false;
      writeDoor(c);
      writeLight(c, emptyLight);
      plates.setScale(c.index, 0);
    }
    byPlayer.clear();
    doors.instanceMatrix.needsUpdate = true;
    lights.instanceMatrix.needsUpdate = true;
    if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
  };

  const eliminate = (c: Cubby, roundIndex: number, k: number): void => {
    if (c.state !== 'idle' && c.state !== 'blink') return;
    c.state = 'falling';
    c.doorTarget = TILT;
    c.fallTime = 0;
    // Deterministic pseudo-random spread so replays of the same show look the same.
    const h = Math.sin((c.index + 1) * 12.9898 + roundIndex * 78.233) * 43758.5453;
    const r = h - Math.floor(h);
    c.vel.set((r - 0.5) * 3.2, 3.2 + r * 2.4, 3.4 + ((k * 0.37) % 1) * 2.2);
    c.spin.set(-4 - r * 6, (r - 0.5) * 10, (r - 0.5) * 8);
    if (c.actor) {
      c.actor.setState(SceneState.Fall);
      c.actor.anim.emote = null;
      c.actor.anim.grounded = false;
      c.actor.kick(1.2);
    }
    plates.setScale(c.index, 0);
    shake.add(0.22);
    post?.punch(0.35);
    callbacks.onEliminate?.(c.playerId, roundIndex);
  };

  const finishCrown = (): void => {
    if (!winner) return;
    crown.visible = true;
    crownT = 99;
    if (!winnerFired) {
      winnerFired = true;
      callbacks.onWinner?.(winner.playerId);
    }
  };

  const schedule = (at: number, run: () => void, essential = false): void => {
    timeline.push({ at, run, essential });
  };

  const buildTimeline = (summary: PlayerWallSummary): void => {
    timeline = [];
    cursor = 0;
    let at = 0;
    schedule(0, () => {
      shot = 'intro';
      header.draw(opts.title ?? 'SHOW RECAP', `${summary.players.length} players`);
    });
    for (const c of cubbies) {
      if (c.state !== 'idle') continue;
      schedule(0.4 + c.index * 0.035, () => c.actor?.playEmote('wave', 2.2));
    }
    at = 2.6;
    summary.rounds.forEach((round, ri) => {
      const victims = round.eliminatedIds
        .map((id) => byPlayer.get(id))
        .filter((c): c is Cubby => !!c && c !== winner);
      schedule(
        at,
        () => {
          shot = 'wide';
          header.draw(`ROUND ${ri + 1}`, round.name);
          header.mesh.rotation.x = -Math.PI / 2;
          callbacks.onRoundStart?.(ri, round);
        },
        true,
      );
      at += 1.3;
      if (victims.length === 0) {
        at += 0.8;
        return;
      }
      schedule(at, () => {
        focusPoint.set(0, 0, 0);
        for (const v of victims) focusPoint.add(v.center);
        focusPoint.multiplyScalar(1 / victims.length);
        shot = 'focus';
        for (const v of victims) {
          if (v.state === 'idle') {
            v.state = 'blink';
            v.blinkTime = 0;
            v.actor?.setState(SceneState.Fall);
          }
        }
      });
      at += 1.4;
      // Accelerating stagger: the first few drop one by one for comedy, then the rest tumble out in a rush.
      let gap = 0.42;
      victims.forEach((v, k) => {
        schedule(at, () => eliminate(v, ri, k), true);
        at += gap;
        gap = Math.max(0.07, gap * 0.78);
      });
      at += 1.6;
      schedule(at, () => {
        shake.add(0.35);
        shot = 'wide';
      });
      at += 0.4;
    });

    schedule(
      at,
      () => {
        for (const c of cubbies)
          if ((c.state === 'idle' || c.state === 'blink') && c !== winner)
            eliminate(c, summary.rounds.length, c.index);
      },
      true,
    );
    at += winner ? 1.2 : 0.4;

    if (winner) {
      const w = winner;
      schedule(
        at,
        () => {
          header.draw('WINNER!', summary.players.find((p) => p.id === w.playerId)?.name ?? '');
          header.mesh.rotation.x = -Math.PI / 2;
          dimTarget = 1;
          w.state = 'winner';
          // Crown rests with its band hugging the head top (band half-height ≈ 0.18 m).
          if (opts.crownHeight === undefined && w.actor) crownHeight = measureHeadHeight(w.holder) + 0.1;
          shot = 'winner';
          winnerBeam.mesh.position.set(w.center.x, w.floorY + 12, 2.5);
          winnerBeam.mesh.lookAt(w.center.x, w.floorY, -CD / 2);
          winnerBeam.mesh.rotateX(-Math.PI / 2);
          spot.position.set(w.center.x, w.floorY + 9, 6);
          spot.target.position.set(w.center.x, w.floorY + 0.6, -CD / 2);
          post?.setFocusVignette(0.35);
        },
        true,
      );
      at += 1.2;
      schedule(
        at,
        () => {
          shake.add(0.6);
          post?.punch(0.6);
          crown.visible = true;
          crownT = 0;
        },
        true,
      );
      at += 1.7;
      schedule(
        at,
        () => {
          finishCrown();
          post?.flash(0.5);
          w.actor?.playEmote('cheer', 6);
          vfx.spawn('confetti', { x: w.center.x, y: w.floorY + 2.4, z: 0.6 }, { intensity: 1.6 });
          vfx.spawn(
            'crownShine',
            { x: w.center.x, y: w.floorY + crownHeight + 0.3, z: w.holder.position.z },
            { duration: 8 },
          );
          for (let k = 0; k < 4; k++) {
            vfx.spawn(
              'fireworks',
              { x: (k - 1.5) * (wallW / 3.2), y: BASE_Y + wallH + 2, z: 3 },
              { delay: k * 0.35 },
            );
          }
        },
        true,
      );
      at += 3.2;
      schedule(at, () => {
        for (let k = 0; k < 3; k++)
          vfx.spawn(
            'fireworks',
            { x: (k - 1) * 6, y: BASE_Y + wallH + 4, z: 2 },
            { delay: k * 0.25, scale: 1.3 },
          );
      });
      at += 2.5;
    }
    schedule(
      at,
      () => {
        playing = false;
        callbacks.onDone?.();
      },
      true,
    );
    timeline.sort((a, b) => a.at - b.at);
  };

  const api: PlayerWallScene = {
    scene,
    camera,
    grade: stage.grade,
    vfx,
    get playing(): boolean {
      return playing;
    },
    attachPost(p): void {
      post = p;
    },
    playRecap(summary: PlayerWallSummary, cbs: PlayerWallCallbacks = {}): void {
      clearActors();
      vfx.clear();
      callbacks = cbs;
      winner = null;
      winnerFired = false;
      crown.visible = false;
      crownT = -1;
      dimTarget = 0;
      winnerBeam.setIntensity(0);
      post?.setFocusVignette(0);
      summary.players.slice(0, capacity).forEach((p, i) => {
        const c = cubbies[i]!;
        c.actor = new TumblerActor(factory, p.loadout);
        c.holder.add(c.actor.object);
        c.state = 'idle';
        c.playerId = p.id;
        byPlayer.set(p.id, c);
        writeLight(c, baseLight);
        plates.setName(i, p.name, p.loadout.colors[0]);
        plates.setPosition(i, c.center.x, c.floorY - 0.32, 0.45);
        plates.setScale(i, 1);
      });
      lights.instanceMatrix.needsUpdate = true;
      if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
      winner = summary.winnerId ? (byPlayer.get(summary.winnerId) ?? null) : null;
      clock = 0;
      playing = true;
      camInit = false;
      if (driving) {
        timeline = [];
        cursor = 0;
        drivenSummary = summary;
      } else {
        drivenSummary = null;
        buildTimeline(summary);
      }
    },
    startDrivenRecap(summary: PlayerWallSummary, cbs: PlayerWallCallbacks = {}): void {
      driving = true;
      try {
        api.playRecap(summary, cbs);
      } finally {
        driving = false;
      }
    },
    beat(b: PlayerWallBeat): void {
      const summary = drivenSummary;
      if (!summary || !playing) return;
      switch (b.type) {
        case 'intro':
          shot = 'intro';
          header.draw(opts.title ?? 'SHOW RECAP', `${summary.players.length} players`);
          for (const c of cubbies) if (c.state === 'idle') c.actor?.playEmote('wave', 2.2);
          return;
        case 'round': {
          const round = summary.rounds[b.roundIndex];
          shot = 'wide';
          header.draw(`ROUND ${b.roundIndex + 1}`, round?.name ?? '');
          header.mesh.rotation.x = -Math.PI / 2;
          if (round) callbacks.onRoundStart?.(b.roundIndex, round);
          return;
        }
        case 'flash': {
          const victims = b.ids.map((id) => byPlayer.get(id)).filter((c): c is Cubby => !!c && c !== winner);
          if (victims.length === 0) return;
          focusPoint.set(0, 0, 0);
          for (const v of victims) focusPoint.add(v.center);
          focusPoint.multiplyScalar(1 / victims.length);
          shot = 'focus';
          for (const v of victims) {
            if (v.state === 'idle') {
              v.state = 'blink';
              v.blinkTime = 0;
              v.actor?.setState(SceneState.Fall);
            }
          }
          return;
        }
        case 'drop': {
          const c = byPlayer.get(b.id);
          if (c && c !== winner) eliminate(c, b.roundIndex, b.order);
          return;
        }
        case 'roundEnd':
          shake.add(0.35);
          shot = 'wide';
          return;
        case 'winnerFocus': {
          // Anyone the recap never dropped (left mid-show) goes now, so the winner stands alone.
          for (const c of cubbies)
            if ((c.state === 'idle' || c.state === 'blink') && c !== winner)
              eliminate(c, summary.rounds.length, c.index);
          const w = winner;
          if (!w) return;
          header.draw('WINNER!', summary.players.find((p) => p.id === w.playerId)?.name ?? '');
          header.mesh.rotation.x = -Math.PI / 2;
          dimTarget = 1;
          w.state = 'winner';
          if (opts.crownHeight === undefined && w.actor) crownHeight = measureHeadHeight(w.holder) + 0.1;
          shot = 'winner';
          winnerBeam.mesh.position.set(w.center.x, w.floorY + 12, 2.5);
          winnerBeam.mesh.lookAt(w.center.x, w.floorY, -CD / 2);
          winnerBeam.mesh.rotateX(-Math.PI / 2);
          spot.position.set(w.center.x, w.floorY + 9, 6);
          spot.target.position.set(w.center.x, w.floorY + 0.6, -CD / 2);
          post?.setFocusVignette(0.35);
          return;
        }
        case 'crown':
          if (!winner) return;
          shake.add(0.6);
          post?.punch(0.6);
          crown.visible = true;
          crownT = 0;
          return;
        case 'reveal': {
          const w = winner;
          if (!w) return;
          // The crown keeps falling if it is still mid-air; only a missed drop snaps it on.
          if (crownT < 0) finishCrown();
          else if (!winnerFired) {
            winnerFired = true;
            callbacks.onWinner?.(w.playerId);
          }
          post?.flash(0.5);
          w.actor?.playEmote('cheer', 6);
          vfx.spawn('confetti', { x: w.center.x, y: w.floorY + 2.4, z: 0.6 }, { intensity: 1.6 });
          vfx.spawn(
            'crownShine',
            { x: w.center.x, y: w.floorY + crownHeight + 0.3, z: w.holder.position.z },
            { duration: 8 },
          );
          for (let k = 0; k < 4; k++)
            vfx.spawn(
              'fireworks',
              { x: (k - 1.5) * (wallW / 3.2), y: BASE_Y + wallH + 2, z: 3 },
              { delay: k * 0.35 },
            );
          return;
        }
        case 'end':
          for (let k = 0; k < 3; k++)
            vfx.spawn(
              'fireworks',
              { x: (k - 1) * 6, y: BASE_Y + wallH + 4, z: 2 },
              { delay: k * 0.25, scale: 1.3 },
            );
          playing = false;
          callbacks.onDone?.();
          return;
      }
    },
    skip(): void {
      if (!playing) return;
      for (; cursor < timeline.length; cursor++) {
        const a = timeline[cursor]!;
        if (a.essential) a.run();
      }
      // A driven recap has no schedule to fast-forward: everyone but the winner just leaves.
      if (drivenSummary) {
        for (const c of cubbies)
          if ((c.state === 'idle' || c.state === 'blink') && c !== winner) c.state = 'falling';
        if (winner) winner.state = 'winner';
      }
      for (const c of cubbies) {
        if (c.state === 'falling' || c.state === 'blink') {
          c.state = 'gone';
          c.holder.visible = false;
          c.doorAngle = 0;
          c.doorTarget = 0;
          writeDoor(c);
          writeLight(c, emptyLight);
        }
      }
      doors.instanceMatrix.needsUpdate = true;
      if (lights.instanceColor) lights.instanceColor.needsUpdate = true;
      finishCrown();
      playing = false;
    },
    update(dt: number): void {
      t += dt;
      levelU.time.value = t;
      bulbTime.value = t;
      stage.update(dt);

      if (playing) {
        clock += dt;
        while (cursor < timeline.length && timeline[cursor]!.at <= clock) timeline[cursor++]!.run();
      }

      let doorsDirty = false;
      let lightsDirty = false;
      for (const c of cubbies) {
        if (c.doorAngle !== c.doorTarget) {
          const k = c.doorTarget > c.doorAngle ? 14 : 4;
          c.doorAngle += (c.doorTarget - c.doorAngle) * Math.min(1, dt * k);
          if (Math.abs(c.doorAngle - c.doorTarget) < 0.002) c.doorAngle = c.doorTarget;
          writeDoor(c);
          doorsDirty = true;
        }
        switch (c.state) {
          case 'blink': {
            c.blinkTime += dt;
            const on = Math.floor(c.blinkTime * 7) % 2 === 0;
            writeLight(c, on ? redLight : baseLight);
            lightsDirty = true;
            if (c.actor) c.actor.anim.facing = Math.sin(c.blinkTime * 18) * 0.25;
            break;
          }
          case 'falling': {
            c.fallTime += dt;
            c.vel.y += GRAVITY * dt;
            c.holder.position.addScaledVector(c.vel, dt);
            c.holder.rotation.x += c.spin.x * dt;
            c.holder.rotation.y += c.spin.y * dt;
            c.holder.rotation.z += c.spin.z * dt;
            if (c.fallTime < 0.1) {
              writeLight(c, redLight);
              lightsDirty = true;
            } else if (c.fallTime < 0.6) {
              writeLight(c, lightColor.copy(redLight).lerp(emptyLight, (c.fallTime - 0.1) / 0.5));
              lightsDirty = true;
            }
            if (c.fallTime > 0.9 && c.doorTarget !== 0) c.doorTarget = 0;
            if (!c.poofed && c.holder.position.y < BASE_Y - 3.5) {
              c.poofed = true;
              vfx.spawn('eliminationPoof', {
                x: c.holder.position.x,
                y: c.holder.position.y,
                z: c.holder.position.z,
              });
            }
            if (c.fallTime > 3) {
              c.state = 'gone';
              c.holder.visible = false;
            }
            break;
          }
          case 'winner': {
            const pulse = 0.8 + Math.sin(t * 5) * 0.2;
            writeLight(c, lightColor.copy(goldLight).multiplyScalar(pulse));
            lightsDirty = true;
            break;
          }
          default:
            break;
        }
        c.actor?.update(dt);
      }
      if (doorsDirty) doors.instanceMatrix.needsUpdate = true;
      if (lightsDirty && lights.instanceColor) lights.instanceColor.needsUpdate = true;

      if (header.mesh.rotation.x !== 0) {
        header.mesh.rotation.x += (0 - header.mesh.rotation.x) * Math.min(1, dt * 9);
        if (Math.abs(header.mesh.rotation.x) < 0.001) header.mesh.rotation.x = 0;
      }

      dim += (dimTarget - dim) * Math.min(1, dt * 2);
      stage.env.lights.setIntensityScale(1 - dim * 0.6, 1 - dim * 0.55);
      bulbBoost.value = 1 + dim * 0.6;
      winnerBeam.setIntensity(dim * 0.7);
      spot.intensity = dim * 220;
      for (const b of beams) {
        b.mesh.rotation.z = Math.sin(t * 0.6 + b.mesh.position.x) * 0.35;
        b.setIntensity(1 - dim * 0.7);
      }

      if (winner && crownT >= 0) {
        const w = winner;
        const headY = w.floorY + crownHeight;
        if (crownT < 99) {
          crownT += dt;
          const k = Math.min(1, crownT / 1.6);
          // Ease-out with a little bounce as it settles.
          const e = 1 - Math.pow(1 - k, 3);
          const bounce = k >= 1 ? 0 : Math.sin(k * Math.PI * 3) * (1 - k) * 0.25;
          crown.position.set(w.center.x, headY + (1 - e) * 7 + bounce, w.holder.position.z);
          crown.rotation.y = (1 - e) * Math.PI * 4;
        } else {
          crown.position.set(w.center.x, headY + Math.sin(t * 2.2) * 0.04, w.holder.position.z);
          crown.rotation.y = Math.sin(t * 0.8) * 0.25;
        }
      }

      // Camera direction
      const wide = wideDistance();
      const midY = BASE_Y + (wallH + 3) / 2;
      switch (shot) {
        case 'intro':
          wantPos.set(Math.sin(t * 0.2) * 2, midY - 1, wide * 0.95);
          wantLook.set(0, midY, 0);
          break;
        case 'wide':
          wantPos.set(Math.sin(t * 0.25) * 1.5, midY + 0.5, wide);
          wantLook.set(0, midY, 0);
          break;
        case 'focus':
          wantPos.set(focusPoint.x * 0.3, midY * 0.75 + focusPoint.y * 0.25, wide * 0.9);
          wantLook.set(focusPoint.x * 0.2, midY * 0.8 + focusPoint.y * 0.2, 0);
          break;
        case 'winner':
          if (winner) {
            wantPos.set(winner.center.x * 0.85, winner.center.y + 1.0, 11);
            wantLook.set(winner.center.x, winner.center.y + 0.1, -CD / 2);
          }
          break;
      }
      if (!camInit) {
        camPos.set(0, midY - 3, wide * 1.35);
        camLook.copy(wantLook);
        camInit = true;
      }
      const k = 1 - Math.exp(-dt * (shot === 'winner' ? 1.4 : 2.2));
      camPos.lerp(wantPos, k);
      camLook.lerp(wantLook, k);
      shake.update(dt, shakeOffset, 0.45);
      camera.position.set(camPos.x + shakeOffset.x, camPos.y + shakeOffset.y, camPos.z + shakeOffset.z);
      wall.position.set(shakeOffset.x * 0.15, shakeOffset.y * 0.15, 0);
      camera.lookAt(camLook);
      vfx.update(dt, camera);
    },
    resize(w: number, h: number): void {
      stage.resize(w, h);
    },
    dispose(): void {
      clearActors();
      vfx.dispose();
      for (const b of beams) b.dispose();
      winnerBeam.dispose();
      header.dispose();
      plates.dispose();
      plainGeo.dispose();
      stripeGeo.dispose();
      headerBack.geometry.dispose();
      for (const mat of [plainMat, stripeMat, doorMat, lightMat, bulbMat] as Material[]) mat.dispose();
      lightGeo.dispose();
      doorColor.dispose();
      bulbs.geometry.dispose();
      crown.geometry.dispose();
      (crown.material as Material).dispose();
      spot.dispose();
      stage.dispose();
    },
  };
  return api;
}
