import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, type Mesh } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { TrailPool } from '../src/vfx/trails.ts';

/** Ribbon points per trail (`POINTS` in trails.ts): each owns `POINTS * 2` vertices. */
const POINTS = 28;

function setup(capacity: number, limit = capacity) {
  const parent = new Group();
  const pool = new TrailPool(parent, capacity, limit, uniform(0), () => {});
  const camera = new PerspectiveCamera();
  camera.position.set(0, 5, -10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { parent, pool, camera };
}

describe('TrailPool', () => {
  it('draws every active ribbon in one mesh, each from its own vertex range', () => {
    const { parent, pool, camera } = setup(4);
    expect(parent.children).toHaveLength(1);
    const mesh = parent.children[0] as Mesh;
    const handles = [pool.acquire('rainbow'), pool.acquire('flame'), pool.acquire('plain', '#ff00ff')];
    let now = 0;
    for (let f = 0; f < 20; f++) {
      now += 1 / 60;
      pool.update(now, camera);
      handles.forEach((h, k) => h?.update(k * 3, 1, f * 0.3, 1 / 60));
    }
    pool.update(now + 1 / 60, camera);
    expect(mesh.visible).toBe(true);
    const count = mesh.geometry.drawRange.count;
    expect(count).toBeGreaterThan(0);
    expect(count % 6).toBe(0);
    const idx = mesh.geometry.index!.array;
    const owners = new Set<number>();
    for (let q = 0; q < count; q += 6) {
      const owner = Math.floor((idx[q] as number) / (POINTS * 2));
      owners.add(owner);
      // Both triangles of a quad stay inside one ribbon's range.
      for (let k = 0; k < 6; k++) expect(Math.floor((idx[q + k] as number) / (POINTS * 2))).toBe(owner);
    }
    expect(owners.size).toBe(3);
  });

  it('fades released ribbons out and hides the mesh once none are left', () => {
    const { parent, pool, camera } = setup(2);
    const mesh = parent.children[0] as Mesh;
    const h = pool.acquire('candy');
    let now = 0;
    for (let f = 0; f < 10; f++) {
      now += 1 / 60;
      h?.update(0, 1, f * 0.3, 1 / 60);
      pool.update(now, camera);
    }
    expect(mesh.visible).toBe(true);
    h?.release();
    for (let f = 0; f < 90; f++) pool.update((now += 1 / 60), camera);
    expect(mesh.visible).toBe(false);
    expect(mesh.geometry.drawRange.count).toBe(0);
    // The ribbon went back to the pool.
    expect(pool.acquire('plain')).not.toBeNull();
    expect(pool.acquire('plain')).not.toBeNull();
    expect(pool.acquire('plain')).toBeNull();
    pool.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
