import { Group, Mesh, Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { disableFrustumCulling } from '../src/post/pipeline.ts';

describe('disableFrustumCulling', () => {
  it('turns culling off for the whole subtree and restores only what it changed', () => {
    const root = new Group();
    const a = new Mesh();
    const b = new Mesh();
    const alwaysDrawn = new Object3D();
    alwaysDrawn.frustumCulled = false;
    root.add(a);
    a.add(b);
    root.add(alwaysDrawn);
    const restore = disableFrustumCulling(root);
    expect([root, a, b, alwaysDrawn].every((o) => !o.frustumCulled)).toBe(true);
    restore();
    expect(root.frustumCulled && a.frustumCulled && b.frustumCulled).toBe(true);
    expect(alwaysDrawn.frustumCulled).toBe(false);
  });
});
