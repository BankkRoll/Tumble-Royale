import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicNodeMaterial, Scene, type Object3D } from 'three/webgpu';
import { modelWorldMatrix, positionGeometry, positionLocal, uniform, vec4 } from 'three/tsl';
import { getRound } from '@tumble/content/rounds';
import { MeshBatcher } from '../src/batching/index.ts';
import { batchability } from '../src/batching/meshBatcher.ts';
import { getObstacleVisual } from '../src/obstacles/index.ts';

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

  it('merges equivalent meshes and stages divergent ones out without gaps', () => {
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
    scene.add(b.object);
    expect(b.stats.batches).toBe(1);

    frame(b, 1); // sources drew themselves this frame and join from the next
    expect(meshes.every((m) => m.layers.mask === 0)).toBe(true);
    frame(b, 2);
    expect(drawnMeshes(scene)).toBe(1);

    // One member's uniform diverges: it is still drawn by the batch this frame, then on its own.
    (meshes[2]!.material as MeshBasicNodeMaterial).userData.tint.value = 0.9;
    frame(b, 3);
    const inst = b.object.children[0] as Mesh & { count: number };
    expect(inst.count).toBe(4);
    expect(meshes[2]!.layers.mask).not.toBe(0);
    frame(b, 4);
    expect(inst.count).toBe(3);
    expect(drawnMeshes(scene)).toBe(2);

    // Hidden members leave the batch immediately.
    meshes[0]!.visible = false;
    frame(b, 5);
    expect(inst.count).toBe(2);

    b.dispose();
    expect(meshes.every((m) => m.layers.mask !== 0)).toBe(true);
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
