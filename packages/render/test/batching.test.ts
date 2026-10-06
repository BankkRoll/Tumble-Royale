import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  type Camera,
  type InstancedMesh,
  type MeshToonNodeMaterial,
  type Object3D,
} from 'three/webgpu';
import { modelWorldMatrix, positionGeometry, positionLocal, uniform, vec4 } from 'three/tsl';
import { playableCustomRound, starterRound } from '@tumble/content/custom';
import { getRound } from '@tumble/content/rounds';
import { MeshBatcher } from '../src/batching/index.ts';
import { batchability } from '../src/batching/meshBatcher.ts';
import { getObstacleVisual } from '../src/obstacles/index.ts';
import { setGlow } from '../src/obstacles/visual-helpers-b.ts';
import { createToonMaterial } from '../src/materials/toon.ts';

/** Drives the batcher's per-frame sync the way the renderer does (once per frame id). */
function frame(b: MeshBatcher, id: number): void {
  (b as unknown as { sync(frame: number): void }).sync(id);
}

function drawnMeshes(root: Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    const m = o as Mesh & { count?: number; isInstancedMesh?: boolean };
    if (!m.isMesh || m.layers.mask === 0) return;
    if (m.isInstancedMesh && m.count === 0) return;
    n++;
  });
  return n;
}

function tintMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  const tint = uniform(0.5);
  m.colorNode = vec4(positionGeometry.mul(tint), 1);
  m.userData.tint = tint;
  return m;
}

