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

/** Draws of one frame, per pass, by label. */
export type DrawPasses = Record<string, Record<string, number>>;

/**
 * Records what the renderer actually draws during its next frame, per pass
 * (`main`, `shadow:<n>` per shadow camera, `post`), by object label. Unlike
 * {@link drawBreakdown} this sees batching, layer masks and per-cascade
 * culling.
 *
 * HACK: wraps three's private `_renderObjectDirect` for one frame, like the
 * warm-up does; resolves with an empty record when that hook is missing.
 *
 * @param renderer - The game's renderer.
 * @param viewCamera - The active view's camera (identifies the main pass).
 * @returns Resolves after the next animation frame.
 */
export function recordDrawPasses(renderer: object, viewCamera: Camera): Promise<DrawPasses> {
  const r = renderer as { _renderObjectDirect?: (...args: unknown[]) => void };
  const direct = r._renderObjectDirect;
  if (typeof direct !== 'function') return Promise.resolve({});
  const out: DrawPasses = {};
  const shadowIds = new Map<Camera, number>();
  r._renderObjectDirect = function (this: unknown, ...args: unknown[]): void {
    const [object, , , camera] = args as [Object3D, unknown, unknown, Camera];
    let pass: string;
    if (camera === viewCamera) pass = 'main';
    else if ((object as { isQuadMesh?: boolean }).isQuadMesh) pass = 'post';
    else {
      let id = shadowIds.get(camera);
      if (id === undefined) shadowIds.set(camera, (id = shadowIds.size));
      pass = `shadow:${id}`;
    }
    const k = label(object);
    const bucket = (out[pass] ??= {});
    bucket[k] = (bucket[k] ?? 0) + 1;
    direct.apply(this, args);
  };
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        delete r._renderObjectDirect;
        for (const [pass, counts] of Object.entries(out)) {
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          out[pass] = { total, ...Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])) };
        }
        resolve(out);
      }),
    );
  });
}
