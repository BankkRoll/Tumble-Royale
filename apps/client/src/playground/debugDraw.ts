/**
 * Rapier debug wireframe. Rapier rebuilds its line buffers on every call, so
 * this is a debug-only path; the geometry buffer is grown, never shrunk, to
 * avoid reallocating GPU buffers each frame.
 */
import { BufferAttribute, BufferGeometry, LineBasicNodeMaterial, LineSegments } from 'three/webgpu';
import type { World } from '@tumble/sim';

/** Toggleable physics wireframe overlay. */
export class PhysicsDebugDraw {
  readonly object: LineSegments;
  private readonly geometry = new BufferGeometry();
  private capacity = 0;

  constructor() {
    const mat = new LineBasicNodeMaterial({ vertexColors: true, depthTest: true, transparent: true, opacity: 0.85 });
    this.object = new LineSegments(this.geometry, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 999;
    this.object.visible = false;
  }

  /** Shows or hides the overlay. */
  set enabled(v: boolean) {
    this.object.visible = v;
  }

  get enabled(): boolean {
    return this.object.visible;
  }

  /** Re-reads the world's debug lines. No-op while hidden. */
  update(world: World): void {
    if (!this.object.visible) return;
    const { vertices, colors } = world.debugRender();
    const count = vertices.length / 3;
    if (count > this.capacity) {
      this.capacity = Math.ceil(count * 1.5);
      this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.capacity * 3), 3));
      this.geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.capacity * 4), 4));
    }
    const pos = this.geometry.getAttribute('position') as BufferAttribute;
    const col = this.geometry.getAttribute('color') as BufferAttribute;
    (pos.array as Float32Array).set(vertices);
    (col.array as Float32Array).set(colors);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.object.material as LineBasicNodeMaterial).dispose();
  }
}