describe('MeshBatcher', () => {
  it('only accepts materials whose look survives instancing', () => {
    const geo = new BoxGeometry();
    const ok = new Mesh(geo, tintMaterial());
    const local = new MeshBasicNodeMaterial();
    local.colorNode = vec4(positionLocal, 1);
    const model = new MeshBasicNodeMaterial();
    model.colorNode = vec4(modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz, 1);
    const glass = new MeshBasicNodeMaterial({ transparent: true });
    expect(batchability(ok)).toBe('ok');
    expect(batchability(new Mesh(geo, local))).toMatch(/object-space/);
    expect(batchability(new Mesh(geo, model))).toMatch(/model accessor/);
    expect(batchability(new Mesh(geo, glass))).toMatch(/transparent/);
  });

  it('merges equivalent meshes and draws divergent ones solo, never twice or not at all', () => {
    const scene = new Scene();
    const meshes = Array.from({ length: 4 }, (_, i) => {
      // Separate geometry and material objects with identical content still group.
      const m = new Mesh(new BoxGeometry(), tintMaterial());
      m.position.x = i * 3;
      scene.add(m);
      return m;
    });
    const b = new MeshBatcher();
    for (const m of meshes) b.add(m);
    b.build();
    b.attach(scene);
    scene.updateMatrixWorld();
    expect(b.stats.batches).toBe(1);
    const inst = b.object.children[0] as InstancedMesh;

    frame(b, 1);
    expect(meshes.every((m) => m.layers.mask === 0)).toBe(true);
    expect(inst.count).toBe(4);
    expect(drawnMeshes(scene)).toBe(1);

    // One member's uniform diverges: it leaves the batch and draws through a one-instance mesh
    // with its own material (and the batch's shader).
    (meshes[2]!.material as MeshBasicNodeMaterial).userData.tint.value = 0.9;
    frame(b, 2);
    expect(inst.count).toBe(3);
    expect(meshes[2]!.layers.mask).toBe(0);
    const solos = (b.object.children as InstancedMesh[]).filter((o) => o.visible && o !== inst);
    expect(solos).toHaveLength(1);
    expect(solos[0]!.material).toBe(meshes[2]!.material);
    expect(solos[0]!.count).toBe(1);
    // Same capacity as the batch, past three's uniform-array path, so both compile to one shader.
    expect(solos[0]!.instanceMatrix.count).toBe(inst.instanceMatrix.count);
    expect(inst.instanceMatrix.count * 64).toBeGreaterThan(65536);
    const m4 = new Matrix4();
    solos[0]!.getMatrixAt(0, m4);
    expect(m4.elements[12]).toBeCloseTo(6);
    expect(drawnMeshes(scene)).toBe(2);

    // Matching again: back into the batch.
    (meshes[2]!.material as MeshBasicNodeMaterial).userData.tint.value = 0.5;
    frame(b, 3);
    expect(inst.count).toBe(4);
    expect(drawnMeshes(scene)).toBe(1);

    // Hidden members leave the batch.
    meshes[0]!.visible = false;
    frame(b, 4);
    expect(inst.count).toBe(3);

    // A swapped material object gives the source its own draw back.
    meshes[1]!.material = tintMaterial();
    frame(b, 5);
    expect(inst.count).toBe(2);
    expect(meshes[1]!.layers.mask).toBe(1);
    expect(drawnMeshes(scene)).toBe(2);

    b.dispose();
    expect(meshes.every((m) => m.layers.mask !== 0)).toBe(true);
  });

  it('groups toon materials by the values their material references read', () => {
    const scene = new Scene();
    const meshes = Array.from({ length: 3 }, (_, i) => {
      const m = new Mesh(new BoxGeometry(), createToonMaterial({ color: '#ff6fb5', emissive: '#ff0000' }));
      m.position.x = i * 3;
      scene.add(m);
      return m;
    });
    const b = new MeshBatcher();
    for (const m of meshes) b.add(m);
    b.build();
    scene.add(b.object);
    expect(b.stats.batches).toBe(1);
    frame(b, 1);
    frame(b, 2);
    expect(drawnMeshes(scene)).toBe(1);

    // One hammer's telegraph glow ramps up: it draws solo, the others stay instanced.
    setGlow(meshes[1]!.material as MeshToonNodeMaterial, 0.8);
    frame(b, 3);
    expect(meshes[1]!.layers.mask).toBe(0);
    expect((b.object.children[0] as InstancedMesh).count).toBe(2);
    expect(drawnMeshes(scene)).toBe(2);
    b.dispose();
  });

  it('builds in slices: one pause per registered root and per batch, same batches', () => {
    const round = getRound('hammer-highway')!;
    const make = (): { b: MeshBatcher; roots: number } => {
      const b = new MeshBatcher();
      let roots = 0;
      for (const inst of round.obstacles) {
        const f = getObstacleVisual(inst.type);
        if (!f) continue;
        b.add(f(inst, { theme: round.theme, speedScale: 1, seed: 1 }).object);
        roots++;
      }
      return { b, roots };
    };
    const sliced = make();
    const progress = [...sliced.b.buildSliced()];
    const whole = make();
    whole.b.build();
    expect(progress.length).toBe(sliced.roots + whole.b.stats.batches);
    expect(progress.at(-1)).toBeCloseTo(1);
    expect(sliced.b.stats).toEqual(whole.b.stats);
  });

  it('more than halves the obstacle draws of a hammer-heavy race', () => {
    const round = getRound('hammer-highway');
    expect(round).toBeTruthy();
    const scene = new Scene();
    const b = new MeshBatcher();
    const visuals = [];
    for (const inst of round!.obstacles) {
      const f = getObstacleVisual(inst.type);
      if (!f) continue;
      const v = f(inst, { theme: round!.theme, speedScale: 1, seed: 1 });
      scene.add(v.object);
      b.add(v.object);
      visuals.push(v);
    }
    const before = drawnMeshes(scene);
    b.build();
    scene.add(b.object);
    for (let i = 1; i <= 3; i++) {
      for (const v of visuals) v.update(1 + i / 60, 1 / 60);
      scene.updateMatrixWorld();
      frame(b, i);
    }
    const after = drawnMeshes(scene);
    expect(after).toBeLessThan(before * 0.5);
    b.dispose();
    for (const v of visuals) v.dispose();
  });
});

/** One render pass as three runs it: the scene's `onBeforeRender` with that pass's camera. */
function pass(scene: Scene, camera: Camera, frameId: number): void {
  camera.updateMatrixWorld();
  scene.onBeforeRender({ info: { frame: frameId } } as never, scene, camera, null as never);
}

function lookingAt(x: number, z: number, far = 20): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 1, 0.1, far);
  cam.position.set(x, 6, z - 6);
  cam.lookAt(x, 0, z);
  cam.updateMatrixWorld();
  return cam;
}

/** Batches a pass draws (not culled, some instances). */
function batchesDrawn(b: MeshBatcher): InstancedMesh[] {
  return (b.object.children as InstancedMesh[]).filter((m) => m.layers.mask !== 0 && m.count > 0);
}

