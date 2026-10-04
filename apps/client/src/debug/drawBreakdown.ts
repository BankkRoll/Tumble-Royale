/**
 * Perf probe: which objects the active view would draw this frame, grouped by
 * name, so a draw-call budget can be traced to the subsystem that spends it.
 */
import { Frustum, Matrix4, type Camera, type Mesh, type Object3D } from 'three/webgpu';

const frustum = new Frustum();
const m = new Matrix4();

function label(o: Object3D): string {
  let n: Object3D | null = o;
  while (n && !n.name) n = n.parent;
  return (n?.name || o.type).replace(/[-_:#]?\d+$/, '');
}

/**
 * Counts visible, in-frustum renderables by name (the nearest named ancestor).
 *
 * @param root - Scene to walk.
 * @param camera - The view's camera.
 * @returns Draw counts keyed by label, largest first.
 */
export function drawBreakdown(root: Object3D, camera: Camera): Record<string, number> {
  camera.updateMatrixWorld();
  frustum.setFromProjectionMatrix(m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const counts = new Map<string, number>();
  const walk = (o: Object3D): void => {
    if (!o.visible) return;
    const r = o as Mesh;
    if (
      (r.isMesh || (o as { isPoints?: boolean }).isPoints || (o as { isSprite?: boolean }).isSprite) &&
      r.geometry
    ) {
      const culled = o.frustumCulled && !frustum.intersectsObject(o);
      if (!culled) {
        const mats = Array.isArray(r.material) ? r.material.length : 1;
        const k = label(o);
        counts.set(k, (counts.get(k) ?? 0) + mats);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}