function row(scene: Scene, zs: number[]): Mesh[] {
  const geo = new BoxGeometry(2, 2, 2);
  const mat = tintMaterial();
  return zs.map((z) => {
    const m = new Mesh(geo, mat);
    m.position.set(0, 1, z);
    m.castShadow = true;
    scene.add(m);
    return m;
  });
}

function batched(scene: Scene, roots: Object3D[]): MeshBatcher {
  const b = new MeshBatcher();
  for (const r of roots) b.add(r);
  b.build();
  b.attach(scene);
  scene.updateMatrixWorld();
  // Members join on the first frame and draw through the batch from the next (see the staging in `sync`).
  pass(scene, lookingAt(0, 0), 0);
  return b;
}

describe('MeshBatcher culling', () => {
  it('culls a course-long batch from passes that see none of its cells', () => {
    const scene = new Scene();
    const meshes = row(scene, [0, 40, 80, 120, 160, 200]);
    const b = batched(scene, meshes);
    expect(b.stats.batches).toBe(1);
    pass(scene, lookingAt(0, 0), 1);
    expect(batchesDrawn(b)).toHaveLength(1);
    expect(batchesDrawn(b)[0]!.count).toBe(6);
    // Between two members: the batch's overall sphere covers this spot, its cells do not.
    pass(scene, lookingAt(0, 100, 8), 1);
    expect(batchesDrawn(b)).toHaveLength(0);
    pass(scene, lookingAt(0, 200), 1);
    expect(batchesDrawn(b)).toHaveLength(1);
    // Sources stay hidden whether or not the batch is culled: nothing draws twice or goes missing.
    for (const m of meshes) expect(m.layers.mask).toBe(0);
    b.dispose();
  });

  it('culls per shadow cascade (orthographic light cameras)', () => {
    const scene = new Scene();
    const b = batched(scene, row(scene, [0, 4, 8, 150, 154]));
    const cascade = (z: number, half: number): OrthographicCamera => {
      const cam = new OrthographicCamera(-half, half, half, -half, 0.1, 200);
      cam.position.set(30, 60, z + 20);
      cam.lookAt(0, 0, z);
      return cam;
    };
    pass(scene, cascade(4, 15), 1);
    expect(batchesDrawn(b)).toHaveLength(1);
    pass(scene, cascade(70, 15), 1);
    expect(batchesDrawn(b)).toHaveLength(0);
    pass(scene, cascade(80, 120), 1);
    expect(batchesDrawn(b)).toHaveLength(1);
    b.dispose();
  });

  it('follows moving members and keeps drawing while the warm-up disables culling', () => {
    const scene = new Scene();
    const meshes = row(scene, [0, 200]);
    const b = batched(scene, meshes);
    const mid = lookingAt(0, 100, 8);
    pass(scene, mid, 1);
    expect(batchesDrawn(b)).toHaveLength(0);
    meshes[1]!.position.z = 100;
    scene.updateMatrixWorld();
    pass(scene, mid, 2);
    expect(batchesDrawn(b)).toHaveLength(1);

    meshes[1]!.position.z = 200;
    scene.updateMatrixWorld();
    pass(scene, mid, 3);
    expect(batchesDrawn(b)).toHaveLength(0);
    const inst = b.object.children[0] as InstancedMesh;
    inst.frustumCulled = false;
    pass(scene, mid, 4);
    expect(batchesDrawn(b)).toHaveLength(1);
    // The warm-up hides every source too: the batch still draws one instance so it compiles.
    for (const m of meshes) m.visible = false;
    pass(scene, mid, 5);
    expect(inst.count).toBe(1);
    inst.frustumCulled = true;
    pass(scene, mid, 6);
    expect(inst.count).toBe(0);
    b.dispose();
  });

  it('restores the scene hook and every source on dispose', () => {
    const scene = new Scene();
    const own = (): void => {};
    scene.onBeforeRender = own;
    const meshes = row(scene, [0, 3]);
    const b = batched(scene, meshes);
    expect(scene.onBeforeRender).not.toBe(own);
    pass(scene, lookingAt(0, 0), 1);
    b.dispose();
    expect(scene.onBeforeRender).toBe(own);
    for (const m of meshes) expect(m.layers.mask).toBe(1);
    expect(b.object.parent).toBeNull();
  });

  it('batches and culls a custom round from the editor like a built-in one', () => {
    const draft = starterRound('race');
    const pillars = [0, 1, 2, 3, 4, 5].map((i) => ({
      id: `pillar-${i}`,
      type: 'bumperPillar' as const,
      position: { x: i % 2 === 0 ? -3 : 3, y: 0, z: 8 + i * 8 },
      params: { radius: 1, height: 2.4, bounceSpeed: 8.5, bounceLift: 2.5 },
    }));
    const r = playableCustomRound(
      { ...draft, obstacles: [...draft.obstacles, ...pillars] },
      'custom:playtest',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const round = r.round;
    const scene = new Scene();
    const visuals = [];
    for (const inst of round.obstacles) {
      const f = getObstacleVisual(inst.type);
      if (!f) continue;
      const v = f(inst, { theme: round.theme, speedScale: 1, seed: 1 });
      scene.add(v.object);
      visuals.push(v);
    }
    const before = drawnMeshes(scene);
    const b = batched(
      scene,
      visuals.map((v) => v.object),
    );
    expect(b.stats.batches).toBeGreaterThan(0);
    const overview = lookingAt(0, 28, 400);
    overview.position.set(0, 60, -40);
    overview.lookAt(0, 0, 28);
    for (let i = 1; i <= 3; i++) {
      for (const v of visuals) v.update(1 + i / 60, 1 / 60);
      scene.updateMatrixWorld();
      pass(scene, overview, i);
    }
    expect(drawnMeshes(scene)).toBeLessThan(before);

    // Parity: each batch holds exactly its hidden sources' current world matrices.
    const m4 = new Matrix4();
    type Internals = {
      batches: { mesh: InstancedMesh; members: { mesh: Mesh; instanced: unknown; mode: number }[] }[];
    };
    for (const { mesh: inst, members } of (b as unknown as Internals).batches) {
      if (members.some((m) => m.instanced)) continue;
      // Mode.Batch (1): drawn as an instance of this batch this frame.
      const shown = members.filter((m) => m.mode === 1);
      expect(inst.count).toBe(shown.length);
      expect(inst.material).toBe(members[0]!.mesh.material);
      for (const m of shown)
        expect(m.mesh.geometry.attributes.position!.count).toBe(inst.geometry.attributes.position!.count);
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m4);
        // Instance matrices are float32 copies of the float64 world matrices.
        const same = (m: Matrix4): boolean => m.elements.every((e, k) => Math.fround(e) === m4.elements[k]);
        expect(shown.some((m) => same(m.mesh.matrixWorld))).toBe(true);
      }
    }

    // A camera at the far end of the course draws fewer batches than the overview.
    const all = batchesDrawn(b).length;
    pass(scene, lookingAt(0, 56, 10), 4);
    expect(batchesDrawn(b).length).toBeLessThan(all);
    b.dispose();
    for (const v of visuals) v.dispose();
  });

  it('keeps the shadow draws of a 100-player race in check (draw-call regression)', () => {
    const round = getRound('tilt-town') as RoundDefinition;
    const scene = new Scene();
    const visuals = [];
    for (const inst of round.obstacles) {
      const f = getObstacleVisual(inst.type);
      if (!f) continue;
      const v = f(inst, { theme: round.theme, speedScale: 1, seed: 1 });
      scene.add(v.object);
      visuals.push(v);
    }
    const b = batched(
      scene,
      visuals.map((v) => v.object),
    );
    for (const v of visuals) v.update(1, 1 / 60);
    scene.updateMatrixWorld();
    // Roughly the nearest CSM cascade at the start line on High: 60 m across around the spawn.
    const s = round.spawn.origin;
    const near = new OrthographicCamera(-30, 30, 30, -30, 0.1, 400);
    near.position.set(s.x + 40, s.y + 80, s.z + 40);
    near.lookAt(s.x, s.y, s.z + 20);
    pass(scene, near, 1);
    const total = b.stats.batches;
    const drawn = batchesDrawn(b).length;
    expect(total).toBeGreaterThan(20);
    // Before per-pass culling every batch drew in every cascade.
    expect(drawn).toBeLessThan(total * 0.5);
    b.dispose();
    for (const v of visuals) v.dispose();
  });
});
